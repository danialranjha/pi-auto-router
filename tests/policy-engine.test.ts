import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine, makePassthroughDecision, mergeHints, buildStrategyRules } from "../src/policy-engine.ts";
import type { RouteTarget, RoutingContext, RoutingHints, PolicyRuleConfig } from "../src/types.ts";

const target: RouteTarget = { provider: "p", modelId: "m", label: "Lbl" };

const baseCtx: RoutingContext = {
  prompt: "hi",
  history: [],
  routeId: "r",
  estimatedTokens: 10,
  classification: "short",
  availableTargets: [target],
};

describe("PolicyEngine skeleton", () => {
  it("returns null with no rules registered", () => {
    const engine = new PolicyEngine();
    assert.equal(engine.decide(baseCtx), null);
    assert.equal(engine.getLastDecision(), null);
  });

  it("runs rules in priority order (lower runs first)", () => {
    const engine = new PolicyEngine({
      rules: [
        { name: "low", priority: 10, condition: () => true, action: (c) => makePassthroughDecision(target, c, "low") },
        { name: "high", priority: 1, condition: () => true, action: (c) => makePassthroughDecision(target, c, "high") },
      ],
    });
    assert.equal(engine.decide(baseCtx)?.phase, "high");
  });

  it("skips rules whose condition returns false", () => {
    const engine = new PolicyEngine({
      rules: [
        { name: "skip", priority: 1, condition: () => false, action: (c) => makePassthroughDecision(target, c, "skip") },
        { name: "match", priority: 2, condition: () => true, action: (c) => makePassthroughDecision(target, c, "match") },
      ],
    });
    assert.equal(engine.decide(baseCtx)?.phase, "match");
  });

  it("skips rules whose action returns null and falls through", () => {
    const engine = new PolicyEngine({
      rules: [
        { name: "null-action", priority: 1, condition: () => true, action: () => null },
        { name: "match", priority: 2, condition: () => true, action: (c) => makePassthroughDecision(target, c, "match") },
      ],
    });
    assert.equal(engine.decide(baseCtx)?.phase, "match");
  });

  it("records the most recent decision", () => {
    const engine = new PolicyEngine({
      rules: [
        { name: "match", priority: 1, condition: () => true, action: (c) => makePassthroughDecision(target, c, "match") },
      ],
    });
    engine.decide(baseCtx);
    assert.equal(engine.getLastDecision()?.phase, "match");
  });

  it("addRule re-sorts the rule list", () => {
    const engine = new PolicyEngine({
      rules: [
        { name: "late", priority: 100, condition: () => true, action: (c) => makePassthroughDecision(target, c, "late") },
      ],
    });
    engine.addRule({ name: "early", priority: 1, condition: () => true, action: (c) => makePassthroughDecision(target, c, "early") });
    assert.equal(engine.decide(baseCtx)?.phase, "early");
  });

  it("preserves explicit phase from action when provided", () => {
    const engine = new PolicyEngine({
      rules: [
        { name: "rule-name", priority: 1, condition: () => true, action: (c) => makePassthroughDecision(target, c, "explicit-phase") },
      ],
    });
    assert.equal(engine.decide(baseCtx)?.phase, "explicit-phase");
  });

  it("falls back to rule name when action omits phase", () => {
    const engine = new PolicyEngine({
      rules: [
        {
          name: "rule-name",
          priority: 1,
          condition: () => true,
          action: (c) => ({ ...makePassthroughDecision(target, c), phase: "" }),
        },
      ],
    });
    assert.equal(engine.decide(baseCtx)?.phase, "rule-name");
  });

  it("respects shadow mode flag", () => {
    const shadow = new PolicyEngine({ shadowMode: true });
    const live = new PolicyEngine({ shadowMode: false });
    assert.equal(shadow.shadowMode, true);
    assert.equal(live.shadowMode, false);
  });
});

describe("mergeHints", () => {
  it("returns a copy when base is null", () => {
    const hints: RoutingHints = { tierOverride: "fast" };
    const result = mergeHints(null, hints);
    assert.equal(result.tierOverride, "fast");
    assert.notEqual(result, hints); // should be a copy
  });

  it("incoming overrides base for scalar fields", () => {
    const base: RoutingHints = { tierOverride: "economy", forceReasoning: false };
    const incoming: RoutingHints = { tierOverride: "reasoning" };
    const result = mergeHints(base, incoming);
    assert.equal(result.tierOverride, "reasoning");
    assert.equal(result.forceReasoning, false); // preserved from base
  });

  it("incoming overrides base for array fields", () => {
    const base: RoutingHints = { preferProviders: ["a", "b"], excludeProviders: ["c"] };
    const incoming: RoutingHints = { preferProviders: ["x"] };
    const result = mergeHints(base, incoming);
    assert.deepEqual(result.preferProviders, ["x"]);
    assert.deepEqual(result.excludeProviders, ["c"]); // preserved from base
  });

  it("handles full merge of disjoint keys", () => {
    const base: RoutingHints = { tierOverride: "fast" };
    const incoming: RoutingHints = { forceReasoning: true, excludeProviders: ["p1"] };
    const result = mergeHints(base, incoming);
    assert.equal(result.tierOverride, "fast");
    assert.equal(result.forceReasoning, true);
    assert.deepEqual(result.excludeProviders, ["p1"]);
  });
});

describe("buildStrategyRules", () => {
  const ctx: RoutingContext = {
    prompt: "hi",
    history: [],
    routeId: "r",
    estimatedTokens: 100,
    classification: "short",
    availableTargets: [{ provider: "p1", modelId: "m1", label: "L1" }],
  };

  it("builds a force-tier rule", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "test-tier", priority: 1, type: "force-tier", tier: "reasoning" },
    ];
    const rules = buildStrategyRules(configs);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].name, "test-tier");
    assert.equal(rules[0].priority, 1);
    assert.equal(rules[0].routeId, undefined);
    // Condition should always match (no condition filter)
    assert.equal(rules[0].condition(ctx), true);
    const hints = rules[0].action(ctx);
    assert.ok(hints);
    assert.equal(hints!.tierOverride, "reasoning");
  });

  it("stamps routeId onto generated rules when provided", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "scoped", priority: 1, type: "force-tier", tier: "fast" },
    ];
    const rules = buildStrategyRules(configs, "subscription-premium");
    assert.equal(rules[0].routeId, "subscription-premium");
  });

  it("builds a prefer-provider rule (string)", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "pref", priority: 1, type: "prefer-provider", provider: "claude" },
    ];
    const rules = buildStrategyRules(configs);
    const hints = rules[0].action(ctx);
    assert.deepEqual(hints!.preferProviders, ["claude"]);
  });

  it("builds a prefer-provider rule (array)", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "pref", priority: 1, type: "prefer-provider", provider: ["claude", "gemini"] },
    ];
    const rules = buildStrategyRules(configs);
    const hints = rules[0].action(ctx);
    assert.deepEqual(hints!.preferProviders, ["claude", "gemini"]);
  });

  it("builds an exclude-provider rule", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "excl", priority: 1, type: "exclude-provider", provider: "deepseek" },
    ];
    const rules = buildStrategyRules(configs);
    const hints = rules[0].action(ctx);
    assert.deepEqual(hints!.excludeProviders, ["deepseek"]);
  });

  it("builds a force-billing rule", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "bill", priority: 1, type: "force-billing", billing: "per-token" },
    ];
    const rules = buildStrategyRules(configs);
    const hints = rules[0].action(ctx);
    assert.equal(hints!.enforceBilling, "per-token");
  });

  it("builds a force-constraint rule", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "constraint", priority: 1, type: "force-constraint", constraint: { reasoning: true, minContextWindow: 100000 } },
    ];
    const rules = buildStrategyRules(configs);
    const hints = rules[0].action(ctx);
    assert.equal(hints!.forceReasoning, true);
    assert.equal(hints!.forceMinContext, 100000);
  });

  it("condition filters by intent via userHint", () => {
    const ctxSwe: RoutingContext = { ...ctx, userHint: "swe" };
    const ctxEconomy: RoutingContext = { ...ctx, userHint: "economy" };

    const configs: PolicyRuleConfig[] = [
      { name: "code-only", priority: 1, type: "force-tier", tier: "swe", condition: { intent: "code" } },
    ];
    const rules = buildStrategyRules(configs);
    assert.equal(rules[0].condition(ctxSwe), true);   // swe = code intent
    assert.equal(rules[0].condition(ctxEconomy), false); // economy = creative intent
  });

  it("condition filters by estimated tokens range", () => {
    const ctxSmall: RoutingContext = { ...ctx, estimatedTokens: 50 };
    const ctxBig: RoutingContext = { ...ctx, estimatedTokens: 5000 };

    const configs: PolicyRuleConfig[] = [
      { name: "small-only", priority: 1, type: "force-tier", tier: "fast", condition: { estimatedTokensMax: 1000 } },
    ];
    const rules = buildStrategyRules(configs);
    assert.equal(rules[0].condition(ctxSmall), true);
    assert.equal(rules[0].condition(ctxBig), false);
  });

  it("condition with no filter always matches", () => {
    const configs: PolicyRuleConfig[] = [
      { name: "always", priority: 1, type: "force-tier", tier: "fast" },
    ];
    const rules = buildStrategyRules(configs);
    assert.equal(rules[0].condition(ctx), true);
  });
});

describe("PolicyEngine evaluateStrategy", () => {
  const target: RouteTarget = { provider: "p", modelId: "m", label: "Lbl" };
  const ctx: RoutingContext = {
    prompt: "hi",
    history: [],
    routeId: "r",
    estimatedTokens: 10,
    classification: "short",
    availableTargets: [target],
  };

  it("returns null when no strategy rules registered", () => {
    const engine = new PolicyEngine();
    assert.equal(engine.evaluateStrategy(ctx), null);
    assert.equal(engine.getLastHints(), null);
  });

  it("returns hints from matching strategy rules", () => {
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "s1", priority: 1, condition: () => true, action: () => ({ tierOverride: "fast" }) },
      ],
    });
    const hints = engine.evaluateStrategy(ctx);
    assert.ok(hints);
    assert.equal(hints!.tierOverride, "fast");
    const lastHints = engine.getLastHints();
    assert.ok(lastHints);
    assert.equal(lastHints!.ruleName, "s1");
  });

  it("merges hints from multiple matching rules (later overrides)", () => {
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "first", priority: 1, condition: () => true, action: () => ({ tierOverride: "economy", forceReasoning: true }) },
        { name: "second", priority: 2, condition: () => true, action: () => ({ tierOverride: "reasoning" }) },
      ],
    });
    const hints = engine.evaluateStrategy(ctx);
    assert.ok(hints);
    assert.equal(hints!.tierOverride, "reasoning"); // second overrides
    assert.equal(hints!.forceReasoning, true); // preserved from first
  });

  it("skips rules whose condition returns false", () => {
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "skip", priority: 1, condition: () => false, action: () => ({ tierOverride: "fast" }) },
        { name: "match", priority: 2, condition: () => true, action: () => ({ tierOverride: "reasoning" }) },
      ],
    });
    const hints = engine.evaluateStrategy(ctx);
    assert.ok(hints);
    assert.equal(hints!.tierOverride, "reasoning");
  });

  it("skips rules whose action returns null", () => {
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "null-action", priority: 1, condition: () => true, action: () => null },
        { name: "match", priority: 2, condition: () => true, action: () => ({ tierOverride: "fast" }) },
      ],
    });
    const hints = engine.evaluateStrategy(ctx);
    assert.ok(hints);
    assert.equal(hints!.tierOverride, "fast");
  });

  it("rebuildStrategyRules replaces all strategy rules", () => {
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "old", priority: 1, condition: () => true, action: () => ({ tierOverride: "fast" }) },
      ],
    });
    engine.rebuildStrategyRules([
      { name: "new", priority: 1, condition: () => true, action: () => ({ tierOverride: "reasoning" }) },
    ]);
    assert.equal(engine.getStrategyRules().length, 1);
    assert.equal(engine.getStrategyRules()[0].name, "new");
    const hints = engine.evaluateStrategy(ctx);
    assert.equal(hints!.tierOverride, "reasoning");
  });

  it("reset clears lastDecision and lastHints", () => {
    const engine = new PolicyEngine({
      rules: [
        { name: "d", priority: 1, condition: () => true, action: (c) => makePassthroughDecision(target, c, "test") },
      ],
      strategyRules: [
        { name: "s", priority: 1, condition: () => true, action: () => ({ tierOverride: "fast" }) },
      ],
    });
    engine.decide(ctx);
    engine.evaluateStrategy(ctx);
    assert.ok(engine.getLastDecision());
    assert.ok(engine.getLastHints());
    engine.reset();
    assert.equal(engine.getLastDecision(), null);
    assert.equal(engine.getLastHints(), null);
  });

  it("fires global rules (routeId=undefined) for any route", () => {
    const ctxA: RoutingContext = { ...ctx, routeId: "route-a" };
    const ctxB: RoutingContext = { ...ctx, routeId: "route-b" };
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "global", priority: 1, routeId: undefined, condition: () => true, action: () => ({ tierOverride: "fast" }) },
      ],
    });
    assert.equal(engine.evaluateStrategy(ctxA)!.tierOverride, "fast");
    assert.equal(engine.evaluateStrategy(ctxB)!.tierOverride, "fast");
  });

  it("scopes route-specific rules to their route only", () => {
    const ctxA: RoutingContext = { ...ctx, routeId: "route-a" };
    const ctxB: RoutingContext = { ...ctx, routeId: "route-b" };
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "only-a", priority: 1, routeId: "route-a", condition: () => true, action: () => ({ tierOverride: "reasoning" }) },
        { name: "only-b", priority: 1, routeId: "route-b", condition: () => true, action: () => ({ tierOverride: "fast" }) },
      ],
    });
    assert.equal(engine.evaluateStrategy(ctxA)!.tierOverride, "reasoning");
    assert.equal(engine.evaluateStrategy(ctxB)!.tierOverride, "fast");
  });

  it("mixes global and route-scoped rules correctly", () => {
    const ctxA: RoutingContext = { ...ctx, routeId: "route-a" };
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "scoped", priority: 1, routeId: "route-a", condition: () => true, action: () => ({ forceReasoning: true }) },
        { name: "global", priority: 2, condition: () => true, action: () => ({ tierOverride: "economy" }) },
      ],
    });
    const hints = engine.evaluateStrategy(ctxA);
    assert.ok(hints);
    assert.equal(hints!.forceReasoning, true);
    assert.equal(hints!.tierOverride, "economy");
  });

  it("returns null when no rules match the route", () => {
    const ctxB: RoutingContext = { ...ctx, routeId: "route-b" };
    const engine = new PolicyEngine({
      strategyRules: [
        { name: "only-a", priority: 1, routeId: "route-a", condition: () => true, action: () => ({ tierOverride: "reasoning" }) },
      ],
    });
    assert.equal(engine.evaluateStrategy(ctxB), null);
  });
});
