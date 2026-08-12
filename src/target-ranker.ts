import type { RouteTarget } from "./types.ts";

export type TargetRankerOptions = {
  getLatency: (target: RouteTarget) => number | null;
  getCost: (target: RouteTarget) => number | null;
  getConfigIndex: (target: RouteTarget) => number;
  preferredProviders?: ReadonlySet<string>;
};

/** Compare targets by provider preference, known latency, cost, then config order. */
export function compareTargets(a: RouteTarget, b: RouteTarget, options: TargetRankerOptions): number {
  if (options.preferredProviders) {
    const preference = Number(options.preferredProviders.has(b.provider)) - Number(options.preferredProviders.has(a.provider));
    if (preference !== 0) return preference;
  }

  const aLatency = options.getLatency(a);
  const bLatency = options.getLatency(b);
  if (aLatency !== null && bLatency !== null && aLatency !== bLatency) return aLatency - bLatency;

  const aCost = options.getCost(a);
  const bCost = options.getCost(b);
  if (aCost !== null && bCost !== null && aCost !== bCost) return aCost - bCost;
  if (aCost !== null && bCost === null) return -1;
  if (aCost === null && bCost !== null) return 1;

  return options.getConfigIndex(a) - options.getConfigIndex(b);
}
