# Deferred Ideas

## PolicyEngine Follow-ups
- **Feedback-driven rules**: Wire FeedbackTracker ratings into PolicyEngine as a condition source. Requires actual feedback data to be useful.

## Architecture
- **Continue extracting from index.ts**: `resolveModelFromRegistry`, `getPrimaryModelLimits`, `formatModelLine` — these semi-pure functions could be extracted next. `resolveModelFromRegistry` requires mocking pi SDK types.
