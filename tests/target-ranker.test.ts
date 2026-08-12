import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareTargets } from "../src/target-ranker.ts";
import type { RouteTarget } from "../src/types.ts";

const targets: RouteTarget[] = [
  { provider: "first", modelId: "model", label: "First" },
  { provider: "second", modelId: "model", label: "Second" },
];

function rank(
  latencies: Record<string, number | null>,
  costs: Record<string, number | null>,
  preferredProviders?: ReadonlySet<string>,
): string[] {
  const configOrder = new Map(targets.map((target, index) => [target.provider, index]));
  return [...targets]
    .sort((a, b) => compareTargets(a, b, {
      getLatency: (target) => latencies[target.provider] ?? null,
      getCost: (target) => costs[target.provider] ?? null,
      getConfigIndex: (target) => configOrder.get(target.provider)!,
      preferredProviders,
    }))
    .map((target) => target.provider);
}

describe("compareTargets", () => {
  it("prefers lower latency when both values are known", () => {
    assert.deepEqual(rank({ first: 200, second: 100 }, { first: 1, second: 2 }), ["second", "first"]);
  });

  it("falls through to cost when only one latency is known", () => {
    assert.deepEqual(rank({ first: 100, second: null }, { first: 2, second: 1 }), ["second", "first"]);
  });

  it("falls through to cost when both latencies are unknown", () => {
    assert.deepEqual(rank({ first: null, second: null }, { first: 2, second: 1 }), ["second", "first"]);
  });

  it("uses config order when latency and cost are tied", () => {
    assert.deepEqual(rank({ first: 100, second: 100 }, { first: 1, second: 1 }), ["first", "second"]);
    assert.deepEqual(rank({ first: null, second: null }, { first: null, second: null }), ["first", "second"]);
  });

  it("keeps preferred providers ahead while applying normal tie-breakers within each group", () => {
    const preferred = new Set(["second"]);
    assert.deepEqual(rank({ first: 10, second: null }, { first: 0, second: 10 }, preferred), ["second", "first"]);
  });
});
