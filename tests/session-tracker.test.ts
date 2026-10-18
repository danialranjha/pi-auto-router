import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionTracker } from "../src/session-tracker.ts";
import { CacheOptimizerRouting, PI_ROUTING_REGISTRY_SYMBOL, hashSessionId } from "../src/cache-optimizer-routing.ts";

const registry = { getAvailable: () => [{ provider: "my-provider", id: "vendor-a/model-1" }] };

// A fake pi session. Like pi, it gives a new context object for each event,
// and all its contexts throw after the session is invalidated.
function fakeSession(id: string) {
  let stale = false;
  const ctx = () => ({
    get sessionManager() {
      if (stale) throw new Error("This extension ctx is stale");
      return { getSessionId: () => id };
    },
    get modelRegistry() {
      if (stale) throw new Error("This extension ctx is stale");
      return registry;
    },
  });
  return { ctx, invalidate: () => { stale = true; } };
}

// The tracker and the shutdown hook as index.ts wires them.
function harness() {
  const globals: Record<symbol, unknown> = {};
  const routing = new CacheOptimizerRouting("auto-router", () => []);
  routing.register(globals);
  const ended: string[] = [];
  const sessions = createSessionTracker((id) => {
    ended.push(id);
    routing.clearSession(id);
  }, () => routing.unregisterAdapter());
  const shutdown = (ctx: any) => {
    sessions.end(ctx);
  };
  const adapter = () => (globals[PI_ROUTING_REGISTRY_SYMBOL] as any).getRouter("auto-router");
  const publish = (sessionId: string) =>
    routing.publish("swe", { provider: "p", modelId: "m", label: "p" }, "success", { sessionId, requestId: "r" });
  const snapshot = (sessionId: string) =>
    adapter()?.resolveActiveRoute("swe", { sessionIdHash: hashSessionId(sessionId), requestId: "r" });
  return { sessions, shutdown, adapter, publish, snapshot, ended, routing, globals };
}

describe("session-tracker", () => {
  it("keeps the main session current when a subagent session ends", () => {
    const sessions = createSessionTracker();
    const main = fakeSession("main");
    const child = fakeSession("child");
    sessions.update(main.ctx());
    sessions.update(child.ctx());
    assert.equal(sessions.sessionId(), "child");

    sessions.end(child.ctx());
    child.invalidate();

    assert.equal(sessions.sessionId(), "main");
    assert.equal(sessions.context().sessionManager.getSessionId(), "main");
    assert.equal(sessions.registry(), registry);
    assert.equal(sessions.hasLiveSessions(), true);
  });

  it("keeps the current session when a session that is not current ends", () => {
    const sessions = createSessionTracker();
    const main = fakeSession("main");
    const child = fakeSession("child");
    sessions.update(child.ctx());
    sessions.update(main.ctx());
    sessions.end(child.ctx());
    assert.equal(sessions.sessionId(), "main");
  });

  it("returns the last registry after every session ends", () => {
    const sessions = createSessionTracker();
    const main = fakeSession("main");
    sessions.update(main.ctx());
    sessions.end(main.ctx());
    main.invalidate();
    assert.equal(sessions.hasLiveSessions(), false);
    assert.equal(sessions.context(), undefined);
    assert.equal(sessions.sessionId(), undefined);
    assert.equal(sessions.registry(), registry);
  });

  it("returns the last registry when the current context is stale", () => {
    const sessions = createSessionTracker();
    const child = fakeSession("child");
    sessions.update(child.ctx());
    // pi-subagents disposes a child even when its shutdown hooks time out.
    child.invalidate();
    assert.equal(sessions.registry(), registry);
  });

  it("ignores a context that is stale before registration", () => {
    const sessions = createSessionTracker();
    const main = fakeSession("main");
    const old = fakeSession("old");
    old.invalidate();
    sessions.update(main.ctx());
    sessions.update(old.ctx());
    sessions.end(old.ctx());
    assert.equal(sessions.sessionId(), "main");
  });

  it("removes a registered child that becomes stale before its shutdown", () => {
    const h = harness();
    const main = fakeSession("main");
    const child = fakeSession("child");
    h.sessions.update(main.ctx());
    h.sessions.update(child.ctx());
    h.publish("main");
    h.publish("child");

    child.invalidate();
    assert.equal(h.sessions.registry(), registry);
    h.shutdown(child.ctx());

    assert.deepEqual(h.ended, ["child"]);
    assert.equal(h.sessions.sessionId(), "main");
    assert.equal(h.snapshot("child"), undefined);
    assert.equal(h.snapshot("main")?.provider, "p");
    assert.ok(h.adapter());

    h.shutdown(main.ctx());
    main.invalidate();
    assert.equal(h.sessions.hasLiveSessions(), false);
    assert.equal(h.sessions.sessionId(), undefined);
    assert.equal(h.sessions.context(), undefined);
    assert.equal(h.adapter(), undefined);
  });

  it("removes a child disposed without shutdown when the main session ends", () => {
    const h = harness();
    const main = fakeSession("main");
    const child = fakeSession("child");
    h.sessions.update(main.ctx());
    h.sessions.update(child.ctx());
    h.publish("main");
    h.publish("child");

    // No session_shutdown for the child.
    child.invalidate();
    // Keep the adapter object: unregister hides it from the registry.
    const adapter = h.adapter();
    h.shutdown(main.ctx());
    main.invalidate();

    assert.deepEqual(h.ended, ["main", "child"]);
    assert.equal(h.sessions.hasLiveSessions(), false);
    assert.equal(h.sessions.sessionId(), undefined);
    assert.equal(h.sessions.context(), undefined);
    const resolve = (id: string) =>
      adapter.resolveActiveRoute("swe", { sessionIdHash: hashSessionId(id), requestId: "r" });
    assert.equal(resolve("child"), undefined);
    assert.equal(resolve("main"), undefined);
    assert.equal(h.adapter(), undefined);
  });

  it("removes a stale session on end() with no read before it", () => {
    const h = harness();
    const main = fakeSession("main");
    const child = fakeSession("child");
    h.sessions.update(main.ctx());
    h.sessions.update(child.ctx());
    child.invalidate();
    h.sessions.end(child.ctx());
    assert.deepEqual(h.ended, ["child"]);
    assert.equal(h.sessions.sessionId(), "main");
  });

  it("removes a child disposed without shutdown on the next read", () => {
    const h = harness();
    const main = fakeSession("main");
    const child = fakeSession("child");
    h.sessions.update(main.ctx());
    h.sessions.update(child.ctx());
    child.invalidate();
    assert.equal(h.sessions.sessionId(), "main");
    assert.deepEqual(h.ended, ["child"]);
  });
});


describe("last-session cleanup", () => {
  for (const read of ["context", "sessionId", "hasLiveSessions", "registry"] as const) {
    it(`unregisters after ${read} prunes the last stale session`, () => {
      const h = harness();
      const main = fakeSession("main");
      const child = fakeSession("child");
      h.sessions.update(main.ctx());
      h.sessions.update(child.ctx());
      h.publish("main");
      h.publish("child");
      const adapter = h.adapter();
      h.shutdown(main.ctx());
      child.invalidate(); // No shutdown callback.
      h.sessions[read]();
      assert.equal(h.adapter(), undefined);
      for (const id of ["main", "child"]) {
        assert.equal(adapter.resolveActiveRoute("swe", {
          sessionIdHash: hashSessionId(id), requestId: "r",
        }), undefined);
      }
      assert.deepEqual(h.ended, ["main", "child"]);
      assert.equal(h.sessions.registry(), registry);
    });
  }

  it("keeps the adapter when update replaces the last stale session", () => {
    const h = harness();
    const old = fakeSession("old");
    h.sessions.update(old.ctx());
    h.publish("old");
    old.invalidate();
    h.sessions.update(fakeSession("new").ctx());
    assert.ok(h.adapter());
    assert.equal(h.sessions.sessionId(), "new");
    assert.equal(h.snapshot("old"), undefined);
    assert.deepEqual(h.ended, ["old"]);
  });

  it("unregisters on stale update and permits a subsequent registration", () => {
    const h = harness();
    const old = fakeSession("old");
    h.sessions.update(old.ctx());
    old.invalidate();
    h.sessions.update(old.ctx());
    assert.equal(h.adapter(), undefined);
    h.routing.register(h.globals);
    h.sessions.update(fakeSession("new").ctx());
    assert.ok(h.adapter());
    h.shutdown(old.ctx());
    assert.equal(h.sessions.sessionId(), "new");
    h.routing.unregisterAdapter();
  });

  it("does not repeat cleanup for duplicate shutdown or later reads", () => {
    const h = harness();
    const main = fakeSession("main");
    h.sessions.update(main.ctx());
    h.shutdown(main.ctx());
    h.shutdown(main.ctx());
    h.sessions.hasLiveSessions();
    assert.deepEqual(h.ended, ["main"]);
  });
});
