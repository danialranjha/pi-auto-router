export type CircuitState = "closed" | "open" | "half-open";

export type CircuitBreakerOptions = {
  /** Consecutive operational failures before opening. Default: 3. */
  failureThreshold?: number;
  /** @deprecated Failure streaks no longer expire in a sliding window. */
  windowMs?: number;
  /** Override the initial cooldown (primarily useful for tests). */
  cooldownMs?: number;
  /** Capped escalation schedule. Default: 2m, 5m, 30m, 2h. */
  cooldownStepsMs?: readonly number[];
  now?: () => number;
};

type TargetState = {
  failures: number;
  openedAt: number;
  retryAt: number;
  backoffStep: number;
  probeInFlight: boolean;
};

export type CircuitPermit = {
  isCurrent(): boolean;
  success(): void;
  failure(minimumRetryAt?: number): void;
  /** Abort, local/input error or exception: release without changing health. */
  release(): void;
};

export class CircuitBreaker {
  private states = new Map<string, TargetState>();
  private resetEpoch = 0;
  readonly failureThreshold: number;
  readonly cooldownStepsMs: readonly number[];
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownStepsMs = options.cooldownStepsMs
      ?? (options.cooldownMs === undefined ? [120_000, 300_000, 1_800_000, 7_200_000] : [options.cooldownMs]);
    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1
      || this.cooldownStepsMs.length === 0
      || this.cooldownStepsMs.some((ms, i, steps) => !Number.isFinite(ms) || ms < 0 || (i > 0 && ms < steps[i - 1]))) {
      throw new Error("Invalid circuit breaker threshold or cooldown schedule");
    }
    this.cooldownStepsMs = [...this.cooldownStepsMs];
    this.now = options.now ?? (() => Date.now());
  }

  /** Pure observation. An expired open circuit is ready for a single trial. */
  getState(key: string): CircuitState {
    const s = this.states.get(key);
    if (!s || s.backoffStep < 0) return "closed";
    return s.probeInFlight || this.now() >= s.retryAt ? "half-open" : "open";
  }

  /** Block open circuits and half-open circuits whose trial is already running. */
  isOpen(key: string): boolean {
    return this.getState(key) === "open" || (this.states.get(key)?.probeInFlight ?? false);
  }

  /** Acquire immediately before transport, including fallback/shadow attempts. */
  acquire(key: string): CircuitPermit | undefined {
    if (this.isOpen(key)) return undefined;
    const s = this.ensureState(key);
    const epoch = this.resetEpoch;
    const probe = s.backoffStep >= 0;
    if (probe) s.probeInFlight = true;
    let completed = false;
    const finish = (outcome: "success" | "failure" | "release", minimumRetryAt = 0) => {
      if (completed) return;
      completed = true;
      // Explicit reset invalidates outstanding permits. Success resets health,
      // but a later failure of an already-running request starts a new streak.
      if (this.resetEpoch !== epoch) return;
      if (probe && this.states.get(key) === s) s.probeInFlight = false;
      if (outcome === "success") this.recordSuccess(key);
      if (outcome === "failure") this.recordFailure(key, minimumRetryAt);
    };
    return {
      isCurrent: () => !completed && this.resetEpoch === epoch,
      success: () => finish("success"),
      failure: (until) => finish("failure", until),
      release: () => finish("release"),
    };
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  recordFailure(key: string, minimumRetryAt = 0): void {
    const s = this.ensureState(key);
    s.failures++;
    // Retain reason-based deadlines from earlier failures on other routes.
    s.retryAt = Math.max(s.retryAt, minimumRetryAt);
    if (s.failures < this.failureThreshold && s.backoffStep < 0) return;
    s.backoffStep = Math.min(s.backoffStep + 1, this.cooldownStepsMs.length - 1);
    s.openedAt = this.now();
    s.retryAt = Math.max(s.retryAt, minimumRetryAt, s.openedAt + this.cooldownStepsMs[s.backoffStep]);
  }

  /** Consecutive operational failures, retained across idle gaps. */
  getFailureCount(key: string): number {
    return this.states.get(key)?.failures ?? 0;
  }

  clear(): void {
    this.resetEpoch++;
    this.states.clear();
  }

  dump(): Record<string, { state: CircuitState; failures: number; openedAt: number; retryAt: number; probeInFlight: boolean }> {
    return Object.fromEntries([...this.states].map(([key, s]) => [key, {
      state: this.getState(key), failures: s.failures, openedAt: s.openedAt,
      retryAt: s.retryAt, probeInFlight: s.probeInFlight,
    }]));
  }

  private ensureState(key: string): TargetState {
    let s = this.states.get(key);
    if (!s) {
      s = { failures: 0, openedAt: 0, retryAt: 0, backoffStep: -1, probeInFlight: false };
      this.states.set(key, s);
    }
    return s;
  }
}
