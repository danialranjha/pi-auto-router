import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../src/circuit-breaker.ts";

function fixture(options: ConstructorParameters<typeof CircuitBreaker>[0] = {}) {
  let now = 0;
  const cb = new CircuitBreaker({ ...options, now: () => now });
  return { cb, advance: (ms: number) => { now += ms; }, time: () => now };
}

describe("CircuitBreaker operational streaks", () => {
  it("starts closed and opens after three sparse failures including timestamp zero", () => {
    const { cb, advance } = fixture();
    assert.equal(cb.getState("target"), "closed");
    for (let i = 0; i < 3; i++) {
      cb.recordFailure("target");
      assert.equal(cb.getFailureCount("target"), i + 1);
      assert.equal(cb.getState("target"), i < 2 ? "closed" : "open");
      if (i < 2) advance(180_000);
    }
  });

  it("retains failures across old window boundaries and arbitrarily long idle", () => {
    for (const gap of [59_999, 60_000, 60_001, 24 * 60 * 60_000]) {
      const { cb, advance } = fixture();
      cb.recordFailure("target"); advance(gap);
      cb.recordFailure("target"); advance(gap);
      cb.recordFailure("target");
      assert.equal(cb.getState("target"), "open", `gap=${gap}`);
    }
  });

  it("state, count and dump observations are pure before and after retry deadline", () => {
    const { cb, advance } = fixture({ failureThreshold: 1 });
    cb.recordFailure("target");
    for (const gap of [0, 120_000, 7_200_000]) {
      advance(gap);
      const snapshot = cb.dump();
      for (let i = 0; i < 5; i++) {
        cb.getState("target"); cb.isOpen("target"); cb.getFailureCount("target");
        assert.deepEqual(cb.dump(), snapshot);
      }
    }
  });

  it("admits exactly one probe at the deadline and immediately reopens after a long-idle failed probe", () => {
    const { cb, advance, time } = fixture({ failureThreshold: 1 });
    cb.recordFailure("target");
    assert.equal(cb.acquire("target"), undefined);
    advance(24 * 60 * 60_000);
    assert.equal(cb.getState("target"), "half-open");
    const probe = cb.acquire("target")!;
    assert.equal(cb.isOpen("target"), true);
    assert.equal(cb.acquire("target"), undefined);
    probe.failure(); probe.release(); probe.failure();
    assert.equal(cb.getState("target"), "open");
    assert.equal(cb.getFailureCount("target"), 2);
    assert.equal(cb.dump().target.retryAt, time() + 300_000);
  });

  it("escalates 2m/5m/30m/2h and caps the deadline", () => {
    const { cb, advance, time } = fixture({ failureThreshold: 1 });
    const steps = [120_000, 300_000, 1_800_000, 7_200_000, 7_200_000];
    for (const delay of steps) {
      cb.acquire("target")!.failure();
      assert.equal(cb.dump().target.retryAt, time() + delay);
      advance(delay);
    }
  });

  it("never shortens a reason deadline, including one from an earlier route failure", () => {
    const { cb, advance, time } = fixture();
    cb.recordFailure("target", 9_000_000);
    advance(180_000); cb.recordFailure("target");
    advance(180_000); cb.recordFailure("target", time() + 120_000);
    assert.equal(cb.dump().target.retryAt, 9_000_000);
    advance(9_000_000 - time());
    cb.acquire("target")!.failure(time() + 12_000_000);
    assert.equal(cb.dump().target.retryAt, time() + 12_000_000);
  });

  it("success resets streak and escalation only for that target", () => {
    const { cb, advance } = fixture({ failureThreshold: 1 });
    cb.recordFailure("bad"); cb.recordSuccess("sibling");
    assert.equal(cb.getState("bad"), "open");
    advance(120_000); cb.acquire("bad")!.success();
    assert.equal(cb.getState("bad"), "closed");
    assert.equal(cb.getFailureCount("bad"), 0);
    cb.acquire("bad")!.failure();
    assert.equal(cb.dump().bad.retryAt, 240_000);
  });

  it("abort/input/throw release allows a replacement probe without changing streak/backoff", () => {
    const { cb, advance } = fixture({ failureThreshold: 1 });
    cb.recordFailure("target"); advance(120_000);
    const probe = cb.acquire("target")!;
    probe.release(); probe.release(); probe.failure();
    assert.equal(cb.getState("target"), "half-open");
    assert.equal(cb.getFailureCount("target"), 1);
    assert.ok(cb.acquire("target"));
  });

  it("reset invalidates old permits and cannot release or poison a new probe", () => {
    const { cb, advance } = fixture({ failureThreshold: 1 });
    cb.recordFailure("target"); advance(120_000);
    const old = cb.acquire("target")!;
    cb.clear();
    cb.acquire("target")!.failure(); advance(120_000);
    const current = cb.acquire("target")!;
    old.failure(); old.release(); old.success();
    assert.equal(cb.acquire("target"), undefined);
    assert.equal(cb.getFailureCount("target"), 1);
    current.success(); assert.equal(cb.getState("target"), "closed");
  });

  it("success resets health, then a later concurrent completion starts a new streak", () => {
    const { cb } = fixture({ failureThreshold: 1 });
    const first = cb.acquire("target")!;
    const second = cb.acquire("target")!;
    first.success(); second.failure();
    assert.equal(cb.getState("target"), "open");
    assert.equal(cb.getFailureCount("target"), 1);
  });

  it("rejects invalid threshold/backoff options", () => {
    for (const options of [{failureThreshold:0}, {cooldownStepsMs:[]}, {cooldownStepsMs:[2,1]}, {cooldownStepsMs:[-1]}]) {
      assert.throws(() => new CircuitBreaker(options));
    }
  });
});
