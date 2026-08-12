import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CacheOptimizerRouting,
  PI_CACHE_HINTS_SYMBOL,
  PI_ROUTING_REGISTRY_SYMBOL,
  applyCacheOptimizerHints,
  hashSessionId,
} from "../src/cache-optimizer-routing.ts";
import type { RouteTarget } from "../src/types.ts";

const target = (provider: string, modelId = `${provider}-model`): RouteTarget => ({ provider, modelId, label: provider });

describe("CacheOptimizerRouting", () => {
  it("registers the V1 adapter and exposes candidate routes", () => {
    const globals: Record<symbol, unknown> = {};
    const routing = new CacheOptimizerRouting("auto-router", () => [target("anthropic"), target("openai")]);
    assert.equal(routing.register(globals), true);
    const registry = globals[PI_ROUTING_REGISTRY_SYMBOL] as any;
    assert.equal(registry.version, 1);
    const adapter = registry.getRouter("auto-router");
    assert.deepEqual(adapter.resolveCandidateRoutes("swe").map((snapshot: any) => snapshot.provider), ["anthropic", "openai"]);
  });

  it("does not overwrite an incompatible protocol global", () => {
    const incompatible = { version: 2 };
    const globals: Record<symbol, unknown> = { [PI_ROUTING_REGISTRY_SYMBOL]: incompatible };
    const routing = new CacheOptimizerRouting("auto-router", () => []);
    assert.equal(routing.register(globals), false);
    assert.equal(globals[PI_ROUTING_REGISTRY_SYMBOL], incompatible);
  });

  it("keeps route snapshots isolated across concurrent sessions and requests", () => {
    const globals: Record<symbol, unknown> = {};
    const routing = new CacheOptimizerRouting("auto-router", () => []);
    routing.register(globals);
    const adapter = (globals[PI_ROUTING_REGISTRY_SYMBOL] as any).getRouter("auto-router");

    routing.publish("swe", target("anthropic"), "trying", { sessionId: "session-a", requestId: "request-a", api: "anthropic-messages" });
    routing.publish("swe", target("openai"), "success", { sessionId: "session-b", requestId: "request-b", api: "openai-responses" });

    assert.equal(adapter.resolveActiveRoute("swe", { sessionIdHash: hashSessionId("session-a"), requestId: "request-a" }).provider, "anthropic");
    assert.equal(adapter.resolveActiveRoute("swe", { sessionIdHash: hashSessionId("session-b"), requestId: "request-b" }).provider, "openai");
    assert.equal(adapter.resolveActiveRoute("swe", { sessionIdHash: hashSessionId("session-a"), requestId: "request-b" }), undefined);
  });

  it("notifies subscribers of route changes and unregisters cleanly", () => {
    const globals: Record<symbol, unknown> = {};
    const routing = new CacheOptimizerRouting("auto-router", () => []);
    routing.register(globals);
    const adapter = (globals[PI_ROUTING_REGISTRY_SYMBOL] as any).getRouter("auto-router");
    const events: string[] = [];
    const unsubscribe = adapter.subscribe((snapshot: any) => events.push(`${snapshot.status}:${snapshot.provider}`));
    routing.publish("swe", target("anthropic"), "trying", { sessionId: "a" });
    routing.publish("swe", target("openai"), "success", { sessionId: "a" });
    unsubscribe();
    routing.publish("swe", target("google"), "failed", { sessionId: "a" });
    assert.deepEqual(events, ["trying:anthropic", "success:openai"]);
    routing.unregisterAdapter();
    assert.equal((globals[PI_ROUTING_REGISTRY_SYMBOL] as any).getRouter("auto-router"), undefined);
  });
});

describe("applyCacheOptimizerHints", () => {
  const model = { provider: "anthropic", id: "claude", api: "anthropic-messages" } as any;
  const context = { systemPrompt: "original", messages: [] } as any;

  it("is a no-op when the optimizer is absent or disabled", () => {
    assert.deepEqual(applyCacheOptimizerHints(context, {}, "swe", model, "session", {}), { context, options: {} });
    const globals: Record<symbol, unknown> = {
      [PI_CACHE_HINTS_SYMBOL]: { version: 1, getHints: () => undefined },
    };
    assert.deepEqual(applyCacheOptimizerHints(context, {}, "swe", model, "session", globals), { context, options: {} });
  });

  it("queries with upstream identity and forwards the effective system prompt through Context", () => {
    let input: any;
    const globals: Record<symbol, unknown> = {
      [PI_CACHE_HINTS_SYMBOL]: {
        version: 1,
        getHints(value: any) {
          input = value;
          return { systemPrompt: "optimized", promptCacheKey: "cache-key", cacheRetention: "long" };
        },
      },
    };
    const result = applyCacheOptimizerHints(context, { maxTokens: 42 }, "swe", model, "session", globals);
    assert.equal(result.context.systemPrompt, "optimized");
    assert.deepEqual(result.context.messages, []);
    assert.equal(result.options.sessionId, "cache-key");
    assert.equal(result.options.cacheRetention, "long");
    assert.equal(result.options.maxTokens, 42);
    assert.deepEqual(input, {
      sessionIdHash: hashSessionId("session"),
      virtualProvider: "auto-router",
      virtualModelId: "swe",
      upstreamProvider: "anthropic",
      upstreamModelId: "claude",
      api: "anthropic-messages",
    });
  });

  it("preserves effective system prompts for OpenAI-family targets too", () => {
    const globals: Record<symbol, unknown> = {
      [PI_CACHE_HINTS_SYMBOL]: { version: 1, getHints: () => ({ systemPrompt: "openai optimized" }) },
    };
    const openai = { provider: "openai", id: "gpt", api: "openai-responses" } as any;
    const result = applyCacheOptimizerHints(context, {}, "swe", openai, "session", globals);
    assert.equal(result.context.systemPrompt, "openai optimized");
    assert.equal(result.context.messages.length, 0);
  });
});
