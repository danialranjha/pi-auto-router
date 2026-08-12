import type { RouteTarget } from "./types.ts";

export type RoutingOrder = "adaptive" | "config";
export type CandidateBuckets = {
  promoted: RouteTarget[];
  normal: RouteTarget[];
  demoted: RouteTarget[];
};

export function parseRoutingOrder(value: unknown): RoutingOrder {
  if (value === undefined) return "adaptive";
  if (value === "adaptive" || value === "config") return value;
  throw new Error(`sortBy must be "adaptive" or "config"; received ${JSON.stringify(value)}`);
}

/**
 * Order candidates without crossing UVI buckets. In config mode, declared order is
 * retained and preferProviders is ignored; requireProvider remains an explicit override.
 */
export function orderCandidateBuckets(
  buckets: CandidateBuckets,
  options: {
    mode: RoutingOrder;
    rankedCompare: (a: RouteTarget, b: RouteTarget) => number;
    preferredCompare?: (a: RouteTarget, b: RouteTarget) => number;
    requireProvider?: string;
    preferProviders?: readonly string[];
  },
): void {
  if (options.mode === "adaptive") {
    buckets.promoted.sort(options.rankedCompare);
    buckets.normal.sort(options.rankedCompare);
    buckets.demoted.sort(options.rankedCompare);
  }

  if (options.requireProvider) {
    const moveToFront = (targets: RouteTarget[]) => {
      const index = targets.findIndex((target) => target.provider === options.requireProvider);
      if (index > 0) targets.unshift(targets.splice(index, 1)[0]);
    };
    moveToFront(buckets.promoted);
    moveToFront(buckets.normal);

    const demotedIndex = buckets.demoted.findIndex((target) => target.provider === options.requireProvider);
    if (demotedIndex >= 0) buckets.normal.unshift(buckets.demoted.splice(demotedIndex, 1)[0]);
  }

  if (options.mode === "adaptive" && options.preferProviders?.length && options.preferredCompare) {
    buckets.promoted.sort(options.preferredCompare);
    buckets.normal.sort(options.preferredCompare);
  }
}
