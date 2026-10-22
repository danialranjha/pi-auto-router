import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectUnrefreshableOAuthDiagnostics,
  describeUnrefreshableOAuthProvider,
  getValidAccessToken,
  hasUsableTargetCredentials,
  providerApiKeyEnvVars,
  readAuthFile,
  resolveProviderApiKeyFromEnv,
  resolveTargetApiKey,
  REFRESHABLE_OAUTH_AUTH_KEYS,
  type AuthData,
} from "../src/auth.ts";
import { DEFAULT_OAUTH_PROVIDERS, ensureFreshAuthForProviders } from "../src/quota-fetcher.ts";

describe("readAuthFile", () => {
  it("returns parsed auth data", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-auth-"));
    const path = join(dir, "auth.json");
    try {
      writeFileSync(path, JSON.stringify({ deepseek: { access: "token" } }));
      assert.deepEqual(readAuthFile(path), { deepseek: { access: "token" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty object for missing, malformed, or non-object files", () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-router-auth-"));
    try {
      const malformed = join(dir, "malformed.json");
      const array = join(dir, "array.json");
      writeFileSync(malformed, "{");
      writeFileSync(array, "[]");
      assert.deepEqual(readAuthFile(join(dir, "missing.json")), {});
      assert.deepEqual(readAuthFile(malformed), {});
      assert.deepEqual(readAuthFile(array), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getValidAccessToken", () => {
  it("returns valid tokens and rejects missing or expired tokens", () => {
    const now = 10_000;
    const auth = {
      valid: { access: "valid-token", expires: now + 1 },
      expired: { access: "expired-token", expires: now },
      noAccess: { expires: now + 1 },
    };
    assert.equal(getValidAccessToken("valid", auth, now), "valid-token");
    assert.equal(getValidAccessToken("expired", auth, now), undefined);
    assert.equal(getValidAccessToken("noAccess", auth, now), undefined);
    assert.equal(getValidAccessToken("missing", auth, now), undefined);
  });

  it("supports API keys stored by pi login", () => {
    const auth = { google: { type: "api_key", key: "stored-gemini-key" } };
    assert.equal(getValidAccessToken("google", auth, 10_000), "stored-gemini-key");
  });
});

describe("provider environment API keys", () => {
  it("includes underscore forms for dashed providers without duplicates", () => {
    const vars = providerApiKeyEnvVars("openai-codex");
    assert.ok(vars.includes("OPENAI_CODEX_API_KEY"));
    assert.ok(vars.includes("OPENAI_CODEX_KEY"));
    assert.equal(new Set(vars).size, vars.length);
  });

  it("uses Pi's canonical provider variable names", () => {
    assert.ok(providerApiKeyEnvVars("google").includes("GEMINI_API_KEY"));
    assert.ok(providerApiKeyEnvVars("moonshotai").includes("MOONSHOT_API_KEY"));
    assert.equal(
      resolveProviderApiKeyFromEnv("google", { GEMINI_API_KEY: "gemini-token" }),
      "gemini-token",
    );
  });

  it("resolves generic custom-provider variables from an injected environment", () => {
    assert.equal(
      resolveProviderApiKeyFromEnv("deepseek", { DEEPSEEK_API_KEY: "env-token" }),
      "env-token",
    );
    assert.equal(resolveProviderApiKeyFromEnv("deepseek", {}), undefined);
  });
});

describe("resolveTargetApiKey", () => {
  const target = { provider: "deepseek", authProvider: "deepseek" };

  it("prefers a valid pi auth token over an environment key", () => {
    const key = resolveTargetApiKey(
      target,
      { deepseek: { access: "auth-token" } },
      10_000,
      () => "env-token",
    );
    assert.equal(key, "auth-token");
  });

  it("falls back to the provider environment key for missing or expired pi auth", () => {
    const missing = resolveTargetApiKey(target, {}, 10_000, () => "env-token");
    const expired = resolveTargetApiKey(
      target,
      { deepseek: { access: "expired", expires: 10_000 } },
      10_000,
      () => "env-token",
    );
    assert.equal(missing, "env-token");
    assert.equal(expired, "env-token");
  });

  it("resolves stored or environment keys for targets without authProvider", () => {
    assert.equal(
      resolveTargetApiKey({ provider: "google" }, { google: { key: "stored-google" } }, 10_000, () => "env-google"),
      "stored-google",
    );
    assert.equal(
      resolveTargetApiKey({ provider: "google" }, {}, 10_000, () => "env-google"),
      "env-google",
    );
  });
});

describe("hasUsableTargetCredentials", () => {
  it("accepts authProvider targets through auth.json or provider env fallback", () => {
    const target = { provider: "deepseek", authProvider: "deepseek", billing: "subscription" as const };
    assert.equal(hasUsableTargetCredentials(target, { deepseek: { access: "auth-token" } }, 10_000, () => undefined), true);
    assert.equal(hasUsableTargetCredentials(target, {}, 10_000, () => "env-token"), true);
    assert.equal(hasUsableTargetCredentials(target, {}, 10_000, () => undefined), false);
  });

  it("requires stored or environment credentials for per-token targets without authProvider", () => {
    const target = { provider: "google", billing: "per-token" as const };
    assert.equal(hasUsableTargetCredentials(target, { google: { key: "stored-google" } }, 10_000, () => undefined), true);
    assert.equal(hasUsableTargetCredentials(target, {}, 10_000, () => "google-key"), true);
    assert.equal(hasUsableTargetCredentials(target, {}, 10_000, () => undefined), false);
  });

  it("allows subscription targets that rely on provider-managed authentication", () => {
    const target = { provider: "ollama", billing: "subscription" as const };
    assert.equal(hasUsableTargetCredentials(target, {}, 10_000, () => undefined), true);
  });
});

describe("unrefreshable OAuth authProvider diagnostics (#22)", () => {
  const now = 10_000;
  const oauthEntry = (expires: number) => ({ type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires });

  it("diagnoses an OAuth entry stored under openai and suggests openai-codex", () => {
    const msg = describeUnrefreshableOAuthProvider("openai", { openai: oauthEntry(now + 60_000) });
    assert.ok(msg);
    assert.match(msg, /authProvider "openai"/);
    assert.match(msg, /authProvider "openai-codex"/);
  });

  it("is silent for refreshable keys, API-key entries, and missing entries", () => {
    assert.equal(describeUnrefreshableOAuthProvider("openai-codex", { "openai-codex": oauthEntry(now) }), undefined);
    assert.equal(describeUnrefreshableOAuthProvider("openai", { openai: { type: "api_key", key: "synthetic-key" } }), undefined);
    assert.equal(describeUnrefreshableOAuthProvider("openai", { openai: { ...oauthEntry(now), key: "synthetic-key" } }), undefined);
    assert.equal(describeUnrefreshableOAuthProvider("deepseek", { deepseek: { access: "synthetic-access" } }), undefined);
    assert.equal(describeUnrefreshableOAuthProvider("openai", {}), undefined);
  });

  it("lists supported providers when there is no known suggestion", () => {
    const msg = describeUnrefreshableOAuthProvider("my-oauth", { "my-oauth": oauthEntry(now) });
    assert.match(msg ?? "", /openai-codex, anthropic, google-gemini-cli, google-antigravity/);
  });

  it("deduplicates diagnostics across route targets", () => {
    const auth = { openai: oauthEntry(now), "openai-codex": oauthEntry(now) };
    const targets = [{ authProvider: "openai" }, { authProvider: "openai" }, { authProvider: "openai-codex" }, {}];
    assert.equal(collectUnrefreshableOAuthDiagnostics(targets, auth).length, 1);
  });

  it("stays in sync with the providers the default refresh path covers", () => {
    assert.deepEqual([...REFRESHABLE_OAUTH_AUTH_KEYS], [...DEFAULT_OAUTH_PROVIDERS]);
  });

  it("openai OAuth entry is eligible before expiry, skipped by refresh, and dropped after expiry; openai-codex keeps working", async () => {
    const target = { provider: "openai", authProvider: "openai", billing: "subscription" as const };
    const codexTarget = { provider: "openai-codex", authProvider: "openai-codex", billing: "subscription" as const };
    const auth = { openai: oauthEntry(now + 1_000), "openai-codex": oauthEntry(now + 1_000) };
    const noEnv = () => undefined;

    assert.equal(hasUsableTargetCredentials(target, auth, now, noEnv), true);

    const later = now + 10 * 60_000;
    const refreshedIds: string[] = [];
    const refreshed = await ensureFreshAuthForProviders([...DEFAULT_OAUTH_PROVIDERS], {
      auth: auth as any,
      nowMs: later,
      persist: false,
      oauthResolver: async (providerId) => {
        refreshedIds.push(providerId);
        return { apiKey: "synthetic-new", newCredentials: { access: "synthetic-new", expires: later + 60_000 } };
      },
    });
    const nextAuth = refreshed.auth as AuthData;

    assert.deepEqual(refreshedIds, ["openai-codex"]);
    assert.equal(hasUsableTargetCredentials(codexTarget, nextAuth, later, noEnv), true);
    assert.equal(hasUsableTargetCredentials(target, nextAuth, later, noEnv), false);
    assert.equal(collectUnrefreshableOAuthDiagnostics([target, codexTarget], nextAuth).length, 1);
  });
});
