/**
 * Classification of a model's terminal stop for failover purposes.
 *
 * A `"length"` stop reason means the model hit its output ceiling and the
 * response was truncated before completion. Such completions must not be
 * reported as successful; the router should fail over to the next target in
 * the route instead of surfacing truncated output (which pi core would then
 * try — and fail — to recover via compact-and-retry).
 */

export function isTruncatedStop(stopReason: unknown): boolean {
  return stopReason === "length";
}

export function truncatedStopMessage(label?: string): string {
  return `${label ?? "Target"}: output truncated (stopReason=length)`;
}
