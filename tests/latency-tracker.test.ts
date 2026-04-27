import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LatencyTracker } from "../src/latency-tracker.ts";

const LATENCY_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.latency.json");

function backupLatency(): string | null {
  try { return fs.readFileSync(LATENCY_PATH, "utf-8"); } catch { return null; }
}

function restoreLatency(backup: string | null): void {
  if (backup !== null) {
    fs.mkdirSync(path.dirname(LATENCY_PATH), { recursive: true });
    fs.writeFileSync(LATENCY_PATH, backup);
  } else {
    try { fs.unlinkSync(LATENCY_PATH); } catch { /* ignore */ }
  }
}

describe("LatencyTracker", () => {
  let backup: string | null;

  before(() => { backup = backupLatency(); });
  after(() => { restoreLatency(backup); });

  it("starts with no records", () => {
    const tracker = new LatencyTracker();
    assert.equal(tracker.getAvgLatency("any"), null);
    assert.equal(tracker.getAll().size, 0);
  });

  it("records and retrieves average latency", () => {
    const tracker = new LatencyTracker();
    tracker.recordLatency("claude-agent-sdk", 3000);
    tracker.recordLatency("claude-agent-sdk", 2000);
    tracker.recordLatency("claude-agent-sdk", 1000);
    const avg = tracker.getAvgLatency("claude-agent-sdk");
    assert.ok(avg !== null);
    assert.ok(avg! >= 1500 && avg! <= 2500); // ~2000 with some decay
    const rec = tracker.getAll().get("claude-agent-sdk")!;
    assert.equal(rec.lastMs, 1000);
    assert.equal(rec.count, 3);
  });

  it("returns null for unknown providers", () => {
    const tracker = new LatencyTracker();
    tracker.recordLatency("openai-codex", 500);
    assert.equal(tracker.getAvgLatency("claude-agent-sdk"), null);
    assert.notEqual(tracker.getAvgLatency("openai-codex"), null);
  });

  it("persists and loads across instances", () => {
    // Clean up any existing latency data
    try { fs.unlinkSync(LATENCY_PATH); } catch { /* ignore */ }

    const t1 = new LatencyTracker();
    t1.recordLatency("gpt", 5000);
    t1.save();

    const t2 = new LatencyTracker();
    t2.load();
    const avg = t2.getAvgLatency("gpt");
    assert.equal(avg, 5000);
  });

  it("caps sample count at 100 and applies decay", () => {
    const tracker = new LatencyTracker();
    // Record 100 samples at 1000ms each
    for (let i = 0; i < 100; i++) {
      tracker.recordLatency("test", 1000);
    }
    assert.equal(tracker.getAll().get("test")!.count, 100);

    // One more sample at 100ms — count stays at 100, avg should be < 1000
    tracker.recordLatency("test", 100);
    const rec = tracker.getAll().get("test")!;
    assert.equal(rec.count, 100);
    assert.equal(rec.lastMs, 100);
    const avg = tracker.getAvgLatency("test")!;
    assert.ok(avg > 100 && avg < 1000); // decayed but not fully replaced
  });

  it("ignores zero or negative latency", () => {
    const tracker = new LatencyTracker();
    tracker.recordLatency("test", 0);
    tracker.recordLatency("test", -1);
    assert.equal(tracker.getAvgLatency("test"), null);
  });

  it("clear() resets all records", () => {
    const tracker = new LatencyTracker();
    tracker.recordLatency("a", 100);
    tracker.recordLatency("b", 200);
    tracker.clear();
    assert.equal(tracker.getAvgLatency("a"), null);
    assert.equal(tracker.getAvgLatency("b"), null);
    assert.equal(tracker.getAll().size, 0);
  });
});
