import { readFileSync } from "node:fs";
import { DEFAULT_OAUTH_PROVIDERS } from "./quota-fetcher.ts";
import type { RouteTarget } from "./types.ts";

export type AuthEntry = {
  type?: string;
  access?: string;
  key?: string;
  expires?: number;
  [key: string]: unknown;
};

export type AuthData = Record<string, AuthEntry>;

/** Read pi auth data. Missing, malformed, or non-object files are treated as empty. */
export function readAuthFile(authFile: string): AuthData {
  try {
    const parsed = JSON.parse(readFileSync(authFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as AuthData;
  } catch {
    return {};
  }
}

/** Return a usable OAuth access token or API key from pi auth storage. */
export function getValidStoredCredential(
  authProvider: string,
  auth: AuthData,
  nowMs = Date.now(),
): string | undefined {
  const entry = auth[authProvider];
  if (!entry) return undefined;
  if (entry.access && (typeof entry.expires !== "number" || entry.expires > nowMs)) {
    return entry.access;
  }
  if (entry.key) return entry.key;
  return undefined;
}

/** Backwards-compatible name for callers that only expect OAuth access tokens. */
export const getValidAccessToken = getValidStoredCredential;

/** Auth storage keys whose OAuth credentials are refreshed before routing. */
export const REFRESHABLE_OAUTH_AUTH_KEYS: readonly string[] = DEFAULT_OAUTH_PROVIDERS;

/** Common non-OAuth provider names that users pair with OAuth credentials by mistake. */
const OAUTH_AUTH_KEY_SUGGESTIONS: Record<string, string> = {
  openai: "openai-codex",
};

function isOAuthEntry(entry: AuthEntry): boolean {
  return entry.type === "oauth" || typeof entry.refresh === "string";
}

/**
 * Explain why an authProvider's stored OAuth credential will stop working on expiry.
 * Returns undefined when the key is refreshable, absent, not OAuth-shaped, or has an API key fallback.
 */
export function describeUnrefreshableOAuthProvider(authProvider: string, auth: AuthData): string | undefined {
  if (REFRESHABLE_OAUTH_AUTH_KEYS.includes(authProvider)) return undefined;
  const entry = auth[authProvider];
  if (!entry || entry.key || !isOAuthEntry(entry)) return undefined;
  const suggestion = OAUTH_AUTH_KEY_SUGGESTIONS[authProvider];
  const fix = suggestion
    ? `use authProvider "${suggestion}" (re-authenticate with /login if needed)`
    : `use one of: ${REFRESHABLE_OAUTH_AUTH_KEYS.join(", ")}`;
  return `authProvider "${authProvider}" has OAuth credentials that auto-router cannot refresh; targets using it are dropped once the token expires. To fix, ${fix}`;
}

/** Deduplicated unrefreshable-OAuth diagnostics for a set of route targets. */
export function collectUnrefreshableOAuthDiagnostics(
  targets: Array<Pick<RouteTarget, "authProvider">>,
  auth: AuthData,
): string[] {
  const keys = new Set(targets.map((t) => t.authProvider).filter((k): k is string => Boolean(k)));
  return Array.from(keys)
    .map((key) => describeUnrefreshableOAuthProvider(key, auth))
    .filter((msg): msg is string => Boolean(msg));
}

const CANONICAL_PROVIDER_ENV_VARS: Record<string, string[]> = {
  google: ["GEMINI_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  huggingface: ["HF_TOKEN"],
};

/** Env var candidate names, including Pi's canonical names and generic custom-provider forms. */
export function providerApiKeyEnvVars(provider: string): string[] {
  const upper = provider.toUpperCase();
  const underscored = provider.replace(/-/g, "_").toUpperCase();
  return Array.from(new Set([
    ...(CANONICAL_PROVIDER_ENV_VARS[provider] ?? []),
    `${upper}_API_KEY`,
    `${upper}_KEY`,
    `${underscored}_API_KEY`,
    `${underscored}_KEY`,
  ]));
}

/** Resolve an API key from provider-specific environment variables. */
export function resolveProviderApiKeyFromEnv(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of providerApiKeyEnvVars(provider)) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve the key passed to the inner model.
 * Pi auth storage takes precedence; provider environment variables are the fallback.
 */
export function resolveTargetApiKey(
  target: Pick<RouteTarget, "provider" | "authProvider">,
  auth: AuthData,
  nowMs = Date.now(),
  resolveEnvKey: (provider: string) => string | undefined = resolveProviderApiKeyFromEnv,
): string | undefined {
  const authKey = target.authProvider ?? target.provider;
  const storedCredential = getValidStoredCredential(authKey, auth, nowMs);
  return storedCredential ?? resolveEnvKey(target.provider);
}

/**
 * Determine whether a target has usable credentials available now.
 * Subscription targets without authProvider are allowed to use provider-managed auth.
 */
export function hasUsableTargetCredentials(
  target: Pick<RouteTarget, "provider" | "authProvider" | "billing">,
  auth: AuthData,
  nowMs = Date.now(),
  resolveEnvKey: (provider: string) => string | undefined = resolveProviderApiKeyFromEnv,
): boolean {
  if (!target.authProvider && target.billing !== "per-token") return true;
  return Boolean(resolveTargetApiKey(target, auth, nowMs, resolveEnvKey));
}
