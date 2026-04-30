import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelSpec, describeTarget, formatHintsHuman, formatRemainingMs, parseResetAfterMs, getCooldownMs, normalizeModelToken, providerApiKeyEnvVars, resolveProviderApiKeyFromEnv } from "../src/display.ts";
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
  it("detects rate limit / 429", () => {
    assert.equal(getCooldownMs("429 Too Many Requests"), 2 * 60_000);
    assert.equal(getCooldownMs("rate limit exceeded"), 2 * 60_000);
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

  it("uses explicit reset-after when available", () => {
    const ms = getCooldownMs("rate limit hit, reset after 30 seconds");
    assert.equal(ms, 30_000 + 5_000);
  });

  it("defaults to 90s for unknown errors", () => {
    assert.equal(getCooldownMs("something went wrong"), 90_000);
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
