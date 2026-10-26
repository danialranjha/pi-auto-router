import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PI_ROUTING_REGISTRY_SYMBOL, hashSessionId } from "../src/cache-optimizer-routing.ts";

// Invoke the extension's registered hooks with real Pi runner contexts. Only the
// model registry/provider transport are fakes; no credentials or network needed.
test("shared extension survives child shutdown and cleans the last stale session", { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(os.tmpdir(), "router-lifecycle-"));
  const originalHome = os.homedir;
  os.homedir = () => home;
  syncBuiltinESMExports();
  const oldUvi = process.env.AUTO_ROUTER_UVI;
  process.env.AUTO_ROUTER_UVI = "0";
  try {
    const dir = join(home, ".pi", "agent", "extensions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auto-router.routes.json"), JSON.stringify({ routes: {
      lifecycle: { targets: [{ provider: "lifecycle-custom", modelId: "custom/model", label: "custom" }] },
      failover: { targets: [{ provider: "lifecycle-custom", modelId: "custom/model", label: "first" },
        { provider: "lifecycle-custom", modelId: "custom/fallback", label: "fallback" }] },
      missing: { targets: [{ provider: "lifecycle-custom", modelId: "missing", label: "missing" }] },
    } }));
    const { ExtensionRunner, SessionManager, createExtensionRuntime } = await import("@earendil-works/pi-coding-agent");
    const { registerApiProvider, unregisterApiProviders, createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/compat");
    const { default: extension } = await import("../index.ts");
    const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
    let provider: any;
    extension({
      on: (event: string, handler: any) => handlers.set(event, handler),
      registerProvider: (_name: string, config: any) => { provider = config; },
      registerCommand: () => {},
    } as any);
    const model: any = { provider: "lifecycle-custom", id: "custom/model", name: "Custom",
      api: "lifecycle-test", baseUrl: "http://unused.invalid", reasoning: false,
      input: ["text"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const bounded = <T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    const observe = <T>(promise: Promise<T>): Promise<T> => {
      // Routing can reject before the readiness barrier; cleanup awaits it below.
      void promise.catch(() => {});
      return promise;
    };
    let calls = 0;
    let deferred: { started: () => void; finish?: (retry?: boolean) => void } | undefined;
    const deferNext = () => {
      let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const pending = { started, finish: undefined as ((retry?: boolean) => void) | undefined };
      deferred = pending;
      return { ready, release: (retry = false) => pending.finish?.(retry) };
    };
    const stream = (_model: any, _context: any, options: any) => {
      calls++;
      const result = createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: [{ type: "text", text: "ok" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const finish = (retry = false) => {
        options?.signal?.removeEventListener("abort", aborted);
        if (retry) result.push({ type: "error", reason: "error", error: {
          ...message, content: [], stopReason: "error", errorMessage: "503 Service unavailable",
        } });
        else result.push({ type: "done", reason: "stop", message });
        result.end();
      };
      const aborted = () => {
        options?.signal?.removeEventListener("abort", aborted);
        result.push({ type: "error", reason: "aborted", error: {
          ...message, content: [], stopReason: "aborted", errorMessage: "Request aborted",
        } });
        result.end();
      };
      if (deferred) {
        const pending = deferred;
        deferred = undefined;
        pending.finish = finish;
        options?.signal?.addEventListener("abort", aborted, { once: true });
        pending.started();
      } else finish();
      return result;
    };
    registerApiProvider({ api: model.api, stream, streamSimple: stream }, "lifecycle-test");
    try {
      const registry: any = { getAvailable: () => [model, { ...model, id: "custom/fallback" }] };
      const session = () => {
        const manager = SessionManager.inMemory(home);
        const runner = new ExtensionRunner([], createExtensionRuntime(), home, manager, registry);
        return { runner, id: manager.getSessionId(), ctx: () => runner.createContext() };
      };
      const emit = (event: string, s: ReturnType<typeof session>) => handlers.get(event)!({ type: event }, s.ctx());
      const adapter = () => (globalThis as any)[PI_ROUTING_REGISTRY_SYMBOL].getRouter("auto-router");
      const eventsPath = join(dir, "auto-router.events.jsonl");
      const finals = () => existsSync(eventsPath)
        ? readFileSync(eventsPath, "utf8").split("\n").filter(line => line && JSON.parse(line).type === "routing.final").length
        : 0;
      const route = async (id: string | undefined, routeId = "lifecycle", signal?: AbortSignal) => {
        const before = finals();
        const outer = { ...model, provider: "auto-router", id: routeId };
        const result = await bounded<AssistantMessage>(provider.streamSimple(outer, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { sessionId: id, signal }).result(), "router response", 15000);
        // A terminal event precedes async bookkeeping. Wait for its persisted
        // routing.final before shutdown/cleanup so no writes outlive the test.
        const deadline = Date.now() + 5000;
        while (finals() <= before && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(finals(), before + 1, "routing bookkeeping completed");
        return result;
      };
      const main = session();
      const child = session();
      await emit("session_start", main);
      await emit("session_start", child);
      assert.equal((await route(child.id)).stopReason, "stop");
      const sharedAdapter = adapter();
      assert.ok(sharedAdapter.resolveActiveRoute("lifecycle", { sessionIdHash: hashSessionId(child.id) }));
      await emit("agent_start", main);
      const parentPending = deferNext();
      const parentResponse = observe(route(undefined)); // Capture fallback origin before async setup.
      await emit("agent_start", child); // Recency changes before transport starts.
      try {
        await bounded(parentPending.ready, "parent transport readiness");
        await emit("session_shutdown", child);
        child.runner.invalidate();
        assert.equal(adapter(), sharedAdapter, "child shutdown preserves adapter during parent request");
        assert.equal(sharedAdapter.resolveActiveRoute("lifecycle", {
          sessionIdHash: hashSessionId(main.id),
        })?.status, "trying", "surviving parent keeps its in-flight snapshot");
      } finally {
        parentPending.release();
        assert.equal((await bounded(parentResponse, "parent completion")).stopReason, "stop");
      }
      assert.equal(adapter(), sharedAdapter);
      assert.equal(sharedAdapter.resolveActiveRoute("lifecycle", { sessionIdHash: hashSessionId(child.id) }), undefined);
      assert.equal((await route(main.id)).stopReason, "stop");
      assert.ok(sharedAdapter.resolveActiveRoute("lifecycle", { sessionIdHash: hashSessionId(main.id) }));
      const missing = await route(main.id, "missing");
      assert.match(missing.errorMessage ?? "", /Available providers: lifecycle-custom/);

      const orphan = session();
      await emit("session_start", orphan);
      await route(orphan.id);
      await emit("session_shutdown", main);
      main.runner.invalidate();
      assert.ok(adapter());
      orphan.runner.invalidate(); // Simulate disposal with no shutdown hook.
      await emit("agent_end", orphan); // Next tracker operation lazily prunes it.
      assert.equal(adapter(), undefined);
      assert.equal(sharedAdapter.resolveActiveRoute("lifecycle"), undefined);

      const next = session();
      await emit("session_start", next);
      assert.ok(adapter());
      assert.equal((await route(next.id)).stopReason, "stop");
      for (const completion of ["late success", "abort", "failover"] as const) {
        const active = completion === "late success" ? next : session();
        if (active !== next) await emit("session_start", active);
        const retained = adapter();
        const pending = deferNext();
        const controller = new AbortController();
        const routeId = completion === "failover" ? "failover" : "lifecycle";
        const response = observe(route(active.id, routeId, controller.signal));
        try {
          await bounded(pending.ready, `${completion} transport readiness`);
          assert.equal(retained.resolveActiveRoute(routeId, {
            sessionIdHash: hashSessionId(active.id),
          })?.status, "trying");
          await emit("session_shutdown", active);
          active.runner.invalidate();
          assert.equal(adapter(), undefined, `${completion}: last shutdown unregisters immediately`);
          assert.equal(retained.resolveActiveRoute(routeId), undefined);
        } finally {
          if (completion === "abort") controller.abort();
          else pending.release(completion === "failover");
          const result = await bounded(response, `${completion} completion`); // Includes persisted routing.final bookkeeping.
          assert.equal(result.stopReason, completion === "abort" ? "aborted" : "stop");
        }
        assert.equal(adapter(), undefined, `${completion}: completion cannot re-register`);
        assert.equal(retained.resolveActiveRoute(routeId), undefined,
          `${completion}: completion cannot resurrect a cleared snapshot`);
        const replacement = session();
        await emit("session_start", replacement);
        assert.equal(adapter().resolveActiveRoute(routeId, {
          sessionIdHash: hashSessionId(active.id),
        }), undefined, `${completion}: later registration cannot expose an ended snapshot`);
        await emit("session_shutdown", replacement);
        replacement.runner.invalidate();
      }
      assert.equal(calls, 9);
    } finally {
      unregisterApiProviders("lifecycle-test");
    }
  } finally {
    os.homedir = originalHome;
    syncBuiltinESMExports();
    if (oldUvi === undefined) delete process.env.AUTO_ROUTER_UVI;
    else process.env.AUTO_ROUTER_UVI = oldUvi;
    rmSync(home, { recursive: true, force: true });
    assert.equal(existsSync(home), false, "owned home removed");
  }
});
