import { createHash } from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { RouteTarget } from "./types.ts";

export const PI_ROUTING_REGISTRY_SYMBOL = Symbol.for("pi.routing.registry.v1");
export const PI_CACHE_HINTS_SYMBOL = Symbol.for("pi.cache.hints.v1");

export type RouteStatus = "planned" | "trying" | "selected" | "success" | "failed";
export type RouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: RouteStatus;
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type RouteHint = { sessionIdHash?: string; requestId?: string };
type RouterAdapter = {
  virtualProvider: string;
  resolveActiveRoute(virtualModelId: string, hint?: RouteHint): RouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): RouteSnapshot[];
  subscribe?(listener: (snapshot: RouteSnapshot) => void): () => void;
};
type RoutingRegistry = {
  version: 1;
  registerRouter(adapter: RouterAdapter): () => void;
  getRouter(provider: string): RouterAdapter | undefined;
};
type CacheHintsService = {
  version: 1;
  getHints(input: {
    sessionIdHash?: string;
    virtualProvider?: string;
    virtualModelId?: string;
    upstreamProvider?: string;
    upstreamModelId?: string;
    api?: string;
  }): { systemPrompt?: string; promptCacheKey?: string; cacheRetention?: "long" } | undefined;
};

export function hashSessionId(sessionId?: string): string | undefined {
  return sessionId ? createHash("sha256").update(sessionId).digest("hex").slice(0, 16) : undefined;
}

function isRegistry(value: unknown): value is RoutingRegistry {
  const registry = value as Partial<RoutingRegistry> | undefined;
  return registry?.version === 1 && typeof registry.registerRouter === "function" && typeof registry.getRouter === "function";
}

function createRegistry(): RoutingRegistry {
  const routers = new Map<string, RouterAdapter>();
  return {
    version: 1,
    registerRouter(adapter) {
      routers.set(adapter.virtualProvider, adapter);
      return () => { if (routers.get(adapter.virtualProvider) === adapter) routers.delete(adapter.virtualProvider); };
    },
    getRouter(provider) { return routers.get(provider); },
  };
}

/** Session/request-scoped implementation of pi-cache-optimizer's routing V1 protocol. */
export class CacheOptimizerRouting {
  private readonly snapshots = new Map<string, RouteSnapshot>();
  private readonly listeners = new Set<(snapshot: RouteSnapshot) => void>();
  private unregister?: () => void;

  constructor(
    private readonly virtualProvider: string,
    private readonly getCandidates: (virtualModelId: string) => RouteTarget[],
  ) {}

  register(globals: Record<symbol, unknown> = globalThis as Record<symbol, unknown>): boolean {
    if (this.unregister) return true;
    const existing = globals[PI_ROUTING_REGISTRY_SYMBOL];
    if (existing !== undefined && !isRegistry(existing)) return false;
    const registry = existing ?? createRegistry();
    if (existing === undefined) globals[PI_ROUTING_REGISTRY_SYMBOL] = registry;
    this.unregister = (registry as RoutingRegistry).registerRouter({
      virtualProvider: this.virtualProvider,
      resolveActiveRoute: (modelId, hint) => this.resolve(modelId, hint),
      resolveCandidateRoutes: (modelId) => this.candidates(modelId),
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    });
    return true;
  }

  unregisterAdapter(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  publish(
    virtualModelId: string,
    target: RouteTarget,
    status: RouteStatus,
    scope: { sessionId?: string; requestId?: string; api?: string },
  ): RouteSnapshot {
    const snapshot: RouteSnapshot = {
      virtualProvider: this.virtualProvider,
      virtualModelId,
      provider: target.provider,
      modelId: target.modelId,
      api: scope.api,
      canonicalModelId: target.modelId,
      routeLabel: target.label,
      status,
      sessionIdHash: hashSessionId(scope.sessionId),
      requestId: scope.requestId,
      timestamp: Date.now(),
    };
    this.snapshots.set(this.key(virtualModelId, snapshot.sessionIdHash, snapshot.requestId), snapshot);
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  clearSession(sessionId?: string): void {
    const sessionIdHash = hashSessionId(sessionId);
    for (const [key, snapshot] of this.snapshots) {
      if (!sessionIdHash || snapshot.sessionIdHash === sessionIdHash) this.snapshots.delete(key);
    }
  }

  private key(modelId: string, sessionIdHash?: string, requestId?: string): string {
    return `${sessionIdHash ?? ""}:${requestId ?? ""}:${modelId}`;
  }

  private resolve(modelId: string, hint?: RouteHint): RouteSnapshot | undefined {
    if (hint?.requestId) return this.snapshots.get(this.key(modelId, hint.sessionIdHash, hint.requestId));
    let latest: RouteSnapshot | undefined;
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.virtualModelId !== modelId) continue;
      if (hint?.sessionIdHash && snapshot.sessionIdHash !== hint.sessionIdHash) continue;
      if (!latest || snapshot.timestamp >= latest.timestamp) latest = snapshot;
    }
    return latest;
  }

  private candidates(modelId: string): RouteSnapshot[] {
    return this.getCandidates(modelId).map((target) => ({
      virtualProvider: this.virtualProvider,
      virtualModelId: modelId,
      provider: target.provider,
      modelId: target.modelId,
      canonicalModelId: target.modelId,
      routeLabel: target.label,
      status: "planned",
      timestamp: Date.now(),
    }));
  }
}

/** Apply query-scoped optimizer hints without relying on deprecated globals. */
export function applyCacheOptimizerHints(
  context: Context,
  options: SimpleStreamOptions,
  virtualModelId: string,
  upstreamModel: Model<Api>,
  sessionId?: string,
  globals: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): { context: Context; options: SimpleStreamOptions } {
  const service = globals[PI_CACHE_HINTS_SYMBOL] as Partial<CacheHintsService> | undefined;
  if (service?.version !== 1 || typeof service.getHints !== "function") return { context, options };

  const hints = service.getHints({
    sessionIdHash: hashSessionId(sessionId),
    virtualProvider: "auto-router",
    virtualModelId,
    upstreamProvider: upstreamModel.provider,
    upstreamModelId: upstreamModel.id,
    api: upstreamModel.api,
  });
  if (!hints) return { context, options };

  return {
    context: hints.systemPrompt === undefined ? context : { ...context, systemPrompt: hints.systemPrompt },
    options: {
      ...options,
      ...(hints.promptCacheKey ? { sessionId: hints.promptCacheKey } : {}),
      ...(hints.cacheRetention ? { cacheRetention: hints.cacheRetention } : {}),
    },
  };
}
