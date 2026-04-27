# Phase 7: Dynamic Budget Reallocation via Utilization Velocity Index (UVI)

**Status:** ✅ Shipped. All deferred items resolved. 146/146 tests pass.

## Summary
UVI fetches real-time OAuth quota data from Anthropic, OpenAI Codex, and Google (vendored from `pi-usage-bars`) and adjusts routing priority based on quota pressure:
- `UVI ≥ 2.0` → **blocked** (provider excluded)
- `UVI ≥ 1.5` → **stressed** (candidates demoted to end of trial order)
- `UVI ≤ 0.5` + `elapsed ≥ 0.7` → **surplus** (candidates promoted to front)

All originally deferred items are done: hard-override flag, default-on, integration tests, Google window confirmation. Post-PR additions added health checks, shadow mode, performance ranking, intent classification, and user feedback. See `PROPOSAL.md` and `README.md` for full documentation.

### Phase 7.5: Per-Token Budget Tracking (Shipped)

Pay-per-token providers (DeepSeek, etc.) now have full budget + UVI support:
- **Balance fetching** from provider APIs (e.g. `GET https://api.deepseek.com/user/balance`)
- **Monthly budgets** — set with `/auto-router budget set <provider> <usd> monthly`
- **Auto-detection** — any provider with a monthly budget is treated as per-token; no config tag needed
- **API key resolution** — checks `auth.json` first, then environment variables (`DEEPSEEK_API_KEY`, etc.)
- **UVI computed identically** to subscription providers: `(monthly_spend / monthly_budget) / elapsed_fraction_of_month`
- **Same audit thresholds**: 80% → warning, 100% → blocked
- New commands: `/auto-router balance show|fetch`
- Diagnostics surfaced in `/auto-router uvi show` when balance fetches fail

## Notes for Future Work
- Snapshots update on the prompt *after* a successful refresh (TTL design). Fresh-on-every-prompt would add 100–500ms latency per prompt.
- `auditBudget` keys by route-config provider name; the cache re-keys `anthropic` snapshots under `claude-agent-sdk`. New OAuth providers need both a `ROUTE_PROVIDER_TO_OAUTH` entry and a re-keying line.
- Promotion fires when `elapsed ≥ 0.7` AND `uvi ≤ 0.5`. Loosening thresholds is config-only via `DEFAULT_UVI_THRESHOLDS`.
- New per-token providers need a balance endpoint parser in `src/balance-fetcher.ts` and optionally a `BALANCE_ENDPOINTS` entry.
