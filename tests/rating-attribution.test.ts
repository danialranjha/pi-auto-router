import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRatingFromCompletedDecision, getMostRecentCompletedDecision, rememberCompletedDecision, type CompletedDecisionFeedbackContext } from "../src/rating-attribution.ts";

function makeDecision(overrides: Partial<CompletedDecisionFeedbackContext> = {}): CompletedDecisionFeedbackContext {
  return {
    timestamp: 1,
    routeId: "subscription-swe",
    requestId: "req-1",
    conversationId: "conv-1",
    provider: "deepseek",
    modelId: "deepseek-v4",
    label: "DeepSeek V4",
    tier: "swe",
    intent: "code",
    outcome: "success",
    ...overrides,
  };
}

describe("rating attribution helpers", () => {
  it("returns the most recently completed decision", () => {
    let history: CompletedDecisionFeedbackContext[] = [];
    history = rememberCompletedDecision(history, makeDecision({ requestId: "req-1", timestamp: 1000 }));
    history = rememberCompletedDecision(history, makeDecision({ requestId: "req-2", timestamp: 2000, provider: "anthropic" }));
    assert.equal(getMostRecentCompletedDecision(history)?.requestId, "req-2");
    assert.equal(getMostRecentCompletedDecision(history)?.provider, "anthropic");
  });

  it("caps remembered decisions to the configured max", () => {
    let history: CompletedDecisionFeedbackContext[] = [];
    history = rememberCompletedDecision(history, makeDecision({ requestId: "req-1" }), 1);
    history = rememberCompletedDecision(history, makeDecision({ requestId: "req-2" }), 1);
    assert.equal(history.length, 1);
    assert.equal(history[0].requestId, "req-2");
  });

  it("builds ratings using the route id instead of provider id", () => {
    const rating = buildRatingFromCompletedDecision(makeDecision(), {
      rating: "bad",
      reason: "too slow",
      tags: ["latency"],
      timestamp: 3000,
    });
    assert.equal(rating.provider, "deepseek");
    assert.equal(rating.routeId, "subscription-swe");
    assert.equal(rating.requestId, "req-1");
    assert.equal(rating.conversationId, "conv-1");
    assert.deepEqual(rating.tags, ["latency"]);
  });
});
