# Phase 7: Dynamic Budget Reallocation via Utilization Velocity Index (UVI)

**Status:** ✅ Shipped in [PR #1](https://github.com/danialranjha/pi-auto-router/pull/1) (merged into `main`). 111/111 tests pass.

## What Shipped
UVI fetches real-time OAuth quota data from Anthropic, OpenAI Codex, and Google (vendored from `pi-usage-bars`) and adjusts routing priority based on quota pressure:
- `UVI ≥ 2.0` → **blocked** (provider excluded)
- `UVI ≥ 1.5` → **stressed** (candidates demoted to end of trial order)
- `UVI ≤ 0.5` + `elapsed ≥ 0.7` → **surplus** (candidates promoted to front)

New modules: `src/uvi.ts`, `src/quota-fetcher.ts`, `src/quota-cache.ts`, `src/candidate-partitioner.ts`.

### Post-PR Additions (Tier 1)
- **Provider health checks** (`src/health-check.ts`) — OAuth auth token verification with TTL cache; filters unhealthy providers in `solveConstraints` before routing
- **Shadow mode** — `AUTO_ROUTER_SHADOW=1` runs full pipeline but uses legacy ordering; `/auto-router shadow show` compares pipeline vs actual picks
- **UVI hard mode** — `AUTO_ROUTER_UVI_HARD=1` excludes demoted (stressed) providers entirely; status line shows `🛡️ uvi-hard`
- **Helpful route errors** — when a user requests a non-existent route, the error lists available routes

## Deferred Items

| # | Item | Status |
|---|------|--------|
| 1 | **Hard-override env flag** for surplus promotion | ✅ `AUTO_ROUTER_UVI_HARD=1` excludes demoted (stressed) providers entirely; `🛡️ uvi-hard` in status line |
| 2 | **Default-on for UVI** | ⬜ Currently opt-in behind `AUTO_ROUTER_UVI=1`; flip once real-world validated |
| 3 | Remaining Phase 7 bullets from PROPOSAL | ⬜ Intent classification, feedback loop — see PROPOSAL.md (health checks, shadow mode, performance ranking are ✅ done) |

## Notes for Future Work
- Snapshots update on the prompt *after* a successful refresh (TTL design). Fresh-on-every-prompt would add 100–500ms latency per prompt.
- `auditBudget` keys by route-config provider name; the cache re-keys `anthropic` snapshots under `claude-agent-sdk`. New OAuth providers need both a `ROUTE_PROVIDER_TO_OAUTH` entry and a re-keying line.
- Promotion fires when `elapsed ≥ 0.7` AND `uvi ≤ 0.5`. Loosening thresholds is config-only via `DEFAULT_UVI_THRESHOLDS`.

## Investigation Outcome: Google Quota Window Duration ✅
Google's `BucketInfo` schema includes an optional `resetTime` (ISO-8601) field. `parseGoogleQuotaBuckets` now captures it; `usageToWindows` derives `windowDurationMs = resetTime - fetchedAt` when present, falling back to `GOOGLE_DAILY_WINDOW_MS` (24h) otherwise. No more hardcoded 24h assumption for modern responses.
