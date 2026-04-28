import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryWithBackoff, buildMonthlyQuotaWindow } from "../src/balance-fetcher.ts";

describe("retryWithBackoff", () => {
  it("returns result on first success", async () => {
    const result = await retryWithBackoff(() => Promise.resolve(42));
    assert.equal(result, 42);
  });

  it("retries on failure and eventually succeeds", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error("fail"));
      return Promise.resolve("ok");
    };
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 1 });
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("throws after exhausting retries", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new Error("always fails"));
    };
    await assert.rejects(
      () => retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1 }),
      { message: "always fails" },
    );
    assert.equal(calls, 3); // initial + 2 retries
  });

  it("does not retry when maxRetries is 0", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.reject(new Error("fail"));
    };
    await assert.rejects(
      () => retryWithBackoff(fn, { maxRetries: 0, baseDelayMs: 1 }),
      { message: "fail" },
    );
    assert.equal(calls, 1);
  });

  it("uses exponential backoff with configurable delays", async () => {
    const delays: number[] = [];
    let calls = 0;
    const start = Date.now();
    const fn = () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error("fail"));
      return Promise.resolve("ok");
    };
    // Use small delays so test is fast
    const result = await retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 40 });
    assert.equal(result, "ok");
    const elapsed = Date.now() - start;
    // First retry: 10ms, second retry: 20ms = ~30ms total delay
    assert.ok(elapsed >= 25, `expected >=25ms elapsed, got ${elapsed}ms`);
  });
});

describe("buildMonthlyQuotaWindow", () => {
  it("returns null for invalid budget", () => {
    assert.equal(buildMonthlyQuotaWindow("p", 0, 0), null);
    assert.equal(buildMonthlyQuotaWindow("p", 0, -1), null);
  });

  it("computes usedPercent from spend/budget", () => {
    const now = new Date("2025-06-15T12:00:00Z").getTime();
    const window = buildMonthlyQuotaWindow("p", 5, 10, now);
    assert.ok(window);
    assert.equal(window!.provider, "p");
    assert.equal(window!.scope, "monthly");
    assert.equal(window!.usedPercent, 50);
    assert.equal(window!.source, "config");
  });

  it("caps usedPercent at 100", () => {
    const window = buildMonthlyQuotaWindow("p", 20, 10);
    assert.equal(window!.usedPercent, 100);
  });

  it("provides month-end resetAt", () => {
    const now = new Date("2025-02-15T12:00:00Z").getTime();
    const window = buildMonthlyQuotaWindow("p", 5, 10, now);
    assert.ok(window);
    // February ends on the 28th in 2025
    assert.ok(window!.resetsAt.includes("2025-03-01"));
  });
});
