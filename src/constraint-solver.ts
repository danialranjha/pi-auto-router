import type { RouteTarget, RoutingContext, Tier } from "./types.ts";

export type CapabilityMap = {
  vision?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export type ConstraintRequirements = {
  vision?: boolean;
  reasoning?: boolean;
  minContextWindow?: number;
  minMaxTokens?: number;
};

export type CapabilityLookup = (target: RouteTarget) => CapabilityMap | undefined;

export type SolveOptions = {
  requirements?: ConstraintRequirements;
  capabilities?: CapabilityLookup;
  isOnCooldown?: (target: RouteTarget) => boolean;
  isHealthy?: (target: RouteTarget) => boolean;
};

export type Rejection = { target: RouteTarget; reason: string };

export type SolveResult = {
  candidates: RouteTarget[];
  rejections: Rejection[];
};

export function solveConstraints(ctx: RoutingContext, options: SolveOptions = {}): SolveResult {
  const { requirements = {}, capabilities, isOnCooldown, isHealthy } = options;
  const candidates: RouteTarget[] = [];
  const rejections: Rejection[] = [];

  for (const target of ctx.availableTargets) {
    if (isHealthy && !isHealthy(target)) {
      rejections.push({ target, reason: "provider unhealthy" });
      continue;
    }
    if (isOnCooldown && isOnCooldown(target)) {
      rejections.push({ target, reason: "on cooldown" });
      continue;
    }
    const caps = capabilities ? capabilities(target) ?? {} : {};
    if (requirements.vision === true && caps.vision === false) {
      rejections.push({ target, reason: "lacks vision capability" });
      continue;
    }
    if (requirements.reasoning === true && caps.reasoning === false) {
      rejections.push({ target, reason: "lacks reasoning capability" });
      continue;
    }
    if (
      typeof requirements.minContextWindow === "number" &&
      typeof caps.contextWindow === "number" &&
      caps.contextWindow < requirements.minContextWindow
    ) {
      rejections.push({
        target,
        reason: `context window ${caps.contextWindow} < required ${requirements.minContextWindow}`,
      });
      continue;
    }
    if (
      typeof requirements.minMaxTokens === "number" &&
      typeof caps.maxTokens === "number" &&
      caps.maxTokens < requirements.minMaxTokens
    ) {
      rejections.push({
        target,
        reason: `max tokens ${caps.maxTokens} < required ${requirements.minMaxTokens}`,
      });
      continue;
    }
    candidates.push(target);
  }

  return { candidates, rejections };
}

export function inferRequirements(
  ctx: RoutingContext,
  base: ConstraintRequirements = {},
): ConstraintRequirements {
  return {
    ...base,
    minContextWindow: Math.max(base.minContextWindow ?? 0, ctx.estimatedTokens),
  };
}

/** Map a routing tier to concrete constraint requirements. */
export function tierToRequirements(tier: Tier | undefined, estimatedTokens: number): ConstraintRequirements {
  const reqs: ConstraintRequirements = {};
  if (tier === "vision") reqs.vision = true;
  if (tier === "reasoning" || tier === "swe") reqs.reasoning = true;
  if (tier === "long") reqs.minContextWindow = Math.max(estimatedTokens, 100_000);
  return reqs;
}
