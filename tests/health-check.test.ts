import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOAuth, ROUTE_TO_OAUTH, HEALTH_CHECK_TTL_MS, UNHEALTHY_TTL_MS, ProviderHealthCache } from "../src/health-check.ts";

describe("ROUTE_TO_OAUTH", () => {
  it("maps openai-codex directly", () => {
    assert.equal(ROUTE_TO_OAUTH["openai-codex"], "openai-codex");
  });

  it("maps google-antigravity directly", () => {
    assert.equal(ROUTE_TO_OAUTH["google-antigravity"], "google-antigravity");
  });

  it("maps claude-agent-sdk to anthropic", () => {
    assert.equal(ROUTE_TO_OAUTH["claude-agent-sdk"], "anthropic");
  });

  it("maps anthropic directly", () => {
    assert.equal(ROUTE_TO_OAUTH["anthropic"], "anthropic");
  });

  it("does not map unknown providers", () => {
    assert.equal(ROUTE_TO_OAUTH["ollama"], undefined);
  });
});

describe("resolveOAuth", () => {
  it("resolves authProvider when it matches a known mapping", () => {
    assert.equal(resolveOAuth("unknown", "openai-codex"), "openai-codex");
  });

  it("resolves provider when authProvider is not provided", () => {
    assert.equal(resolveOAuth("openai-codex"), "openai-codex");
  });

  it("prefers authProvider over provider", () => {
    // claude-agent-sdk → anthropic, but if authProvider is openai-codex...
    assert.equal(resolveOAuth("claude-agent-sdk", "openai-codex"), "openai-codex");
  });

  it("maps claude-agent-sdk via provider when no authProvider", () => {
    assert.equal(resolveOAuth("claude-agent-sdk"), "anthropic");
  });

  it("returns null for unmapped providers with no authProvider", () => {
    assert.equal(resolveOAuth("ollama"), null);
  });

  it("returns null for unknown authProvider too", () => {
    assert.equal(resolveOAuth("unknown", "ollama"), null);
  });

  it("handles empty string provider", () => {
    assert.equal(resolveOAuth(""), null);
  });
});

describe("HEALTH_CHECK_TTL constants", () => {
  it("healthy TTL is 60 seconds", () => {
    assert.equal(HEALTH_CHECK_TTL_MS, 60_000);
  });

  it("unhealthy TTL is 10 seconds", () => {
    assert.equal(UNHEALTHY_TTL_MS, 10_000);
  });
});

describe("ProviderHealthCache", () => {
  it("isHealthy returns true for non-OAuth provider (ollama)", () => {
    const cache = new ProviderHealthCache();
    assert.equal(cache.isHealthy("ollama"), true);
  });

  it("isHealthy returns true for known OAuth provider before any checks", () => {
    const cache = new ProviderHealthCache();
    assert.equal(cache.isHealthy("openai-codex"), true);
  });

  it("getHealthError returns undefined for non-OAuth provider", () => {
    const cache = new ProviderHealthCache();
    assert.equal(cache.getHealthError("ollama"), undefined);
  });

  it("getHealthError returns undefined before any checks", () => {
    const cache = new ProviderHealthCache();
    assert.equal(cache.getHealthError("openai-codex"), undefined);
  });

  it("clear resets internal state", () => {
    const cache = new ProviderHealthCache();
    cache.checkIfStale("openai-codex");
    cache.clear();
    assert.equal(cache.isHealthy("openai-codex"), true);
  });

  it("checkAllIfStale handles empty array", () => {
    const cache = new ProviderHealthCache();
    // Should not throw
    cache.checkAllIfStale([]);
    assert.equal(cache.isHealthy("openai-codex"), true);
  });
});
