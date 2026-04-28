import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { solveConstraints, type CapabilityMap } from "../src/constraint-solver.ts";
import { partitionAuditedCandidates } from "../src/candidate-partitioner.ts";
import type { BudgetState, RouteTarget, RoutingContext } from "../src/types.ts";

const t1: RouteTarget = { provider: "fast-cheap", modelId: "fast-1", label: "FastCheap" };
const t2: RouteTarget = { provider: "slow-expensive", modelId: "slow-1", label: "SlowExp" };
const t3: RouteTarget = { provider: "vision-only", modelId: "vis-1", label: "Vision" };
const t4: RouteTarget = { provider: "over-budget", modelId: "budget-1", label: "OverBudget" };

const baseCtx: RoutingContext = {
  prompt: "test",
  history: [],
  routeId: "test-route",
  estimatedTokens: 1000,
  classification: "medium",
  availableTargets: [t1, t2, t3, t4],
};

const allCaps: CapabilityMap = { vision: true, reasoning: true, contextWindow: 200000, maxTokens: 32000 };

function caps(t: RouteTarget): CapabilityMap | undefined {
  if (t.provider === "vision-only") return { vision: true, contextWindow: 200000, maxTokens: 32000 };
  if (t.provider === "fast-cheap") return allCaps;
  if (t.provider === "slow-expensive") return allCaps;
  if (t.provider === "over-budget") return allCaps;
  return undefined;
}

describe("Pipeline integration: constraint solver → budget auditor → partitioner", () => {
  it("passes all candidates through when no constraints or budgets", () => {
    const solved = solveConstraints(baseCtx, { capabilities: caps });
    assert.equal(solved.candidates.length, 4);
    assert.equal(solved.rejections.length, 0);

    const partition = partitionAuditedCandidates(solved.candidates, undefined);
    assert.equal(partition.rejections.length, 0);
    assert.equal(partition.ordered.length, 4);
  });

  it("filters by vision requirement, then partitions", () => {
    // Only fast-cheap and vision-only have vision in this custom lookup
    const customCaps = (t: RouteTarget): CapabilityMap | undefined => {
      if (t.provider === "fast-cheap") return allCaps;
      if (t.provider === "vision-only") return { vision: true, contextWindow: 200000, maxTokens: 32000 };
      // slow-expensive and over-budget explicitly lack vision
      return { vision: false, reasoning: true, contextWindow: 200000, maxTokens: 32000 };
    };
    const solved = solveConstraints(baseCtx, {
      requirements: { vision: true },
      capabilities: customCaps,
    });
    assert.equal(solved.candidates.length, 2); // FastCheap + Vision
    assert.equal(solved.rejections.length, 2); // SlowExp + OverBudget rejected

    const partition = partitionAuditedCandidates(solved.candidates, undefined);
    assert.equal(partition.ordered.length, 2);
  });

  it("blocks candidates over daily budget", () => {
    const budget: BudgetState = {
      dailySpend: { "slow-expensive": 9, "over-budget": 12 },
      dailyLimit: { "slow-expensive": 10, "over-budget": 10 },
    };
    const solved = solveConstraints(baseCtx, { capabilities: caps });
    assert.equal(solved.candidates.length, 4);

    const partition = partitionAuditedCandidates(solved.candidates, budget);
    // slow-expensive: spend 9/10 = 90% → warning, not blocked
    // over-budget: spend 12/10 = 120% → blocked
    assert.equal(partition.rejections.length, 1);
    assert.ok(partition.rejections[0].includes("OverBudget"));
    assert.equal(partition.warnings.length, 1);
    assert.ok(partition.warnings[0].includes("slow-expensive") || partition.warnings[0].includes("SlowExp"), `expected warning to mention slow-expensive, got: ${partition.warnings[0]}`);
    assert.equal(partition.ordered.length, 3); // OverBudget removed
  });

  it("promotes surplus UVI providers and demotes stressed ones", () => {
    const budget: BudgetState = {
      dailySpend: {},
      dailyLimit: {},
      utilization: {
        "fast-cheap": {
          provider: "fast-cheap",
          uvi: 0.3,
          status: "surplus",
          windows: [],
          reason: "underutilized",
          fetchedAt: Date.now(),
        },
        "slow-expensive": {
          provider: "slow-expensive",
          uvi: 1.7,
          status: "stressed",
          windows: [],
          reason: "burning fast",
          fetchedAt: Date.now(),
        },
      },
    };
    const solved = solveConstraints(baseCtx, { capabilities: caps });
    const partition = partitionAuditedCandidates(solved.candidates, budget);

    // FastCheap should be in promoted, SlowExp in demoted
    assert.equal(partition.promoted.length, 1);
    assert.equal(partition.promoted[0].provider, "fast-cheap");
    assert.equal(partition.demoted.length, 1);
    assert.equal(partition.demoted[0].provider, "slow-expensive");
    // Order: promoted, normal, demoted
    assert.equal(partition.ordered[0].provider, "fast-cheap");
    assert.equal(partition.ordered[partition.ordered.length - 1].provider, "slow-expensive");
  });

  it("hard mode excludes demoted providers from ordered list", () => {
    const budget: BudgetState = {
      dailySpend: {},
      dailyLimit: {},
      utilization: {
        "slow-expensive": {
          provider: "slow-expensive",
          uvi: 1.7,
          status: "stressed",
          windows: [],
          reason: "burning fast",
          fetchedAt: Date.now(),
        },
      },
    };
    const solved = solveConstraints(baseCtx, { capabilities: caps });
    const partition = partitionAuditedCandidates(solved.candidates, budget, { hardMode: true });

    assert.equal(partition.demoted.length, 1);
    // In hard mode, ordered excludes demoted
    assert.equal(partition.ordered.length, 3);
    const providers = partition.ordered.map((t) => t.provider);
    assert.ok(!providers.includes("slow-expensive"));
  });

  it("filters by cooldown then partitions remaining", () => {
    const solved = solveConstraints(baseCtx, {
      capabilities: caps,
      isOnCooldown: (t) => t.provider === "vision-only",
    });
    assert.equal(solved.rejections.length, 1);
    assert.equal(solved.rejections[0].reason, "on cooldown");
    assert.equal(solved.candidates.length, 3);

    const partition = partitionAuditedCandidates(solved.candidates, undefined);
    assert.equal(partition.ordered.length, 3);
  });

  it("handles empty candidate set gracefully", () => {
    const solved = solveConstraints({ ...baseCtx, availableTargets: [] }, { capabilities: caps });
    assert.equal(solved.candidates.length, 0);

    const partition = partitionAuditedCandidates(solved.candidates, undefined);
    assert.equal(partition.ordered.length, 0);
    assert.equal(partition.rejections.length, 0);
  });

  it("blocks critical UVI providers (UVI >= 2.0)", () => {
    const budget: BudgetState = {
      dailySpend: {},
      dailyLimit: {},
      utilization: {
        "fast-cheap": {
          provider: "fast-cheap",
          uvi: 2.5,
          status: "critical",
          windows: [],
          reason: "on track to exhaust",
          fetchedAt: Date.now(),
        },
      },
    };
    const solved = solveConstraints(baseCtx, { capabilities: caps });
    const partition = partitionAuditedCandidates(solved.candidates, budget);

    // FastCheap should be blocked (critical UVI)
    assert.equal(partition.rejections.length, 1);
    assert.ok(partition.rejections[0].includes("FastCheap"));
    assert.ok(partition.rejections[0].includes("UVI critical"));
    assert.equal(partition.ordered.length, 3);
  });

  it("end-to-end: vision filter → budget audit → UVI partition", () => {
    const budget: BudgetState = {
      dailySpend: { "over-budget": 15 },
      dailyLimit: { "over-budget": 10 },
      utilization: {
        "fast-cheap": {
          provider: "fast-cheap",
          uvi: 0.3,
          status: "surplus",
          windows: [],
          reason: "surplus",
          fetchedAt: Date.now(),
        },
        "slow-expensive": {
          provider: "slow-expensive",
          uvi: 2.1,
          status: "critical",
          windows: [],
          reason: "critical",
          fetchedAt: Date.now(),
        },
      },
    };

    // 1. Constraint: no vision requirement, so all pass
    const solved = solveConstraints(baseCtx, { capabilities: caps });
    assert.equal(solved.candidates.length, 4);

    // 2. Budget + UVI:
    //    - over-budget: blocked (spend > limit)
    //    - slow-expensive: blocked (UVI critical)
    //    - fast-cheap: promoted (UVI surplus)
    //    - vision-only: normal
    const partition = partitionAuditedCandidates(solved.candidates, budget);
    assert.equal(partition.rejections.length, 2); // over-budget + slow-expensive
    assert.equal(partition.promoted.length, 1);
    assert.equal(partition.promoted[0].provider, "fast-cheap");
    assert.equal(partition.normal.length, 1);
    assert.equal(partition.normal[0].provider, "vision-only");
    assert.equal(partition.demoted.length, 0);

    // Final order: promoted first, then normal
    assert.equal(partition.ordered[0].provider, "fast-cheap");
    assert.equal(partition.ordered[1].provider, "vision-only");
  });
});
