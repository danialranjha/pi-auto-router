import { ensureFreshAuthForProviders, type OAuthProviderId } from "./quota-fetcher.ts";

/**
 * Maps a route-config provider name to the OAuth provider id used for auth checks.
 */
export const ROUTE_TO_OAUTH: Record<string, OAuthProviderId> = {
  "openai-codex": "openai-codex",
  "google-antigravity": "google-antigravity",
  "google-gemini-cli": "google-gemini-cli",
  "anthropic": "anthropic",
  "claude-agent-sdk": "anthropic",
};

export const HEALTH_CHECK_TTL_MS = 60_000; // cache healthy status for 60s
export const UNHEALTHY_TTL_MS = 10_000; // retry unhealthy providers sooner

interface HealthEntry {
  healthy: boolean;
  error?: string;
  checkedAt: number;
}

/**
 * Lightweight provider health cache.
 * Verifies OAuth auth tokens exist without fetching full quota usage.
 * Works independently of UVI — health checks run even when UVI is disabled.
 */
export class ProviderHealthCache {
  private cache = new Map<OAuthProviderId, HealthEntry>();
  private inflight = new Map<OAuthProviderId, Promise<void>>();

  /**
   * Check if a route target's provider is healthy.
   * For OAuth providers: verifies the auth token exists and is refreshable.
   * For non-OAuth providers: always returns true.
   */
  isHealthy(provider: string, authProvider?: string): boolean {
    const oauthId = resolveOAuth(provider, authProvider);
    if (!oauthId) return true; // non-OAuth provider — assume healthy
    const entry = this.cache.get(oauthId);
    if (!entry) return true; // not yet checked — assume healthy (don't block on first prompt)
    if (!entry.healthy && Date.now() - entry.checkedAt < UNHEALTHY_TTL_MS) return false;
    if (!entry.healthy) return true; // unhealthy TTL expired — retry
    if (Date.now() - entry.checkedAt > HEALTH_CHECK_TTL_MS) return true; // healthy TTL expired — re-check next cycle
    return true;
  }

  /**
   * Get the health error for a provider, if any (for UI display).
   */
  getHealthError(provider: string, authProvider?: string): string | undefined {
    const oauthId = resolveOAuth(provider, authProvider);
    if (!oauthId) return undefined;
    const entry = this.cache.get(oauthId);
    if (entry && !entry.healthy && Date.now() - entry.checkedAt < UNHEALTHY_TTL_MS) {
      return entry.error;
    }
    return undefined;
  }

  /**
   * Trigger a background health check. Non-blocking.
   * Call this before routing to refresh stale health data.
   */
  checkIfStale(provider: string, authProvider?: string): void {
    const oauthId = resolveOAuth(provider, authProvider);
    if (!oauthId) return;
    const entry = this.cache.get(oauthId);
    if (!entry || Date.now() - entry.checkedAt > HEALTH_CHECK_TTL_MS) {
      this.refreshInBackground(oauthId);
    }
  }

  /** Reset all cached health state (for /auto-router reset). */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /**
   * Check health for all candidate providers. Non-blocking.
   */
  checkAllIfStale(providers: Array<{ provider: string; authProvider?: string }>): void {
    for (const p of providers) {
      this.checkIfStale(p.provider, p.authProvider);
    }
  }

  /**
   * Force a health refresh for a specific provider. Returns true if healthy.
   */
  async checkNow(provider: string, authProvider?: string): Promise<boolean> {
    const oauthId = resolveOAuth(provider, authProvider);
    if (!oauthId) return true;
    await this.refresh(oauthId);
    return this.cache.get(oauthId)?.healthy ?? true;
  }

  private refreshInBackground(oauthId: OAuthProviderId): void {
    if (this.inflight.has(oauthId)) return;
    const promise = this.refresh(oauthId).finally(() => {
      if (this.inflight.get(oauthId) === promise) this.inflight.delete(oauthId);
    });
    this.inflight.set(oauthId, promise);
  }

  private async refresh(oauthId: OAuthProviderId): Promise<void> {
    const now = Date.now();
    try {
      await ensureFreshAuthForProviders([oauthId]);
      this.cache.set(oauthId, { healthy: true, checkedAt: now });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.cache.set(oauthId, { healthy: false, error: msg, checkedAt: now });
    }
  }
}

export function resolveOAuth(provider: string, authProvider?: string): OAuthProviderId | null {
  if (authProvider && ROUTE_TO_OAUTH[authProvider]) return ROUTE_TO_OAUTH[authProvider];
  if (provider && ROUTE_TO_OAUTH[provider]) return ROUTE_TO_OAUTH[provider];
  return null;
}

/** Global singleton, lazy-initialized. */
let instance: ProviderHealthCache | null = null;

export function getProviderHealthCache(): ProviderHealthCache {
  if (!instance) instance = new ProviderHealthCache();
  return instance;
}
