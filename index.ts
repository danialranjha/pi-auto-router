import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  getModel,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PROVIDER_ID = "auto-router";
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const ROUTES_PATH = join(homedir(), ".pi", "agent", "extensions", "auto-router.routes.json");

type RouteTarget = {
  provider: string;
  modelId: string;
  authProvider?: string;
  label: string;
};

type RouteDefinition = {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  targets: RouteTarget[];
};

type RoutesFile = {
  routes?: Record<string, RouteDefinition>;
  aliases?: Record<string, string | string[]>;
};

type AliasConfig = Record<string, string | string[]>;

type CooldownState = {
  until: number;
  reason: string;
};

const cooldowns = new Map<string, CooldownState>();
const lastAttemptByRoute = new Map<string, string>();
const activeTargetByRoute = new Map<string, string>();
let latestUiContext: any;

const DEFAULT_ROUTES: Record<string, RouteDefinition> = {
  "subscription-premium": {
    name: "Subscription Premium Router",
    reasoning: true,
    input: ["text", "image"],
    targets: [
      { provider: "claude-agent-sdk", modelId: "claude-opus-4-6", label: "Claude Opus 4.6 via Claude Code" },
      { provider: "google-antigravity", modelId: "gemini-3.1-pro-high", authProvider: "google-antigravity", label: "Gemini 3.1 Pro" },
      { provider: "openai-codex", modelId: "gpt-5.4", authProvider: "openai-codex", label: "GPT-5.4" },
      { provider: "claude-agent-sdk", modelId: "claude-opus-4-5", label: "Claude Opus 4.5 via Claude Code" },
      { provider: "ollama", modelId: "glm-5.1:cloud", label: "GLM-5.1 via Ollama Cloud Subscription" }
    ]
  },
  "subscription-coding": {
    name: "Subscription Coding Router",
    reasoning: true,
    input: ["text", "image"],
    targets: [
      { provider: "claude-agent-sdk", modelId: "claude-opus-4-6", label: "Claude Opus 4.6 via Claude Code" },
      { provider: "openai-codex", modelId: "gpt-5.4", authProvider: "openai-codex", label: "GPT-5.4" },
      { provider: "google-antigravity", modelId: "gemini-3.1-pro-high", authProvider: "google-antigravity", label: "Gemini 3.1 Pro" },
      { provider: "claude-agent-sdk", modelId: "claude-opus-4-5", label: "Claude Opus 4.5 via Claude Code" },
      { provider: "ollama", modelId: "glm-5.1:cloud", label: "GLM-5.1 via Ollama Cloud Subscription" }
    ]
  },
  "subscription-fast": {
    name: "Subscription Fast Router",
    reasoning: true,
    input: ["text", "image"],
    targets: [
      { provider: "google-antigravity", modelId: "gemini-3-flash", authProvider: "google-antigravity", label: "Gemini 3 Flash" },
      { provider: "openai-codex", modelId: "gpt-5.4-mini", authProvider: "openai-codex", label: "GPT-5.4 Mini" },
      { provider: "claude-agent-sdk", modelId: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 via Claude Code" },
      { provider: "openai-codex", modelId: "gpt-5.2-codex", authProvider: "openai-codex", label: "GPT-5.2 Codex" },
      { provider: "ollama", modelId: "glm-5.1:cloud", label: "GLM-5.1 via Ollama Cloud Subscription" }
    ]
  }
};

const DEFAULT_ALIASES: AliasConfig = {
  premium: ["auto-router/subscription-premium"],
  coding: ["auto-router/subscription-coding"],
  fast: ["auto-router/subscription-fast"],
  glm: ["ollama/glm-5.1:cloud"],
  claude: ["claude-agent-sdk/claude-opus-4-6", "claude-agent-sdk/claude-opus-4-5"],
  gemini: ["google-antigravity/gemini-3.1-pro-high", "google-antigravity/gemini-3-flash"],
  codex: ["openai-codex/gpt-5.4", "openai-codex/gpt-5.2-codex"]
};

let routesCache: Record<string, RouteDefinition> = DEFAULT_ROUTES;
let aliasesCache: AliasConfig = DEFAULT_ALIASES;
let configError: string | undefined;

function parseModelSpec(spec: string): { provider: string; modelId: string } | null {
  const normalized = spec.trim();
  const slashIndex = normalized.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) return null;
  const provider = normalized.slice(0, slashIndex).trim();
  const modelId = normalized.slice(slashIndex + 1).trim();
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

function getRouteName(modelId: string): string {
  return String(modelId ?? "").replace(/^subscription-/, "");
}

function prettyRouteName(routeId: string): string {
  return routesCache[routeId]?.name ?? routeId;
}

function readAuth(): Record<string, { access?: string; expires?: number }> {
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  } catch {
    return {};
  }
}

function getAccessToken(authProvider: string): string | undefined {
  const auth = readAuth();
  const entry = auth[authProvider];
  if (!entry?.access) return undefined;
  if (typeof entry.expires === "number" && entry.expires <= Date.now()) return undefined;
  return entry.access;
}

function getTargetKey(target: RouteTarget | undefined | null): string {
  if (!target) return "unknown/unknown";
  return `${target.provider || "unknown"}/${target.modelId || "unknown"}`;
}

function describeTarget(target: RouteTarget | undefined | null): string {
  if (!target) return "unknown target";
  return `${target.label || "Unknown"} [${target.provider || "unknown"}/${target.modelId || "unknown"}]`;
}

function validateRouteTarget(target: unknown): target is RouteTarget {
  if (!target || typeof target !== "object") return false;
  const candidate = target as Record<string, unknown>;
  return (
    typeof candidate.provider === "string" && candidate.provider.trim().length > 0 &&
    typeof candidate.modelId === "string" && candidate.modelId.trim().length > 0 &&
    typeof candidate.label === "string" && candidate.label.trim().length > 0 &&
    (candidate.authProvider === undefined || typeof candidate.authProvider === "string")
  );
}

function loadRoutesConfig(): void {
  routesCache = DEFAULT_ROUTES;
  aliasesCache = DEFAULT_ALIASES;
  configError = undefined;

  if (!existsSync(ROUTES_PATH)) return;

  try {
    const parsed = JSON.parse(readFileSync(ROUTES_PATH, "utf8")) as RoutesFile;
    const nextRoutes: Record<string, RouteDefinition> = {};
    const rawRoutes = parsed.routes ?? {};

    if (typeof rawRoutes !== "object" || Array.isArray(rawRoutes) || rawRoutes === null) {
      throw new Error("routes must be a top-level object");
    }

    for (const [routeId, routeDef] of Object.entries(rawRoutes)) {
      if (!routeId.trim()) throw new Error("route ids must be non-empty strings");
      if (!routeDef || typeof routeDef !== "object" || Array.isArray(routeDef)) {
        throw new Error(`route ${routeId} must be an object`);
      }
      const targets = (routeDef as Record<string, unknown>).targets;
      if (!Array.isArray(targets) || targets.length === 0) {
        throw new Error(`route ${routeId} must define a non-empty targets array`);
      }
      for (const target of targets) {
        if (!validateRouteTarget(target)) {
          throw new Error(`route ${routeId} has an invalid target entry`);
        }
      }
      nextRoutes[routeId] = {
        name: typeof routeDef.name === "string" ? routeDef.name : routeId,
        reasoning: typeof routeDef.reasoning === "boolean" ? routeDef.reasoning : true,
        input: Array.isArray(routeDef.input) ? routeDef.input.filter((x): x is "text" | "image" => x === "text" || x === "image") : ["text", "image"],
        targets: targets.map((target) => ({ ...target })),
      };
    }

    const rawAliases = parsed.aliases ?? {};
    if (typeof rawAliases !== "object" || Array.isArray(rawAliases) || rawAliases === null) {
      throw new Error("aliases must be a top-level object");
    }
    const nextAliases: AliasConfig = {};
    for (const [key, value] of Object.entries(rawAliases)) {
      const alias = key.trim();
      if (!alias) throw new Error("alias names must be non-empty strings");
      if (typeof value === "string") {
        if (!parseModelSpec(value)) throw new Error(`alias ${alias} must target provider/modelId`);
        nextAliases[alias] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        const candidates = value.map((item) => String(item).trim());
        if (!candidates.every((candidate) => parseModelSpec(candidate))) {
          throw new Error(`alias ${alias} contains an invalid provider/modelId`);
        }
        nextAliases[alias] = candidates;
      } else {
        throw new Error(`alias ${alias} must be a string or non-empty string[]`);
      }
    }

    routesCache = Object.keys(nextRoutes).length > 0 ? nextRoutes : DEFAULT_ROUTES;
    aliasesCache = Object.keys(nextAliases).length > 0 ? nextAliases : DEFAULT_ALIASES;
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    routesCache = DEFAULT_ROUTES;
    aliasesCache = DEFAULT_ALIASES;
  }
}

function getInnerModel(target: RouteTarget): Model<Api> {
  if (target.provider === "claude-agent-sdk") {
    const anthropicBase = getModel("anthropic", target.modelId);
    if (!anthropicBase) throw new Error(`Configured route target not found: anthropic/${target.modelId}`);
    return {
      ...anthropicBase,
      provider: "claude-agent-sdk",
      api: "claude-agent-sdk" as Api,
      baseUrl: "claude-agent-sdk",
    } as Model<Api>;
  }
  const model = getModel(target.provider, target.modelId);
  if (!model) throw new Error(`Configured route target not found: ${target.provider}/${target.modelId}`);
  return model as Model<Api>;
}

function getPrimaryModelLimits(route: RouteDefinition): { contextWindow: number; maxTokens: number } {
  const first = route.targets[0];
  if (!first) return { contextWindow: 200000, maxTokens: 128000 };
  try {
    const model = first.provider === "claude-agent-sdk"
      ? getModel("anthropic", first.modelId)
      : getModel(first.provider, first.modelId);
    if (model) return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  } catch {}
  return { contextWindow: 200000, maxTokens: 128000 };
}

function isRetryableError(message: any): boolean {
  const text = String(message ?? "").toLowerCase();
  if (!text) return false;
  return [
    "429", "rate limit", "ratelimit", "too many requests", "overloaded", "overload", "capacity",
    "temporarily unavailable", "timeout", "timed out", "econnreset", "etimedout", "network", "connection",
    "try again", "internal server error", "502", "503", "504",
    "quota", "credit", "balance", "billing", "exhausted", "reached", "limit",
    "bad gateway", "service unavailable", "gateway timeout", "500", "busy", "upstream",
    "hit your limit", "quota exceeded", "credits exhausted", "insufficient balance"
  ].some((needle) => text.includes(needle));
}

function getCooldownMs(message: any): number {
  const text = String(message ?? "").toLowerCase();
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many requests")) return 2 * 60_000;
  if (text.includes("overloaded") || text.includes("capacity") || text.includes("503")) return 5 * 60_000;
  return 90_000;
}

function putOnCooldown(target: RouteTarget, reason: string) {
  cooldowns.set(getTargetKey(target), { until: Date.now() + getCooldownMs(reason), reason });
}

function getHealthyTargets(routeId: string): RouteTarget[] {
  const now = Date.now();
  return (routesCache[routeId]?.targets ?? []).filter((target) => {
    if (!target) return false;
    const token = target.authProvider ? getAccessToken(target.authProvider) : "builtin";
    if (!token) return false;
    const cooldown = cooldowns.get(getTargetKey(target));
    return !cooldown || cooldown.until <= now;
  });
}

function formatCooldowns(routeId?: string): string {
  const now = Date.now();
  const targets = routeId ? routesCache[routeId]?.targets ?? [] : Object.values(routesCache).flatMap((route) => route.targets);
  const lines = targets
    .map((target) => {
      const state = cooldowns.get(getTargetKey(target));
      if (!state || state.until <= now) return null;
      const mins = Math.max(1, Math.ceil((state.until - now) / 60_000));
      return `${target.label}: cooldown ${mins}m`;
    })
    .filter((x): x is string => Boolean(x));
  return lines.length ? lines.join(" | ") : "no cooldowns";
}

function buildCombinedError(model: Model<Api>, routeId: string, errors: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "error",
    errorMessage: `All auto-router targets failed for ${routeId}: ${errors.join(" | ")}`,
    timestamp: Date.now()
  };
}

async function tryTarget(
  outer: AssistantMessageEventStream,
  outerModel: Model<Api>,
  target: RouteTarget,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<{ success: boolean; retryableFailure?: string; terminalError?: AssistantMessage }> {
  activeTargetByRoute.set(outerModel.id, describeTarget(target));
  refreshStatus(outerModel.id);
  const token = target.authProvider ? getAccessToken(target.authProvider) : undefined;
  if (target.authProvider && !token) {
    return { success: false, retryableFailure: `${target.label}: no valid subscription token` };
  }

  const innerModel = getInnerModel(target);
  const buffered: any[] = [];
  let flushed = false;
  let sawSubstantive = false;
  let thinkingCount = 0;

  const flush = () => {
    if (flushed) return;
    for (const event of buffered) outer.push(event);
    buffered.length = 0;
    flushed = true;
  };

  const inner = streamSimple(innerModel, context, { ...options, apiKey: token });
  let lastMessage: AssistantMessage | undefined;

  for await (const event of inner) {
    if (event.type === "done") {
      lastMessage = event.message;
    }

    const isRealContent = [
      "text_start", "text_delta", "toolcall_start", "toolcall_delta", "toolcall_end"
    ].includes(event.type);

    if (isRealContent) {
      if (event.type === "text_delta") {
        const deltaText = (event as any).text ?? (event as any).delta ?? "";
        if (isRetryableError(deltaText)) {
          putOnCooldown(target, deltaText);
          return { success: false, retryableFailure: `${target.label}: ${deltaText}` };
        }
      }
      sawSubstantive = true;
    } else if (event.type === "thinking_delta") {
      thinkingCount++;
      if (thinkingCount > 10) sawSubstantive = true;
    } else if (event.type === "thinking_start") {
      // thinking_start is not immediately substantive to allow failover
      // if the model fails right after starting to think.
    }

    if (event.type === "error") {
      const message = event.error?.errorMessage || `${target.label || "Target"}: unknown error`;
      if (!sawSubstantive && isRetryableError(message)) {
        putOnCooldown(target, message);
        return { success: false, retryableFailure: `${target.label || "Target"}: ${message}` };
      }
      flush();
      outer.push({
        ...event,
        error: {
          ...(event.error || {}),
          provider: outerModel.provider,
          model: outerModel.id,
          errorMessage: `${target.label || "Target"}: ${message}`
        }
      });
      return {
        success: false,
        terminalError: {
          ...(event.error || {}),
          provider: outerModel.provider,
          model: outerModel.id,
          errorMessage: `${target.label || "Target"}: ${message}`
        }
      } as any;
    }

    if (flushed) {
      outer.push(event);
    } else {
      buffered.push(event);
      if (sawSubstantive || event.type === "done") flush();
    }
  }

  lastAttemptByRoute.set(outerModel.id, target.label);

  if (lastMessage?.stopReason === "error" || lastMessage?.errorMessage) {
    const message = lastMessage.errorMessage || "Unknown terminal error";
    if (!sawSubstantive && isRetryableError(message)) {
      putOnCooldown(target, message);
      return { success: false, retryableFailure: `${target.label || "Target"}: ${message}` };
    }
    return {
      success: false,
      terminalError: {
        ...lastMessage,
        provider: outerModel.provider,
        model: outerModel.id,
        errorMessage: `${target.label || "Target"}: ${message}`
      }
    };
  }

  return { success: true };
}

function streamAutoRouter(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();

  (async () => {
    const routeId = model.id;
    const errors: string[] = [];
    try {
      loadRoutesConfig();
      const targets = getHealthyTargets(routeId);
      if (targets.length === 0) {
        outer.push({ type: "error", reason: "error", error: buildCombinedError(model, routeId, ["no healthy route targets available"]) });
        outer.end();
        return;
      }

      for (const target of targets) {
        lastAttemptByRoute.set(routeId, target.label);
        const result = await tryTarget(outer, model, target, context, options);
        if (result.success) {
          activeTargetByRoute.delete(routeId);
          refreshStatus(routeId);
          outer.end();
          return;
        }
        if (result.retryableFailure) {
          errors.push(result.retryableFailure);
          continue;
        }
        if (result.terminalError) {
          activeTargetByRoute.delete(routeId);
          refreshStatus(routeId);
          outer.end();
          return;
        }
      }

      activeTargetByRoute.delete(routeId);
      refreshStatus(routeId);
      outer.push({ type: "error", reason: "error", error: buildCombinedError(model, routeId, errors.length ? errors : ["all targets exhausted"]) });
      outer.end();
    } catch (error) {
      activeTargetByRoute.delete(routeId);
      refreshStatus(routeId);
      outer.push({ type: "error", reason: "error", error: buildCombinedError(model, routeId, [error instanceof Error ? error.message : String(error)]) });
      outer.end();
    }
  })();

  return outer;
}

function getStatusLine(routeId?: string): string {
  if (!routeId || !(routeId in routesCache)) return "auto-router idle";
  const healthy = getHealthyTargets(routeId).map((target) => String(target?.label ?? "Unknown"));
  const activeTarget = activeTargetByRoute.get(routeId);
  const lastTarget = lastAttemptByRoute.get(routeId);
  const active = activeTarget ? `current: ${activeTarget}` : lastTarget ? `last: ${lastTarget}` : "no calls yet";
  return `auto-router ${getRouteName(routeId)} | ${active} | healthy: ${healthy.join(", ") || "none"} | ${formatCooldowns(routeId)}`;
}

function refreshStatus(routeId?: string) {
  const ctx = latestUiContext;
  if (!ctx) return;
  const activeModel = ctx.model;
  if (activeModel?.provider === PROVIDER_ID) {
    ctx.ui.setStatus("auto-router", getStatusLine(routeId ?? activeModel.id));
  } else {
    ctx.ui.setStatus("auto-router", undefined);
  }
}

function routeSummary(routeId: string): string {
  const route = routesCache[routeId];
  if (!route) return `Unknown route: ${routeId}`;
  const healthySet = new Set(getHealthyTargets(routeId).map(getTargetKey));
  const lines = (route.targets || []).map((target, index) => {
    if (!target) return `${index + 1}. [Invalid Target]`;
    const key = getTargetKey(target);
    const cooldown = cooldowns.get(key);
    const cooldownText = cooldown && cooldown.until > Date.now() ? ` | cooldown ${Math.max(1, Math.ceil((cooldown.until - Date.now()) / 60_000))}m` : "";
    const authText = target.authProvider ? `auth=${target.authProvider}` : "auth=builtin";
    const healthText = healthySet.has(key) ? "healthy" : "unavailable";
    return `${index + 1}. ${target.label || "Unknown"} [${target.provider || "unknown"}/${target.modelId || "unknown"}] | ${authText} | ${healthText}${cooldownText}`;
  });
  return [
    `${routeId} — ${prettyRouteName(routeId)}`,
    (() => { const l = getPrimaryModelLimits(route); return `thinking=${route.reasoning !== false} | input=${(route.input ?? ["text", "image"]).join(",")} | ctx=${l.contextWindow} | max=${l.maxTokens} (from primary target)`; })(),
    ...lines
  ].join("\n");
}

function formatModelLine(model: { provider: string; id: string; name: string; reasoning: boolean; input: readonly string[]; contextWindow: number; maxTokens: number; cost: { input: number; output: number } }, currentModel: { provider?: string; id?: string } | null | undefined): string {
  const current = currentModel && model.provider === currentModel.provider && model.id === currentModel.id;
  const marker = current ? " (current)" : "";
  const capabilities = [model.reasoning ? "reasoning" : null, model.input.includes("image") ? "vision" : null].filter(Boolean).join(", ");
  const capabilityText = capabilities ? ` [${capabilities}]` : "";
  const costText = `$${model.cost.input.toFixed(2)}/$${model.cost.output.toFixed(2)} per 1M tokens (in/out)`;
  return `${model.provider}/${model.id}${marker}${capabilityText}\n  ${model.name} | ctx: ${model.contextWindow.toLocaleString()} | max: ${model.maxTokens.toLocaleString()}\n  ${costText}`;
}

function searchModels(query: string, ctx: any): string {
  const normalized = String(query ?? "").toLowerCase();
  const matches = ctx.modelRegistry.getAvailable().filter((model: any) =>
    String(model.id ?? "").toLowerCase().includes(normalized) ||
    String(model.name ?? "").toLowerCase().includes(normalized) ||
    String(model.provider ?? "").toLowerCase().includes(normalized)
  );
  if (matches.length === 0) return `No models found matching "${query}"`;
  return `Models matching "${query}" (${matches.length}):\n\n${matches.map((model: any) => formatModelLine(model, ctx.model)).join("\n\n")}`;
}

function searchRoutes(query: string): string {
  const normalized = String(query ?? "").toLowerCase();
  const routeMatches = Object.entries(routesCache).filter(([routeId, route]) =>
    String(routeId ?? "").toLowerCase().includes(normalized) ||
    String(route.name ?? routeId ?? "").toLowerCase().includes(normalized) ||
    (route.targets || []).some((target) =>
      target && (
        String(target.label ?? "").toLowerCase().includes(normalized) ||
        String(target.provider ?? "").toLowerCase().includes(normalized) ||
        String(target.modelId ?? "").toLowerCase().includes(normalized)
      )
    )
  );
  if (routeMatches.length === 0) return `No routes found matching "${query}"`;
  return routeMatches.map(([routeId]) => routeSummary(routeId)).join("\n\n");
}

function resolveAlias(name: string, ctx: any): { success?: string; error?: string } {
  const aliasKey = Object.keys(aliasesCache).find((key) => String(key ?? "").toLowerCase() === String(name ?? "").toLowerCase());
  if (!aliasKey) return { error: `Unknown alias: ${name}` };
  const candidates = Array.isArray(aliasesCache[aliasKey]) ? aliasesCache[aliasKey] as string[] : [aliasesCache[aliasKey] as string];
  const available = ctx.modelRegistry.getAvailable();
  for (const candidate of candidates) {
    const spec = parseModelSpec(candidate);
    if (!spec) continue;
    const match = available.find((model: any) => model.provider === spec.provider && model.id === spec.modelId);
    if (match) return { success: `${aliasKey} -> ${match.provider}/${match.id}` };
  }
  return { error: `Alias ${aliasKey} has no currently available target. Tried: ${candidates.join(", ")}` };
}

function rebuildProvider(pi: ExtensionAPI) {
  loadRoutesConfig();
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "auto-router",
    apiKey: "auto-router-literal",
    api: "auto-router-api",
    models: Object.entries(routesCache).map(([routeId, route]) => {
      const limits = getPrimaryModelLimits(route);
      return {
        id: routeId,
        name: route.name ?? routeId,
        reasoning: route.reasoning !== false,
        input: route.input ?? ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: limits.contextWindow,
        maxTokens: limits.maxTokens,
      };
    }),
    streamSimple: streamAutoRouter,
  });
}

export default function (pi: ExtensionAPI) {
  rebuildProvider(pi);

  const updateUi = (ctx: any) => {
    latestUiContext = ctx;
    loadRoutesConfig();
    refreshStatus();
  };

  pi.on("session_start", async (_event, ctx) => updateUi(ctx));
  pi.on("model_select", async (_event, ctx) => updateUi(ctx));
  pi.on("agent_start", async (_event, ctx) => updateUi(ctx));
  pi.on("agent_end", async (_event, ctx) => updateUi(ctx));

  pi.registerCommand("auto-router", {
    description: "Auto-router status, routes, aliases, search, resolve, and reset",
    handler: async (args, ctx) => {
      rebuildProvider(pi);
      updateUi(ctx);
      const trimmed = args.trim();
      const [subcommandRaw, ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      const subcommand = String(subcommandRaw ?? "status").toLowerCase();
      const remainder = rest.join(" ").trim();
      const activeModel = ctx.model;
      const activeRouteId = activeModel?.provider === PROVIDER_ID ? activeModel.id : undefined;

      if (subcommand === "switch") {
        if (!remainder) {
          ctx.ui.notify("Usage: /auto-router switch <route|alias|provider/model>", "error");
          return;
        }

        // Try as a route ID first (e.g., "subscription-premium")
        if (routesCache[remainder]) {
          const model = ctx.modelRegistry.find(PROVIDER_ID, remainder);
          if (model) {
            const success = await pi.setModel(model);
            if (success) {
              updateUi(ctx);
              ctx.ui.notify(`Switched to auto-router/${remainder}`, "success");
            } else {
              ctx.ui.notify(`Failed to switch to auto-router/${remainder}`, "error");
            }
          } else {
            ctx.ui.notify(`Route ${remainder} not found in model registry`, "error");
          }
          return;
        }

        // Try as an alias
      const aliasKey = Object.keys(aliasesCache).find((key) => String(key ?? "").toLowerCase() === String(remainder ?? "").toLowerCase());
        if (aliasKey) {
          const candidates = Array.isArray(aliasesCache[aliasKey]) ? aliasesCache[aliasKey] as string[] : [aliasesCache[aliasKey] as string];
          for (const candidate of candidates) {
            const spec = parseModelSpec(candidate);
            if (!spec) continue;
            const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
            if (model) {
              const success = await pi.setModel(model);
              if (success) {
                updateUi(ctx);
                ctx.ui.notify(`Switched to ${spec.provider}/${spec.modelId} (via alias "${aliasKey}")`, "success");
              } else {
                ctx.ui.notify(`Failed to switch to ${spec.provider}/${spec.modelId}`, "error");
              }
              return;
            }
          }
          ctx.ui.notify(`Alias "${aliasKey}" has no available targets. Tried: ${candidates.join(", ")}`, "error");
          return;
        }

        // Try as a direct provider/model spec
        const spec = parseModelSpec(remainder);
        if (spec) {
          const model = ctx.modelRegistry.find(spec.provider, spec.modelId);
          if (model) {
            const success = await pi.setModel(model);
            if (success) {
              updateUi(ctx);
              ctx.ui.notify(`Switched to ${spec.provider}/${spec.modelId}`, "success");
            } else {
              ctx.ui.notify(`Failed to switch to ${spec.provider}/${spec.modelId}`, "error");
            }
          } else {
            ctx.ui.notify(`Model ${remainder} not found`, "error");
          }
          return;
        }

        ctx.ui.notify(`"${remainder}" is not a known route, alias, or provider/model`, "error");
        return;
      }

      if (subcommand === "reset") {
        cooldowns.clear();
        lastAttemptByRoute.clear();
        activeTargetByRoute.clear();
        updateUi(ctx);
        ctx.ui.notify("Auto-router cooldowns reset", "success");
        return;
      }

      if (subcommand === "reload") {
        rebuildProvider(pi);
        updateUi(ctx);
        ctx.ui.notify(`Reloaded auto-router config from ${ROUTES_PATH}${configError ? `\nWarning: ${configError}` : ""}`, configError ? "warning" : "success");
        return;
      }

      if (subcommand === "list") {
        const routeLines = Object.keys(routesCache).map((routeId) => routeSummary(routeId));
        const aliasLines = Object.entries(aliasesCache).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" -> ") : value}`);
        ctx.ui.notify([
          `Active route: ${activeRouteId ?? "none"}`,
          activeRouteId ? getStatusLine(activeRouteId) : "Select an auto-router model via /model to use it.",
          configError ? `\nWarning: ${configError}` : "",
          "\nConfigured routes:\n",
          ...routeLines,
          "\nAliases:\n",
          ...aliasLines
        ].join("\n"), "info");
        return;
      }

      if (subcommand === "show") {
        const routeId = remainder || activeRouteId;
        if (!routeId) {
          ctx.ui.notify("Usage: /auto-router show <routeId>", "error");
          return;
        }
        ctx.ui.notify(`${routeSummary(routeId)}${configError ? `\n\nWarning: ${configError}` : ""}`, routesCache[routeId] ? "info" : "error");
        return;
      }

      if (subcommand === "search") {
        if (!remainder) {
          ctx.ui.notify("Usage: /auto-router search <query>", "error");
          return;
        }
        ctx.ui.notify(`${searchRoutes(remainder)}\n\n${searchModels(remainder, ctx)}`, "info");
        return;
      }

      if (subcommand === "aliases") {
        const lines = Object.entries(aliasesCache).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" -> ") : value}`);
        ctx.ui.notify([`Aliases (${lines.length}):`, ...lines].join("\n"), "info");
        return;
      }

      if (subcommand === "resolve") {
        if (!remainder) {
          ctx.ui.notify("Usage: /auto-router resolve <alias>", "error");
          return;
        }
        const result = resolveAlias(remainder, ctx);
        ctx.ui.notify(result.success ?? result.error ?? "No result", result.success ? "success" : "error");
        return;
      }

      if (subcommand === "models") {
        const lines = ctx.modelRegistry.getAvailable().map((model: any) => formatModelLine(model, ctx.model));
        ctx.ui.notify(`Available models (${lines.length}):\n\n${lines.join("\n\n")}`, "info");
        return;
      }

      ctx.ui.notify([
        `Active route: ${activeRouteId ?? "none"}`,
        activeRouteId ? getStatusLine(activeRouteId) : "Select an auto-router model via /model to use it.",
        configError ? `\nWarning: ${configError}` : "",
        "",
        "Commands:",
        "/auto-router status",
        "/auto-router switch <route|alias|provider/model>",
        "/auto-router list",
        "/auto-router show <routeId>",
        "/auto-router search <query>",
        "/auto-router aliases",
        "/auto-router resolve <alias>",
        "/auto-router models",
        "/auto-router reload",
        "/auto-router reset"
      ].join("\n"), "info");
    }
  });
}
