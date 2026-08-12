import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BudgetTracker } from "../src/budget-tracker.ts";
import { DecisionLogger } from "../src/decision-logger.ts";
import { FeedbackTracker } from "../src/feedback-tracker.ts";
import { LatencyTracker } from "../src/latency-tracker.ts";
import { RouterEventLogger } from "../src/router-event-logger.ts";
import { getAutoRouterStoragePaths, resolveAutoRouterLogDir } from "../src/storage-paths.ts";

function tempRoot(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), "auto-router-storage-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe("auto-router storage paths", () => {
  it("uses env over config and config over the existing default", () => {
    assert.equal(resolveAutoRouterLogDir({ env: { AUTO_ROUTER_LOG_DIR: "/env/logs" }, configLogDir: "/config/logs" }), "/env/logs");
    assert.equal(resolveAutoRouterLogDir({ env: {}, configLogDir: "/config/logs" }), "/config/logs");
    assert.equal(resolveAutoRouterLogDir({ env: {}, homeDir: "/home/test" }), "/home/test/.pi/agent/extensions");
  });

  it("creates a missing directory and returns every shared writer path", () => {
    const root = tempRoot();
    try {
      const directory = join(root.path, "nested", "logs");
      const paths = getAutoRouterStoragePaths({ env: {}, configLogDir: directory });
      assert.equal(existsSync(directory), true);
      assert.deepEqual(Object.values(paths).slice(1).map((value) => value.slice(directory.length + 1)), [
        "auto-router.decisions.jsonl",
        "auto-router.events.jsonl",
        "auto-router.stats.json",
        "auto-router.latency.json",
        "auto-router.ratings.json",
      ]);
    } finally { root.cleanup(); }
  });

  it("rejects an invalid or unwritable target before touching existing files", () => {
    const root = tempRoot();
    try {
      const existing = join(root.path, "existing.json");
      const notDirectory = join(root.path, "not-a-directory");
      writeFileSync(existing, "preserve me");
      writeFileSync(notDirectory, "file");
      assert.throws(
        () => getAutoRouterStoragePaths({ env: {}, configLogDir: notDirectory }),
        /log directory is not writable.*not-a-directory/,
      );
      assert.equal(existsSync(existing), true);
    } finally { root.cleanup(); }
  });

  it("routes decision, event, statistics, latency, and rating writers to one directory", async () => {
    const root = tempRoot();
    try {
      const paths = getAutoRouterStoragePaths({ env: {}, configLogDir: join(root.path, "logs") });
      new DecisionLogger(10, paths.decisions).clear();
      new RouterEventLogger(paths.events).clear();
      await new BudgetTracker(paths.stats).save();
      new LatencyTracker(paths.latency).save();
      new FeedbackTracker(paths.ratings).save();
      for (const file of [paths.decisions, paths.events, paths.stats, paths.latency, paths.ratings]) {
        assert.equal(existsSync(file), true, file);
      }
    } finally { root.cleanup(); }
  });
});
