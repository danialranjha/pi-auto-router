import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetTracker } from "../src/budget-tracker.ts";

describe("BudgetTracker", () => {
  it("starts empty when file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.load();
    assert.deepEqual(tracker.getBudgetState(), { dailySpend: {}, dailyLimit: {}, monthlySpend: {}, monthlyLimit: {} });
  });

  it("records usage and accumulates spend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.recordUsage("openai-codex", { input: 100, output: 50, cost: { total: 0.12 } }, "2026-04-25");
    await tracker.recordUsage("openai-codex", { input: 10, output: 5, cost: { total: 0.03 } }, "2026-04-25");
    const summary = tracker.getDailySummary("2026-04-25");
    assert.equal(summary.length, 1);
    assert.equal(summary[0].provider, "openai-codex");
    assert.equal(summary[0].inputTokens, 110);
    assert.equal(summary[0].outputTokens, 55);
    assert.equal(summary[0].estimatedCost, 0.15);
  });

  it("persists limits and daily stats across reload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const path = join(dir, "stats.json");
    const trackerA = new BudgetTracker(path);
    await trackerA.recordUsage("google-antigravity", { input: 1, output: 2, cost: { total: 0.22 } }, "2026-04-25");
    await trackerA.setDailyLimit("google-antigravity", 5);

    const trackerB = new BudgetTracker(path);
    await trackerB.load();
    assert.equal(trackerB.getDailySpend("2026-04-25")["google-antigravity"], 0.22);
    assert.equal(trackerB.getDailyLimits()["google-antigravity"], 5);
  });

  it("gracefully handles corrupt json by resetting to defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const path = join(dir, "stats.json");
    await writeFile(path, "{not-json", "utf8");
    const tracker = new BudgetTracker(path);
    await tracker.load();
    assert.deepEqual(tracker.getBudgetState(), { dailySpend: {}, dailyLimit: {}, monthlySpend: {}, monthlyLimit: {} });
  });

  it("writes a versioned json file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const path = join(dir, "stats.json");
    const tracker = new BudgetTracker(path);
    await tracker.recordUsage("claude-agent-sdk", { input: 7, output: 8, cost: { total: 0 } }, "2026-04-25");
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.version, 2);
    assert.ok(raw.daily["2026-04-25"]);
  });

  it("can clear a limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.setDailyLimit("nvidia", 2.5);
    await tracker.clearDailyLimit("nvidia");
    assert.equal(tracker.getDailyLimits().nvidia, undefined);
  });

  it("exposes utilization snapshots through getBudgetState", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-router-budget-"));
    const tracker = new BudgetTracker(join(dir, "stats.json"));
    await tracker.load();
    assert.equal(tracker.getBudgetState().utilization, undefined);
    tracker.setUtilization({
      anthropic: {
        provider: "anthropic",
        uvi: 1.7,
        status: "stressed",
        windows: [],
        reason: "test",
        fetchedAt: 1,
      },
    });
    const state = tracker.getBudgetState();
    assert.ok(state.utilization);
    assert.equal(state.utilization!.anthropic.status, "stressed");
    assert.equal(tracker.getUtilization().anthropic.uvi, 1.7);
  });
});
