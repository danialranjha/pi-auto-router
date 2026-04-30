# Deferred Ideas

## PolicyEngine Follow-ups
- **Feedback-driven rules**: Wire FeedbackTracker ratings into PolicyEngine as a condition source. Requires actual feedback data to be useful.

## Architecture
- **Extract remaining from index.ts**: `resolveModelFromRegistry` and `getPrimaryModelLimits` are the last extractable functions. Both require mocking pi SDK types.

## Routing Quality (from audit)
- **Replace broken Gemini 3.1 Pro**: "Antigravity is no longer supported" — L4 target in swe route is dead. Consider replacing with Gemini 3.2 or an alternative frontier model.
- **Per-route cooldown for Claude Opus**: With cooldown isolation working, the swe route's L1 Claude Opus should start being reachable (once rate-limit resets). Monitor `/auto-router decisions` for L1 hit rate improvement.
- **Tier-differentiated routing**: IntentToTier maps "analysis"→"reasoning" and "code"→"swe", but targets within a route aren't tier-filtered — all targets are candidates regardless of tier. Consider selecting target subsets based on effective tier for better intent-routing alignment.
