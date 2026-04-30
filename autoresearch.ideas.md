# Deferred Ideas

## PolicyEngine Follow-ups
- **Feedback-driven rules**: Wire FeedbackTracker ratings into PolicyEngine as a condition source. Requires actual feedback data to be useful.

## Architecture
- **Continue extracting from index.ts**: `resolveModelFromRegistry`, `getPrimaryModelLimits`, `formatModelLine` — these semi-pure functions could be extracted next. `resolveModelFromRegistry` requires mocking pi SDK types.

## Routing Quality (from audit)
- **Replace broken Gemini 3.1 Pro**: "Antigravity is no longer supported" — L4 target in swe route is dead. Consider replacing with Gemini 3.2 or an alternative frontier model.
- **Per-route cooldown for Claude Opus**: With cooldown isolation working, the swe route's L1 Claude Opus should start being reachable (once rate-limit resets). Monitor `/auto-router decisions` for L1 hit rate improvement.
- **Tier-differentiated routing**: IntentToTier maps "analysis"→"reasoning" and "code"→"swe", but targets within a route aren't tier-filtered — all targets are candidates regardless of tier. Consider selecting target subsets based on effective tier for better intent-routing alignment.
- **Parse "resets Xpm" in error messages**: Claude Code errors like "resets 8pm (America/Los_Angeles)" could be parsed to compute exact cooldown duration instead of falling back to 30min heuristic.
