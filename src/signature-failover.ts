/** Gemini emits these before accepting a request, so failover is safe only before output. */
export function isThoughtSignatureCompatibilityError(error: unknown): boolean {
  const text = String(error ?? "").toLowerCase();
  const mentionsSignature = text.includes("thought_signature")
    || text.includes("thought signature")
    || text.includes("thoughtsignature");
  const isCompatibilityFailure = text.includes("missing")
    || text.includes("required")
    || text.includes("corrupt")
    || text.includes("invalid");
  return mentionsSignature && isCompatibilityFailure;
}

export function shouldFailOverThoughtSignatureError(error: unknown, sawSubstantiveOutput: boolean): boolean {
  return !sawSubstantiveOutput && isThoughtSignatureCompatibilityError(error);
}
