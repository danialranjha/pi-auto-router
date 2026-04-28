import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapRouteProviderToOAuth } from "../src/quota-cache.ts";

describe("mapRouteProviderToOAuth", () => {
  it("maps known providers directly", () => {
    assert.equal(mapRouteProviderToOAuth("openai-codex"), "openai-codex");
    assert.equal(mapRouteProviderToOAuth("google-antigravity"), "google-antigravity");
    assert.equal(mapRouteProviderToOAuth("google-gemini-cli"), "google-gemini-cli");
    assert.equal(mapRouteProviderToOAuth("anthropic"), "anthropic");
  });

  it("maps claude-agent-sdk to anthropic", () => {
    assert.equal(mapRouteProviderToOAuth("claude-agent-sdk"), "anthropic");
  });

  it("uses authProvider when provider is not in the map", () => {
    assert.equal(mapRouteProviderToOAuth("unknown", "openai-codex"), "openai-codex");
  });

  it("returns null for unknown providers", () => {
    assert.equal(mapRouteProviderToOAuth("unknown"), null);
    assert.equal(mapRouteProviderToOAuth("unknown", "also-unknown"), null);
  });

  it("prefers authProvider over provider", () => {
    // If both are known, authProvider takes precedence
    assert.equal(mapRouteProviderToOAuth("openai-codex", "anthropic"), "anthropic");
  });

  it("handles empty strings gracefully", () => {
    assert.equal(mapRouteProviderToOAuth(""), null);
    assert.equal(mapRouteProviderToOAuth("", ""), null);
  });
});
