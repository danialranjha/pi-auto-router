import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { partitionAuditedCandidates } from "../src/candidate-partitioner.ts";
import type { BudgetState, RouteTarget, UVIStatus, UtilizationSnapshot } from "../src/types.ts";

function target(provider: string, label = provider): RouteTarget {
  return { provider, modelId: `${provider}-model`, label };
}

function snap(provider: string, status: UVIStatus, uvi: number): UtilizationSnapshot {
  return { provider, status, uvi, windows: [], reason: `${status} (test)`, fetchedAt: 1 };
}

describe("partitionAuditedCandidates", () => {
  it("returns empty result when no candidates", () => {
    const result = partitionAuditedCandidates([], { dailySpend: {}, dailyLimit: {} });
    assert.deepEqual(result.ordered, []);
    assert.deepEqual(result.rejections, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.uviNotes, []);
  });

  it("preserves order when no UVI hints apply", () => {
    const a = target("openai-codex", "A");
    const b = target("claude-agent-sdk", "B");
    const c = target("google-gemini-cli", "C");
    const result = partitionAuditedCandidates([a, b, c], { dailySpend: {}, dailyLimit: {} });
    assert.deepEqual(result.ordered, [a, b, c]);
    assert.deepEqual(result.normal, [a, b, c]);
    assert.equal(result.promoted.length, 0);
    assert.equal(result.demoted.length, 0);
  });

  it("orders [promoted, normal, demoted] for mixed UVI hints", () => {
    const a = target("openai-codex", "A");
    const b = target("claude-agent-sdk", "B");
    const c = target("google-gemini-cli", "C");
    const budgetState: BudgetState = {
      dailySpend: {},
      dailyLimit: {},
      utilization: {
        "openai-codex": snap("openai-codex", "stressed", 1.7),
        "google-gemini-cli": snap("google-gemini-cli", "surplus", 0.3),
      },
    };
    const result = partitionAuditedCandidates([a, b, c], budgetState);
    assert.deepEqual(result.ordered, [c, b, a]);
    assert.deepEqual(result.promoted, [c]);
    assert.deepEqual(result.normal, [b]);
    assert.deepEqual(result.demoted, [a]);
  });

  it("excludes blocked candidates and records rejection messages", () => {
    const a = target("openai-codex", "A");
    const b = target("claude-agent-sdk", "B");
    const budgetState: BudgetState = {
      dailySpend: { "openai-codex": 10 },
      dailyLimit: { "openai-codex": 10 },
    };
    const result = partitionAuditedCandidates([a, b], budgetState);
    assert.deepEqual(result.ordered, [b]);
    assert.equal(result.rejections.length, 1);
    assert.match(result.rejections[0], /^A:.*at or above its daily budget/);
  });

  it("collects USD warnings without affecting order", () => {
    const a = target("openai-codex", "A");
    const budgetState: BudgetState = {
      dailySpend: { "openai-codex": 8 },
      dailyLimit: { "openai-codex": 10 },
    };
    const result = partitionAuditedCandidates([a], budgetState);
    assert.deepEqual(result.ordered, [a]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /near its daily budget/);
  });

  it("treats UVI critical as blocked", () => {
    const a = target("openai-codex", "A");
    const b = target("claude-agent-sdk", "B");
    const budgetState: BudgetState = {
      dailySpend: {},
      dailyLimit: {},
      utilization: { "openai-codex": snap("openai-codex", "critical", 2.5) },
    };
    const result = partitionAuditedCandidates([a, b], budgetState);
    assert.deepEqual(result.ordered, [b]);
    assert.equal(result.rejections.length, 1);
    assert.match(result.rejections[0], /A:/);
  });

  it("emits uviNotes for promoted and demoted candidates", () => {
    const a = target("openai-codex", "A");
    const c = target("google-gemini-cli", "C");
    const budgetState: BudgetState = {
      dailySpend: {},
      dailyLimit: {},
      utilization: {
        "openai-codex": snap("openai-codex", "stressed", 1.75),
        "google-gemini-cli": snap("google-gemini-cli", "surplus", 0.25),
      },
    };
    const result = partitionAuditedCandidates([a, c], budgetState);
    assert.equal(result.uviNotes.length, 2);
    assert.ok(result.uviNotes.some((n) => /C promoted \(UVI=0\.25 surplus\)/.test(n)));
    assert.ok(result.uviNotes.some((n) => /A demoted \(UVI=1\.75 stressed\)/.test(n)));
  });

  it("preserves intra-bucket order", () => {
    const a = target("openai-codex", "A");
    const b = target("claude-agent-sdk", "B");
    const c = target("google-gemini-cli", "C");
    const budgetState: BudgetState = {
      dailySpend: {},
      dailyLimit: {},
      utilization: {
        "openai-codex": snap("openai-codex", "surplus", 0.2),
        "claude-agent-sdk": snap("claude-agent-sdk", "surplus", 0.4),
      },
    };
    const result = partitionAuditedCandidates([a, b, c], budgetState);
    assert.deepEqual(result.ordered, [a, b, c]);
    assert.deepEqual(result.promoted, [a, b]);
    assert.deepEqual(result.normal, [c]);
  });
});
