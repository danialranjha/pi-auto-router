import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelSpec, describeTarget, formatHintsHuman, formatRemainingMs, parseResetAfterMs, parseClockResetMs, getCooldownMs, normalizeModelToken, findCaseInsensitiveKey, providerApiKeyEnvVars, resolveProviderApiKeyFromEnv, formatModelLine, getPrimaryModelLimits, findModelInRegistry, validateRouteTarget, getTargetKey } from "../src/display.ts";
import type { ModelDisplayInfo } from "../src/display.ts";
import type { RouteTarget, RoutingHints } from "../src/types.ts";

describe("parseModelSpec", () => {
  it("parses valid provider/modelId", () => {
    const result = parseModelSpec("openai/gpt-4");
    assert.ok(result);
    assert.equal(result!.provider, "openai");
    assert.equal(result!.modelId, "gpt-4");
  });

  it("parses with nested model IDs", () => {
    const result = parseModelSpec("nvidia/deepseek-ai/deepseek-v3.2");
    assert.ok(result);
    assert.equal(result!.provider, "nvidia");
    assert.equal(result!.modelId, "deepseek-ai/deepseek-v3.2");
  });

  it("returns null for no slash", () => {
    assert.equal(parseModelSpec("just-a-model"), null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseModelSpec(""), null);
  });

  it("returns null for URLs", () => {
    assert.equal(parseModelSpec("https://example.com/model"), null);
  });

  it("returns null for trailing slash", () => {
    assert.equal(parseModelSpec("provider/"), null);
  });

  it("returns null for leading slash", () => {
    assert.equal(parseModelSpec("/model"), null);
  });
});

describe("describeTarget", () => {
  it("describes a valid target", () => {
    const t: RouteTarget = { provider: "claude", modelId: "opus-4", label: "Claude Opus 4" };
    assert.equal(describeTarget(t), "Claude Opus 4 [claude/opus-4]");
  });

  it("falls back to provider/model when no label", () => {
    const t: RouteTarget = { provider: "gemini", modelId: "pro", label: "" };
    assert.ok(describeTarget(t).includes("gemini/pro"));
  });

  it("handles null", () => {
    assert.equal(describeTarget(null), "(none)");
  });

  it("handles undefined", () => {
    assert.equal(describeTarget(undefined), "(none)");
  });
});

describe("formatHintsHuman", () => {
  it("formats tier override", () => {
    const hints: RoutingHints = { tierOverride: "reasoning" };
    assert.equal(formatHintsHuman(hints), "tier→reasoning");
  });

  it("formats constraint overrides", () => {
    const hints: RoutingHints = { forceReasoning: true, forceVision: true, forceMinContext: 100000 };
    assert.ok(formatHintsHuman(hints).includes("reasoning"));
    assert.ok(formatHintsHuman(hints).includes("vision"));
    assert.ok(formatHintsHuman(hints).includes("ctx≥100000"));
  });

  it("formats provider hints", () => {
    const hints: RoutingHints = {
      requireProvider: "claude",
      preferProviders: ["claude", "gemini"],
      excludeProviders: ["deepseek"],
    };
    const result = formatHintsHuman(hints);
    assert.ok(result.includes("require=claude"));
    assert.ok(result.includes("prefer=[claude,gemini]"));
    assert.ok(result.includes("exclude=[deepseek]"));
  });

  it("formats billing enforcement", () => {
    const hints: RoutingHints = { enforceBilling: "per-token" };
    assert.equal(formatHintsHuman(hints), "billing=per-token");
  });

  it("returns empty hints placeholder for empty object", () => {
    assert.equal(formatHintsHuman({}), "(empty hints)");
  });
});

describe("formatRemainingMs", () => {
  it("formats seconds", () => {
    assert.equal(formatRemainingMs(30_000), "30s");
    assert.equal(formatRemainingMs(1_000), "1s");
    assert.equal(formatRemainingMs(500), "1s"); // min 1s
  });

  it("formats minutes", () => {
    assert.equal(formatRemainingMs(120_000), "2m");
    assert.equal(formatRemainingMs(60_000), "1m");
  });

  it("formats hours", () => {
    assert.equal(formatRemainingMs(3_600_000), "1h");
    assert.equal(formatRemainingMs(7_200_000), "2h");
  });

  it("formats days", () => {
    const oneDay = 24 * 60 * 60_000;
    assert.equal(formatRemainingMs(oneDay), "1d");
    assert.equal(formatRemainingMs(oneDay * 2), "2d");
  });
});

describe("parseResetAfterMs", () => {
  it("parses seconds", () => {
    assert.equal(parseResetAfterMs("reset after 30 seconds"), 30_000);
  });

  it("parses minutes", () => {
    assert.equal(parseResetAfterMs("reset after 5 minutes"), 5 * 60_000);
  });

  it("parses hours", () => {
    assert.equal(parseResetAfterMs("reset after 2 hours"), 2 * 60 * 60_000);
  });

  it("parses abbreviated units", () => {
    assert.equal(parseResetAfterMs("reset after 10s"), 10_000);
    assert.equal(parseResetAfterMs("reset after 3m"), 3 * 60_000);
    assert.equal(parseResetAfterMs("reset after 1h"), 60 * 60_000);
    assert.equal(parseResetAfterMs("reset after 1d"), 24 * 60 * 60_000);
  });

  it("returns undefined for no match", () => {
    assert.equal(parseResetAfterMs("some random error"), undefined);
    assert.equal(parseResetAfterMs(""), undefined);
  });

  it("returns undefined for invalid values", () => {
    assert.equal(parseResetAfterMs("reset after -1s"), undefined);
    assert.equal(parseResetAfterMs("reset after 0s"), undefined);
  });
});

describe("getCooldownMs", () => {
  it("detects rate limit / 429 / throttled", () => {
    assert.equal(getCooldownMs("429 Too Many Requests"), 2 * 60_000);
    assert.equal(getCooldownMs("rate limit exceeded"), 2 * 60_000);
    assert.equal(getCooldownMs("Request throttled"), 2 * 60_000);
  });

  it("detects throttled variants", () => {
    assert.equal(getCooldownMs("Throttled"), 2 * 60_000);
    assert.equal(getCooldownMs("API request throttled, try again later"), 2 * 60_000);
  });

  it("detects quota / capacity / overload", () => {
    assert.equal(getCooldownMs("quota exceeded"), 5 * 60_000);
    assert.equal(getCooldownMs("service overloaded"), 5 * 60_000);
    assert.equal(getCooldownMs("503 Service Unavailable"), 5 * 60_000);
  });

  it("detects not found / model unavailable", () => {
    assert.equal(getCooldownMs("404 Not Found"), 60 * 60_000);
    assert.equal(getCooldownMs("model not available"), 60 * 60_000);
  });

  it("detects bad request / context length", () => {
    assert.equal(getCooldownMs("400 Bad Request"), 30_000);
    assert.equal(getCooldownMs("maximum context length exceeded"), 30_000);
  });

  it("detects quota exhaustion (hit your limit / credits)", () => {
    assert.equal(getCooldownMs("You've hit your limit"), 30 * 60_000);
    assert.equal(getCooldownMs("credits exhausted"), 30 * 60_000);
    assert.equal(getCooldownMs("insufficient balance"), 30 * 60_000);
  });

  it("uses explicit reset-after when available", () => {
    const ms = getCooldownMs("rate limit hit, reset after 30 seconds");
    assert.equal(ms, 30_000 + 5_000);
  });

  it("uses clock reset for 'resets 8pm' messages", () => {
    // This computes today's 8pm, hard to assert exact ms. Just verify > 0 and > 30min default
    const ms = getCooldownMs("You've hit your limit · resets 8pm (America/Los_Angeles)");
    assert.ok(ms > 30 * 60_000); // should be longer than the 30min fallback
  });

  it("defaults to 90s for unknown errors", () => {
    assert.equal(getCooldownMs("something went wrong"), 90_000);
  });
});

describe("parseClockResetMs", () => {
  it("parses 'resets 8pm' pattern", () => {
    const ms = parseClockResetMs("You've hit your limit · resets 8pm (America/Los_Angeles)");
    assert.ok(typeof ms === "number" && ms > 0);
    // Should be less than 24 hours (next 8pm today or tomorrow)
    assert.ok(ms < 24 * 60 * 60_000);
  });

  it("parses 'resets 11:30am' with minutes", () => {
    const ms = parseClockResetMs("rate limited, resets 11:30am");
    assert.ok(typeof ms === "number" && ms > 0);
    assert.ok(ms < 24 * 60 * 60_000);
  });

  it("parses 'resets 12am' (midnight)", () => {
    const ms = parseClockResetMs("quota exhausted, resets 12am");
    assert.ok(typeof ms === "number" && ms > 0);
    assert.ok(ms < 24 * 60 * 60_000);
  });

  it("parses 'resets 12pm' (noon)", () => {
    const ms = parseClockResetMs("resets 12pm UTC");
    assert.ok(typeof ms === "number" && ms > 0);
    assert.ok(ms < 24 * 60 * 60_000);
  });

  it("returns undefined for non-clock messages", () => {
    assert.equal(parseClockResetMs("rate limit exceeded"), undefined);
    assert.equal(parseClockResetMs("429 Too Many Requests"), undefined);
    assert.equal(parseClockResetMs(""), undefined);
  });

  it("returns undefined for invalid hour values", () => {
    assert.equal(parseClockResetMs("resets 13pm"), undefined);
    assert.equal(parseClockResetMs("resets 0pm"), undefined);
  });
});

describe("normalizeModelToken", () => {
  it("lowercases and removes non-alphanumeric", () => {
    assert.equal(normalizeModelToken("GPT-4"), "gpt4");
    assert.equal(normalizeModelToken("Claude Opus 4.6"), "claudeopus46");
  });

  it("strips cloud/latest/instruct tags", () => {
    assert.equal(normalizeModelToken("glm-5.1:cloud"), "glm51");
    assert.equal(normalizeModelToken("model:latest"), "model");
    assert.equal(normalizeModelToken("llama:instruct"), "llama");
  });

  it("handles empty input", () => {
    assert.equal(normalizeModelToken(""), "");
  });

  it("handles already clean input", () => {
    assert.equal(normalizeModelToken("gpt4"), "gpt4");
  });
});

describe("findCaseInsensitiveKey", () => {
  const aliases: Record<string, string[]> = {
    "reasoning": ["auto-router/subscription-reasoning"],
    "swe": ["auto-router/subscription-swe"],
    "Claude": ["claude-agent-sdk/claude-opus-4-7"],
  };

  it("finds exact match", () => {
    assert.equal(findCaseInsensitiveKey(aliases, "reasoning"), "reasoning");
  });

  it("finds case-insensitive match", () => {
    assert.equal(findCaseInsensitiveKey(aliases, "REASONING"), "reasoning");
    assert.equal(findCaseInsensitiveKey(aliases, "Reasoning"), "reasoning");
  });

  it("returns key with original casing", () => {
    assert.equal(findCaseInsensitiveKey(aliases, "claude"), "Claude");
  });

  it("returns undefined for no match", () => {
    assert.equal(findCaseInsensitiveKey(aliases, "fast"), undefined);
  });

  it("handles empty string needle", () => {
    assert.equal(findCaseInsensitiveKey(aliases, ""), undefined);
  });

  it("handles undefined needle", () => {
    assert.equal(findCaseInsensitiveKey(aliases, undefined as any), undefined);
  });

  it("returns undefined for empty record", () => {
    assert.equal(findCaseInsensitiveKey({}, "anything"), undefined);
  });
});

describe("providerApiKeyEnvVars", () => {
  it("generates upper-case API key env var for simple provider", () => {
    const vars = providerApiKeyEnvVars("ollama");
    assert.ok(vars.includes("OLLAMA_API_KEY"));
    assert.ok(vars.includes("OLLAMA_KEY"));
  });

  it("generates underscore variant for dashed provider names", () => {
    const vars = providerApiKeyEnvVars("openai-codex");
    assert.ok(vars.includes("OPENAI_CODEX_API_KEY"));
  });
});

describe("resolveProviderApiKeyFromEnv", () => {
  it("returns undefined for providers with no env var set", () => {
    assert.equal(resolveProviderApiKeyFromEnv("nonexistent_provider_xyz"), undefined);
  });

  it("returns key from OLLAMA_API_KEY env var", () => {
    const original = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "test-ollama-key-123";
    try {
      assert.equal(resolveProviderApiKeyFromEnv("ollama"), "test-ollama-key-123");
    } finally {
      if (original !== undefined) process.env.OLLAMA_API_KEY = original;
      else delete process.env.OLLAMA_API_KEY;
    }
  });

  it("returns key from DEEPSEEK_API_KEY env var", () => {
    const original = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-test-deepseek";
    try {
      assert.equal(resolveProviderApiKeyFromEnv("deepseek"), "sk-test-deepseek");
    } finally {
      if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  });
});

const baseModel: ModelDisplayInfo = {
  provider: "testco",
  id: "test-1",
  name: "Test Model 1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 128000,
  cost: { input: 3.0, output: 15.0 },
};

describe("formatModelLine", () => {
  it("formats a model with reasoning + vision capabilities", () => {
    const result = formatModelLine(baseModel, null);
    assert.ok(result.includes("testco/test-1"));
    assert.ok(result.includes("[reasoning, vision]"));
    assert.ok(result.includes("Test Model 1"));
    assert.ok(result.includes("ctx: 200,000"));
    assert.ok(result.includes("max: 128,000"));
    assert.ok(result.includes("$3.00/$15.00"));
    assert.ok(!result.includes("(current)"));
  });

  it("marks current model when provider and id match", () => {
    const result = formatModelLine(baseModel, { provider: "testco", id: "test-1" });
    assert.ok(result.includes("(current)"));
    assert.ok(result.startsWith("testco/test-1 (current)"));
  });

  it("does not mark current when provider differs", () => {
    const result = formatModelLine(baseModel, { provider: "other", id: "test-1" });
    assert.ok(!result.includes("(current)"));
  });

  it("does not mark current when id differs", () => {
    const result = formatModelLine(baseModel, { provider: "testco", id: "other" });
    assert.ok(!result.includes("(current)"));
  });

  it("omits capability label for text-only model without reasoning", () => {
    const model: ModelDisplayInfo = { ...baseModel, reasoning: false, input: ["text"] };
    const result = formatModelLine(model, null);
    assert.ok(!result.includes("["));
    assert.ok(!result.includes("]"));
  });

  it("shows only reasoning for text-only reasoning model", () => {
    const model: ModelDisplayInfo = { ...baseModel, reasoning: true, input: ["text"] };
    const result = formatModelLine(model, null);
    assert.ok(result.includes("[reasoning]"));
    assert.ok(!result.includes("vision"));
  });

  it("shows only vision for non-reasoning image model", () => {
    const model: ModelDisplayInfo = { ...baseModel, reasoning: false, input: ["text", "image"] };
    const result = formatModelLine(model, null);
    assert.ok(result.includes("[vision]"));
    assert.ok(!result.includes("reasoning"));
  });

  it("handles undefined currentModel", () => {
    const result = formatModelLine(baseModel, undefined);
    assert.ok(!result.includes("(current)"));
    assert.ok(result.includes("testco/test-1"));
  });

  it("formats costs with toFixed(2)", () => {
    const model: ModelDisplayInfo = { ...baseModel, cost: { input: 0.5, output: 2 } };
    const result = formatModelLine(model, null);
    assert.ok(result.includes("$0.50/$2.00"));
  });

  it("formats large context windows", () => {
    const model: ModelDisplayInfo = { ...baseModel, contextWindow: 1000000 };
    const result = formatModelLine(model, null);
    assert.ok(result.includes("ctx: 1,000,000"));
  });
});

describe("getPrimaryModelLimits", () => {
  const noModel = (_p: string, _m: string) => undefined;
  const model200k = (p: string, m: string) => p === "test" ? { contextWindow: 200000, maxTokens: 64000 } : undefined;

  it("uses route explicit limits when both set", () => {
    const result = getPrimaryModelLimits(
      { contextWindow: 128000, maxTokens: 32000 },
      noModel,
    );
    assert.equal(result.contextWindow, 128000);
    assert.equal(result.maxTokens, 32000);
  });

  it("falls back to first target model lookup", () => {
    const result = getPrimaryModelLimits(
      { targets: [{ provider: "test", modelId: "m1" }] },
      model200k,
    );
    assert.equal(result.contextWindow, 200000);
    assert.equal(result.maxTokens, 64000);
  });

  it("remaps claude-agent-sdk to anthropic for model lookup", () => {
    const antModel = (p: string, _m: string) => p === "anthropic" ? { contextWindow: 500000, maxTokens: 128000 } : undefined;
    const result = getPrimaryModelLimits(
      { targets: [{ provider: "claude-agent-sdk", modelId: "claude-opus" }] },
      antModel,
    );
    assert.equal(result.contextWindow, 500000);
  });

  it("returns defaults when no targets present", () => {
    const result = getPrimaryModelLimits({ targets: [] }, noModel);
    assert.equal(result.contextWindow, 200000);
    assert.equal(result.maxTokens, 128000);
  });

  it("returns defaults when model lookup returns undefined", () => {
    const result = getPrimaryModelLimits(
      { targets: [{ provider: "unknown", modelId: "none" }] },
      noModel,
    );
    assert.equal(result.contextWindow, 200000);
    assert.equal(result.maxTokens, 128000);
  });

  it("returns defaults when model lookup throws", () => {
    const throwing = (_p: string, _m: string) => { throw new Error("boom"); };
    const result = getPrimaryModelLimits(
      { targets: [{ provider: "test", modelId: "m" }] },
      throwing,
    );
    assert.equal(result.contextWindow, 200000);
    assert.equal(result.maxTokens, 128000);
  });
});

describe("findModelInRegistry", () => {
  const models: Array<{ provider: string; id: string; name?: string }> = [
    { provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai-codex", id: "gpt-5-high", name: "GPT-5 High" },
    { provider: "openai-codex", id: "gpt-5-high:instruct", name: "GPT-5 High (Instruct)" },
    { provider: "google-gemini-cli", id: "gemini-3.2-pro", name: "Gemini 3.2 Pro" },
  ];

  it("finds exact match by provider + id", () => {
    const found = findModelInRegistry(models, "anthropic", "claude-opus-4-7");
    assert.ok(found);
    assert.equal(found!.id, "claude-opus-4-7");
  });

  it("finds by tail match after slash", () => {
    const found = findModelInRegistry(models, "anthropic", "anthropic/claude-opus-4-7");
    assert.ok(found);
    assert.equal(found!.id, "claude-opus-4-7");
  });

  it("finds by normalized token (strips :instruct suffix)", () => {
    const found = findModelInRegistry(models, "openai-codex", "gpt5high");
    assert.ok(found);
    assert.equal(found!.id, "gpt-5-high");
  });

  it("finds with partial name match as fallback", () => {
    const found = findModelInRegistry(models, "openai-codex", "gpt5");
    assert.ok(found);
    assert.equal(found!.id, "gpt-5-high");
  });

  it("finds with case-insensitive matching", () => {
    const found = findModelInRegistry(models, "ANTHROPIC", "Claude-Sonnet-4-6");
    assert.ok(found);
    assert.equal(found!.id, "claude-sonnet-4-6");
  });

  it("falls back to global search when provider doesn't match", () => {
    const found = findModelInRegistry(models, "deepseek", "gpt-5-high");
    assert.ok(found);
    assert.equal(found!.provider, "openai-codex");
  });

  it("returns undefined for non-existent model", () => {
    const found = findModelInRegistry(models, "anthropic", "nonexistent-model");
    assert.equal(found, undefined);
  });

  it("returns undefined for empty available list", () => {
    const found = findModelInRegistry([], "anthropic", "claude-opus-4-7");
    assert.equal(found, undefined);
  });

  it("returns undefined for empty modelId", () => {
    const found = findModelInRegistry(models, "anthropic", "");
    assert.equal(found, undefined);
  });
});

describe("validateRouteTarget", () => {
  it("rejects null and non-objects", () => {
    assert.equal(validateRouteTarget(null), false);
    assert.equal(validateRouteTarget(undefined), false);
    assert.equal(validateRouteTarget("string"), false);
  });

  it("rejects objects with empty provider/modelId/label", () => {
    assert.equal(validateRouteTarget({ provider: "", modelId: "m", label: "L" }), false);
    assert.equal(validateRouteTarget({ provider: "p", modelId: "", label: "L" }), false);
    assert.equal(validateRouteTarget({ provider: "p", modelId: "m", label: "" }), false);
  });

  it("rejects whitespace-only strings", () => {
    assert.equal(validateRouteTarget({ provider: "  ", modelId: "m", label: "L" }), false);
  });

  it("rejects invalid billing values", () => {
    const base = { provider: "p", modelId: "m", label: "L" };
    assert.equal(validateRouteTarget({ ...base, billing: "hourly" }), false);
    assert.equal(validateRouteTarget({ ...base, billing: 123 }), false);
  });

  it("rejects non-string authProvider", () => {
    assert.equal(validateRouteTarget({ provider: "p", modelId: "m", label: "L", authProvider: 123 }), false);
  });

  it("rejects non-string balanceEndpoint", () => {
    assert.equal(validateRouteTarget({ provider: "p", modelId: "m", label: "L", balanceEndpoint: true }), false);
  });

  it("accepts minimal valid target", () => {
    assert.equal(validateRouteTarget({ provider: "p", modelId: "m", label: "L" }), true);
  });

  it("accepts target with billing subscription", () => {
    assert.equal(validateRouteTarget({ provider: "p", modelId: "m", label: "L", billing: "subscription" }), true);
  });

  it("accepts target with billing per-token", () => {
    assert.equal(validateRouteTarget({ provider: "p", modelId: "m", label: "L", billing: "per-token" }), true);
  });
});

describe("getTargetKey", () => {
  it("formats unscoped key with provider/modelId", () => {
    assert.equal(getTargetKey({ provider: "claude-agent-sdk", modelId: "claude-opus" }), "claude-agent-sdk/claude-opus");
  });

  it("formats route-scoped key", () => {
    assert.equal(
      getTargetKey({ provider: "openai-codex", modelId: "gpt-5-high" }, "subscription-reasoning"),
      "subscription-reasoning:openai-codex/gpt-5-high",
    );
  });

  it("returns unknown/unknown for null target", () => {
    assert.equal(getTargetKey(null), "unknown/unknown");
  });

  it("returns unknown/unknown for undefined target", () => {
    assert.equal(getTargetKey(undefined), "unknown/unknown");
  });

  it("uses 'unknown' for missing provider or modelId", () => {
    assert.equal(getTargetKey({ provider: "", modelId: "m" }), "unknown/m");
    assert.equal(getTargetKey({ provider: "p" }), "p/unknown");
  });
});
