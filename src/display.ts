import type { RouteTarget, RoutingHints } from "./types.ts";

/** Parse a "provider/modelId" spec string. Returns null for invalid input. */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | null {
  if (spec.includes("://")) return null; // ignore URLs
  const firstSlash = spec.indexOf("/");
  if (firstSlash <= 0) return null; // need provider/modelId
  const provider = spec.substring(0, firstSlash).trim();
  const modelId = spec.substring(firstSlash + 1).trim();
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

/** Human-readable description of a route target. */
export function describeTarget(target: RouteTarget | undefined | null): string {
  if (!target) return "(none)";
  const provider = target.provider || "unknown";
  const model = target.modelId || "unknown";
  return `${target.label || `${provider}/${model}`} [${provider}/${model}]`;
}

/** Format RoutingHints for display in /auto-router explain. */
export function formatHintsHuman(hints: RoutingHints): string {
  const parts: string[] = [];
  if (hints.tierOverride) parts.push(`tier→${hints.tierOverride}`);
  if (hints.forceReasoning) parts.push("reasoning");
  if (hints.forceVision) parts.push("vision");
  if (typeof hints.forceMinContext === "number") parts.push(`ctx≥${hints.forceMinContext}`);
  if (hints.requireProvider) parts.push(`require=${hints.requireProvider}`);
  if (hints.preferProviders?.length) parts.push(`prefer=[${hints.preferProviders.join(",")}]`);
  if (hints.excludeProviders?.length) parts.push(`exclude=[${hints.excludeProviders.join(",")}]`);
  if (hints.enforceBilling) parts.push(`billing=${hints.enforceBilling}`);
  return parts.join(" ") || "(empty hints)";
}

/** Format a millisecond duration as a human-readable string (e.g. "30s", "5m", "2h", "1d"). */
export function formatRemainingMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.ceil(ms / 1_000))}s`;
  if (ms < 60 * 60_000) return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.max(1, Math.ceil(ms / (60 * 60_000)))}h`;
  return `${Math.max(1, Math.ceil(ms / (24 * 60 * 60_000)))}d`;
}

/** Extract a Retry-After style duration from an error message string. Returns ms or undefined. */
export function parseResetAfterMs(message: any): number | undefined {
  const text = String(message ?? "");
  const match = text.match(/reset after\s+(\d+)\s*(s|m|h|d|second|minute|hour|day)s?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase()[0];
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

/** Parse a clock-time reset like "resets 8pm (America/Los_Angeles)" and return ms until that time. */
export function parseClockResetMs(message: any): number | undefined {
  const text = String(message ?? "");
  // Match: "resets 8pm", "resets 8pm (America/Los_Angeles)", "resets 11:30am", etc.
  const match = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)(?:\s*\(([^)]+)\))?/i);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]) || 0;
  const ampm = match[3].toLowerCase();
  if (!Number.isFinite(hour) || hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined;
  const hour24 = ampm === "pm" && hour !== 12 ? hour + 12 : ampm === "am" && hour === 12 ? 0 : hour;
  const now = Date.now();
  const target = new Date(now);
  target.setHours(hour24, minute, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  const ms = target.getTime() - now;
  return ms > 0 ? ms : undefined;
}

/** Determine cooldown duration in ms based on the error message content. */
export function getCooldownMs(message: any): number {
  const explicitResetMs = parseResetAfterMs(message);
  if (explicitResetMs) return explicitResetMs + 5_000;
  const clockResetMs = parseClockResetMs(message);
  if (clockResetMs) return clockResetMs;

  const text = String(message ?? "").toLowerCase();
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many requests")) return 2 * 60_000;
  if (text.includes("hit your limit") || text.includes("credits exhausted") || text.includes("insufficient balance")) return 30 * 60_000;
  if (text.includes("quota") || text.includes("capacity") || text.includes("overloaded") || text.includes("503")) return 5 * 60_000;
  if (/\b(404|410)\b/.test(text) || text.includes("not found") || text.includes("model not available") || text.includes("gone")) return 60 * 60_000;
  if (/\b400\b/.test(text) || text.includes("bad request") || text.includes("maximum context length") || text.includes("context_length_exceeded")) return 30_000;
  return 90_000;
}

/** Normalize a model token string for fuzzy matching (lowercase, strip tags, remove non-alphanumeric). */
export function normalizeModelToken(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/:(cloud|latest|instruct)$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Case-insensitive key lookup in a record. Returns the actual key or undefined. */
export function findCaseInsensitiveKey<T>(record: Record<string, T>, needle: string): string | undefined {
  const normalized = String(needle ?? "").toLowerCase();
  return Object.keys(record).find((key) => String(key ?? "").toLowerCase() === normalized);
}

/** Env var candidate names for a given provider (e.g. "ollama" → OLLAMA_API_KEY, OLLAMA_KEY). */
export function providerApiKeyEnvVars(provider: string): string[] {
  const upper = provider.toUpperCase();
  const dashed = provider.replace(/-/g, "_").toUpperCase();
  return [`${upper}_API_KEY`, `${upper}_KEY`, `${dashed}_API_KEY`];
}

/** Resolve an API key from environment variables for a provider. Returns undefined if none set. */
export function resolveProviderApiKeyFromEnv(provider: string): string | undefined {
  for (const name of providerApiKeyEnvVars(provider)) {
    const val = process.env[name];
    if (val) return val;
  }
  return undefined;
}

/** Model descriptor with cost info (mirrors Model<Api> fields used for display). */
export interface ModelDisplayInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number };
}

/** Format a single model line for /auto-router models output. */
export function formatModelLine(
  model: ModelDisplayInfo,
  currentModel: { provider?: string; id?: string } | null | undefined,
): string {
  const current = currentModel && model.provider === currentModel.provider && model.id === currentModel.id;
  const marker = current ? " (current)" : "";
  const capabilities = [model.reasoning ? "reasoning" : null, model.input.includes("image") ? "vision" : null].filter(Boolean).join(", ");
  const capabilityText = capabilities ? ` [${capabilities}]` : "";
  const costText = `$${model.cost.input.toFixed(2)}/$${model.cost.output.toFixed(2)} per 1M tokens (in/out)`;
  return `${model.provider}/${model.id}${marker}${capabilityText}\n  ${model.name} | ctx: ${model.contextWindow.toLocaleString()} | max: ${model.maxTokens.toLocaleString()}\n  ${costText}`;
}
