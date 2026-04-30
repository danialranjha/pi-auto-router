import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditBudget, auditUsd, applyUtilization } from "../src/budget-auditor.ts";
import type { UVIStatus, UtilizationSnapshot } from "../src/types.ts";

function snap(provider: string, status: UVIStatus, uvi: number): UtilizationSnapshot {
  return { provider, status, uvi, windows: [], reason: `${status} (test)`, fetchedAt: 1 };
}

describe("auditBudget", () => {
  it("allows providers with no configured limit", () => {
    const result = auditBudget("openai-codex", { dailySpend: {}, dailyLimit: {} });
    assert.equal(result.status, "ok");
    assert.equal(result.limit, null);
  });

  it("allows spend below 80%", () => {
    const result = auditBudget("openai-codex", { dailySpend: { "openai-codex": 1 }, dailyLimit: { "openai-codex": 10 } });
    assert.equal(result.status, "ok");
    assert.equal(result.remaining, 9);
  });

  it("warns at 80%+", () => {
    const result = auditBudget("openai-codex", { dailySpend: { "openai-codex": 8 }, dailyLimit: { "openai-codex": 10 } });
    assert.equal(result.status, "warning");
    assert.match(result.message ?? "", /near its daily budget/);
  });

  it("blocks at or above 100%", () => {
    const result = auditBudget("openai-codex", { dailySpend: { "openai-codex": 10 }, dailyLimit: { "openai-codex": 10 } });
    assert.equal(result.status, "blocked");
    assert.match(result.message ?? "", /at or above its daily budget/);
  });

  it("uses projected spend when additional cost is provided", () => {
    const result = auditBudget("openai-codex", { dailySpend: { "openai-codex": 7.9 }, dailyLimit: { "openai-codex": 10 } }, 0.2);
    assert.equal(result.status, "warning");
  });

  it("blocks when UVI is critical even without USD limit", () => {
    const result = auditBudget("anthropic", {
      dailySpend: {},
      dailyLimit: {},
      utilization: { anthropic: snap("anthropic", "critical", 2.4) },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.uvi, 2.4);
    assert.equal(result.utilizationStatus, "critical");
  });

  it("warns and emits demote hint when UVI is stressed", () => {
    const result = auditBudget("anthropic", {
      dailySpend: {},
      dailyLimit: {},
      utilization: { anthropic: snap("anthropic", "stressed", 1.7) },
    });
    assert.equal(result.status, "warning");
    assert.equal(result.hint, "demote");
    assert.equal(result.utilizationStatus, "stressed");
  });

  it("emits promote hint when UVI is surplus", () => {
    const result = auditBudget("openai-codex", {
      dailySpend: {},
      dailyLimit: {},
      utilization: { "openai-codex": snap("openai-codex", "surplus", 0.3) },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.hint, "promote");
    assert.equal(result.utilizationStatus, "surplus");
  });

  it("UVI critical overrides USD-ok status", () => {
    const result = auditBudget("anthropic", {
      dailySpend: { anthropic: 1 },
      dailyLimit: { anthropic: 10 },
      utilization: { anthropic: snap("anthropic", "critical", 2.5) },
    });
    assert.equal(result.status, "blocked");
  });

  it("USD blocked stays blocked with no UVI", () => {
    const result = auditBudget("openai-codex", {
      dailySpend: { "openai-codex": 10 },
      dailyLimit: { "openai-codex": 10 },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.hint, undefined);
  });
});

describe("auditUsd", () => {
  it("returns ok with null limit when no limits configured", () => {
    const result = auditUsd("test-provider", { dailySpend: {}, dailyLimit: {} }, 0);
    assert.equal(result.status, "ok");
    assert.equal(result.limit, null);
    assert.equal(result.remaining, null);
  });

  it("prefers monthly limit over daily for per-token providers", () => {
    const result = auditUsd("deepseek", {
      dailySpend: {},
      dailyLimit: { deepseek: 50 },
      monthlySpend: { deepseek: 95 },
      monthlyLimit: { deepseek: 100 },
    }, 0);
    assert.equal(result.status, "warning");
    assert.equal(result.budgetType, "monthly");
    assert.equal(result.limit, 100);
  });

  it("warns at exactly 80% of daily limit", () => {
    const result = auditUsd("prov", {
      dailySpend: { prov: 8 },
      dailyLimit: { prov: 10 },
    }, 0);
    assert.equal(result.status, "warning");
  });

  it("blocks when projected exceeds daily limit", () => {
    const result = auditUsd("prov", {
      dailySpend: { prov: 9.5 },
      dailyLimit: { prov: 10 },
    }, 1);
    assert.equal(result.status, "blocked");
  });

  it("handles zero limit gracefully", () => {
    const result = auditUsd("prov", {
      dailySpend: {},
      dailyLimit: { prov: 0 },
    }, 0);
    assert.equal(result.status, "ok");
    assert.equal(result.limit, null);
  });

  it("handles missing spend for provider with limit", () => {
    const result = auditUsd("prov", {
      dailySpend: {},
      dailyLimit: { prov: 10 },
    }, 0);
    assert.equal(result.status, "ok");
    assert.equal(result.spend, 0);
  });
});

describe("applyUtilization", () => {
  it("returns base unchanged when util is undefined", () => {
    const base = { status: "ok" as const, provider: "p", spend: 0, limit: null, remaining: null, usageRatio: null };
    const result = applyUtilization(base, undefined, "p");
    assert.equal(result.status, "ok");
  });

  it("sets blocked status for critical UVI", () => {
    const base = { status: "ok" as const, provider: "p", spend: 0, limit: null, remaining: null, usageRatio: null };
    const result = applyUtilization(base, snap("p", "critical", 2.5), "p");
    assert.equal(result.status, "blocked");
    assert.equal(result.uvi, 2.5);
    assert.equal(result.utilizationStatus, "critical");
  });

  it("sets promote hint for surplus UVI", () => {
    const base = { status: "ok" as const, provider: "p", spend: 0, limit: null, remaining: null, usageRatio: null };
    const result = applyUtilization(base, snap("p", "surplus", 0.3), "p");
    assert.equal(result.hint, "promote");
  });

  it("preserves existing warning status with stressed UVI", () => {
    const base = { status: "warning" as const, provider: "p", spend: 0, limit: 10, remaining: 2, usageRatio: 0.8 };
    const result = applyUtilization(base, snap("p", "stressed", 1.5), "p");
    assert.equal(result.status, "warning");
    assert.equal(result.hint, "demote");
  });
});
