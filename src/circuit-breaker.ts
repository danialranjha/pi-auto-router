export type CircuitState = "closed" | "open" | "half-open";

export type CircuitBreakerOptions = {
  /** Number of failures within the window to open the circuit. Default: 3 */
  failureThreshold?: number;
  /** Time window in ms for counting failures. Default: 60_000 (1 minute) */
  windowMs?: number;
  /** How long the circuit stays open before transitioning to half-open. Default: 30_000 (30 seconds) */
  cooldownMs?: number;
};

type ProviderState = {
  failures: number[]; // timestamps of recent failures
  openedAt: number;   // when the circuit opened (0 = not open)
};

export class CircuitBreaker {
  private states = new Map<string, ProviderState>();
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.windowMs = options.windowMs ?? 60_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  /** Check if the circuit is open (provider is blocked). */
  isOpen(provider: string): boolean {
    return this.getState(provider) === "open";
  }

  /** Get the current circuit state for a provider. */
  getState(provider: string): CircuitState {
    const s = this.states.get(provider);
    if (!s) return "closed";
    const now = Date.now();

    // Prune stale failures outside the window
    const cutoff = now - this.windowMs;
    s.failures = s.failures.filter((t) => t >= cutoff);

    if (s.openedAt > 0) {
      // Circuit is open — check if cooldown has elapsed
      if (now - s.openedAt >= this.cooldownMs) {
        // Transition to half-open: allow one trial request
        s.openedAt = 0;
        return "half-open";
      }
      return "open";
    }

    // Check if threshold crossed
    if (s.failures.length >= this.failureThreshold) {
      s.openedAt = now;
      return "open";
    }

    return "closed";
  }

  /** Record a successful request. Resets the circuit for this provider. */
  recordSuccess(provider: string): void {
    const s = this.states.get(provider);
    if (s) {
      s.failures = [];
      s.openedAt = 0;
    }
  }

  /** Record a failed request. */
  recordFailure(provider: string): void {
    let s = this.states.get(provider);
    if (!s) {
      s = { failures: [], openedAt: 0 };
      this.states.set(provider, s);
    }
    s.failures.push(Date.now());
    // If we were in half-open and this failure comes in, reopen the circuit
    if (s.openedAt === 0 && s.failures.length >= this.failureThreshold) {
      s.openedAt = Date.now();
    }
  }

  /** Number of recent failures for a provider (within the window). */
  getFailureCount(provider: string): number {
    const s = this.states.get(provider);
    if (!s) return 0;
    const cutoff = Date.now() - this.windowMs;
    return s.failures.filter((t) => t >= cutoff).length;
  }

  /** Clear all state. */
  clear(): void {
    this.states.clear();
  }

  /** Get all providers with their current state. */
  dump(): Record<string, { state: CircuitState; failures: number; openedAt: number }> {
    const result: Record<string, { state: CircuitState; failures: number; openedAt: number }> = {};
    for (const [provider] of this.states) {
      result[provider] = {
        state: this.getState(provider),
        failures: this.getFailureCount(provider),
        openedAt: this.states.get(provider)?.openedAt ?? 0,
      };
    }
    return result;
  }
}
