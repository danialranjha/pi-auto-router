import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderCandidateBuckets, parseRoutingOrder } from "../src/routing-order.ts";
import type { RouteTarget } from "../src/types.ts";

const target = (provider: string): RouteTarget => ({ provider, modelId: "model", label: provider });
const names = (targets: RouteTarget[]) => targets.map(({ provider }) => provider);

describe("parseRoutingOrder", () => {
  it("defaults to adaptive and accepts only implemented modes", () => {
    assert.equal(parseRoutingOrder(undefined), "adaptive");
    assert.equal(parseRoutingOrder("adaptive"), "adaptive");
    assert.equal(parseRoutingOrder("config"), "config");
  });

  it("rejects unsupported latency and cost modes", () => {
    assert.throws(() => parseRoutingOrder("latency"), /adaptive.*config/);
    assert.throws(() => parseRoutingOrder("cost"), /adaptive.*config/);
  });
});

describe("orderCandidateBuckets", () => {
  const reverse = (a: RouteTarget, b: RouteTarget) => b.provider.localeCompare(a.provider);

  it("keeps config order inside each UVI bucket without crossing buckets", () => {
    const buckets = {
      promoted: [target("a"), target("b")],
      normal: [target("c"), target("d")],
      demoted: [target("e"), target("f")],
    };
    orderCandidateBuckets(buckets, { mode: "config", rankedCompare: reverse });
    assert.deepEqual([
      ...names(buckets.promoted),
      ...names(buckets.normal),
      ...names(buckets.demoted),
    ], ["a", "b", "c", "d", "e", "f"]);
  });

  it("keeps adaptive ordering as the default behavior", () => {
    const buckets = { promoted: [target("a"), target("b")], normal: [target("c"), target("d")], demoted: [] };
    orderCandidateBuckets(buckets, { mode: parseRoutingOrder(undefined), rankedCompare: reverse });
    assert.deepEqual(names(buckets.promoted), ["b", "a"]);
    assert.deepEqual(names(buckets.normal), ["d", "c"]);
  });

  it("lets requireProvider override config order and promotes a demoted requirement to normal", () => {
    const buckets = { promoted: [target("a"), target("b")], normal: [target("c")], demoted: [target("required"), target("e")] };
    orderCandidateBuckets(buckets, { mode: "config", rankedCompare: reverse, requireProvider: "required" });
    assert.deepEqual(names(buckets.promoted), ["a", "b"]);
    assert.deepEqual(names(buckets.normal), ["required", "c"]);
    assert.deepEqual(names(buckets.demoted), ["e"]);
  });

  it("ignores preferProviders in config mode to retain declared order", () => {
    const buckets = { promoted: [], normal: [target("first"), target("preferred")], demoted: [] };
    orderCandidateBuckets(buckets, {
      mode: "config",
      rankedCompare: reverse,
      preferredCompare: (a, b) => Number(b.provider === "preferred") - Number(a.provider === "preferred"),
      preferProviders: ["preferred"],
    });
    assert.deepEqual(names(buckets.normal), ["first", "preferred"]);
  });

  it("applies preferProviders within non-demoted buckets in adaptive mode", () => {
    const preferredFirst = (a: RouteTarget, b: RouteTarget) => Number(b.provider === "preferred") - Number(a.provider === "preferred");
    const buckets = { promoted: [], normal: [target("first"), target("preferred")], demoted: [target("other"), target("preferred")] };
    orderCandidateBuckets(buckets, {
      mode: "adaptive",
      rankedCompare: () => 0,
      preferredCompare: preferredFirst,
      preferProviders: ["preferred"],
    });
    assert.deepEqual(names(buckets.normal), ["preferred", "first"]);
    assert.deepEqual(names(buckets.demoted), ["other", "preferred"]);
  });
});
