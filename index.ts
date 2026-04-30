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
import { inferRequirements, solveConstraints, tierToRequirements, type CapabilityMap, type ConstraintRequirements } from "./src/constraint-solver.ts";
import { BudgetTracker, todayKey } from "./src/budget-tracker.ts";
import { partitionAuditedCandidates } from "./src/candidate-partitioner.ts";
import { QuotaCache, mapRouteProviderToOAuth } from "./src/quota-cache.ts";
import { getProviderHealthCache } from "./src/health-check.ts";
import { LatencyTracker } from "./src/latency-tracker.ts";
import { classifyIntent, intentToTier, type IntentResult } from "./src/intent-classifier.ts";
import { FeedbackTracker } from "./src/feedback-tracker.ts";
import { PolicyEngine, buildStrategyRules, type StrategyRule } from "./src/policy-engine.ts";
import { CircuitBreaker } from "./src/circuit-breaker.ts";
import { parseModelSpec, describeTarget, formatHintsHuman, formatRemainingMs, getCooldownMs, parseResetAfterMs, normalizeModelToken, resolveProviderApiKeyFromEnv, formatModelLine, findCaseInsensitiveKey, getPrimaryModelLimits, findModelInRegistry, validateRouteTarget } from "./src/display.ts";
import { fetchAllBalances, buildMonthlyQuotaWindow } from "./src/balance-fetcher.ts";
import { aggregateProviderUVI } from "./src/uvi.ts";
import { DecisionLogger } from "./src/decision-logger.ts";
import type { DecisionLogEntry, RoutingDecision, Tier, Message as RoutingMessage, UtilizationSnapshot, BillingModel, BalanceState, QuotaWindow, PolicyRuleConfig } from "./src/types.ts";

const PROVIDER_ID = "auto-router";
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const ROUTES_PATH = join(homedir(), ".pi", "agent", "extensions", "auto-router.routes.json");

type RouteTarget = {
  provider: string;
  modelId: string;
  authProvider?: string;
  label: string;
  billing?: "subscription" | "per-token";
  balanceEndpoint?: string;
};

type RouteDefinition = {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  targets: RouteTarget[];
  policyRules?: PolicyRuleConfig[];
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
const lastStrategyTraceByRoute = new Map<string, { rules: Array<{ name: string; matched: boolean }>; hints: RoutingDecision["reasoning"] | null }>();
const lastBudgetWarningByRoute = new Map<string, string>();
const budgetTracker = new BudgetTracker();
const quotaCache = new QuotaCache();
const latencyTracker = new LatencyTracker();
const feedbackTracker = new FeedbackTracker();
const policyEngine = new PolicyEngine();
const circuitBreaker = new CircuitBreaker();
const decisionLogger = new DecisionLogger();
const balanceCache = new Map<string, BalanceState>();
let balanceLastRefreshAt = 0;
let balanceFetchErrors: Record<string, string> = {};
const BALANCE_REFRESH_INTERVAL_MS = 60_000;

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
  const remapped: Record<string, UtilizationSnapshot> = {};

  // Subscription UVI (only when enabled)
  if (quotaCache.isEnabled()) {
    const snapshots = quotaCache.getAllSnapshots();
    for (const [oauthId, snap] of Object.entries(snapshots)) {
      remapped[oauthId] = snap;
      if (oauthId === "anthropic") remapped["claude-agent-sdk"] = snap;
    }
  }

  // Per-token provider UVI windows — always computed, independent of subscription UVI toggle
  const now = Date.now();
  for (const [provider, balance] of balanceCache) {
    if (balance.error) continue;
    const monthlyLimit = budgetTracker.getMonthlyLimits();
    const limit = monthlyLimit[provider];
    if (!limit || limit <= 0) continue;
    const monthlySpend = budgetTracker.getMonthlySpend()[provider] ?? 0;
    const window = buildMonthlyQuotaWindow(provider, monthlySpend, limit, now);
    if (window) {
      const snap = aggregateProviderUVI(provider, [window], now);
      remapped[provider] = snap;
    }
  }

  if (Object.keys(remapped).length > 0) {
    budgetTracker.setUtilization(remapped);
  }
}

function getPerTokenProviders(): Array<{ provider: string; authProvider?: string; balanceEndpoint?: string }> {
  const seen = new Set<string>();
  const result: Array<{ provider: string; authProvider?: string; balanceEndpoint?: string }> = [];

  // Collect providers explicitly tagged as per-token in route config
  for (const route of Object.values(routesCache)) {
    for (const target of route.targets) {
      if (target.billing !== "per-token") continue;
      if (seen.has(target.provider)) continue;
      seen.add(target.provider);
      result.push({ provider: target.provider, authProvider: target.authProvider, balanceEndpoint: target.balanceEndpoint });
    }
  }

  // Also include any provider that has a monthly budget set (implicit per-token)
  const monthlyLimits = budgetTracker.getMonthlyLimits();
  for (const provider of Object.keys(monthlyLimits)) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    // Try to find authProvider from route config for API key resolution
    let authProvider: string | undefined;
    for (const route of Object.values(routesCache)) {
      const match = route.targets.find((t) => t.provider === provider);
      if (match) { authProvider = match.authProvider; break; }
    }
    result.push({ provider, authProvider });
  }

  return result;
}

async function refreshBalances(): Promise<void> {
  const now = Date.now();
  if (now - balanceLastRefreshAt < BALANCE_REFRESH_INTERVAL_MS) return;
  balanceLastRefreshAt = now;

  const perToken = getPerTokenProviders();
  balanceFetchErrors = {};
  if (perToken.length === 0) return;

  const auth = readAuth();
  const providersWithKeys = perToken
    .filter((p) => {
      const authKey = p.authProvider ?? p.provider;
      const entry = auth[authKey];
      if (entry?.access) return true;
      // Fall back to environment variables
      const envKey = resolveProviderApiKeyFromEnv(p.provider);
      if (envKey) return true;
      balanceFetchErrors[p.provider] = `no API key in auth.json (checked "${authKey}") or env`;
      return false;
    })
    .map((p) => ({
      provider: p.provider,
      apiKey: (p.authProvider ? auth[p.authProvider]?.access : auth[p.provider]?.access) ?? resolveProviderApiKeyFromEnv(p.provider)!,
      balanceEndpoint: p.balanceEndpoint,
    }));

  if (providersWithKeys.length === 0) return;

  try {
    const balances = await fetchAllBalances(providersWithKeys);
    for (const [provider, state] of Object.entries(balances)) {
      balanceCache.set(provider, state);
      if (state.error) {
        balanceFetchErrors[provider] = state.error;
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    for (const { provider } of providersWithKeys) {
      balanceFetchErrors[provider] = msg;
    }
  }
}

function formatUtilizationLines(cache: QuotaCache): string[] {
  const snapshots = cache.getAllSnapshots();
  // Merge in per-token UVI from balance cache
  const now = Date.now();
  const monthlyLimit = budgetTracker.getMonthlyLimits();
  const monthlySpend = budgetTracker.getMonthlySpend();
  for (const [provider, balance] of balanceCache) {
    if (balance.error) continue;
    const limit = monthlyLimit[provider];
    if (!limit || limit <= 0) continue;
    const spend = monthlySpend[provider] ?? 0;
    const window = buildMonthlyQuotaWindow(provider, spend, limit, now);
    if (window) {
      const snap = aggregateProviderUVI(provider, [window], now);
      snapshots[provider] = snap;
    }
  }
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
    feedbackTracker.load();
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

function getTargetKey(target: RouteTarget | undefined | null, routeId?: string): string {
  if (!target) return "unknown/unknown";
  const targetKey = `${target.provider || "unknown"}/${target.modelId || "unknown"}`;
  return routeId ? `${routeId}:${targetKey}` : targetKey;
}


function getTargetBilling(target: RouteTarget): BillingModel {
  if (target.billing === "per-token") return "per-token";
  // Auto-detect: if a monthly budget is set for this provider, treat as per-token
  const monthlyLimits = budgetTracker.getMonthlyLimits();
  if (monthlyLimits[target.provider]) return "per-token";
  return "subscription";
}

// validateRouteTarget is imported from ./src/display.ts

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
      // Parse optional policy rules for this route
      let policyRules: PolicyRuleConfig[] | undefined;
      const rawRules = (routeDef as Record<string, unknown>).policyRules;
      if (Array.isArray(rawRules)) {
        policyRules = rawRules.filter((r): r is PolicyRuleConfig =>
          r && typeof r === "object" && typeof (r as PolicyRuleConfig).name === "string" && typeof (r as PolicyRuleConfig).type === "string"
        );
      }

      nextRoutes[routeId] = {
        name: typeof routeDef.name === "string" ? routeDef.name : routeId,
        reasoning: typeof routeDef.reasoning === "boolean" ? routeDef.reasoning : true,
        input: Array.isArray(routeDef.input) ? routeDef.input.filter((x): x is "text" | "image" => x === "text" || x === "image") : ["text", "image"],
        contextWindow: typeof routeDef.contextWindow === "number" ? routeDef.contextWindow : undefined,
        maxTokens: typeof routeDef.maxTokens === "number" ? routeDef.maxTokens : undefined,
        targets: targets.map((target) => ({ ...target })),
        policyRules,
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
    rebuildPolicyEngine();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
    routesCache = DEFAULT_ROUTES;
    aliasesCache = DEFAULT_ALIASES;
    rebuildPolicyEngine();
  }
}

/** Rebuild the policy engine from all loaded route configs. Rules are scoped per-route. */
function rebuildPolicyEngine(): void {
  const allRules: StrategyRule[] = [];
  for (const [routeId, route] of Object.entries(routesCache)) {
    if (route.policyRules) {
      allRules.push(...buildStrategyRules(route.policyRules, routeId));
    }
  }
  policyEngine.rebuildStrategyRules(allRules);
}

function resolveModelFromRegistry(target: RouteTarget, context?: Context): Model<Api> | undefined {
  const registry = (context as any)?.modelRegistry || latestUiContext?.modelRegistry;
  const available: Array<{ provider: string; id: string; name?: string }> =
    typeof registry?.getAvailable === "function" ? registry.getAvailable() : [];

  // Try to find the provider even if available is empty (for built-in models)
  const provider = target.provider === "claude-agent-sdk" ? "anthropic" : target.provider;

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

  // Direct lookup via pi SDK
  const direct = (() => {
    try {
      return getModel(provider, target.modelId);
    } catch {
      try {
        if (target.modelId.includes("/")) {
          const [p, m] = target.modelId.split("/");
          return getModel(p, m);
        }
      } catch {}
      return undefined;
    }
  })();
  if (direct) return wrapTarget(direct);

  // Registry search via extracted matching logic
  if (available.length > 0) {
    const match = findModelInRegistry(available, provider, target.modelId);
    if (match) return wrapTarget(match);
  }

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

function getPrimaryModelLimitsFn(route: RouteDefinition): { contextWindow: number; maxTokens: number } {
  return getPrimaryModelLimits(route, (provider, modelId) => {
    try {
      const model = getModel(provider, modelId);
      if (model) return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
    } catch { /* SDK may throw */ }
    return undefined;
  });
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
    "no api key", "401",
    "invalid 'input", "call_id", "function_response.name", "required_field_missing",
    "400 status code", "invalid_request_error", "invalid google cloud code assist credentials"
  ].some((needle) => text.includes(needle));
}

function putOnCooldown(target: RouteTarget, reason: string, routeId?: string) {
  cooldowns.set(getTargetKey(target, routeId), { until: Date.now() + getCooldownMs(reason), reason });
}

function getHealthyTargets(routeId: string): RouteTarget[] {
  const now = Date.now();
  return (routesCache[routeId]?.targets ?? []).filter((target) => {
    if (!target) return false;
    const token = target.authProvider ? getAccessToken(target.authProvider) : "builtin";
    if (!token) return false;
    const cooldown = cooldowns.get(getTargetKey(target, routeId));
    if (cooldown && cooldown.until > now) return false;
    // Circuit breaker: skip providers with an open circuit
    if (circuitBreaker.isOpen(target.provider)) return false;
    return true;
  });
}

function formatCooldowns(routeId?: string): string {
  const now = Date.now();
  const targets = routeId ? routesCache[routeId]?.targets ?? [] : Object.values(routesCache).flatMap((route) => route.targets);
  const lines = targets
    .map((target) => {
      const state = cooldowns.get(getTargetKey(target, routeId));
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
  let token = target.authProvider ? getAccessToken(target.authProvider) : undefined;
  // Fall back to environment variables for providers without authProvider (e.g. ollama)
  if (!token) token = resolveProviderApiKeyFromEnv(target.provider);
  
  if (target.authProvider && !token) {
    const message = `${target.label}: no valid subscription token`;
    putOnCooldown(target, message, outerModel.id);
    return { success: false, retryableFailure: message };
  }

  let innerModel: Model<Api>;
  try {
    innerModel = getInnerModel(target, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    putOnCooldown(target, message, outerModel.id);
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
          putOnCooldown(target, message, outerModel.id);
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
      putOnCooldown(target, message, outerModel.id);
      return { success: false, retryableFailure: `${target.label || "Target"}: ${message}` };
    }
    throw error;
  }

  lastAttemptByRoute.set(outerModel.id, target.label);

  if (lastMessage?.stopReason === "error" || lastMessage?.errorMessage) {
    const message = lastMessage.errorMessage || "Unknown terminal error";
    if (!sawSubstantive && isRetryableError(message)) {
      putOnCooldown(target, message, outerModel.id);
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

/** Look up model cost from the registry. Returns { input, output } in USD per 1M tokens, or null. */
function lookupModelCost(target: RouteTarget, context: Context): { inputUsd: number; outputUsd: number } | null {
  const model = resolveModelFromRegistry(target, context);
  if (!model) return null;
  const cost = (model as any).cost;
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return null;
  return { inputUsd: cost.input, outputUsd: cost.output };
}

/** Estimate cost for a target given estimated input tokens and a rough output multiplier (default 4×). */
function estimateModelCost(target: RouteTarget, context: Context, estimatedInputTokens: number): number | null {
  const cost = lookupModelCost(target, context);
  if (!cost) return null;
  const estimatedOutputTokens = estimatedInputTokens * 4;
  return (estimatedInputTokens * cost.inputUsd + estimatedOutputTokens * cost.outputUsd) / 1_000_000;
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
      refreshBalances();
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

      // === PolicyEngine: evaluate strategy rules (pre-constraint) ===
      let effectiveTierFinal = effectiveTier;
      let filteredHealthy = healthy;
      const strategyHints = policyEngine.evaluateStrategy(ctx);
      // Store evaluation trace for /auto-router explain
      lastStrategyTraceByRoute.set(routeId, {
        rules: policyEngine.getLastTrace().map((r) => ({ name: r.name, matched: r.matched })),
        hints: strategyHints ? formatHintsHuman(strategyHints) : null,
      });
      if (strategyHints) {
        // Apply tier override
        if (strategyHints.tierOverride) effectiveTierFinal = strategyHints.tierOverride;
        // Apply provider exclusions
        if (strategyHints.excludeProviders && strategyHints.excludeProviders.length > 0) {
          const excludeSet = new Set(strategyHints.excludeProviders);
          filteredHealthy = healthy.filter((t) => !excludeSet.has(t.provider));
          // Rebuild ctx with filtered targets so constraint solver sees the reduced set
          ctx.availableTargets = filteredHealthy;
        }
        // Apply billing model enforcement
        if (strategyHints.enforceBilling) {
          filteredHealthy = filteredHealthy.filter((t) => getTargetBilling(t) === strategyHints.enforceBilling);
          ctx.availableTargets = filteredHealthy;
        }
      }

      const requirements = inferRequirements(ctx, tierToRequirements(effectiveTierFinal, ctx.estimatedTokens));
      // Merge strategy constraint overrides into requirements
      if (strategyHints) {
        if (strategyHints.forceReasoning) requirements.reasoning = true;
        if (strategyHints.forceVision) requirements.vision = true;
        if (typeof strategyHints.forceMinContext === "number") {
          requirements.minContextWindow = Math.max(requirements.minContextWindow ?? 0, strategyHints.forceMinContext);
        }
      }
      const solved = solveConstraints(ctx, {
        requirements,
        capabilities: (t) => lookupCapabilities(t, context),
        isOnCooldown: (t) => {
          const c = cooldowns.get(getTargetKey(t, routeId));
          if (c && c.until > Date.now()) return true;
          // Circuit breaker: skip providers with an open circuit
          if (circuitBreaker.isOpen(t.provider)) return true;
          return false;
        },
        isHealthy: (t) => healthCache.isHealthy(t.provider, t.authProvider),
      });

      const partition = partitionAuditedCandidates(solved.candidates, budgetState, { hardMode: uviHardMode });
      const auditedRejections = partition.rejections;
      const budgetWarnings = partition.warnings;
      const uviNotes = partition.uviNotes;

      // Sort within UVI buckets: latency → cost → config order.
      // Build a config-order index so we can break ties by priority (L1 before L8).
      const configIndex = new Map(ctx.availableTargets.map((t, i) => [getTargetKey(t), i]));
      const rankedSort = (a: RouteTarget, b: RouteTarget): number => {
        // 1. Both have latency data — compare directly (lower is better)
        const la = latencyTracker.getAvgLatency(a.provider);
        const lb = latencyTracker.getAvgLatency(b.provider);
        if (la !== null && lb !== null && la !== lb) return la - lb;
        // 2. One or both have unknown latency — sort by estimated cost (cheaper first)
        const ca = estimateModelCost(a, context, ctx.estimatedTokens);
        const cb = estimateModelCost(b, context, ctx.estimatedTokens);
        if (ca !== null && cb !== null && ca !== cb) return ca - cb;
        // 3. One has cost data, the other doesn't — prefer the one we can price
        if (ca !== null && cb === null) return -1;
        if (ca === null && cb !== null) return 1;
        // 4. Everything tied — preserve config order (L1 before L8)
        const ia = configIndex.get(getTargetKey(a)) ?? 999;
        const ib = configIndex.get(getTargetKey(b)) ?? 999;
        return ia - ib;
      };
      partition.promoted.sort(rankedSort);
      partition.normal.sort(rankedSort);
      partition.demoted.sort(rankedSort);

      // === PolicyEngine: apply post-partition hints (prefer/require providers) ===
      if (strategyHints?.requireProvider) {
        // Move the required provider to the front of promoted (or normal if no promoted)
        const reqProv = strategyHints.requireProvider;
        const moveToFront = (arr: RouteTarget[]) => {
          const idx = arr.findIndex((t) => t.provider === reqProv);
          if (idx > 0) {
            const [item] = arr.splice(idx, 1);
            arr.unshift(item);
          }
        };
        moveToFront(partition.promoted);
        moveToFront(partition.normal);
        // If the required provider isn't in any bucket but is in demoted, promote it
        const inDemoted = partition.demoted.findIndex((t) => t.provider === reqProv);
        if (inDemoted >= 0) {
          const [item] = partition.demoted.splice(inDemoted, 1);
          partition.normal.unshift(item);
        }
      }
      if (strategyHints?.preferProviders && strategyHints.preferProviders.length > 0) {
        const preferSet = new Set(strategyHints.preferProviders);
        const preferSort = (a: RouteTarget, b: RouteTarget): number => {
          const aPref = preferSet.has(a.provider) ? 0 : 1;
          const bPref = preferSet.has(b.provider) ? 0 : 1;
          if (aPref !== bPref) return aPref - bPref;
          // Within same preference group, sort by latency
          const la = latencyTracker.getAvgLatency(a.provider);
          const lb = latencyTracker.getAvgLatency(b.provider);
          if (la === null && lb === null) {
            // fall through to cost
          } else if (la === null) return 1;
          else if (lb === null) return -1;
          else if (la !== lb) return la - lb;
          // Same latency — cheaper first
          const ca = estimateModelCost(a, context, ctx.estimatedTokens);
          const cb = estimateModelCost(b, context, ctx.estimatedTokens);
          if (ca !== null && cb !== null && ca !== cb) return ca - cb;
          if (ca !== null && cb === null) return -1;
          if (ca === null && cb !== null) return 1;
          return 0;
        };
        partition.promoted.sort(preferSort);
        partition.normal.sort(preferSort);
        // Leave demoted as-is (don't promote stressed providers via preference)
      }
      const orderedAudited = [...partition.promoted, ...partition.normal, ...partition.demoted];
      const pipelineTargets = orderedAudited.length > 0
        ? orderedAudited
        : (solved.candidates.length > 0 ? solved.candidates : healthy);
      // In shadow mode: use legacy config-order targets for actual routing,
      // but fall back to pipeline targets if legacy is exhausted.
      const legacyTargets = shadowMode
        ? healthy.filter((t) => {
            if (!getProviderHealthCache().isHealthy(t.provider, t.authProvider)) return false;
            const c = cooldowns.get(getTargetKey(t, routeId));
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
      if (intent && intent.category !== "general") reasoningParts.push(`intent ${intent.category} (${(intent.confidence * 100).toFixed(0)}%) → tier=${effectiveTierFinal}`);
      if (strategyHints) {
        const ruleNames = policyEngine.getLastHints()?.ruleName;
        const stratParts: string[] = [];
        if (strategyHints.tierOverride) stratParts.push(`tier→${strategyHints.tierOverride}`);
        if (strategyHints.preferProviders?.length) stratParts.push(`prefer=[${strategyHints.preferProviders.join(",")}]`);
        if (strategyHints.excludeProviders?.length) stratParts.push(`exclude=[${strategyHints.excludeProviders.join(",")}]`);
        if (strategyHints.requireProvider) stratParts.push(`require=${strategyHints.requireProvider}`);
        if (stratParts.length > 0) {
          const label = ruleNames ? `strategy:${ruleNames}` : "strategy";
          reasoningParts.push(`${label} ${stratParts.join(" ")}`);
        }
      }
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
      const estCost = estimateModelCost(targets[0], context, ctx.estimatedTokens);
      if (estCost !== null) {
        reasoningParts.push(`est cost $${estCost.toFixed(4)}`);
      }
      const billing = getTargetBilling(targets[0]);
      const selectedLimit = billing === "per-token"
        ? budgetState.monthlyLimit?.[targets[0].provider]
        : budgetState.dailyLimit?.[targets[0].provider];
      const selectedSpend = billing === "per-token"
        ? (budgetState.monthlySpend?.[targets[0].provider] ?? 0)
        : (budgetState.dailySpend?.[targets[0].provider] ?? 0);
      const budgetRemaining = typeof selectedLimit === "number" && selectedLimit > 0
        ? Math.max(0, selectedLimit - selectedSpend)
        : 0;
      const decision: RoutingDecision = {
        tier: match?.tier ?? effectiveTierFinal ?? "swe",
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

      // Track outcomes for the decision log
      let finalOutcome: DecisionLogEntry["outcome"] | null = null;
      let finalLatencyMs = 0;
      let finalSelectedTarget = "";

      for (const target of targets) {
        lastAttemptByRoute.set(routeId, target.label);
        const t0 = Date.now();
        const result = await tryTarget(outer, model, target, context, options);
        if (result.success) {
          const elapsed = Date.now() - t0;
          finalOutcome = "success";
          finalLatencyMs = elapsed;
          finalSelectedTarget = target.label;
          latencyTracker.recordLatency(target.provider, elapsed);
          circuitBreaker.recordSuccess(target.provider);
          try { latencyTracker.save(); } catch { /* ignore */ }
          if (result.lastMessage?.usage) {
            try {
              await budgetTracker.recordUsage(target.provider, result.lastMessage.usage);
              if (getTargetBilling(target) === "per-token") {
                await budgetTracker.recordMonthlyUsage(target.provider, result.lastMessage.usage);
              }
            } catch {
              // ignore - never fail a successful response on stats write error
            }
          }
          activeTargetByRoute.delete(routeId);
          refreshStatus(routeId);
          // Log the decision with its outcome
          decisionLogger.log({
            timestamp: Date.now(),
            routeId,
            tier: decision.tier,
            phase: decision.phase,
            provider: decision.target.provider,
            modelId: decision.target.modelId,
            targetLabel: decision.target.label,
            reasoning: decision.reasoning,
            estimatedTokens: decision.metadata.estimatedTokens,
            budgetRemaining: decision.metadata.budgetRemaining,
            confidence: decision.metadata.confidence,
            outcome: finalOutcome,
            latencyMs: finalLatencyMs,
            selectedTarget: finalSelectedTarget,
          });
          outer.end();
          return;
        }
        if (result.retryableFailure) {
          circuitBreaker.recordFailure(target.provider);
          errors.push(result.retryableFailure);
          finalSelectedTarget = target.label;
          continue;
        }
        if (result.terminalError) {
          finalOutcome = "terminal_error";
          finalSelectedTarget = target.label;
          activeTargetByRoute.delete(routeId);
          refreshStatus(routeId);
          // Log the decision with terminal outcome
          decisionLogger.log({
            timestamp: Date.now(),
            routeId,
            tier: decision.tier,
            phase: decision.phase,
            provider: decision.target.provider,
            modelId: decision.target.modelId,
            targetLabel: decision.target.label,
            reasoning: decision.reasoning,
            estimatedTokens: decision.metadata.estimatedTokens,
            budgetRemaining: decision.metadata.budgetRemaining,
            confidence: decision.metadata.confidence,
            outcome: finalOutcome,
            latencyMs: 0,
            selectedTarget: finalSelectedTarget,
          });
          outer.end();
          return;
        }
      }

      activeTargetByRoute.delete(routeId);
      refreshStatus(routeId);
      // Log exhausted outcome
      decisionLogger.log({
        timestamp: Date.now(),
        routeId,
        tier: decision.tier,
        phase: decision.phase,
        provider: decision.target.provider,
        modelId: decision.target.modelId,
        targetLabel: decision.target.label,
        reasoning: decision.reasoning,
        estimatedTokens: decision.metadata.estimatedTokens,
        budgetRemaining: decision.metadata.budgetRemaining,
        confidence: decision.metadata.confidence,
        outcome: "exhausted",
        latencyMs: 0,
        selectedTarget: errors.length ? errors.join(" | ") : "all targets exhausted",
      });
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
  const circuitText = formatCircuitStatusSegment();
  return `auto-router ${getRouteName(routeId)}${tierHint}${shadowText}${hardText} | ${active} | healthy: ${healthy.join(", ") || "none"} | ${formatCooldowns(routeId)}${budgetText}${healthIssuesText}${circuitText}${uviText}`;
}

function formatUviStatusSegment(): string {
  const snaps: Record<string, UtilizationSnapshot> = {};

  // Subscription UVI (only when enabled)
  if (quotaCache.isEnabled()) {
    Object.assign(snaps, quotaCache.getAllSnapshots());
  }

  // Per-token UVI from monthly spend vs budget
  const now = Date.now();
  const monthlyLimit = budgetTracker.getMonthlyLimits();
  const monthlySpend = budgetTracker.getMonthlySpend();
  for (const [provider, balance] of balanceCache) {
    if (balance.error) continue;
    const limit = monthlyLimit[provider];
    if (!limit || limit <= 0) continue;
    const spend = monthlySpend[provider] ?? 0;
    const window = buildMonthlyQuotaWindow(provider, spend, limit, now);
    if (window) {
      snaps[provider] = aggregateProviderUVI(provider, [window], now);
    }
  }

  const hot = Object.values(snaps).filter((s) => s.status === "stressed" || s.status === "critical");
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

function formatCircuitStatusSegment(): string {
  const dump = circuitBreaker.dump();
  const open = Object.entries(dump).filter(([, s]) => s.state === "open" || s.state === "half-open");
  if (open.length === 0) return "";
  const parts = open.map(([provider, s]) => `${provider}=${s.state}(${s.failures}f)`);
  return ` | 🔌 circuit: ${parts.join(", ")}`;
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
  const healthySet = new Set(getHealthyTargets(routeId).map((t: RouteTarget) => getTargetKey(t, routeId)));
  const lines = (route.targets || []).map((target, index) => {
    if (!target) return `${index + 1}. [Invalid Target]`;
    const key = getTargetKey(target, routeId);
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
    (() => { const l = getPrimaryModelLimitsFn(route); return `thinking=${route.reasoning !== false} | vision=${(route.input ?? ["text", "image"]).includes("image")} | ctx=${l.contextWindow.toLocaleString()} | max=${l.maxTokens.toLocaleString()}${route.contextWindow ? " (forced)" : ""}`; })(),
    ...lines
  ].join("\n");
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
  const aliasKey = findCaseInsensitiveKey(aliasesCache as Record<string, unknown>, name);
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
      const limits = getPrimaryModelLimitsFn(route);
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
        lastStrategyTraceByRoute.clear();
        getProviderHealthCache().clear();
        latencyTracker.clear();
        feedbackTracker.clear();
        decisionLogger.clear();
        policyEngine.reset();
        circuitBreaker.clear();
        balanceCache.clear();
        balanceFetchErrors = {};
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

      if (subcommand === "rate") {
        const [ratingRaw, ...reasonParts] = remainder ? remainder.split(/\s+/) : [];
        const rating = String(ratingRaw ?? "").toLowerCase();
        if (rating !== "good" && rating !== "bad") {
          ctx.ui.notify("Usage: /auto-router rate <good|bad> [reason]", "error");
          return;
        }
        const lastDecision = lastDecisionByRoute.values().next().value as RoutingDecision | undefined;
        // Find the most recent decision across all routes
        let recentDecision: RoutingDecision | undefined;
        for (const d of lastDecisionByRoute.values()) {
          recentDecision = d; // last inserted wins
        }
        if (!recentDecision) {
          ctx.ui.notify("No routing decision to rate yet. Send a prompt first.", "warning");
          return;
        }
        const reason = reasonParts.length > 0 ? reasonParts.join(" ") : undefined;
        feedbackTracker.record({
          provider: recentDecision.target.provider,
          modelId: recentDecision.target.modelId,
          routeId: recentDecision.target.provider, // use provider as route context
          rating: rating as "good" | "bad",
          reason,
          tier: recentDecision.tier,
          timestamp: Date.now(),
        });
        try { feedbackTracker.save(); } catch { /* ignore */ }
        const emoji = rating === "good" ? "👍" : "👎";
        const reasonSuffix = reason ? ` (${reason})` : "";
        ctx.ui.notify(`${emoji} Rated ${recentDecision.target.label} as ${rating}${reasonSuffix}`, "success");
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
          // Clear only subscription utilization; per-token UVI is independent
          budgetTracker.setUtilization({});
          syncUtilizationIntoBudget();
          ctx.ui.notify("UVI disabled. Per-token provider UVI (monthly budget) is unaffected.", "info");
          return;
        }
        if (action === "refresh") {
          const subscriptionEnabled = quotaCache.isEnabled();
          const perTokenCount = getPerTokenProviders().length;
          if (!subscriptionEnabled && perTokenCount === 0) {
            ctx.ui.notify("UVI is disabled and no per-token providers configured. Enable with /auto-router uvi enable (or set AUTO_ROUTER_UVI=1).", "warning");
            return;
          }
          ctx.ui.notify("Refreshing UVI snapshots...", "info");
          if (subscriptionEnabled) await quotaCache.refreshNow();
          if (perTokenCount > 0) { balanceLastRefreshAt = 0; await refreshBalances(); }
          syncUtilizationIntoBudget();
          const lines = formatUtilizationLines(quotaCache);
          ctx.ui.notify(lines.length > 0 ? ["UVI snapshot:", ...lines].join("\n") : "UVI: no snapshots (no providers with quota/balance data)", "info");
          return;
        }
        // show (default)
        const lines = formatUtilizationLines(quotaCache);
        const subscriptionEnabled = quotaCache.isEnabled();
        const perToken = getPerTokenProviders();
        const perTokenCount = perToken.length;
        const statusLabel = subscriptionEnabled
          ? (perTokenCount > 0 ? "enabled (+ per-token)" : "enabled")
          : (perTokenCount > 0 ? "enabled (per-token only)" : "disabled");
        const header = `UVI (${statusLabel}):`;
        // Collect per-token providers with fetch errors for diagnostics
        const balanceIssueLines: string[] = [];
        for (const [provider, err] of Object.entries(balanceFetchErrors)) {
          if (!lines.some((l) => l.includes(provider))) {
            balanceIssueLines.push(`  ${provider.padEnd(22)} [not showing: ${err}]`);
          }
        }
        if (lines.length === 0) {
          const hintParts: string[] = [];
          if (subscriptionEnabled) hintParts.push("No OAuth snapshots yet");
          if (perTokenCount > 0) hintParts.push("no per-token data");
          const hint = hintParts.length > 0
            ? `${hintParts.join("; ")}. Try /auto-router uvi refresh.`
            : "Set AUTO_ROUTER_UVI=1 or run /auto-router uvi enable to start polling.";
          const out = [header, `  ${hint}`];
          if (balanceIssueLines.length > 0) out.push(...balanceIssueLines);
          ctx.ui.notify(out.join("\n"), "info");
          return;
        }
        const out = [header, ...lines];
        if (perTokenCount === 0) {
          out.push("", "💡 Per-token providers: none configured. Set a monthly budget to enable:");
          out.push(`     /auto-router budget set <provider> <usd> monthly`);
        } else if (balanceIssueLines.length > 0) {
          out.push("", "⚠ per-token providers not showing:", ...balanceIssueLines);
        }
        out.push("", "Subcommands: show | refresh | enable | disable");
        ctx.ui.notify(out.join("\n"), "info");
        return;
      }

      if (subcommand === "balance") {
        const [actionRaw] = remainder ? remainder.split(/\s+/) : [];
        const action = String(actionRaw ?? "show").toLowerCase();
        if (action === "fetch" || action === "refresh") {
          balanceLastRefreshAt = 0;
          await refreshBalances();
          syncUtilizationIntoBudget();
        }
        // show (default)
        const perToken = getPerTokenProviders();
        if (perToken.length === 0) {
          ctx.ui.notify("No per-token providers configured. Add `\"billing\": \"per-token\"` to a route target, or set a monthly budget.", "info");
          return;
        }
        const lines: string[] = [];
        for (const { provider } of perToken) {
          const balance = balanceCache.get(provider);
          const monthlyLimit = budgetTracker.getMonthlyLimits()[provider];
          const monthlySpend = budgetTracker.getMonthlySpend()[provider] ?? 0;
          const limitText = monthlyLimit ? `$${monthlyLimit.toFixed(2)}` : "none";
          const pctText = monthlyLimit ? ` (${Math.round((monthlySpend / monthlyLimit) * 100)}% used)` : "";
          const errText = balanceFetchErrors[provider] ? ` [! ${balanceFetchErrors[provider]}]` : "";
          if (balance && !balance.error) {
            lines.push(`  ${provider.padEnd(22)} balance $${balance.totalBalance.toFixed(2)} ${balance.currency} | topped-up $${balance.toppedUpBalance.toFixed(2)} | budget ${limitText} | spent $${monthlySpend.toFixed(2)}${pctText}`);
          } else if (balance?.error) {
            lines.push(`  ${provider.padEnd(22)} [fetch error: ${balance.error}] | budget ${limitText} | spent $${monthlySpend.toFixed(2)}${pctText}`);
          } else {
            lines.push(`  ${provider.padEnd(22)} [not fetched yet${errText}] | budget ${limitText} | spent $${monthlySpend.toFixed(2)}${pctText}`);
          }
        }
        const uviLines = (() => {
          const snaps = balanceCache.size > 0 ? Object.fromEntries(
            [...balanceCache.entries()].filter(([, b]) => !b.error).map(([provider]) => {
              const limit = budgetTracker.getMonthlyLimits()[provider];
              if (!limit) return [];
              const spend = budgetTracker.getMonthlySpend()[provider] ?? 0;
              const window = buildMonthlyQuotaWindow(provider, spend, limit);
              if (!window) return [];
              const snap = aggregateProviderUVI(provider, [window]);
              return [provider, snap];
            }).filter((x) => x.length > 0)
          ) : {};
          return Object.entries(snaps).map(([provider, snap]) => {
            return `  ${provider.padEnd(22)} UVI=${snap.uvi.toFixed(2).padStart(5)} ${snap.status.padEnd(8)} | monthly@${Math.round((budgetTracker.getMonthlySpend()[provider] ?? 0) / (budgetTracker.getMonthlyLimits()[provider] ?? 1) * 100)}%`;
          });
        })();
        ctx.ui.notify([
          "Per-token provider balances:",
          ...lines,
          ...(uviLines.length > 0 ? ["", "Monthly UVI:", ...uviLines] : []),
          "",
          "Subcommands: show | fetch (refresh)",
          "Set monthly budget: /auto-router budget set <provider> <usd> monthly",
        ].join("\n"), "info");
        return;
      }

      if (subcommand === "budget") {
        await ensureBudgetLoaded();
        const [actionRaw, ...restArgs] = remainder ? remainder.split(/\s+/) : [];
        const action = String(actionRaw ?? "show").toLowerCase();
        if (action === "show" || action === "" || !actionRaw) {
          const summary = budgetTracker.getDailySummary();
          const day = todayKey();
          const mon = monthKey();
          const lines: string[] = [];
          const seen = new Set<string>();
          for (const s of summary) {
            seen.add(s.provider);
            const limitText = typeof s.limitUsd === "number" ? `limit $${s.limitUsd.toFixed(2)}` : "no limit";
            const ratio = typeof s.limitUsd === "number" && s.limitUsd > 0 ? ` (${Math.round((s.estimatedCost / s.limitUsd) * 100)}%)` : "";
            lines.push(`  ${s.provider.padEnd(22)} spend $${s.estimatedCost.toFixed(2)} | in ${s.inputTokens} | out ${s.outputTokens} | ${limitText}${ratio}`);
          }
          // Add monthly providers
          const monthlyLimits = budgetTracker.getMonthlyLimits();
          const monthlySpend = budgetTracker.getMonthlySpend();
          for (const [provider, limit] of Object.entries(monthlyLimits)) {
            if (seen.has(provider)) continue;
            seen.add(provider);
            const spend = monthlySpend[provider] ?? 0;
            const ratio = limit > 0 ? ` (${Math.round((spend / limit) * 100)}%)` : "";
            const monthlyStats = budgetTracker.getMonthlyProviderStats(provider);
            lines.push(`  ${provider.padEnd(22)} spend $${spend.toFixed(2)} | in ${monthlyStats.inputTokens} | out ${monthlyStats.outputTokens} | monthly limit $${limit.toFixed(2)}${ratio}`);
          }
          if (lines.length === 0) {
            ctx.ui.notify(`No budget activity yet for ${day} (daily) / ${mon} (monthly). Set a limit with: /auto-router budget set <provider> <usd> [monthly]`, "info");
            return;
          }
          const uviLines = formatUtilizationLines(quotaCache);
          const out = [`Auto-router budget for ${day} (daily) / ${mon} (monthly):`, ...lines];
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
          const maybeMonthly = String(restArgs[2] ?? "").toLowerCase();
          if (!provider || !Number.isFinite(amount) || amount <= 0) {
            ctx.ui.notify("Usage: /auto-router budget set <provider> <usd> [monthly]", "error");
            return;
          }
          if (maybeMonthly === "monthly") {
            await budgetTracker.setMonthlyLimit(provider, amount);
            ctx.ui.notify(`Set monthly budget for ${provider} = $${amount.toFixed(2)}`, "info");
          } else {
            await budgetTracker.setDailyLimit(provider, amount);
            ctx.ui.notify(`Set daily budget for ${provider} = $${amount.toFixed(2)}`, "info");
          }
          return;
        }
        if (action === "clear") {
          const provider = restArgs[0];
          const maybeMonthly = String(restArgs[1] ?? "").toLowerCase();
          if (!provider) {
            ctx.ui.notify("Usage: /auto-router budget clear <provider> [monthly]", "error");
            return;
          }
          if (maybeMonthly === "monthly") {
            await budgetTracker.clearMonthlyLimit(provider);
            ctx.ui.notify(`Cleared monthly budget for ${provider}`, "info");
          } else {
            await budgetTracker.clearDailyLimit(provider);
            ctx.ui.notify(`Cleared daily budget for ${provider}`, "info");
          }
          return;
        }
        ctx.ui.notify("Usage: /auto-router budget [show|set <provider> <usd> [monthly]|clear <provider> [monthly]]", "error");
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
        const providerStats = feedbackTracker.getProviderStats();
        const ps = providerStats[decision.target.provider];
        const ratingLine = ps
          ? `  ratings:    ${ps.good}👍 ${ps.bad}👎 (${ps.total} total, ${ps.total > 0 ? ((ps.good / ps.total) * 100).toFixed(0) : 0}% good)`
          : `  ratings:    none yet`;
        const lines = [
          `Last routing decision for ${routeId}:`,
          `  phase:      ${decision.phase}`,
          `  tier:       ${decision.tier}`,
          `  target:     ${describeTarget(decision.target)}`,
          ratingLine,
          `  confidence: ${decision.metadata.confidence.toFixed(2)}`,
          `  est tokens: ${decision.metadata.estimatedTokens}`,
          shortcut ? `  shortcut:   ${shortcut.shortcut} (tier=${shortcut.tier})` : `  shortcut:   none`,
          `  reasoning:  ${decision.reasoning}`,
        ];
        // Append strategy evaluation trace if available
        const stratTrace = lastStrategyTraceByRoute.get(routeId);
        if (stratTrace && stratTrace.rules.length > 0) {
          lines.push("", "Strategy rules evaluated:");
          for (const rule of stratTrace.rules) {
            const marker = rule.matched ? "✅" : "❌";
            lines.push(`  ${marker} ${rule.name}`);
          }
          if (stratTrace.hints) {
            lines.push(`  → applied: ${stratTrace.hints}`);
          }
        }
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

      if (subcommand === "rules") {
        const strategyRules = policyEngine.getStrategyRules();
        const allRules = policyEngine.getRules();
        const lastHints = policyEngine.getLastHints();
        const lines: string[] = [];
        if (strategyRules.length === 0 && allRules.length === 0) {
          lines.push("  No policy rules configured.");
          lines.push("");
          lines.push("  Add policyRules to a route in auto-router.routes.json:");
          lines.push('  "policyRules": [');
          lines.push('    { "name": "prefer-claude", "type": "prefer-provider", "provider": "claude-agent-sdk", "priority": 1 }');
          lines.push('  ]');
        } else {
          if (strategyRules.length > 0) {
            lines.push(`Strategy rules (${strategyRules.length}):`);
            for (const r of strategyRules) {
              lines.push(`  ${r.name.padEnd(24)} priority=${r.priority}`);
            }
          }
          if (allRules.length > 0) {
            if (strategyRules.length > 0) lines.push("");
            lines.push(`Decision rules (${allRules.length}):`);
            for (const r of allRules) {
              lines.push(`  ${r.name.padEnd(24)} priority=${r.priority}`);
            }
          }
        }
        if (lastHints) {
          lines.push("");
          lines.push(`Last applied: ${lastHints.ruleName}`);
          lines.push(`  hints: ${JSON.stringify(lastHints.hints)}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (subcommand === "circuit") {
        const dump = circuitBreaker.dump();
        const providers = Object.keys(dump);
        if (providers.length === 0) {
          ctx.ui.notify("Circuit breaker: no providers have been tracked yet (no failures recorded).", "info");
          return;
        }
        const lines: string[] = ["Circuit breaker state:"];
        for (const [provider, state] of Object.entries(dump)) {
          const icon = state.state === "open" ? "🔴" : state.state === "half-open" ? "🟡" : "🟢";
          const openedInfo = state.openedAt > 0 ? ` (opened ${Math.round((Date.now() - state.openedAt) / 1000)}s ago)` : "";
          lines.push(`  ${icon} ${provider.padEnd(22)} ${state.state.padEnd(10)} failures=${state.failures}${openedInfo}`);
        }
        lines.push("", `Threshold: ${circuitBreaker.failureThreshold} failures within ${circuitBreaker.windowMs / 1000}s window, ${circuitBreaker.cooldownMs / 1000}s cooldown`);
        lines.push("Reset: /auto-router reset");
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (subcommand === "decisions") {
        const [actionRaw, ...actionRest] = remainder ? remainder.split(/\s+/) : [];
        const action = String(actionRaw ?? "recent").toLowerCase();

        if (action === "recent" || action === "list") {
          const limit = parseInt(actionRest[0] ?? "10", 10);
          if (isNaN(limit) || limit < 1 || limit > 500) {
            ctx.ui.notify("Usage: /auto-router decisions recent [count=10]", "error");
            return;
          }
          const recent = decisionLogger.getRecent(limit);
          if (recent.length === 0) {
            ctx.ui.notify("No routing decisions logged yet. Send a prompt first.", "info");
            return;
          }
          const lines = recent.map((e, i) => {
            const ts = new Date(e.timestamp).toLocaleTimeString();
            const icon = e.outcome === "success" ? "✅" : e.outcome === "terminal_error" ? "❌" : "⚠️";
            return `  ${String(i + 1).padEnd(3)} ${icon} ${ts.padEnd(11)} ${e.tier.padEnd(10)} ${e.targetLabel.padEnd(28)} ${e.outcome}${e.outcome === "success" ? ` (${e.latencyMs}ms)` : ""}`;
          });
          ctx.ui.notify([
            `Routing decisions (last ${recent.length}):`,
            `  ${recent.length > 0 ? `Path: ${decisionLogger.logFilePath}` : ""}`,
            `  Total logged: ${decisionLogger.count}`,
            "",
            ...lines,
          ].join("\n"), "info");
          return;
        }

        if (action === "stats") {
          const providerStats = decisionLogger.getProviderStats();
          const tierStats = decisionLogger.getTierStats();
          const providerLines = Object.entries(providerStats)
            .sort(([, a], [, b]) => b.attempts - a.attempts)
            .map(([provider, s]) => {
              const rate = s.attempts > 0 ? ((s.successes / s.attempts) * 100).toFixed(0) : "-";
              return `  ${provider.padEnd(22)} attempts=${s.attempts} success=${rate}% avg=${s.avgLatencyMs}ms`;
            });
          const tierLines = Object.entries(tierStats)
            .sort(([, a], [, b]) => b.count - a.count)
            .map(([tier, s]) => {
              return `  ${tier.padEnd(12)} count=${String(s.count).padEnd(4)} success=${(s.successRate * 100).toFixed(0)}% conf=${s.avgConfidence.toFixed(2)}`;
            });
          ctx.ui.notify([
            `Decision log stats (${decisionLogger.count} total entries):`,
            "",
            "Per provider:",
            ...(providerLines.length > 0 ? providerLines : ["  none yet"]),
            "",
            "Per tier:",
            ...(tierLines.length > 0 ? tierLines : ["  none yet"]),
          ].join("\n"), "info");
          return;
        }

        if (action === "show") {
          const routeId = actionRest[0] || activeRouteId;
          if (!routeId) {
            ctx.ui.notify("Usage: /auto-router decisions show <routeId>", "error");
            return;
          }
          const entries = decisionLogger.query((e) => e.routeId === routeId).slice(-10).reverse();
          if (entries.length === 0) {
            ctx.ui.notify(`No decisions logged for route "${routeId}".`, "info");
            return;
          }
          const lines = entries.map((e, i) => {
            const ts = new Date(e.timestamp).toLocaleString();
            const icon = e.outcome === "success" ? "✅" : e.outcome === "terminal_error" ? "❌" : "⚠️";
            return `  ${i + 1}. ${icon} ${ts} — ${e.targetLabel} → ${e.outcome}${e.outcome === "success" ? ` (${e.latencyMs}ms)` : ""}`;
          });
          ctx.ui.notify([
            `Decisions for "${routeId}" (last ${entries.length}):`,
            ...lines,
          ].join("\n"), "info");
          return;
        }

        if (action === "export") {
          const all = decisionLogger.query();
          if (all.length === 0) {
            ctx.ui.notify("No decisions to export.", "info");
            return;
          }
          // Summarize as a compact table
          const byProvider = decisionLogger.getProviderStats();
          const byTier = decisionLogger.getTierStats();
          const lines = [
            `Decision Log Export — ${all.length} entries`,
            `File: ${decisionLogger.logFilePath}`,
            "",
            "Per Provider:",
            ...Object.entries(byProvider)
              .sort(([, a], [, b]) => b.attempts - a.attempts)
              .map(([p, s]) => `  ${p}: ${s.successes}/${s.attempts} success (${s.attempts > 0 ? ((s.successes / s.attempts) * 100).toFixed(0) : 0}%), avg ${s.avgLatencyMs}ms`),
            "",
            "Per Tier:",
            ...Object.entries(byTier)
              .sort(([, a], [, b]) => b.count - a.count)
              .map(([t, s]) => `  ${t}: ${s.count} calls, ${(s.successRate * 100).toFixed(0)}% success, avg conf ${s.avgConfidence.toFixed(2)}`),
            "",
            `Raw JSONL path: ${decisionLogger.logFilePath}`,
            `Analyze with: cat "${decisionLogger.logFilePath}" | jq -s .`,
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        if (action === "clear") {
          decisionLogger.clear();
          ctx.ui.notify("Decision log cleared.", "success");
          return;
        }

        ctx.ui.notify([
          "Usage: /auto-router decisions <subcommand>",
          "",
          "Subcommands:",
          "  recent [count=10]   Show last N decisions",
          "  show <routeId>      Show decisions for a specific route",
          "  stats               Per-provider and per-tier summary",
          "  export              Summary with jq analysis tip",
          "  clear               Wipe the decision log",
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
        "/auto-router balance [show|fetch]",
        "/auto-router budget [show|set <provider> <usd> [monthly]|clear <provider> [monthly]]",
        "/auto-router uvi [show|enable|disable|refresh]",
        "/auto-router shadow [show|enable|disable]",
        "/auto-router rate <good|bad> [reason]",
        "/auto-router decisions [recent|stats|show|export|clear]",
        "/auto-router test-resolve <provider/modelId>",
        "/auto-router debug",
        "/auto-router reload",
        "/auto-router reset"
      ].join("\n"), "info");
    }
  });
}
