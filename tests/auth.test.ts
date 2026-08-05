import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getValidAccessToken,
  hasUsableTargetCredentials,
  providerApiKeyEnvVars,
  readAuthFile,
  resolveProviderApiKeyFromEnv,
  resolveTargetApiKey,
} from "../src/auth.ts";

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
