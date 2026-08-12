import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  watch,
  type FSWatcher,
} from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MODEL_STATUS_KEY = "auto-router-model";
export const DEFAULT_MODEL_STATUS_TAIL_BYTES = 64 * 1024;
export const DEFAULT_MODEL_STATUS_POLL_MS = 1_000;

export type ModelStatusEvent = {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  routeId?: string;
  data?: {
    actualTarget?: { provider?: string; modelId?: string };
    plannedTarget?: { provider?: string; modelId?: string };
  };
};

export type TailFileSystem = {
  openSync(path: string, flags: string): number;
  fstatSync(fd: number): { size: number };
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
};

const nodeTailFileSystem: TailFileSystem = { openSync, fstatSync, readSync, closeSync };

export type ReadLatestRouterModelOptions = {
  tailBytes?: number;
  sessionId?: string;
  fileSystem?: TailFileSystem;
};

/** Read and parse at most the final tailBytes of an append-only JSONL event log. */
export function readLatestRouterModel(
  eventsPath: string,
  options: ReadLatestRouterModelOptions = {},
): string | undefined {
  const tailBytes = Math.max(1, options.tailBytes ?? DEFAULT_MODEL_STATUS_TAIL_BYTES);
  const fileSystem = options.fileSystem ?? nodeTailFileSystem;
  let fd: number | undefined;

  try {
    fd = fileSystem.openSync(eventsPath, "r");
    const size = fileSystem.fstatSync(fd).size;
    if (size <= 0) return undefined;

    const start = Math.max(0, size - tailBytes);
    const requestedBytes = size - start;
    const buffer = Buffer.allocUnsafe(requestedBytes);
    let bytesRead = 0;
    while (bytesRead < requestedBytes) {
      const count = fileSystem.readSync(
        fd,
        buffer,
        bytesRead,
        requestedBytes - bytesRead,
        start + bytesRead,
      );
      if (count <= 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0) return undefined;

    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    const endsWithNewline = raw.endsWith("\n");
    let lines = raw.split("\n");

    // A non-zero tail starts at an arbitrary byte and therefore its first record
    // cannot be trusted. A non-newline-terminated final record may still be in flight.
    if (start > 0) lines = lines.slice(1);
    if (!endsWithNewline) lines = lines.slice(0, -1);

    let best: { timestamp: number; order: number; routeId: string; modelId: string } | undefined;
    for (let order = 0; order < lines.length; order++) {
      const line = lines[order].trim();
      if (!line) continue;

      let event: ModelStatusEvent;
      try {
        event = JSON.parse(line) as ModelStatusEvent;
      } catch {
        continue;
      }
      if (options.sessionId !== undefined && event.sessionId !== options.sessionId) continue;

      const target = event.type === "routing.final"
        ? event.data?.actualTarget
        : event.type === "routing.decision"
          ? event.data?.plannedTarget
          : undefined;
      const routeId = event.routeId;
      const modelId = target?.modelId;
      if (!routeId || !modelId) continue;

      const parsedTimestamp = Date.parse(event.timestamp ?? "");
      const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0;
      if (!best || timestamp > best.timestamp || (timestamp === best.timestamp && order > best.order)) {
        best = { timestamp, order, routeId, modelId };
      }
    }

    return best ? `${best.routeId} → ${best.modelId}` : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fileSystem.closeSync(fd);
      } catch {
        // Best-effort close after a failed or concurrent read.
      }
    }
  }
}

type WatcherLike = Pick<FSWatcher, "close" | "unref" | "on">;
type IntervalHandle = ReturnType<typeof setInterval>;

type ModelStatusRuntimeOptions = {
  eventsPath: string;
  tailBytes?: number;
  pollIntervalMs?: number;
  readLatest?: (eventsPath: string, options: ReadLatestRouterModelOptions) => string | undefined;
  fileExists?: (eventsPath: string) => boolean;
  watchFile?: (eventsPath: string, callback: () => void) => WatcherLike;
  setIntervalFn?: (callback: () => void, intervalMs: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
};

type ActiveStatusRuntime = {
  active: boolean;
  ctx?: ExtensionContext;
  sessionId: string;
  lastValue: string | undefined;
  initialized: boolean;
  interval?: IntervalHandle;
  watcher?: WatcherLike;
};

/** Session-scoped owner for the status integration's external resources. */
export class ModelStatusRuntime {
  private active?: ActiveStatusRuntime;

  constructor(private readonly options: ModelStatusRuntimeOptions) {}

  start(ctx: ExtensionContext, sessionId: string): void {
    if (this.active?.active && this.active.ctx === ctx && this.active.sessionId === sessionId) {
      this.apply(this.active);
      return;
    }
    this.shutdown();

    const state: ActiveStatusRuntime = {
      active: true,
      ctx,
      sessionId,
      lastValue: undefined,
      initialized: false,
    };
    this.active = state;

    this.apply(state);
    this.ensureWatcher(state);

    const setIntervalFn: NonNullable<ModelStatusRuntimeOptions["setIntervalFn"]> =
      this.options.setIntervalFn ?? (setInterval as NonNullable<ModelStatusRuntimeOptions["setIntervalFn"]>);
    state.interval = setIntervalFn(() => {
      this.runExternalCallback(state, () => {
        this.apply(state);
        this.ensureWatcher(state);
      });
    }, this.options.pollIntervalMs ?? DEFAULT_MODEL_STATUS_POLL_MS);
    state.interval?.unref?.();
  }

  shutdown(): void {
    const state = this.active;
    if (!state) return;

    // Invalidate first. A queued callback may run while handles are being closed.
    state.active = false;
    state.ctx = undefined;
    this.active = undefined;

    if (state.interval !== undefined) {
      try {
        (this.options.clearIntervalFn ?? clearInterval)(state.interval);
      } catch {
        // Teardown remains best-effort and idempotent.
      }
      state.interval = undefined;
    }
    if (state.watcher) {
      try {
        state.watcher.close();
      } catch {
        // Teardown remains best-effort and idempotent.
      }
      state.watcher = undefined;
    }
  }

  private isCurrent(state: ActiveStatusRuntime): boolean {
    return state.active && this.active === state && state.ctx !== undefined;
  }

  private runExternalCallback(state: ActiveStatusRuntime, callback: () => void): void {
    if (!this.isCurrent(state)) return;
    try {
      callback();
    } catch {
      // Raw Node timer/watcher callbacks must never escape to process-level handlers.
    }
  }

  private apply(state: ActiveStatusRuntime): void {
    if (!this.isCurrent(state)) return;
    try {
      const readLatest = this.options.readLatest ?? readLatestRouterModel;
      const nextValue = readLatest(this.options.eventsPath, {
        tailBytes: this.options.tailBytes,
        sessionId: state.sessionId,
      });
      // Once initialized, an empty tail means "no applicable record in this
      // bounded window", not that another session should clear our status.
      if (state.initialized && (nextValue === undefined || nextValue === state.lastValue)) return;
      state.lastValue = nextValue;
      state.initialized = true;
      state.ctx?.ui.setStatus(MODEL_STATUS_KEY, nextValue);
    } catch {
      // Includes read races and a context invalidated concurrently with callback entry.
    }
  }

  private ensureWatcher(state: ActiveStatusRuntime): void {
    if (!this.isCurrent(state) || state.watcher) return;
    const fileExists = this.options.fileExists ?? existsSync;
    if (!fileExists(this.options.eventsPath)) return;

    try {
      const watchFile = this.options.watchFile
        ?? ((eventsPath: string, callback: () => void) => watch(eventsPath, { persistent: false }, callback));
      const watcher = watchFile(this.options.eventsPath, () => {
        this.runExternalCallback(state, () => this.apply(state));
      });
      state.watcher = watcher;
      watcher.unref?.();
      watcher.on("error", () => {
        this.runExternalCallback(state, () => {
          if (state.watcher === watcher) {
            try {
              watcher.close();
            } catch {
              // Polling remains available as fallback.
            }
            state.watcher = undefined;
          }
        });
      });
    } catch {
      // Polling remains available as fallback.
    }
  }
}

export type ModelStatusExtensionOptions = ModelStatusRuntimeOptions;

export function createModelStatusExtension(options: ModelStatusExtensionOptions) {
  return function modelStatusExtension(pi: ExtensionAPI): void {
    const runtime = new ModelStatusRuntime(options);
    pi.on("session_start", async (_event, ctx) => {
      runtime.start(ctx, ctx.sessionManager.getSessionId());
    });
    pi.on("session_shutdown", async () => {
      runtime.shutdown();
    });
  };
}
