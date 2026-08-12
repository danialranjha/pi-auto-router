import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MODEL_STATUS_KEY,
  ModelStatusRuntime,
  createModelStatusExtension,
  readLatestRouterModel,
  type ReadLatestRouterModelOptions,
} from "../src/model-status.ts";

function withTempFile(contents?: string): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "auto-router-status-"));
  const path = join(directory, "events.jsonl");
  if (contents !== undefined) writeFileSync(path, contents);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function event(
  type: "routing.decision" | "routing.final",
  modelId: string,
  options: { sessionId?: string; routeId?: string; timestamp?: string } = {},
): string {
  const targetKey = type === "routing.final" ? "actualTarget" : "plannedTarget";
  return JSON.stringify({
    type,
    timestamp: options.timestamp ?? "2026-08-12T00:00:00.000Z",
    sessionId: options.sessionId,
    routeId: options.routeId ?? "subscription-swe",
    data: { [targetKey]: { provider: "example", modelId } },
  });
}

class FakeWatcher extends EventEmitter {
  closeCount = 0;
  unrefCount = 0;

  close(): void { this.closeCount++; }
  unref(): this { this.unrefCount++; return this; }
  fire(): void { this.emit("change"); }
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(values: Array<string | undefined> = [undefined]) {
  const watchers: FakeWatcher[] = [];
  const intervals: Array<{ callback: () => void; cleared: boolean; unref(): void }> = [];
  let readIndex = 0;
  const readLatest = () => values[Math.min(readIndex++, values.length - 1)];
  const runtime = new ModelStatusRuntime({
    eventsPath: "/fake/events.jsonl",
    readLatest,
    fileExists: () => true,
    watchFile: (_path, callback) => {
      const watcher = new FakeWatcher();
      watcher.on("change", callback);
      watchers.push(watcher);
      return watcher as any;
    },
    setIntervalFn: (callback) => {
      const interval = { callback, cleared: false, unref() {} };
      intervals.push(interval);
      return interval as any;
    },
    clearIntervalFn: (interval) => {
      (interval as any).cleared = true;
    },
  });
  return { runtime, watchers, intervals, getReadCount: () => readIndex };
}

function context(sessionId: string, onStatus?: (key: string, value: string | undefined) => void): any {
  return {
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: onStatus ?? (() => {}) },
  };
}

describe("readLatestRouterModel", () => {
  it("handles missing and empty files", () => {
    const missing = withTempFile();
    const empty = withTempFile("");
    try {
      assert.equal(readLatestRouterModel(missing.path), undefined);
      assert.equal(readLatestRouterModel(empty.path), undefined);
    } finally {
      missing.cleanup();
      empty.cleanup();
    }
  });

  it("reads files smaller than the tail and selects the latest applicable event", () => {
    const file = withTempFile([
      event("routing.decision", "planned", { sessionId: "session-a", timestamp: "2026-08-12T00:00:00Z" }),
      event("routing.final", "actual", { sessionId: "session-a", timestamp: "2026-08-12T00:00:01Z" }),
      "",
    ].join("\n"));
    try {
      assert.equal(
        readLatestRouterModel(file.path, { sessionId: "session-a" }),
        "subscription-swe → actual",
      );
    } finally {
      file.cleanup();
    }
  });

  it("skips a first record cut by the tail boundary and ignores malformed or partial final lines", () => {
    const complete = event("routing.final", "complete", {
      sessionId: "session-a",
      timestamp: "2026-08-12T00:00:02Z",
    });
    const raw = `${event("routing.final", "old", { sessionId: "session-a" })}\n${"x".repeat(200)}\n{malformed}\n${complete}\n${event("routing.final", "partial", { sessionId: "session-a" }).slice(0, 40)}`;
    const file = withTempFile(raw);
    try {
      assert.equal(
        readLatestRouterModel(file.path, { sessionId: "session-a", tailBytes: complete.length + 80 }),
        "subscription-swe → complete",
      );
    } finally {
      file.cleanup();
    }
  });

  it("filters global-log records by Pi session id", () => {
    const file = withTempFile([
      event("routing.final", "mine", { sessionId: "session-a", timestamp: "2026-08-12T00:00:01Z" }),
      event("routing.final", "other-process", { sessionId: "session-b", timestamp: "2026-08-12T00:00:02Z" }),
      "",
    ].join("\n"));
    try {
      assert.equal(
        readLatestRouterModel(file.path, { sessionId: "session-a" }),
        "subscription-swe → mine",
      );
    } finally {
      file.cleanup();
    }
  });

  it("never requests the entire large log", () => {
    const tail = `${event("routing.final", "bounded", { sessionId: "session-a" })}\n`;
    const data = Buffer.from(`${"z".repeat(2_000_000)}\n${tail}`);
    const reads: Array<{ length: number; position: number }> = [];
    const fileSystem: NonNullable<ReadLatestRouterModelOptions["fileSystem"]> = {
      openSync: () => 1,
      fstatSync: () => ({ size: data.length }),
      readSync: (_fd, buffer, offset, length, position) => {
        reads.push({ length, position });
        const count = Math.min(length, data.length - position);
        data.copy(buffer, offset, position, position + count);
        return count;
      },
      closeSync: () => {},
    };

    assert.equal(
      readLatestRouterModel("ignored", { sessionId: "session-a", tailBytes: 64 * 1024, fileSystem }),
      "subscription-swe → bounded",
    );
    assert.ok(reads.length > 0);
    assert.ok(reads.every((read) => read.length <= 64 * 1024));
    assert.equal(reads[0].position, data.length - 64 * 1024);
  });
});

describe("ModelStatusRuntime lifecycle", () => {
  it("initializes status at session start and starts one watcher and timer", () => {
    const harness = createHarness(["subscription-swe → model-a"]);
    const updates: Array<[string, string | undefined]> = [];
    harness.runtime.start(context("session-a", (key, value) => updates.push([key, value])), "session-a");

    assert.deepEqual(updates, [[MODEL_STATUS_KEY, "subscription-swe → model-a"]]);
    assert.equal(harness.watchers.length, 1);
    assert.equal(harness.intervals.length, 1);
  });

  it("keeps repeated starts idempotent", () => {
    const harness = createHarness(["subscription-swe → model-a"]);
    const ctx = context("session-a");
    harness.runtime.start(ctx, "session-a");
    harness.runtime.start(ctx, "session-a");

    assert.equal(harness.watchers.length, 1);
    assert.equal(harness.intervals.length, 1);
  });

  it("shutdown closes the watcher and timer and late callbacks cannot use the old context", () => {
    const harness = createHarness(["subscription-swe → model-a", "subscription-swe → model-b"]);
    let active = true;
    let calls = 0;
    const oldCtx: any = {
      sessionManager: { getSessionId: () => "session-a" },
      get ui() {
        if (!active) throw new Error("stale context accessed");
        return { setStatus: () => { calls++; } };
      },
    };
    harness.runtime.start(oldCtx, "session-a");
    const watcher = harness.watchers[0];
    const interval = harness.intervals[0];

    harness.runtime.shutdown();
    active = false;
    watcher.fire();
    interval.callback();

    assert.equal(watcher.closeCount, 1);
    assert.equal(interval.cleared, true);
    assert.equal(calls, 1);
  });

  it("does not clear a known status when the bounded tail has no applicable session event", () => {
    const harness = createHarness(["subscription-swe → mine", undefined]);
    const updates: Array<string | undefined> = [];
    harness.runtime.start(context("mine", (_key, value) => updates.push(value)), "mine");
    harness.watchers[0].fire();
    assert.deepEqual(updates, ["subscription-swe → mine"]);
  });

  it("replacement sessions update only their fresh context", () => {
    const oldHarness = createHarness(["subscription-swe → old"]);
    const newHarness = createHarness(["subscription-swe → new", "subscription-swe → newer"]);
    const oldUpdates: Array<string | undefined> = [];
    const newUpdates: Array<string | undefined> = [];
    oldHarness.runtime.start(context("old", (_key, value) => oldUpdates.push(value)), "old");
    const abandonedWatcher = oldHarness.watchers[0];
    oldHarness.runtime.shutdown();

    newHarness.runtime.start(context("new", (_key, value) => newUpdates.push(value)), "new");
    abandonedWatcher.fire();
    newHarness.watchers[0].fire();

    assert.deepEqual(oldUpdates, ["subscription-swe → old"]);
    assert.deepEqual(newUpdates, ["subscription-swe → new", "subscription-swe → newer"]);
  });

  it("contains rapid append/shutdown callback races and callback exceptions", () => {
    const harness = createHarness(["subscription-swe → model-a"]);
    const ctx = context("session-a", () => { throw new Error("simulated stale guard"); });
    harness.runtime.start(ctx, "session-a");
    const watcher = harness.watchers[0];
    const interval = harness.intervals[0];

    for (let index = 0; index < 100; index++) {
      if (index === 25) harness.runtime.shutdown();
      assert.doesNotThrow(() => watcher.fire());
      assert.doesNotThrow(() => interval.callback());
    }
    assert.equal(watcher.closeCount, 1);
    assert.equal(interval.cleared, true);
  });
});

describe("model status extension wiring", () => {
  it("uses session_start only and tears down on every session_shutdown", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const harness: Harness = createHarness([undefined]);
    const extension = createModelStatusExtension({
      eventsPath: "/fake/events.jsonl",
      readLatest: () => undefined,
      fileExists: () => true,
      watchFile: (_path, callback) => {
        const watcher = new FakeWatcher();
        watcher.on("change", callback);
        harness.watchers.push(watcher);
        return watcher as any;
      },
      setIntervalFn: (callback) => {
        const interval = { callback, cleared: false, unref() {} };
        harness.intervals.push(interval);
        return interval as any;
      },
      clearIntervalFn: (interval) => { (interval as any).cleared = true; },
    });
    extension({ on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as any);

    assert.deepEqual([...handlers.keys()].sort(), ["session_shutdown", "session_start"]);
    await handlers.get("session_start")?.({ reason: "reload" }, context("replacement"));
    assert.equal(harness.watchers.length, 1);
    assert.equal(harness.intervals.length, 1);
    await handlers.get("session_shutdown")?.({ reason: "fork" }, context("replacement"));
    assert.equal(harness.watchers[0].closeCount, 1);
    assert.equal(harness.intervals[0].cleared, true);
  });
});
