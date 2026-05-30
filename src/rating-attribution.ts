import type { Rating, RatingValue } from "./feedback-tracker.ts";

export type CompletedDecisionFeedbackContext = {
  timestamp: number;
  routeId: string;
  requestId: string;
  conversationId: string;
  provider: string;
  modelId: string;
  label: string;
  tier: string;
  intent?: string;
  outcome?: string;
};

export function rememberCompletedDecision(
  history: CompletedDecisionFeedbackContext[],
  decision: CompletedDecisionFeedbackContext,
  maxEntries = 100,
): CompletedDecisionFeedbackContext[] {
  const next = [...history, decision];
  return next.length > maxEntries ? next.slice(-maxEntries) : next;
}

export function getMostRecentCompletedDecision(
  history: CompletedDecisionFeedbackContext[],
): CompletedDecisionFeedbackContext | undefined {
  return history.length > 0 ? history[history.length - 1] : undefined;
}

export function buildRatingFromCompletedDecision(
  decision: CompletedDecisionFeedbackContext,
  input: {
    rating: RatingValue;
    reason?: string;
    tags?: string[];
    timestamp: number;
  },
): Rating {
  return {
    provider: decision.provider,
    modelId: decision.modelId,
    routeId: decision.routeId,
    rating: input.rating,
    reason: input.reason,
    tags: input.tags,
    tier: decision.tier,
    intent: decision.intent,
    requestId: decision.requestId,
    conversationId: decision.conversationId,
    timestamp: input.timestamp,
  };
}
