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

/** Determine cooldown duration in ms based on the error message content. */
export function getCooldownMs(message: any): number {
  const explicitResetMs = parseResetAfterMs(message);
  if (explicitResetMs) return explicitResetMs + 5_000;

  const text = String(message ?? "").toLowerCase();
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many requests")) return 2 * 60_000;
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
