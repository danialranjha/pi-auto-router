import { isThoughtSignatureCompatibilityError } from "./signature-failover.ts";

/** Route-independent identity; distinct configured auth identities stay isolated. */
export function getOperationalTargetKey(target: { provider: string; modelId: string; authProvider?: string }): string {
  return JSON.stringify([target.provider, target.modelId, target.authProvider ?? target.provider]);
}

/** Preserve route-local cooldowns while separating configured auth identities. */
export function getOperationalCooldownKey(target: { provider: string; modelId: string; authProvider?: string }, routeId?: string): string {
  return JSON.stringify([routeId ?? "", getOperationalTargetKey(target)]);
}

/** Same-request failover is broader than evidence of operational unavailability. */
export function isOperationalFailure(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  if (isThoughtSignatureCompatibilityError(text)) return false;
  // Keep existing auth/input cooldown and failover behavior, without poisoning
  // operational streaks for failures tied to credentials or conversation data.
  if (/\b(400|401|403|404|410)\b/.test(text) || [
    "no api key", "no valid credentials", "unauthorized", "invalid api key",
    "invalid google cloud code assist credentials", "invalid 'input", "call_id",
    "function_response.name", "required_field_missing", "invalid_request_error",
    "bad request", "context_length_exceeded", "maximum context length",
  ].some((needle) => text.includes(needle))) return false;
  return [
    "429", "421", "misdirected request", "rate limit", "ratelimit", "rate_limited", "too many requests",
    "overloaded", "over capacity", "capacity reached", "busy", "temporarily unavailable",
    "timeout", "timed out", "econnreset", "etimedout", "network", "connection",
    "try again", "internal server error", "502", "503", "504", "500",
    "quota", "hit your limit", "credits exhausted", "insufficient balance",
    "bad gateway", "service unavailable", "gateway timeout", "upstream",
  ].some((needle) => text.includes(needle));
}
