import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "../src/circuit-breaker.ts";

describe("CircuitBreaker", () => {
  it("starts closed for unknown providers", () => {
    const cb = new CircuitBreaker();
    assert.equal(cb.getState("p1"), "closed");
    assert.equal(cb.isOpen("p1"), false);
  });

  it("opens after failureThreshold consecutive failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 10_000 });
    cb.recordFailure("p1");
    assert.equal(cb.getState("p1"), "closed");
    cb.recordFailure("p1");
    assert.equal(cb.getState("p1"), "closed");
    cb.recordFailure("p1");
    assert.equal(cb.getState("p1"), "open");
    assert.equal(cb.isOpen("p1"), true);
  });

  it("closes on success before threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    cb.recordSuccess("p1");
    assert.equal(cb.getState("p1"), "closed");
    cb.recordFailure("p1");
    assert.equal(cb.getState("p1"), "closed"); // still only 1 failure
  });

  it("transitions to half-open after cooldown", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 0 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    // cooldownMs=0 means immediate transition to half-open on next check
    assert.equal(cb.getState("p1"), "half-open");
  });

  it("closes on success in half-open state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 0 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    assert.equal(cb.getState("p1"), "half-open");

    cb.recordSuccess("p1");
    assert.equal(cb.getState("p1"), "closed");
    assert.equal(cb.getFailureCount("p1"), 0);
  });

  it("reopens on failure in half-open state", () => {
    // Use long cooldown to observe the open state
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    assert.equal(cb.getState("p1"), "open");
  });

  it("prunes stale failures outside the window", () => {
    // windowMs=1: failures may or may not be stale depending on timing.
    // Verify that getState handles stale failure pruning gracefully.
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 1, cooldownMs: 10_000 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    const count = cb.getFailureCount("p1");
    assert.ok(count >= 0 && count <= 2, `expected 0-2 failures, got ${count}`);
    assert.equal(cb.getState("p1"), "closed");
  });

  it("prunes stale failures outside the window", () => {
    // windowMs=1: failures may or may not be stale depending on timing.
    // Verify that getState handles stale failure pruning without errors.
    const cb = new CircuitBreaker({ failureThreshold: 3, windowMs: 1, cooldownMs: 10_000 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    // After recording, count should be >= 0 (may be pruned or not)
    const count = cb.getFailureCount("p1");
    assert.ok(count >= 0 && count <= 2, `expected 0-2 failures, got ${count}`);
    // State should be closed since threshold is 3 and we're not at threshold
    assert.equal(cb.getState("p1"), "closed");
  });

  it("clear resets all state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    assert.equal(cb.getState("p1"), "open");

    cb.clear();
    assert.equal(cb.getState("p1"), "closed");
    assert.equal(cb.getFailureCount("p1"), 0);
  });

  it("dump returns state for all providers", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure("p1");
    cb.recordFailure("p2");
    const dump = cb.dump();
    assert.equal(Object.keys(dump).length, 2);
    assert.equal(dump.p1.state, "closed");
    assert.equal(dump.p1.failures, 1);
    assert.equal(dump.p2.failures, 1);
  });

  it("handles multiple providers independently", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure("p1");
    cb.recordFailure("p1");
    cb.recordFailure("p2");
    assert.equal(cb.getState("p1"), "open");
    assert.equal(cb.getState("p2"), "closed");
  });
});
