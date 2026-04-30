import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DecisionLogger, isValidEntry } from "../src/decision-logger.ts";
import type { DecisionLogEntry } from "../src/types.ts";

function tempPath(): string {
  return path.join(os.tmpdir(), `auto-router-decisions-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function makeEntry(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    timestamp: Date.now(),
    routeId: "subscription-reasoning",
    tier: "swe",
    phase: "default",
    provider: "claude-agent-sdk",
    modelId: "claude-opus-4-6",
    targetLabel: "Claude Opus 4.6",
    reasoning: "intent code (85%) → tier=swe | premium budget: 97%",
    estimatedTokens: 4500,
    budgetRemaining: 42.5,
    confidence: 0.75,
    outcome: "success",
    latencyMs: 3200,
    selectedTarget: "Claude Opus 4.6",
    ...overrides,
  };
}

describe("DecisionLogger", () => {
  it("starts empty", () => {
    const l = new DecisionLogger(10_000, tempPath());
    assert.equal(l.count, 0);
    assert.equal(l.getRecent().length, 0);
  });

  it("logs and retrieves entries (newest first)", () => {
    const l = new DecisionLogger(10_000, tempPath());
    l.log(makeEntry({ timestamp: 1000, provider: "provider-a" }));
    l.log(makeEntry({ timestamp: 2000, provider: "provider-b" }));
    l.log(makeEntry({ timestamp: 3000, provider: "provider-c" }));
    assert.equal(l.count, 3);
    const recent = l.getRecent(10);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].provider, "provider-c"); // newest first
    assert.equal(recent[2].provider, "provider-a");
  });

  it("query filters correctly", () => {
    const l = new DecisionLogger(10_000, tempPath());
    l.log(makeEntry({ provider: "claude-agent-sdk", outcome: "success" }));
    l.log(makeEntry({ provider: "openai-codex", outcome: "success" }));
    l.log(makeEntry({ provider: "claude-agent-sdk", outcome: "exhausted" }));
    const onlyClaude = l.query((e) => e.provider === "claude-agent-sdk");
    assert.equal(onlyClaude.length, 2);
    const onlySuccess = l.query((e) => e.outcome === "success");
    assert.equal(onlySuccess.length, 2);
  });

  it("getProviderStats computes correctly", () => {
    const l = new DecisionLogger(10_000, tempPath());
    l.log(makeEntry({ provider: "claude-agent-sdk", outcome: "success", latencyMs: 1000 }));
    l.log(makeEntry({ provider: "claude-agent-sdk", outcome: "success", latencyMs: 3000 }));
    l.log(makeEntry({ provider: "claude-agent-sdk", outcome: "exhausted", latencyMs: 0 }));
    l.log(makeEntry({ provider: "openai-codex", outcome: "success", latencyMs: 2000 }));
    const stats = l.getProviderStats();
    assert.equal(stats["claude-agent-sdk"].attempts, 3);
    assert.equal(stats["claude-agent-sdk"].successes, 2);
    assert.equal(stats["claude-agent-sdk"].failures, 1);
    assert.equal(stats["claude-agent-sdk"].avgLatencyMs, 2000); // (1000+3000)/2
    assert.equal(stats["openai-codex"].attempts, 1);
    assert.equal(stats["openai-codex"].avgLatencyMs, 2000);
  });

  it("getTierStats computes correctly", () => {
    const l = new DecisionLogger(10_000, tempPath());
    l.log(makeEntry({ tier: "swe", outcome: "success", confidence: 0.9 }));
    l.log(makeEntry({ tier: "swe", outcome: "exhausted", confidence: 0.8 }));
    l.log(makeEntry({ tier: "fast", outcome: "success", confidence: 0.5 }));
    const stats = l.getTierStats();
    assert.equal(stats["swe"].count, 2);
    assert.equal(stats["swe"].successRate, 0.5);
    assert.ok(Math.abs(stats["swe"].avgConfidence - 0.85) < 0.0001);
    assert.equal(stats["fast"].count, 1);
    assert.equal(stats["fast"].successRate, 1);
    assert.equal(stats["fast"].avgConfidence, 0.5);
  });

  it("caps at maxEntries", () => {
    const l = new DecisionLogger(5, tempPath());
    for (let i = 0; i < 10; i++) {
      l.log(makeEntry({ timestamp: i }));
    }
    assert.equal(l.count, 5);
    const recent = l.getRecent(10);
    assert.equal(recent.length, 5);
    assert.equal(recent[recent.length - 1].timestamp, 5); // oldest kept
  });

  it("persists and loads across instances", () => {
    const f = tempPath();
    const l1 = new DecisionLogger(10_000, f);
    l1.log(makeEntry({ provider: "persisted-provider", timestamp: 1234 }));
    l1.log(makeEntry({ provider: "persisted-provider2", timestamp: 5678 }));

    const l2 = new DecisionLogger(10_000, f);
    assert.equal(l2.count, 2);
    const recent = l2.getRecent(10);
    assert.equal(recent.length, 2);
    assert.equal(recent[1].provider, "persisted-provider");
    assert.equal(recent[0].provider, "persisted-provider2");
  });

  it("clear removes all entries", () => {
    const l = new DecisionLogger(10_000, tempPath());
    l.log(makeEntry());
    l.log(makeEntry());
    l.clear();
    assert.equal(l.count, 0);
  });

  it("handles corrupt file gracefully", () => {
    const f = tempPath();
    fs.writeFileSync(f, "not json\n{partial\n");
    const l = new DecisionLogger(10_000, f);
    assert.equal(l.count, 0);
  });

  it("logFilePath returns the path", () => {
    const f = tempPath();
    const l = new DecisionLogger(10_000, f);
    assert.equal(l.logFilePath, f);
  });

  it("logBatch writes all entries in one write", () => {
    const f = tempPath();
    const l1 = new DecisionLogger(10_000, f);
    l1.logBatch([
      makeEntry({ provider: "batch-a", timestamp: 1 }),
      makeEntry({ provider: "batch-b", timestamp: 2 }),
      makeEntry({ provider: "batch-c", timestamp: 3 }),
    ]);
    assert.equal(l1.count, 3);

    const l2 = new DecisionLogger(10_000, f);
    assert.equal(l2.count, 3);
  });
});

describe("isValidEntry", () => {
  it("rejects null and non-objects", () => {
    assert.equal(isValidEntry(null), false);
    assert.equal(isValidEntry(undefined), false);
    assert.equal(isValidEntry("string"), false);
    assert.equal(isValidEntry(123), false);
  });

  it("rejects objects missing required string fields", () => {
    assert.equal(isValidEntry({}), false);
    assert.equal(isValidEntry({ routeId: "r" }), false);
  });

  it("rejects invalid outcome values", () => {
    assert.equal(isValidEntry({
      timestamp: 1, routeId: "r", tier: "swe", phase: "solve",
      provider: "p", outcome: "partial_success",
    }), false);
  });

  it("accepts valid entries with any of the three outcomes", () => {
    const base = { timestamp: 1, routeId: "r", tier: "swe", phase: "solve", provider: "p" };
    assert.equal(isValidEntry({ ...base, outcome: "success" }), true);
    assert.equal(isValidEntry({ ...base, outcome: "terminal_error" }), true);
    assert.equal(isValidEntry({ ...base, outcome: "exhausted" }), true);
  });

  it("rejects when timestamp is not a number", () => {
    assert.equal(isValidEntry({
      timestamp: "now", routeId: "r", tier: "swe", phase: "solve",
      provider: "p", outcome: "success",
    }), false);
  });
});
