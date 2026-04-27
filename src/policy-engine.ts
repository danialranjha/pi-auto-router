import type { PolicyRule, PolicyRuleConfig, RouteTarget, RoutingContext, RoutingDecision, RoutingHints } from "./types.ts";

export type PolicyEngineOptions = {
  rules?: PolicyRule[];
  strategyRules?: StrategyRule[];
  shadowMode?: boolean;
};

/** A rule that inspects the routing context and returns lightweight hints rather than a full decision. */
export type StrategyRule = {
  name: string;
  priority: number;
  /** If set, this rule only fires for the matching route ID. Undefined = global (all routes). */
  routeId?: string;
  condition: (ctx: RoutingContext) => boolean;
  action: (ctx: RoutingContext) => RoutingHints | null;
};

export class PolicyEngine {
  private rules: PolicyRule[];
  private strategyRules: StrategyRule[];
  readonly shadowMode: boolean;
  private lastDecision: RoutingDecision | null = null;
  private lastHints: { ruleName: string; hints: RoutingHints } | null = null;

  constructor(options: PolicyEngineOptions = {}) {
    this.rules = [...(options.rules ?? [])].sort((a, b) => a.priority - b.priority);
    this.strategyRules = [...(options.strategyRules ?? [])].sort((a, b) => a.priority - b.priority);
    this.shadowMode = options.shadowMode ?? false;
  }

  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priority - b.priority);
  }

  addStrategyRule(rule: StrategyRule): void {
    this.strategyRules.push(rule);
    this.strategyRules.sort((a, b) => a.priority - b.priority);
  }

  getRules(): readonly PolicyRule[] {
    return this.rules;
  }

  getStrategyRules(): readonly StrategyRule[] {
    return this.strategyRules;
  }

  getLastDecision(): RoutingDecision | null {
    return this.lastDecision;
  }

  getLastHints(): { ruleName: string; hints: RoutingHints } | null {
    return this.lastHints;
  }

  decide(ctx: RoutingContext): RoutingDecision | null {
    for (const rule of this.rules) {
      if (!rule.condition(ctx)) continue;
      const decision = rule.action(ctx);
      if (decision) {
        this.lastDecision = { ...decision, phase: decision.phase || rule.name };
        return this.lastDecision;
      }
    }
    return null;
  }

  /**
   * Evaluate strategy rules in priority order. Merges hints from all matching rules
   * (later rules override earlier ones for conflicting keys). Returns null if no rules match.
   * Only fires rules whose routeId is undefined (global) or matches the provided routeId.
   */
  evaluateStrategy(ctx: RoutingContext): RoutingHints | null {
    let merged: RoutingHints | null = null;
    let matchedRuleName: string | undefined;

    for (const rule of this.strategyRules) {
      // Route scoping: skip rules that are scoped to a different route
      if (rule.routeId !== undefined && rule.routeId !== ctx.routeId) continue;
      if (!rule.condition(ctx)) continue;
      const hints = rule.action(ctx);
      if (!hints) continue;
      matchedRuleName = rule.name;
      merged = mergeHints(merged, hints);
    }

    if (merged && matchedRuleName) {
      this.lastHints = { ruleName: matchedRuleName, hints: merged };
    }
    return merged;
  }

  /** Replace all strategy rules (used after config reload). */
  rebuildStrategyRules(rules: StrategyRule[]): void {
    this.strategyRules = [...rules].sort((a, b) => a.priority - b.priority);
    this.lastHints = null;
  }

  /** Clear last decision and last hints (used on reset). */
  reset(): void {
    this.lastDecision = null;
    this.lastHints = null;
  }
}

export function makePassthroughDecision(
  target: RouteTarget,
  ctx: RoutingContext,
  phase = "passthrough",
): RoutingDecision {
  return {
    tier: ctx.userHint ?? "swe",
    phase,
    target,
    reasoning: "Passthrough: selected target without policy override",
    metadata: {
      estimatedTokens: ctx.estimatedTokens,
      budgetRemaining: 0,
      confidence: 0.1,
    },
  };
}

/** Merge two RoutingHints, with `incoming` overriding `base` for conflicting scalar/array keys. */
export function mergeHints(base: RoutingHints | null, incoming: RoutingHints): RoutingHints {
  if (!base) return { ...incoming };
  return {
    tierOverride: incoming.tierOverride ?? base.tierOverride,
    forceReasoning: incoming.forceReasoning ?? base.forceReasoning,
    forceVision: incoming.forceVision ?? base.forceVision,
    forceMinContext: incoming.forceMinContext ?? base.forceMinContext,
    requireProvider: incoming.requireProvider ?? base.requireProvider,
    excludeProviders: incoming.excludeProviders ?? base.excludeProviders,
    preferProviders: incoming.preferProviders ?? base.preferProviders,
    enforceBilling: incoming.enforceBilling ?? base.enforceBilling,
  };
}

/**
 * Build StrategyRule objects from JSON-serializable PolicyRuleConfig entries.
 * If routeId is provided, all generated rules are scoped to that route.
 * These are meant to be loaded from auto-router.routes.json.
 */
export function buildStrategyRules(configs: PolicyRuleConfig[], routeId?: string): StrategyRule[] {
  return configs.map((c) => ({
    name: c.name,
    priority: c.priority,
    routeId,
    condition: buildCondition(c.condition),
    action: buildAction(c),
  }));
}

function buildCondition(cond?: PolicyRuleConfig["condition"]): (ctx: RoutingContext) => boolean {
  if (!cond) return () => true;
  return (ctx: RoutingContext) => {
    // Intent matching: check userHint which carries the intent-derived tier
    if (cond.intent) {
      const intentTier = ctx.userHint;
      // Map intent to tier: code→swe, creative→economy, analysis→long, general→undefined
      const intentToTierMap: Record<string, string | undefined> = {
        code: "swe",
        creative: "economy",
        analysis: "long",
        general: undefined,
      };
      if (intentToTierMap[cond.intent] !== intentTier) return false;
    }
    if (typeof cond.estimatedTokensMin === "number" && ctx.estimatedTokens < cond.estimatedTokensMin) return false;
    if (typeof cond.estimatedTokensMax === "number" && ctx.estimatedTokens > cond.estimatedTokensMax) return false;
    return true;
  };
}

function buildAction(c: PolicyRuleConfig): (ctx: RoutingContext) => RoutingHints | null {
  const hints: RoutingHints = {};

  switch (c.type) {
    case "force-tier":
      if (c.tier) hints.tierOverride = c.tier;
      break;
    case "prefer-provider": {
      const providers = typeof c.provider === "string" ? [c.provider] : (c.provider ?? []);
      if (providers.length > 0) hints.preferProviders = providers;
      break;
    }
    case "exclude-provider": {
      const providers = typeof c.provider === "string" ? [c.provider] : (c.provider ?? []);
      if (providers.length > 0) hints.excludeProviders = providers;
      break;
    }
    case "force-billing":
      if (c.billing) hints.enforceBilling = c.billing;
      break;
    case "force-constraint":
      if (c.constraint) {
        if (c.constraint.reasoning) hints.forceReasoning = true;
        if (c.constraint.vision) hints.forceVision = true;
        if (typeof c.constraint.minContextWindow === "number") hints.forceMinContext = c.constraint.minContextWindow;
      }
      break;
  }

  // Always return the same hints object (stateless)
  return () => hints;
}
