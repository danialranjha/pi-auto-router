# Deferred Ideas

## PolicyEngine Follow-ups
- **Feedback-driven rules**: Wire FeedbackTracker ratings into PolicyEngine. Requires real feedback data (needs actual pi usage to populate ratings).

## Routing Quality
- **Replace broken Gemini 3.1 Pro**: Default routes still reference google-antigravity/gemini-3.1-pro-high which returns "no longer supported". Replace with google-gemini-cli equivalents. Config-only change — no code impact.
- **Tier-differentiated routing**: IntentToTier maps "analysis"→"reasoning" and "code"→"swe", but RouteTarget has no tier field. Would require schema changes and constraint solver modifications.

## Architecture
- Index.ts is now down to SDK-dependent wiring: provider registration, slash-command dispatch, state management, and pi SDK calls. All pure functions extracted.
- **buildCombinedError**: Could be extracted with mock types but requires pi SDK AssistantMessage/Model/Api types.

## Session State
- 384 tests (+218 / +131%), 14 functions extracted, 4 bugs fixed
- All 18 modules covered, all 4 persistence type guards tested
- All error-to-cooldown patterns have explicit coverage
