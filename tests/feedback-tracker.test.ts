import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FeedbackTracker, type Rating } from "../src/feedback-tracker.ts";

const RATINGS_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.ratings.json");

function backup(): string | null {
  try { return fs.readFileSync(RATINGS_PATH, "utf-8"); } catch { return null; }
}

function restore(b: string | null): void {
  if (b !== null) {
    fs.mkdirSync(path.dirname(RATINGS_PATH), { recursive: true });
    fs.writeFileSync(RATINGS_PATH, b);
  } else {
    try { fs.unlinkSync(RATINGS_PATH); } catch { /* ignore */ }
  }
}

function makeRating(overrides: Partial<Rating> = {}): Rating {
  return {
    provider: "claude-agent-sdk",
    modelId: "claude-opus-4-6",
    routeId: "subscription-reasoning",
    rating: "good",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("FeedbackTracker", () => {
  let b: string | null;
  before(() => { b = backup(); });
  after(() => { restore(b); });

  it("starts with no ratings", () => {
    const t = new FeedbackTracker();
    assert.equal(t.getRecent().length, 0);
    assert.equal(t.getLast(), undefined);
  });

  it("records and retrieves ratings", () => {
    const t = new FeedbackTracker();
    t.record(makeRating({ rating: "good" }));
    t.record(makeRating({ rating: "bad", reason: "too slow" }));
    const recent = t.getRecent();
    assert.equal(recent.length, 2);
    assert.equal(recent[0].rating, "bad"); // most recent first
    assert.equal(recent[0].reason, "too slow");
    assert.equal(recent[1].rating, "good");
  });

  it("getLast returns most recent", () => {
    const t = new FeedbackTracker();
    t.record(makeRating({ rating: "good" }));
    t.record(makeRating({ rating: "bad" }));
    assert.equal(t.getLast()!.rating, "bad");
  });

  it("computes per-provider stats", () => {
    const t = new FeedbackTracker();
    t.record(makeRating({ provider: "claude-agent-sdk", rating: "good" }));
    t.record(makeRating({ provider: "claude-agent-sdk", rating: "good" }));
    t.record(makeRating({ provider: "claude-agent-sdk", rating: "bad" }));
    t.record(makeRating({ provider: "openai-codex", rating: "good" }));
    const stats = t.getProviderStats();
    assert.equal(stats["claude-agent-sdk"].good, 2);
    assert.equal(stats["claude-agent-sdk"].bad, 1);
    assert.equal(stats["claude-agent-sdk"].total, 3);
    assert.equal(stats["openai-codex"].good, 1);
    assert.equal(stats["openai-codex"].bad, 0);
  });

  it("caps ratings at 500", () => {
    const t = new FeedbackTracker();
    for (let i = 0; i < 600; i++) {
      t.record(makeRating({ timestamp: i }));
    }
    assert.ok(t.getRecent(1000).length <= 500);
    // Oldest should be dropped (timestamp 100+)
    const all = t.getRecent(1000);
    const oldestTimestamp = all[all.length - 1].timestamp;
    assert.ok(oldestTimestamp >= 100);
  });

  it("persists and loads across instances", () => {
    try { fs.unlinkSync(RATINGS_PATH); } catch { /* ignore */ }
    const t1 = new FeedbackTracker();
    t1.record(makeRating({ rating: "good", timestamp: 1000 }));
    t1.save();

    const t2 = new FeedbackTracker();
    t2.load();
    assert.equal(t2.getRecent().length, 1);
    assert.equal(t2.getRecent()[0].rating, "good");
  });

  it("clear() removes all ratings", () => {
    const t = new FeedbackTracker();
    t.record(makeRating());
    t.record(makeRating());
    t.clear();
    assert.equal(t.getRecent().length, 0);
  });

  it("handles corrupt file gracefully", () => {
    fs.writeFileSync(RATINGS_PATH, "not json");
    const t = new FeedbackTracker();
    t.load();
    assert.equal(t.getRecent().length, 0);
  });
});
