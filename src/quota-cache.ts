import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  fetchAllUsages,
  usageToWindows,
  type FetchAllUsagesConfig,
  type OAuthProviderId,
  type UsageByProvider,
} from "./quota-fetcher.ts";
import { aggregateProviderUVI } from "./uvi.ts";
import {
  DEFAULT_UVI_THRESHOLDS,
  type UVIThresholds,
  type UtilizationSnapshot,
} from "./types.ts";

const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");

const OAUTH_PROVIDERS: OAuthProviderId[] = [
  "openai-codex",
  "anthropic",
  "google-gemini-cli",
  "google-antigravity",
];

// Maps the route-config `provider` field (and optional `authProvider`) to
// the OAuth provider id used by the usage endpoints.
const ROUTE_PROVIDER_TO_OAUTH: Record<string, OAuthProviderId> = {
  "openai-codex": "openai-codex",
  "google-antigravity": "google-antigravity",
  "google-gemini-cli": "google-gemini-cli",
  "anthropic": "anthropic",
  "claude-agent-sdk": "anthropic",
};

export function mapRouteProviderToOAuth(
  provider: string,
  authProvider?: string,
): OAuthProviderId | null {
  if (authProvider && ROUTE_PROVIDER_TO_OAUTH[authProvider]) return ROUTE_PROVIDER_TO_OAUTH[authProvider];
  if (provider && ROUTE_PROVIDER_TO_OAUTH[provider]) return ROUTE_PROVIDER_TO_OAUTH[provider];
  return null;
}

export type QuotaCacheOptions = {
  ttlMs?: number;
  thresholds?: UVIThresholds;
  fetchConfig?: FetchAllUsagesConfig;
  enabled?: boolean;
};

const DEFAULT_TTL_MS = 60_000;
const MIN_REFRESH_INTERVAL_MS = 30_000;

export class QuotaCache {
  private snapshots = new Map<OAuthProviderId, UtilizationSnapshot>();
  private lastRefreshAt = 0;
  private inflight: Promise<void> | null = null;
  private ttlMs: number;
  private thresholds: UVIThresholds;
  private fetchConfig: FetchAllUsagesConfig;
  private enabled: boolean;

  constructor(opts: QuotaCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? envTtlMs() ?? DEFAULT_TTL_MS;
    this.thresholds = opts.thresholds ?? DEFAULT_UVI_THRESHOLDS;
    this.fetchConfig = opts.fetchConfig ?? {};
    this.enabled = opts.enabled ?? envEnabled();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    process.env.AUTO_ROUTER_UVI = enabled ? "1" : "0";
    writeUviEnabledToSettings(enabled);
  }

  getSnapshot(oauthProvider: OAuthProviderId): UtilizationSnapshot | undefined {
    return this.snapshots.get(oauthProvider);
  }

  getAllSnapshots(): Record<string, UtilizationSnapshot> {
    return Object.fromEntries(this.snapshots.entries());
  }

  isStale(now = Date.now()): boolean {
    if (this.lastRefreshAt === 0) return true;
    return now - this.lastRefreshAt > this.ttlMs;
  }

  /** Trigger a background refresh if stale. Never throws, never blocks the caller. */
  refreshIfStale(now = Date.now()): void {
    if (!this.enabled) return;
    if (this.inflight) return;
    if (now - this.lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return;
    if (!this.isStale(now)) return;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
  }

  /** Force a refresh now and wait for it. */
  async refreshNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    await this.inflight;
  }

  private async refresh(): Promise<void> {
    const now = Date.now();
    let usages: UsageByProvider = {};
    try {
      usages = await fetchAllUsages(this.fetchConfig);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      for (const id of OAUTH_PROVIDERS) {
        const prev = this.snapshots.get(id);
        this.snapshots.set(id, {
          provider: id,
          uvi: prev?.uvi ?? 0,
          status: prev?.status ?? "ok",
          windows: prev?.windows ?? [],
          reason: `fetch failed: ${msg}`,
          error: msg,
          stale: prev ? true : undefined,
          fetchedAt: now,
        });
      }
      this.lastRefreshAt = now;
      return;
    }

    for (const id of OAUTH_PROVIDERS) {
      const usage = usages[id];
      if (!usage) {
        // No auth or skipped; clear so we don't show stale data.
        this.snapshots.delete(id);
        continue;
      }
      if (usage.error) {
        const prev = this.snapshots.get(id);
        this.snapshots.set(id, {
          provider: id,
          uvi: prev?.uvi ?? 0,
          status: prev?.status ?? "ok",
          windows: prev?.windows ?? [],
          reason: `usage fetch error: ${usage.error}`,
          error: usage.error,
          stale: prev ? true : undefined,
          fetchedAt: now,
        });
        continue;
      }
      const windows = usageToWindows(id, usage);
      const snap = aggregateProviderUVI(id, windows, now, this.thresholds);
      this.snapshots.set(id, snap);
    }
    this.lastRefreshAt = now;
  }
}

function envEnabled(): boolean {
  const raw = process.env.AUTO_ROUTER_UVI;
  if (raw) return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on";
  // Fall back to persisted settings file so enabled state survives restarts.
  // Default-on: if neither env var nor settings file has an explicit value,
  // UVI is enabled. Opt out with AUTO_ROUTER_UVI=0 or /auto-router uvi disable.
  return readUviEnabledFromSettings();
}

function envTtlMs(): number | undefined {
  const raw = process.env.AUTO_ROUTER_UVI_TTL_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readUviEnabledFromSettings(): boolean {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw);
    // Explicit check: only return true if the key exists and is true.
    // If the key doesn't exist, default to true (enabled by default).
    if ("autoRouterUviEnabled" in settings) {
      return settings.autoRouterUviEnabled === true;
    }
    return true;
  } catch {
    // File missing or corrupt — default to enabled.
    return true;
  }
}

function writeUviEnabledToSettings(enabled: boolean): void {
  try {
    let settings: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      settings = JSON.parse(raw);
    } catch {
      // file missing or corrupt; start fresh
    }
    settings.autoRouterUviEnabled = enabled;
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // best-effort; don't crash if settings can't be written
  }
}
