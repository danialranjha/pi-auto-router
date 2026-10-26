import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

// Exercise the public command and provider callbacks, not just diagnostic helpers.
// A private home and offline transport keep real credentials and providers untouched.
test("#22 warns before OAuth expiry and explains the empty route after expiry", { timeout: 20000 }, async () => {
  const home = mkdtempSync(join(os.tmpdir(), "router-oauth-warning-"));
  const originalHome = os.homedir;
  const originalFetch = globalThis.fetch;
  const oldUvi = process.env.AUTO_ROUTER_UVI;
  os.homedir = () => home;
  syncBuiltinESMExports();
  process.env.AUTO_ROUTER_UVI = "0";
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("Network forbidden in OAuth warning test"); };
  let runner: any;
  let shutdown: (() => Promise<unknown>) | undefined;
  let unregister: (() => void) | undefined;
  try {
    const dir = join(home, ".pi", "agent", "extensions");
    mkdirSync(dir, { recursive: true });
    const authPath = join(home, ".pi", "agent", "auth.json");
    const routesPath = join(dir, "auto-router.routes.json");
    const target = { provider: "oauth-warning-offline", modelId: "offline", authProvider: "openai", billing: "subscription", label: "OAuth" };
    const setRoute = (authProvider: string) => writeFileSync(routesPath, JSON.stringify({ routes: {
      oauth: { targets: [{ ...target, authProvider }, { ...target, authProvider, label: "Duplicate" }] },
    } }));
    const setAuth = (key: string, entry: object) => writeFileSync(authPath, JSON.stringify({ [key]: entry }));
    const oauth = { type: "oauth", access: "synthetic-access-secret", refresh: "synthetic-refresh-secret", expires: Date.now() + 3600000 };
    setRoute("openai");
    setAuth("openai", oauth);

    const { ExtensionRunner, SessionManager, createExtensionRuntime } = await import("@earendil-works/pi-coding-agent");
    const { registerApiProvider, unregisterApiProviders, createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/compat");
    const { default: extension } = await import("../index.ts");
    const handlers = new Map<string, any>();
    let command: any;
    let provider: any;
    extension({
      on: (event: string, handler: any) => handlers.set(event, handler),
      registerProvider: (_name: string, config: any) => { provider = config; },
      registerCommand: (name: string, config: any) => { if (name === "auto-router") command = config.handler; },
    } as any);
    const model: any = { provider: target.provider, id: "offline", name: "Offline", api: "oauth-warning-test",
      baseUrl: "http://unused.invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const manager = SessionManager.inMemory(home);
    runner = new ExtensionRunner([], createExtensionRuntime(), home, manager, { getAvailable: () => [model] } as any);
    const notifications: Array<{ message: string; level: string }> = [];
    runner.setUIContext({ ...runner.createContext().ui,
      notify: (message: string, level: string) => notifications.push({ message, level }),
    } as any);
    const ctx = () => runner.createContext();
    shutdown = () => handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx());
    await handlers.get("session_start")({ type: "session_start" }, ctx());
    const runCommand = async (args: string) => {
      notifications.length = 0;
      await command(args, ctx());
      assert.equal(notifications.length, 1);
      return notifications[0];
    };
    const assertDiagnostic = (message: string) => {
      assert.match(message, /authProvider "openai" has OAuth credentials that auto-router cannot refresh/);
      assert.match(message, /use authProvider "openai-codex"/);
      assert.match(message, /\/login/);
      assert.equal(message.split("has OAuth credentials").length - 1, 1, "deduplicated warning");
      assert.doesNotMatch(message, /synthetic-(access|refresh|key)-secret/);
    };
    for (const args of ["", "status", "list", "show oauth", "reload", "help"]) {
      const notification = await runCommand(args);
      assertDiagnostic(notification.message);
      if (args === "reload") assert.equal(notification.level, "warning");
    }

    let transportCalls = 0;
    const stream = (_model: any, _context: any, options: any) => {
      transportCalls++;
      assert.equal(options.apiKey, oauth.access);
      const result = createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api,
        provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      result.push({ type: "done", reason: "stop", message });
      result.end();
      return result;
    };
    registerApiProvider({ api: model.api, stream, streamSimple: stream }, "oauth-warning-test");
    unregister = () => unregisterApiProviders("oauth-warning-test");
    const route = () => provider.streamSimple({ ...model, provider: "auto-router", id: "oauth" }, {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    }, { sessionId: manager.getSessionId() }).result();
    assert.equal((await route()).stopReason, "stop", "unexpired unsupported key remains eligible");
    // Terminal response precedes persisted bookkeeping; don't remove its home early.
    const eventsPath = join(dir, "auto-router.events.jsonl");
    const deadline = Date.now() + 5000;
    while ((!existsSync(eventsPath) || !readFileSync(eventsPath, "utf8").includes('"routing.final"')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(eventsPath) && readFileSync(eventsPath, "utf8").includes('"routing.final"'));

    setAuth("openai", { ...oauth, expires: Date.now() - 1 });
    const failed = await route();
    assert.equal(failed.stopReason, "error");
    assertDiagnostic(failed.errorMessage ?? "");
    assert.equal(transportCalls, 1, "expired key is rejected before transport");
    assertDiagnostic((await runCommand("status")).message);

    setRoute("openai-codex");
    setAuth("openai-codex", oauth);
    for (const args of ["status", "show oauth", "reload"]) {
      const notification = await runCommand(args);
      assert.doesNotMatch(notification.message, /Warning:|cannot refresh/);
      assert.equal(notification.level, "info");
    }
    setRoute("openai");
    setAuth("openai", { type: "api_key", key: "synthetic-key-secret" });
    assert.doesNotMatch((await runCommand("reload")).message, /Warning:|cannot refresh/);
    assert.equal(networkCalls, 0);
  } finally {
    try {
      await shutdown?.();
    } finally {
      runner?.invalidate();
      unregister?.();
      globalThis.fetch = originalFetch;
      os.homedir = originalHome;
      syncBuiltinESMExports();
      if (oldUvi === undefined) delete process.env.AUTO_ROUTER_UVI;
      else process.env.AUTO_ROUTER_UVI = oldUvi;
      rmSync(home, { recursive: true, force: true });
    }
  }
});
