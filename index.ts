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
import { buildRoutingContext } from "./src/context-analyzer.ts";
import { DEFAULT_SHORTCUTS, listShortcuts, parseShortcut } from "./src/shortcut-parser.ts";
import { inferRequirements, solveConstraints, type CapabilityMap, type ConstraintRequirements } from "./src/constraint-solver.ts";
import { BudgetTracker, todayKey } from "./src/budget-tracker.ts";
import { partitionAuditedCandidates } from "./src/candidate-partitioner.ts";
import { QuotaCache, mapRouteProviderToOAuth } from "./src/quota-cache.ts";
import { getProviderHealthCache } from "./src/health-check.ts";
import { LatencyTracker } from "./src/latency-tracker.ts";
import { classifyIntent, intentToTier, type IntentResult } from "./src/intent-classifier.ts";
import type { RoutingDecision, Tier, Message as RoutingMessage, UtilizationSnapshot } from "./src/types.ts";

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
  contextWindow?: number;
  maxTokens?: number;
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
const lastDecisionByRoute = new Map<string, RoutingDecision>();
const lastShortcutByRoute = new Map<string, { shortcut: string; tier: Tier }>();
const lastBudgetWarningByRoute = new Map<string, string>();
const budgetTracker = new BudgetTracker();
const quotaCache = new QuotaCache();
const latencyTracker = new LatencyTracker();

// Shadow mode: run full pipeline but use legacy ordering for actual routing.
let shadowMode = envShadowEnabled();
const lastShadowByRoute = new Map<string, { shadowTargets: string[]; actualTargets: string[] }>();

// UVI hard mode: when enabled, demoted (stressed) providers are completely excluded
// rather than just deprioritized. AUTO_ROUTER_UVI_HARD=1
const uviHardMode = (() => {
  const raw = process.env.AUTO_ROUTER_UVI_HARD;
  return raw === "1" || (raw ?? "").toLowerCase() === "true" || (raw ?? "").toLowerCase() === "on";
})();

let budgetReady = false;
let latestUiContext: any;

function envShadowEnabled(): boolean {
  const raw = process.env.AUTO_ROUTER_SHADOW;
  return raw === "1" || (raw ?? "").toLowerCase() === "true" || (raw ?? "").toLowerCase() === "on";
}

function syncUtilizationIntoBudget(): void {
  if (!quotaCache.isEnabled()) return;
  const snapshots = quotaCache.getAllSnapshots();
  // Re-key snapshots by route-config provider names so auditBudget(provider) lookups work.
  const remapped: Record<string, UtilizationSnapshot> = {};
  for (const [oauthId, snap] of Object.entries(snapshots)) {
    remapped[oauthId] = snap;
    if (oauthId === "anthropic") remapped["claude-agent-sdk"] = snap;
  }
  budgetTracker.setUtilization(remapped);
}

function formatUtilizationLines(cache: QuotaCache): string[] {
  const snapshots = cache.getAllSnapshots();
  const entries = Object.entries(snapshots);
  if (entries.length === 0) return [];
  return entries.map(([provider, snap]) => {
    const winSummary = snap.windows.length > 0
      ? snap.windows.map((w) => `${w.scope}@${w.usedPercent.toFixed(0)}%`).join(", ")
      : "no windows";
    const staleTag = snap.stale ? " [stale]" : "";
    const errTag = snap.error ? ` [err: ${snap.error}]` : "";
    return `  ${provider.padEnd(22)} UVI=${snap.uvi.toFixed(2).padStart(5)} ${snap.status.padEnd(8)} | ${winSummary}${staleTag}${errTag}`;
  });
}

async function ensureBudgetLoaded(): Promise<void> {
  if (budgetReady) return;
  try {
    await budgetTracker.load();
    latencyTracker.load();
  } catch {
    // ignore - tracker resets to defaults internally
  }
  budgetReady = true;
}

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
      { provider: "nvidia", modelId: "deepseek-ai/deepseek-v3.2", label: "DeepSeek v3.2 via NVIDIA" },
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
  deepseek: ["nvidia/deepseek-ai/deepseek-v3.2"],
  nvidia: ["nvidia/deepseek-ai/deepseek-v3.2"],
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
        contextWindow: typeof routeDef.contextWindow === "number" ? routeDef.contextWindow : undefined,
        maxTokens: typeof routeDef.maxTokens === "number" ? routeDef.maxTokens : undefined,
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

function normalizeModelToken(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/:(cloud|latest|instruct)$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function resolveModelFromRegistry(target: RouteTarget, context?: Context): Model<Api> | undefined {
  const registry = (context as any)?.modelRegistry || latestUiContext?.modelRegistry;
  const available = typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
  
  // Try to find the provider even if available is empty (for built-in models)
  const provider = target.provider === "claude-agent-sdk" ? "anthropic" : target.provider;
  const requestedId = String(target.modelId ?? "").toLowerCase();
  const requestedParts = requestedId.split("/").filter(Boolean);
  const requestedTail = requestedParts.at(-1) ?? requestedId;
  const requestedNormalized = normalizeModelToken(requestedId);
  const requestedTailNormalized = normalizeModelToken(requestedTail);

  const wrapClaude = (base: any): Model<Api> => ({
    ...base,
    provider: "claude-agent-sdk",
    api: "claude-agent-sdk" as Api,
    baseUrl: "claude-agent-sdk",
  } as Model<Api>);

  const wrapTarget = (base: any): Model<Api> => {
    if (target.provider === "claude-agent-sdk") return wrapClaude(base);
    return base as Model<Api>;
  };

  const direct = (() => {
    try {
      // Use the actual provider name for getModel
      return getModel(provider, target.modelId);
    } catch {
      try {
          // Fallback to searching without provider prefix if modelId already has it
          if (target.modelId.includes("/")) {
              const [p, m] = target.modelId.split("/");
              return getModel(p, m);
          }
      } catch {}
      return undefined;
    }
  })();
  if (direct) return wrapTarget(direct);

  if (!Array.isArray(available) || available.length === 0) return undefined;

  const findInList = (list: any[]) => {
    return list.find((model: any) => {
      const id = String(model?.id ?? "").toLowerCase();
      const idNormalized = normalizeModelToken(id);
      return id === requestedId || id === requestedTail || id.endsWith(`/${requestedId}`) || id.endsWith(`/${requestedTail}`) || idNormalized === requestedNormalized || idNormalized === requestedTailNormalized;
    }) ?? list.find((model: any) => {
      const id = String(model?.id ?? "").toLowerCase();
      const name = String(model?.name ?? "").toLowerCase();
      const idNormalized = normalizeModelToken(id);
      const nameNormalized = normalizeModelToken(name);
      return id.includes(requestedTail) || name.includes(requestedTail) || idNormalized.includes(requestedTailNormalized) || requestedNormalized.includes(idNormalized) || nameNormalized.includes(requestedTailNormalized);
    });
  };

  const providerMatches = available.filter((model: any) => String(model?.provider ?? "").toLowerCase() === provider.toLowerCase());
  const pick = findInList(providerMatches);
  if (pick) return wrapTarget(pick);

  // Fallback: search across all providers if not found in requested provider
  const globalPick = findInList(available);
  if (globalPick) return wrapTarget(globalPick);

  return undefined;
}

function getInnerModel(target: RouteTarget, context?: Context): Model<Api> {
  const model = resolveModelFromRegistry(target, context);
  if (!model) {
    const registry = (context as any)?.modelRegistry;
    const available = typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];
    const providers = Array.from(new Set(available.map((m: any) => m.provider))).join(", ");
    throw new Error(`Configured route target not found: ${target.provider}/${target.modelId}. Available providers: ${providers || "none"}`);
  }
  return model;
}

function getPrimaryModelLimits(route: RouteDefinition): { contextWindow: number; maxTokens: number } {
  if (route.contextWindow && route.maxTokens) return { contextWindow: route.contextWindow, maxTokens: route.maxTokens };
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
  // NOTE: This only matches against actual error event strings (not model text output).
  // Be conservative with single-word tokens — they're prone to false positives.
  return [
    "429", "rate limit", "ratelimit", "too many requests",
    "overloaded", "over capacity", "capacity reached", "busy",
    "temporarily unavailable", "timeout", "timed out", "econnreset", "etimedout",
    "network", "connection", "try again", "internal server error",
    "502", "503", "504", "500",
    "quota", "quota will reset", "quota exceeded",
    "hit your limit", "credits exhausted", "insufficient balance",
    "bad gateway", "service unavailable", "gateway timeout", "upstream",
    "invalid 'input", "call_id", "function_response.name", "required_field_missing",
    "400 status code", "invalid_request_error", "invalid google cloud code assist credentials"
  ].some((needle) => text.includes(needle));
}

function parseResetAfterMs(message: any): number | undefined {
  const text = String(message ?? "");
  const match = text.match(/reset after\s+(\d+)\s*(s|m|h|d|second|minute|hour|day)s?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase()[0]; // Take the first character: s, m, h, d
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unitMs = unit === "s"
    ? 1_000
    : unit === "m"
      ? 60_000
      : unit === "h"
        ? 60 * 60_000
        : 24 * 60 * 60_000;
  return value * unitMs;
}

function getCooldownMs(message: any): number {
  const explicitResetMs = parseResetAfterMs(message);
  if (explicitResetMs) return explicitResetMs + 5_000;

  const text = String(message ?? "").toLowerCase();
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many requests")) return 2 * 60_000;
  if (text.includes("quota") || text.includes("capacity") || text.includes("overloaded") || text.includes("503")) return 5 * 60_000;
  // 404 / 410 / "not found" / "model not available" — model is gone, back off for an hour.
  // Use word boundaries so "4040ms" / "version 404.x" don't match.
  if (/\b(404|410)\b/.test(text) || text.includes("not found") || text.includes("model not available") || text.includes("gone")) return 60 * 60_000;
  // 400 / "bad request" / context-length errors — payload-specific, brief cooldown so the next
  // call (with a different payload) can still try this target.
  if (/\b400\b/.test(text) || text.includes("bad request") || text.includes("maximum context length") || text.includes("context_length_exceeded")) return 30_000;
  return 90_000;
}

function putOnCooldown(target: RouteTarget, reason: string) {
  cooldowns.set(getTargetKey(target), { until: Date.now() + getCooldownMs(reason), reason });
}

function formatRemainingMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1_000))}s`;
  if (ms < 60 * 60_000) return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.max(1, Math.ceil(ms / (60 * 60_000)))}h`;
  return `${Math.max(1, Math.ceil(ms / (24 * 60 * 60_000)))}d`;
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
      return `${target.label}: cooldown ${formatRemainingMs(state.until - now)}`;
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

function sanitizeContext(context: Context): Context {
  const messages = (context as any)?.messages;
  if (!Array.isArray(messages)) return context;

  const newMessages = messages.map((msg: any) => {
    if (!msg) return msg;
    const newMsg = { ...msg };

    // Handle tool calls in assistant messages
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      newMsg.tool_calls = msg.tool_calls.map((tc: any) => {
        const newTc = { ...tc };
        if (newTc.id === undefined || newTc.id === null || String(newTc.id).trim() === "") {
          newTc.id = `call_${Math.random().toString(36).substring(2, 11)}`;
        }
        return newTc;
      });
    }

    // Handle tool results
    if (msg.role === "tool" || msg.role === "toolResult") {
      const toolCallId = msg.tool_call_id || msg.toolCallId;
      if (toolCallId === undefined || toolCallId === null || String(toolCallId).trim() === "") {
        const generatedId = `call_${Math.random().toString(36).substring(2, 11)}`;
        if (msg.role === "tool") newMsg.tool_call_id = generatedId;
        else newMsg.toolCallId = generatedId;
      }
      
      const toolName = msg.name || msg.toolName;
      // Gemini requires a name for function_response
      if (toolName === undefined || toolName === null || String(toolName).trim() === "") {
        if (msg.role === "tool") newMsg.name = "unknown_tool";
        else newMsg.toolName = "unknown_tool";
      }
    }

    return newMsg;
  });

  return { ...context, messages: newMessages } as Context;
}

async function tryTarget(
  outer: AssistantMessageEventStream,
  outerModel: Model<Api>,
  target: RouteTarget,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<{ success: boolean; retryableFailure?: string; terminalError?: AssistantMessage; lastMessage?: AssistantMessage }> {
  activeTargetByRoute.set(outerModel.id, describeTarget(target));
  refreshStatus(outerModel.id);
  const token = target.authProvider ? getAccessToken(target.authProvider) : undefined;
  
  if (target.authProvider && !token) {
    const message = `${target.label}: no valid subscription token`;
    putOnCooldown(target, message);
    return { success: false, retryableFailure: message };
  }

  let innerModel: Model<Api>;
  try {
    innerModel = getInnerModel(target, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    putOnCooldown(target, message);
    return { success: false, retryableFailure: `${target.label || "Target"}: ${message}` };
  }
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

  const sanitized = sanitizeContext(context);
  const inner = streamSimple(innerModel, sanitized, { ...options, apiKey: token });
  let lastMessage: AssistantMessage | undefined;

  try {
    for await (const event of inner) {
      if (event.type === "done") {
        lastMessage = event.message;
      }

      const isRealContent = [
        "text_start", "text_delta", "toolcall_start", "toolcall_delta", "toolcall_end"
      ].includes(event.type);

      if (isRealContent) {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!sawSubstantive && isRetryableError(message)) {
      putOnCooldown(target, message);
      return { success: false, retryableFailure: `${target.label || "Target"}: ${message}` };
    }
    throw error;
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

  return { success: true, lastMessage };
}

function extractLastUserText(context: Context): { text: string; index: number; partIndex: number | null } | null {
  const messages = (context as any)?.messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") {
      return { text: content, index: i, partIndex: null };
    }
    if (Array.isArray(content)) {
      for (let p = 0; p < content.length; p++) {
        const part = content[p];
        if (part && typeof part === "object" && typeof (part as any).text === "string") {
          return { text: (part as any).text, index: i, partIndex: p };
        }
      }
    }
  }
  return null;
}

function applyCleanedPrompt(context: Context, location: { index: number; partIndex: number | null }, cleaned: string): void {
  const messages = (context as any)?.messages;
  if (!Array.isArray(messages)) return;
  const msg = messages[location.index];
  if (!msg) return;
  if (location.partIndex === null) {
    msg.content = cleaned;
    return;
  }
  const parts = msg.content;
  if (Array.isArray(parts) && parts[location.partIndex]) {
    parts[location.partIndex] = { ...parts[location.partIndex], text: cleaned };
  }
}

function getRoutingMessages(context: Context, excludeIndex: number): RoutingMessage[] {
  const messages = (context as any)?.messages;
  if (!Array.isArray(messages)) return [];
  const out: RoutingMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === excludeIndex) continue;
    const m = messages[i];
    if (m && typeof m.role === "string") out.push({ role: m.role, content: m.content });
  }
  return out;
}

function lookupCapabilities(target: RouteTarget, context: Context): CapabilityMap | undefined {
  const model = resolveModelFromRegistry(target, context);
  if (!model) return undefined;
  const input = (model as any).input ?? [];
  return {
    vision: Array.isArray(input) ? input.includes("image") : undefined,
    reasoning: typeof (model as any).reasoning === "boolean" ? (model as any).reasoning : undefined,
    contextWindow: typeof (model as any).contextWindow === "number" ? (model as any).contextWindow : undefined,
    maxTokens: typeof (model as any).maxTokens === "number" ? (model as any).maxTokens : undefined,
  };
}

function tierToRequirements(tier: Tier | undefined, estimatedTokens: number): ConstraintRequirements {
  const reqs: ConstraintRequirements = {};
  if (tier === "vision") reqs.vision = true;
  if (tier === "reasoning" || tier === "swe") reqs.reasoning = true;
  if (tier === "long") reqs.minContextWindow = Math.max(estimatedTokens, 100_000);
  return reqs;
}

function recordDecision(routeId: string, decision: RoutingDecision): void {
  lastDecisionByRoute.set(routeId, decision);
}

function streamAutoRouter(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();

  (async () => {
    const routeId = model.id;
    const errors: string[] = [];
    try {
      loadRoutesConfig();
      await ensureBudgetLoaded();
      quotaCache.refreshIfStale();
      syncUtilizationIntoBudget();

      const userMsg = extractLastUserText(context);
      const match = userMsg ? parseShortcut(userMsg.text) : null;
      if (match && userMsg) {
        applyCleanedPrompt(context, userMsg, match.cleanedPrompt);
        lastShortcutByRoute.set(routeId, { shortcut: match.shortcut, tier: match.tier });
      } else {
        lastShortcutByRoute.delete(routeId);
      }

      const promptText = match?.cleanedPrompt ?? userMsg?.text ?? "";
      const history = userMsg ? getRoutingMessages(context, userMsg.index) : [];
      const healthy = getHealthyTargets(routeId);

      // Kick off background health checks for all candidate providers.
      // Non-blocking — results used next prompt or if already cached.
      const healthCache = getProviderHealthCache();
      healthCache.checkAllIfStale(
        healthy.map((t) => ({ provider: t.provider, authProvider: t.authProvider })),
      );

      const budgetState = budgetTracker.getBudgetState();
      // Classify user intent for routing when no @ shortcut is used
      const intent = match ? null : classifyIntent(promptText, history);
      const effectiveTier = match?.tier ?? (intent ? intentToTier(intent.category) ?? undefined : undefined);
      const ctx = buildRoutingContext({
        prompt: promptText,
        history,
        routeId,
        availableTargets: healthy,
        userHint: effectiveTier,
        budgetState,
      });

      const requirements = inferRequirements(ctx, tierToRequirements(effectiveTier, ctx.estimatedTokens));
      const solved = solveConstraints(ctx, {
        requirements,
        capabilities: (t) => lookupCapabilities(t, context),
        isOnCooldown: (t) => {
          const c = cooldowns.get(getTargetKey(t));
          return !!c && c.until > Date.now();
        },
        isHealthy: (t) => healthCache.isHealthy(t.provider, t.authProvider),
      });

      const partition = partitionAuditedCandidates(solved.candidates, budgetState, { hardMode: uviHardMode });
      const auditedRejections = partition.rejections;
      const budgetWarnings = partition.warnings;
      const uviNotes = partition.uviNotes;

      // Sort within UVI buckets by historical latency (fastest first).
      // Providers with no latency data sort last within their bucket.
      const latencySort = (a: RouteTarget, b: RouteTarget): number => {
        const la = latencyTracker.getAvgLatency(a.provider);
        const lb = latencyTracker.getAvgLatency(b.provider);
        if (la === null && lb === null) return 0;
        if (la === null) return 1;
        if (lb === null) return -1;
        return la - lb;
      };
      partition.promoted.sort(latencySort);
      partition.normal.sort(latencySort);
      partition.demoted.sort(latencySort);
      const orderedAudited = [...partition.promoted, ...partition.normal, ...partition.demoted];
      const pipelineTargets = orderedAudited.length > 0
        ? orderedAudited
        : (solved.candidates.length > 0 ? solved.candidates : healthy);
      // In shadow mode: use legacy config-order targets for actual routing,
      // but fall back to pipeline targets if legacy is exhausted.
      const legacyTargets = shadowMode
        ? healthy.filter((t) => {
            if (!getProviderHealthCache().isHealthy(t.provider, t.authProvider)) return false;
            const c = cooldowns.get(getTargetKey(t));
            return !c || c.until <= Date.now();
          })
        : null;
      const targets = legacyTargets && legacyTargets.length > 0
        ? legacyTargets
        : pipelineTargets;
      if (shadowMode && pipelineTargets.length > 0) {
        lastShadowByRoute.set(routeId, {
          shadowTargets: pipelineTargets.map((t) => t.label),
          actualTargets: (legacyTargets && legacyTargets.length > 0 ? legacyTargets : pipelineTargets).map((t) => t.label),
        });
      } else if (shadowMode) {
        lastShadowByRoute.delete(routeId);
      }
      const constraintFallback = solved.candidates.length === 0 && solved.rejections.length > 0;
      const budgetFallback = orderedAudited.length === 0 && auditedRejections.length > 0;

      if (budgetWarnings.length > 0) {
        lastBudgetWarningByRoute.set(routeId, budgetWarnings.join(" | "));
      } else {
        lastBudgetWarningByRoute.delete(routeId);
      }

      if (targets.length === 0) {
        const parts: string[] = [];
        // If the route doesn't exist at all, give a helpful error
        if (!(routeId in routesCache)) {
          const available = Object.keys(routesCache).join(", ");
          parts.push(`route "${routeId}" not found. Available: ${available || "none"}`);
        }
        if (solved.rejections.length > 0) {
          parts.push(`constraints unmet (${solved.rejections.map((r) => `${r.target.label}: ${r.reason}`).join("; ")})`);
        }
        if (auditedRejections.length > 0) {
          parts.push(`budget exhausted (${auditedRejections.join("; ")})`);
        }
        const reason = parts.length > 0 ? parts.join(" / ") : "no healthy route targets available";
        outer.push({ type: "error", reason: "error", error: buildCombinedError(model, routeId, [reason]) });
        outer.end();
        return;
      }

      const reasoningParts: string[] = [];
      if (match) reasoningParts.push(`shortcut ${match.shortcut} → tier=${match.tier}`);
      if (intent && intent.category !== "general") reasoningParts.push(`intent ${intent.category} (${(intent.confidence * 100).toFixed(0)}%) → tier=${effectiveTier}`);
      reasoningParts.push(`${ctx.classification} context (~${ctx.estimatedTokens} tokens)`);
      if (constraintFallback) {
        reasoningParts.push(`constraints unmet for all candidates; falling back to healthy list`);
      } else if (solved.rejections.length > 0) {
        reasoningParts.push(`filtered out ${solved.rejections.length} target(s)`);
      }
      if (budgetFallback) {
        reasoningParts.push(`all candidates over budget; falling back`);
      } else if (auditedRejections.length > 0) {
        reasoningParts.push(`budget-blocked ${auditedRejections.length} target(s)`);
      }
      if (budgetWarnings.length > 0) {
        reasoningParts.push(`budget warning: ${budgetWarnings.join("; ")}`);
      }
      if (uviNotes.length > 0) {
        reasoningParts.push(`uvi: ${uviNotes.join("; ")}`);
      }
      reasoningParts.push(`selected ${targets[0].label}`);
      const latAvg = latencyTracker.getAvgLatency(targets[0].provider);
      if (latAvg !== null) {
        reasoningParts.push(`avg latency ${(latAvg / 1000).toFixed(1)}s`);
      }
      const selectedLimit = budgetState.dailyLimit?.[targets[0].provider];
      const selectedSpend = budgetState.dailySpend?.[targets[0].provider] ?? 0;
      const budgetRemaining = typeof selectedLimit === "number" && selectedLimit > 0
        ? Math.max(0, selectedLimit - selectedSpend)
        : 0;
      const decision: RoutingDecision = {
        tier: match?.tier ?? "swe",
        phase: match ? "shortcut" : "default",
        target: targets[0],
        reasoning: reasoningParts.join(" | "),
        metadata: {
          estimatedTokens: ctx.estimatedTokens,
          budgetRemaining,
          confidence: match ? 0.9 : 0.5,
        },
      };
      recordDecision(routeId, decision);

      for (const target of targets) {
        lastAttemptByRoute.set(routeId, target.label);
        const t0 = Date.now();
        const result = await tryTarget(outer, model, target, context, options);
        if (result.success) {
          const elapsed = Date.now() - t0;
          latencyTracker.recordLatency(target.provider, elapsed);
          try { latencyTracker.save(); } catch { /* ignore */ }
          if (result.lastMessage?.usage) {
            try {
              await budgetTracker.recordUsage(target.provider, result.lastMessage.usage);
            } catch {
              // ignore - never fail a successful response on stats write error
            }
          }
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
  const decision = lastDecisionByRoute.get(routeId);
  const tierHint = decision ? ` | tier=${decision.tier} (${decision.metadata.confidence.toFixed(2)})` : "";
  const budgetWarning = lastBudgetWarningByRoute.get(routeId);
  const budgetText = budgetWarning ? ` | ⚠ ${budgetWarning}` : "";
  const uviText = formatUviStatusSegment();
  const healthIssuesText = formatHealthIssuesSegment(healthy);
  const shadowText = shadowMode ? " 🔬 shadow" : "";
  const hardText = uviHardMode && quotaCache.isEnabled() ? " 🛡️ uvi-hard" : "";
  return `auto-router ${getRouteName(routeId)}${tierHint}${shadowText}${hardText} | ${active} | healthy: ${healthy.join(", ") || "none"} | ${formatCooldowns(routeId)}${budgetText}${healthIssuesText}${uviText}`;
}

function formatUviStatusSegment(): string {
  if (!quotaCache.isEnabled()) return "";
  const snaps = Object.values(quotaCache.getAllSnapshots());
  const hot = snaps.filter((s) => s.status === "stressed" || s.status === "critical");
  if (hot.length === 0) return "";
  const parts = hot.map((s) => `${s.provider}=${s.uvi.toFixed(2)} ${s.status}`);
  return ` | uvi: ${parts.join(", ")}`;
}

function formatHealthIssuesSegment(healthy: Array<{ provider: string; authProvider?: string }>): string {
  const cache = getProviderHealthCache();
  const issues: string[] = [];
  for (const t of healthy) {
    const err = cache.getHealthError(t.provider, t.authProvider);
    if (err) issues.push(`${t.provider}: ${err}`);
  }
  return issues.length > 0 ? ` | ⚠ health: ${issues.join("; ")}` : "";
}

function refreshStatus(routeId?: string) {
  const ctx = latestUiContext;
  if (!ctx) return;
  try {
    const activeModel = ctx.model;
    if (activeModel?.provider === PROVIDER_ID) {
      ctx.ui.setStatus("auto-router", getStatusLine(routeId ?? activeModel.id));
    } else {
      ctx.ui.setStatus("auto-router", undefined);
    }
  } catch {
    // Ignore stale context errors in non-interactive mode or during teardown
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
    const cooldownText = cooldown && cooldown.until > Date.now() ? ` | cooldown ${formatRemainingMs(cooldown.until - Date.now())} (Reason: ${cooldown.reason})` : "";
    const authText = target.authProvider ? `auth=${target.authProvider}` : "auth=builtin";
    const healthText = healthySet.has(key)
      ? `healthy${getProviderHealthCache().getHealthError(target.provider, target.authProvider) ? ` (auth issue: ${getProviderHealthCache().getHealthError(target.provider, target.authProvider)})` : ""}`
      : "unavailable";
    const latAvg = latencyTracker.getAvgLatency(target.provider);
    const latText = latAvg !== null ? ` | ⏱ avg ${(latAvg / 1000).toFixed(1)}s (${latencyTracker.getAll().get(target.provider)!.count} samples)` : "";
    return `${index + 1}. ${target.label || "Unknown"} [${target.provider || "unknown"}/${target.modelId || "unknown"}] | ${authText} | ${healthText}${cooldownText}${latText}`;
  });
  return [
    `${routeId} — ${prettyRouteName(routeId)}`,
    (() => { const l = getPrimaryModelLimits(route); return `thinking=${route.reasoning !== false} | vision=${(route.input ?? ["text", "image"]).includes("image")} | ctx=${l.contextWindow.toLocaleString()} | max=${l.maxTokens.toLocaleString()}${route.contextWindow ? " (forced)" : ""}`; })(),
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

  // Correct tool-name hallucinations: the model often invents MCP-style names
  // (e.g. mcp__tavily__tavily_search) for tools that are actually registered
  // as native pi tools (web_search, web_extract). Append a hard nudge.
  pi.on("before_agent_start", async (event) => {
    const nudge = [
      "",
      "## Tool naming (IMPORTANT)",
      "For web search and URL extraction in this pi environment:",
      "- Use `mcp__custom-tools__web_search` for web search.",
      "- Use `mcp__custom-tools__web_extract` for fetching URL content.",
      "Do NOT call `mcp__tavily__tavily_search` / `mcp__tavily__tavily_extract` — those names do not resolve and will fail with `Tool not found`.",
    ].join("\n");
    return { systemPrompt: (event.systemPrompt ?? "") + "\n" + nudge };
  });

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
        lastDecisionByRoute.clear();
        lastShortcutByRoute.clear();
        lastBudgetWarningByRoute.clear();
        lastShadowByRoute.clear();
        getProviderHealthCache().clear();
        latencyTracker.clear();
        updateUi(ctx);
        ctx.ui.notify("Auto-router cooldowns, decision history, and health cache reset", "success");
        return;
      }

      if (subcommand === "shadow") {
        const [actionRaw] = remainder ? remainder.split(/\s+/) : [];
        const action = String(actionRaw ?? "show").toLowerCase();
        if (action === "enable") {
          shadowMode = true;
          ctx.ui.notify("Shadow mode enabled — pipeline runs but legacy ordering is used for routing", "success");
        } else if (action === "disable") {
          shadowMode = false;
          ctx.ui.notify("Shadow mode disabled — pipeline ordering will be used for routing", "success");
        } else if (action === "show") {
          const lines: string[] = [`Shadow mode: ${shadowMode ? "🟢 enabled" : "🔴 disabled"}`];
          if (shadowMode) {
            lines.push("", "Pipeline runs but actual routing uses legacy config-order targets.");
            lines.push("Enable permanently: AUTO_ROUTER_SHADOW=1");
          } else {
            lines.push("", "Enable with /auto-router shadow enable or AUTO_ROUTER_SHADOW=1");
          }
          if (lastShadowByRoute.size > 0) {
            lines.push("", "Last shadow comparison:");
            for (const [routeId, cmp] of lastShadowByRoute) {
              lines.push(`  Route: ${routeId}`);
              lines.push(`    Pipeline would pick: ${cmp.shadowTargets.join(" → ")}`);
              lines.push(`    Actually used:      ${cmp.actualTargets.join(" → ")}`);
              const diff = cmp.shadowTargets[0] !== cmp.actualTargets[0];
              lines.push(`    Match: ${diff ? "❌ different" : "✅ same first target"}`);
            }
          } else {
            lines.push("", "No shadow comparisons recorded yet. Send a prompt to see pipeline vs legacy differences.");
          }
          ctx.ui.notify(lines.join("\n"), "info");
        }
        return;
      }

      if (subcommand === "uvi") {
        const [actionRaw] = remainder ? remainder.split(/\s+/) : [];
        const action = String(actionRaw ?? "show").toLowerCase();
        if (action === "enable") {
          quotaCache.setEnabled(true);
          ctx.ui.notify("UVI enabled. Background refresh will run on the next prompt (or use /auto-router uvi refresh).", "success");
          return;
        }
        if (action === "disable") {
          quotaCache.setEnabled(false);
          budgetTracker.setUtilization({});
          ctx.ui.notify("UVI disabled.", "info");
          return;
        }
        if (action === "refresh") {
          if (!quotaCache.isEnabled()) {
            ctx.ui.notify("UVI is disabled. Enable it first with /auto-router uvi enable (or set AUTO_ROUTER_UVI=1).", "warning");
            return;
          }
          ctx.ui.notify("Refreshing UVI snapshots...", "info");
          await quotaCache.refreshNow();
          syncUtilizationIntoBudget();
          const lines = formatUtilizationLines(quotaCache);
          ctx.ui.notify(lines.length > 0 ? ["UVI snapshot:", ...lines].join("\n") : "UVI: no snapshots (no OAuth providers found in auth.json?)", "info");
          return;
        }
        // show (default)
        const lines = formatUtilizationLines(quotaCache);
        const status = quotaCache.isEnabled() ? "enabled" : "disabled";
        const header = `UVI (${status}):`;
        if (lines.length === 0) {
          const hint = quotaCache.isEnabled()
            ? "No snapshots yet. Try /auto-router uvi refresh."
            : "Set AUTO_ROUTER_UVI=1 or run /auto-router uvi enable to start polling.";
          ctx.ui.notify(`${header}\n  ${hint}`, "info");
          return;
        }
        ctx.ui.notify([header, ...lines, "", "Subcommands: show | refresh | enable | disable"].join("\n"), "info");
        return;
      }

      if (subcommand === "budget") {
        await ensureBudgetLoaded();
        const [actionRaw, ...restArgs] = remainder ? remainder.split(/\s+/) : [];
        const action = String(actionRaw ?? "show").toLowerCase();
        if (action === "show" || action === "" || !actionRaw) {
          const summary = budgetTracker.getDailySummary();
          const day = todayKey();
          if (summary.length === 0) {
            ctx.ui.notify(`No budget activity yet for ${day}. Set a limit with: /auto-router budget set <provider> <usd>`, "info");
            return;
          }
          const lines = summary.map((s) => {
            const limitText = typeof s.limitUsd === "number" ? `limit $${s.limitUsd.toFixed(2)}` : "no limit";
            const ratio = typeof s.limitUsd === "number" && s.limitUsd > 0 ? ` (${Math.round((s.estimatedCost / s.limitUsd) * 100)}%)` : "";
            return `  ${s.provider.padEnd(22)} spend $${s.estimatedCost.toFixed(2)} | in ${s.inputTokens} | out ${s.outputTokens} | ${limitText}${ratio}`;
          });
          const uviLines = formatUtilizationLines(quotaCache);
          const out = [`Auto-router budget for ${day}:`, ...lines];
          if (uviLines.length > 0) {
            out.push("", "UVI (utilization velocity):", ...uviLines);
          } else if (quotaCache.isEnabled()) {
            out.push("", "UVI: no snapshots yet (refreshing in background; try again shortly)");
          } else {
            out.push("", "UVI: disabled (set AUTO_ROUTER_UVI=1 to enable)");
          }
          out.push("", `Stats file: ${budgetTracker.getPath()}`);
          ctx.ui.notify(out.join("\n"), "info");
          return;
        }
        if (action === "set") {
          const provider = restArgs[0];
          const amount = Number(restArgs[1]);
          if (!provider || !Number.isFinite(amount) || amount <= 0) {
            ctx.ui.notify("Usage: /auto-router budget set <provider> <dailyUsd>", "error");
            return;
          }
          await budgetTracker.setDailyLimit(provider, amount);
          ctx.ui.notify(`Set daily budget for ${provider} = $${amount.toFixed(2)}`, "info");
          return;
        }
        if (action === "clear") {
          const provider = restArgs[0];
          if (!provider) {
            ctx.ui.notify("Usage: /auto-router budget clear <provider>", "error");
            return;
          }
          await budgetTracker.clearDailyLimit(provider);
          ctx.ui.notify(`Cleared daily budget for ${provider}`, "info");
          return;
        }
        ctx.ui.notify("Usage: /auto-router budget [show|set <provider> <usd>|clear <provider>]", "error");
        return;
      }

      if (subcommand === "explain") {
        const routeId = remainder || activeRouteId;
        if (!routeId) {
          ctx.ui.notify("Usage: /auto-router explain <routeId>  (or select an auto-router model first)", "error");
          return;
        }
        const decision = lastDecisionByRoute.get(routeId);
        if (!decision) {
          ctx.ui.notify(`No routing decision recorded yet for ${routeId}. Send a prompt first.`, "info");
          return;
        }
        const shortcut = lastShortcutByRoute.get(routeId);
        const lines = [
          `Last routing decision for ${routeId}:`,
          `  phase:      ${decision.phase}`,
          `  tier:       ${decision.tier}`,
          `  target:     ${describeTarget(decision.target)}`,
          `  confidence: ${decision.metadata.confidence.toFixed(2)}`,
          `  est tokens: ${decision.metadata.estimatedTokens}`,
          shortcut ? `  shortcut:   ${shortcut.shortcut} (tier=${shortcut.tier})` : `  shortcut:   none`,
          `  reasoning:  ${decision.reasoning}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (subcommand === "shortcuts") {
        const lines = listShortcuts(DEFAULT_SHORTCUTS).map((s) => `  ${s.shortcut.padEnd(12)} → tier=${s.tier.padEnd(10)} ${s.description}`);
        ctx.ui.notify([
          "Available @ shortcuts (include in your prompt to bias routing):",
          ...lines,
          "",
          "Example: @reasoning explain how transformers work",
        ].join("\n"), "info");
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

      if (subcommand === "debug") {
        const available = ctx.modelRegistry.getAvailable();
        const providers = Array.from(new Set(available.map((m: any) => m.provider)));
        ctx.ui.notify(`Available Providers: ${providers.join(", ")}\n\nFirst 20 Models:\n${available.slice(0, 20).map((m: any) => `${m.provider}/${m.id}`).join("\n")}`, "info");
        return;
      }

      if (subcommand === "test-resolve") {
        if (!remainder) {
          ctx.ui.notify("Usage: /auto-router test-resolve <provider>/<modelId>", "error");
          return;
        }
        const spec = parseModelSpec(remainder);
        if (!spec) {
          ctx.ui.notify("Invalid spec. Use provider/modelId", "error");
          return;
        }
        const res = resolveModelFromRegistry({ provider: spec.provider, modelId: spec.modelId, label: "Test" }, ctx);
        if (res) {
          ctx.ui.notify(`✅ Resolved ${spec.provider}/${spec.modelId}\nTarget: ${res.provider}/${res.id}\nName: ${res.name}`, "success");
        } else {
          const available = ctx.modelRegistry.getAvailable();
          const providers = Array.from(new Set(available.map((m: any) => m.provider))).join(", ");
          ctx.ui.notify(`❌ Failed to resolve ${spec.provider}/${spec.modelId}\nAvailable providers: ${providers || "none"}`, "error");
        }
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
        "/auto-router explain [routeId]",
        "/auto-router shortcuts",
        "/auto-router budget [show|set <provider> <usd>|clear <provider>]",
        "/auto-router uvi [show|enable|disable|refresh]",
        "/auto-router shadow [show|enable|disable]",
        "/auto-router test-resolve <provider/modelId>",
        "/auto-router debug",
        "/auto-router reload",
        "/auto-router reset"
      ].join("\n"), "info");
    }
  });
}
