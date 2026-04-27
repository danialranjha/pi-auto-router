// Portions adapted from https://github.com/ajarellanod/pi-usage-bars
// (extensions/usage-bars/core.ts) — fetches OAuth quota state from
// Anthropic, OpenAI Codex, and Google (Gemini / Antigravity) usage endpoints.
// Trimmed: no z.ai support, no UI helpers; adds QuotaWindow adapter.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { QuotaWindow } from "./types.ts";

export type OAuthProviderId =
  | "openai-codex"
  | "anthropic"
  | "google-gemini-cli"
  | "google-antigravity";

export interface AuthData {
  "openai-codex"?: { access?: string; refresh?: string; expires?: number };
  anthropic?: { access?: string; refresh?: string; expires?: number };
  "google-gemini-cli"?: { access?: string; refresh?: string; projectId?: string; expires?: number };
  "google-antigravity"?: { access?: string; refresh?: string; projectId?: string; expires?: number };
}

export interface UsageData {
  session: number;
  weekly: number;
  sessionResetsIn?: string;
  weeklyResetsIn?: string;
  sessionResetsAt?: string;
  weeklyResetsAt?: string;
  sessionResetsInSec?: number;
  weeklyResetsInSec?: number;
  extraSpend?: number;
  extraLimit?: number;
  warning?: string;
  stale?: boolean;
  fetchedAt?: number;
  error?: string;
}

export type UsageByProvider = Partial<Record<OAuthProviderId, UsageData | null>>;

export interface UsageEndpoints {
  gemini: string;
  antigravity: string;
  googleLoadCodeAssistEndpoints: string[];
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: HeadersLike;
  json(): Promise<any>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface RequestConfig {
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export interface FetchConfig extends RequestConfig {
  endpoints?: UsageEndpoints;
  env?: NodeJS.ProcessEnv;
}

export interface OAuthApiKeyResult {
  newCredentials: Record<string, any>;
  apiKey: string;
}

export type OAuthApiKeyResolver = (
  providerId: OAuthProviderId,
  credentials: Record<string, Record<string, any>>,
) => Promise<OAuthApiKeyResult | null>;

export interface EnsureFreshAuthConfig {
  auth?: AuthData | null;
  authFile?: string;
  oauthResolver?: OAuthApiKeyResolver;
  nowMs?: number;
  persist?: boolean;
  forceRefreshProviders?: OAuthProviderId[];
}

export interface FreshAuthResult {
  auth: AuthData | null;
  changed: boolean;
  refreshErrors: Partial<Record<OAuthProviderId, string>>;
}

export interface FetchAllUsagesConfig extends FetchConfig, EnsureFreshAuthConfig {
  cacheFile?: string;
}

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const CLAUDE_SHARED_FRESH_TTL_MS = 2 * 60 * 1000;
const CLAUDE_BASE_BACKOFF_MS = 2 * 60 * 1000;
const CLAUDE_MAX_BACKOFF_MS = 30 * 60 * 1000;

export const DEFAULT_AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
export const DEFAULT_USAGE_CACHE_FILE = path.join(os.tmpdir(), "pi", "auto-router-uvi-cache.json");
export const GOOGLE_QUOTA_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
export const GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist",
];

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const CODEX_PRIMARY_WINDOW_MS = 5 * HOUR_MS;
export const CODEX_SECONDARY_WINDOW_MS = 7 * DAY_MS;
export const CLAUDE_FIVE_HOUR_WINDOW_MS = 5 * HOUR_MS;
export const CLAUDE_SEVEN_DAY_WINDOW_MS = 7 * DAY_MS;
// Google quota endpoint doesn't expose duration; assume daily resets.
export const GOOGLE_DAILY_WINDOW_MS = DAY_MS;

export function resolveUsageEndpoints(env: NodeJS.ProcessEnv = process.env): UsageEndpoints {
  const configured = (value: string | undefined, fallback: string) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
  };

  return {
    gemini: configured(env.PI_GEMINI_USAGE_ENDPOINT, GOOGLE_QUOTA_ENDPOINT),
    antigravity: configured(env.PI_ANTIGRAVITY_USAGE_ENDPOINT, GOOGLE_QUOTA_ENDPOINT),
    googleLoadCodeAssistEndpoints: GOOGLE_LOAD_CODE_ASSIST_ENDPOINTS,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "request timeout";
    return error.message || String(error);
  }
  return String(error);
}

function asObject(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, any>;
}

function getHeader(headers: HeadersLike | undefined, name: string): string | null {
  if (!headers) return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

interface JsonRequestSuccess {
  ok: true;
  data: any;
  status: number;
  headers?: HeadersLike;
}
interface JsonRequestError {
  ok: false;
  error: string;
  status: number | null;
  headers?: HeadersLike;
}
type JsonRequestResult = JsonRequestSuccess | JsonRequestError;

async function requestJson(url: string, init: RequestInit, config: RequestConfig = {}): Promise<JsonRequestResult> {
  const fetchFn = config.fetchFn ?? ((fetch as unknown) as FetchLike);
  const timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, status: response.status, headers: response.headers };
    }
    try {
      const data = await response.json();
      return { ok: true, data, status: response.status, headers: response.headers };
    } catch {
      return { ok: false, error: "invalid JSON response", status: response.status, headers: response.headers };
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error), status: null };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1000;
  const dateMs = new Date(value).getTime();
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

export function readAuth(authFile = DEFAULT_AUTH_FILE): AuthData | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    return asObject(parsed) as AuthData;
  } catch {
    return null;
  }
}

export function writeAuth(auth: AuthData, authFile = DEFAULT_AUTH_FILE): boolean {
  try {
    const dir = path.dirname(authFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${authFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2));
    fs.renameSync(tmpPath, authFile);
    return true;
  } catch {
    return false;
  }
}

let cachedOAuthResolver: OAuthApiKeyResolver | null = null;

async function getDefaultOAuthResolver(): Promise<OAuthApiKeyResolver> {
  if (cachedOAuthResolver) return cachedOAuthResolver;
  const mod = await import("@mariozechner/pi-ai/oauth");
  if (typeof (mod as any).getOAuthApiKey !== "function") {
    throw new Error("oauth resolver unavailable");
  }
  cachedOAuthResolver = (providerId, credentials) =>
    (mod as any).getOAuthApiKey(providerId, credentials) as Promise<OAuthApiKeyResult | null>;
  return cachedOAuthResolver;
}

function isCredentialExpired(creds: { expires?: number } | undefined, nowMs: number): boolean {
  if (!creds) return false;
  if (typeof creds.expires !== "number") return false;
  return nowMs + TOKEN_REFRESH_SKEW_MS >= creds.expires;
}

export async function ensureFreshAuthForProviders(
  providerIds: OAuthProviderId[],
  config: EnsureFreshAuthConfig = {},
): Promise<FreshAuthResult> {
  const authFile = config.authFile ?? DEFAULT_AUTH_FILE;
  const auth = config.auth ?? readAuth(authFile);
  if (!auth) return { auth: null, changed: false, refreshErrors: {} };

  const nowMs = config.nowMs ?? Date.now();
  const uniqueProviders = Array.from(new Set(providerIds));
  const forcedProviders = new Set(config.forceRefreshProviders ?? []);
  const nextAuth: AuthData = { ...auth };
  const refreshErrors: Partial<Record<OAuthProviderId, string>> = {};
  let changed = false;

  for (const providerId of uniqueProviders) {
    const creds = (nextAuth as any)[providerId] as { access?: string; refresh?: string; expires?: number } | undefined;
    if (!creds?.refresh) continue;
    const needsRefresh = forcedProviders.has(providerId) || !creds.access || isCredentialExpired(creds, nowMs);
    if (!needsRefresh) continue;

    try {
      const resolver = config.oauthResolver ?? (await getDefaultOAuthResolver());
      const resolved = await resolver(providerId, nextAuth as any);
      if (!resolved?.newCredentials) {
        refreshErrors[providerId] = "missing OAuth credentials";
        continue;
      }
      (nextAuth as any)[providerId] = { ...(nextAuth as any)[providerId], ...resolved.newCredentials };
      changed = true;
    } catch (error) {
      refreshErrors[providerId] = toErrorMessage(error);
    }
  }

  if (changed && config.persist !== false) writeAuth(nextAuth, authFile);
  return { auth: nextAuth, changed, refreshErrors };
}

export function readPercentCandidate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) {
    if (Number.isInteger(value)) return value;
    return value * 100;
  }
  if (value >= 0 && value <= 100) return value;
  return null;
}

function usedPercentFromRemainingFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const remaining = Math.max(0, Math.min(1, value));
  return (1 - remaining) * 100;
}

function pickMostUsedBucket(buckets: any[]): any | null {
  let best: any | null = null;
  let bestUsed = -1;
  for (const bucket of buckets) {
    const used = usedPercentFromRemainingFraction(bucket?.remainingFraction);
    if (used == null) continue;
    if (used > bestUsed) {
      bestUsed = used;
      best = bucket;
    }
  }
  return best;
}

export function parseGoogleQuotaBuckets(
  data: any,
  provider: "gemini" | "antigravity",
): { session: number; weekly: number; sessionResetsAt?: string; weeklyResetsAt?: string } | null {
  const allBuckets = Array.isArray(data?.buckets) ? data.buckets : [];
  if (!allBuckets.length) return null;
  const requestBuckets = allBuckets.filter((b: any) => String(b?.tokenType || "").toUpperCase() === "REQUESTS");
  const buckets = requestBuckets.length ? requestBuckets : allBuckets;
  const modelId = (b: any) => String(b?.modelId || "").toLowerCase();
  const claudeNonThinking = buckets.filter((b: any) => modelId(b).includes("claude") && !modelId(b).includes("thinking"));
  const geminiPro = buckets.filter((b: any) => modelId(b).includes("gemini") && modelId(b).includes("pro"));
  const geminiFlash = buckets.filter((b: any) => modelId(b).includes("gemini") && modelId(b).includes("flash"));

  const primaryBucket =
    provider === "antigravity"
      ? pickMostUsedBucket(claudeNonThinking) || pickMostUsedBucket(geminiPro) || pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(buckets)
      : pickMostUsedBucket(geminiPro) || pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(buckets);
  const secondaryBucket = pickMostUsedBucket(geminiFlash) || pickMostUsedBucket(geminiPro) || pickMostUsedBucket(buckets);
  const session = usedPercentFromRemainingFraction(primaryBucket?.remainingFraction);
  const weekly = usedPercentFromRemainingFraction(secondaryBucket?.remainingFraction);
  if (session == null || weekly == null) return null;
  const sessionResetsAt = typeof primaryBucket?.resetTime === "string" ? primaryBucket.resetTime : undefined;
  const weeklyResetsAt = typeof secondaryBucket?.resetTime === "string" ? secondaryBucket.resetTime : undefined;
  return { session, weekly, sessionResetsAt, weeklyResetsAt };
}

function googleMetadata(projectId?: string) {
  return {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    ...(projectId ? { duetProject: projectId } : {}),
  };
}

function googleHeaders(token: string, projectId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": JSON.stringify(googleMetadata(projectId)),
  };
}

export async function discoverGoogleProjectId(token: string, config: FetchConfig = {}): Promise<string | undefined> {
  const env = config.env ?? process.env;
  const envProjectId = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID;
  if (envProjectId) return envProjectId;
  const endpoints = config.endpoints ?? resolveUsageEndpoints(env);
  for (const endpoint of endpoints.googleLoadCodeAssistEndpoints) {
    const result = await requestJson(
      endpoint,
      { method: "POST", headers: googleHeaders(token), body: JSON.stringify({ metadata: googleMetadata() }) },
      config,
    );
    if (!result.ok) continue;
    const data = result.data;
    if (typeof data?.cloudaicompanionProject === "string" && data.cloudaicompanionProject) return data.cloudaicompanionProject;
    if (data?.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object") {
      const id = data.cloudaicompanionProject.id;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

export async function fetchCodexUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );
  if (!result.ok) return { session: 0, weekly: 0, error: result.error };
  const primary = result.data?.rate_limit?.primary_window;
  const secondary = result.data?.rate_limit?.secondary_window;
  const fetchedAt = Date.now();
  return {
    session: readPercentCandidate(primary?.used_percent) ?? 0,
    weekly: readPercentCandidate(secondary?.used_percent) ?? 0,
    sessionResetsInSec: typeof primary?.reset_after_seconds === "number" ? primary.reset_after_seconds : undefined,
    weeklyResetsInSec: typeof secondary?.reset_after_seconds === "number" ? secondary.reset_after_seconds : undefined,
    fetchedAt,
  };
}

export async function fetchClaudeUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    "https://api.anthropic.com/api/oauth/usage",
    { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } },
    config,
  );
  const fetchedAt = Date.now();
  if (!result.ok) {
    const retryAfterMs = parseRetryAfterMs(getHeader(result.headers, "retry-after"), fetchedAt);
    return {
      session: 0,
      weekly: 0,
      error: result.error,
      fetchedAt,
      ...(retryAfterMs != null ? { sessionResetsInSec: Math.ceil(retryAfterMs / 1000) } : {}),
    };
  }
  const data = result.data;
  const usage: UsageData = {
    session: readPercentCandidate(data?.five_hour?.utilization) ?? 0,
    weekly: readPercentCandidate(data?.seven_day?.utilization) ?? 0,
    sessionResetsAt: typeof data?.five_hour?.resets_at === "string" ? data.five_hour.resets_at : undefined,
    weeklyResetsAt: typeof data?.seven_day?.resets_at === "string" ? data.seven_day.resets_at : undefined,
    fetchedAt,
  };
  if (data?.extra_usage?.is_enabled) {
    usage.extraSpend = typeof data.extra_usage.used_credits === "number" ? data.extra_usage.used_credits : undefined;
    usage.extraLimit = typeof data.extra_usage.monthly_limit === "number" ? data.extra_usage.monthly_limit : undefined;
  }
  return usage;
}

export async function fetchGoogleUsage(
  token: string,
  endpoint: string,
  projectId: string | undefined,
  provider: "gemini" | "antigravity",
  config: FetchConfig = {},
): Promise<UsageData> {
  if (!endpoint) return { session: 0, weekly: 0, error: "configure endpoint" };
  const discoveredProjectId = projectId || (await discoverGoogleProjectId(token, config));
  if (!discoveredProjectId) return { session: 0, weekly: 0, error: "missing projectId (try /login again)" };
  const result = await requestJson(
    endpoint,
    { method: "POST", headers: googleHeaders(token, discoveredProjectId), body: JSON.stringify({ project: discoveredProjectId }) },
    config,
  );
  const fetchedAt = Date.now();
  if (!result.ok) return { session: 0, weekly: 0, error: result.error, fetchedAt };
  const quota = parseGoogleQuotaBuckets(result.data, provider);
  if (quota) return { ...quota, fetchedAt };
  return { session: 0, weekly: 0, error: "unrecognized response shape", fetchedAt };
}

export async function fetchAllUsages(config: FetchAllUsagesConfig = {}): Promise<UsageByProvider> {
  const authFile = config.authFile ?? DEFAULT_AUTH_FILE;
  const auth = config.auth ?? readAuth(authFile);
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const results: UsageByProvider = {};
  if (!auth) return results;

  const oauthProviders: OAuthProviderId[] = ["openai-codex", "anthropic", "google-gemini-cli", "google-antigravity"];
  const refreshed = await ensureFreshAuthForProviders(oauthProviders, { ...config, auth, authFile });
  const authData = refreshed.auth ?? auth;

  const refreshError = (providerId: OAuthProviderId): string | null => {
    const error = refreshed.refreshErrors[providerId];
    return error ? `auth refresh failed (${error})` : null;
  };

  const tasks: Promise<void>[] = [];
  const assign = (key: OAuthProviderId, task: Promise<UsageData>) => {
    tasks.push(
      task
        .then((usage) => { results[key] = usage; })
        .catch((error) => { results[key] = { session: 0, weekly: 0, error: toErrorMessage(error) }; }),
    );
  };

  if (authData["openai-codex"]?.access) {
    const err = refreshError("openai-codex");
    if (err) results["openai-codex"] = { session: 0, weekly: 0, error: err };
    else assign("openai-codex", fetchCodexUsage(authData["openai-codex"].access, config));
  }

  if (authData.anthropic?.access) {
    const err = refreshError("anthropic");
    if (err) results.anthropic = { session: 0, weekly: 0, error: err };
    else assign("anthropic", fetchClaudeUsage(authData.anthropic.access, config));
  }

  if (authData["google-gemini-cli"]?.access) {
    const err = refreshError("google-gemini-cli");
    if (err) results["google-gemini-cli"] = { session: 0, weekly: 0, error: err };
    else {
      const creds = authData["google-gemini-cli"];
      assign("google-gemini-cli", fetchGoogleUsage(creds.access!, endpoints.gemini, creds.projectId, "gemini", { ...config, endpoints }));
    }
  }

  if (authData["google-antigravity"]?.access) {
    const err = refreshError("google-antigravity");
    if (err) results["google-antigravity"] = { session: 0, weekly: 0, error: err };
    else {
      const creds = authData["google-antigravity"];
      assign("google-antigravity", fetchGoogleUsage(creds.access!, endpoints.antigravity, creds.projectId, "antigravity", { ...config, endpoints }));
    }
  }

  await Promise.all(tasks);
  return results;
}

// ─── Adapter: UsageData → QuotaWindow[] ───────────────────────────────────────

export function usageToWindows(provider: OAuthProviderId, usage: UsageData | null | undefined): QuotaWindow[] {
  if (!usage || usage.error) return [];
  const fetchedAt = usage.fetchedAt ?? Date.now();
  const source: QuotaWindow["source"] = usage.stale ? "stale-cache" : "oauth-usage";
  const windows: QuotaWindow[] = [];

  switch (provider) {
    case "openai-codex": {
      windows.push({
        provider,
        scope: "session",
        usedPercent: usage.session,
        resetsInSec: usage.sessionResetsInSec,
        windowDurationMs: CODEX_PRIMARY_WINDOW_MS,
        source,
        fetchedAt,
      });
      windows.push({
        provider,
        scope: "weekly",
        usedPercent: usage.weekly,
        resetsInSec: usage.weeklyResetsInSec,
        windowDurationMs: CODEX_SECONDARY_WINDOW_MS,
        source,
        fetchedAt,
      });
      break;
    }
    case "anthropic": {
      windows.push({
        provider,
        scope: "session",
        usedPercent: usage.session,
        resetsAt: usage.sessionResetsAt,
        windowDurationMs: CLAUDE_FIVE_HOUR_WINDOW_MS,
        source,
        fetchedAt,
      });
      windows.push({
        provider,
        scope: "weekly",
        usedPercent: usage.weekly,
        resetsAt: usage.weeklyResetsAt,
        windowDurationMs: CLAUDE_SEVEN_DAY_WINDOW_MS,
        source,
        fetchedAt,
      });
      break;
    }
    case "google-gemini-cli":
    case "google-antigravity": {
      // Google's BucketInfo exposes per-bucket resetTime (ISO-8601). When present,
      // derive the actual window duration from (resetTime - fetchedAt); otherwise
      // fall back to the 24h assumption.
      // Primary bucket (most-used model, e.g. gemini-pro) → session scope.
      let sessionMs = GOOGLE_DAILY_WINDOW_MS;
      if (usage.sessionResetsAt) {
        const resetMs = new Date(usage.sessionResetsAt).getTime();
        if (Number.isFinite(resetMs) && resetMs > fetchedAt) sessionMs = resetMs - fetchedAt;
      }
      windows.push({
        provider,
        scope: "session",
        usedPercent: usage.session,
        resetsAt: usage.sessionResetsAt,
        windowDurationMs: sessionMs,
        source,
        fetchedAt,
      });
      // Secondary bucket (next-most-used model, e.g. gemini-flash) → weekly scope.
      let weeklyMs = GOOGLE_DAILY_WINDOW_MS;
      if (usage.weeklyResetsAt) {
        const resetMs = new Date(usage.weeklyResetsAt).getTime();
        if (Number.isFinite(resetMs) && resetMs > fetchedAt) weeklyMs = resetMs - fetchedAt;
      }
      windows.push({
        provider,
        scope: "weekly",
        usedPercent: usage.weekly,
        resetsAt: usage.weeklyResetsAt,
        windowDurationMs: weeklyMs,
        source,
        fetchedAt,
      });
      break;
    }
  }

  return windows;
}
