# Changelog

## 0.2.0 — Policy Engine, Circuit Breaker & Dynamic Budget Reallocation

**Release date:** 2026-04-27
**Tests:** 258 passing across 48 suites

### Major Features

#### Utilization Velocity Index (UVI) — Dynamic Budget Reallocation
- Real-time OAuth quota monitoring from Anthropic, OpenAI Codex, and Google
- Three-tier dynamic routing adjustment:
  - **Critical** (UVI ≥ 2.0): provider blocked from selection
  - **Stressed** (UVI ≥ 1.5): candidates demoted to end of trial order
  - **Surplus** (UVI ≤ 0.5 & window ≥ 70% elapsed): candidates promoted to front
- Integrated with budget auditor for quota-aware failover
- Default-on with `/auto-router uvi enable|disable` toggle
- Hard mode (`AUTO_ROUTER_UVI_HARD=1`) — excludes stressed providers entirely
- `/auto-router uvi show` with per-provider diagnostics
- UVI status in status line and `/auto-router explain` output

#### Policy Engine (5 Rule Types)
- **force-tier** — override auto-detected tier
- **prefer-provider** — boost specific providers in trial order
- **exclude-provider** — block providers from selection
- **force-billing** — enforce subscription vs. per-token billing
- **force-constraint** — add reasoning/vision/context window requirements
- Route-scoped rules (`routeId` field) prevent cross-route interference
- Time-of-day/weekday conditions with overnight range support
- Priority-ordered rule evaluation with dry-run traces
- `/auto-router rules` command for visibility
- `/auto-router explain` shows per-rule ✅/❌ evaluation

#### Circuit Breaker
- Closed → Open → Half-open state machine
- Configurable: `failureThreshold` (default 3), `windowMs` (60s), `cooldownMs` (30s)
- Integrated at constraint solver (prevents selection) and `tryTarget` loop (records success/failure)
- `/auto-router circuit` command + status line segment with 🔌 indicator

#### Per-Token Budget Tracking (Phase 7.5)
- Balance fetching from provider APIs (DeepSeek: `GET https://api.deepseek.com/user/balance`)
- Monthly budgets via `/auto-router budget set <provider> <usd> monthly`
- Auto-detection: any provider with a monthly budget treated as per-token
- API key resolution: `auth.json` first, then environment variables
- UVI computed identically to subscription providers
- Same audit thresholds: 80% → warning, 100% → blocked
- `/auto-router balance show|fetch` commands

#### Cost-Aware Ranking
- Estimated USD cost as secondary tiebreaker within UVI latency buckets
- `lookupModelCost` / `estimateModelCost` (4× output token multiplier)
- Cost surfaced in routing reasoning output
- Latency-first, cost-second within promoted/normal/demoted partitions

#### Enhanced Intent Classification
- Heuristic classifier: code, creative, analysis, general intents
- File extension support: `.java`, `.c`, `.cpp`, `.h`, `.md`, `.rst`, `.adoc`
- Documentation patterns: README, CHANGELOG detection
- Conversation depth boost: +2 for 5+ messages, +1 for 3+
- Mapped to tier hints in routing pipeline
- Displayed in `/auto-router explain` with confidence scores

#### Performance-Based Ranking
- Rolling average per-provider latency tracking (max 100 samples)
- Candidates sorted fastest-first within promoted/normal/demoted UVI buckets
- Persistent across restarts (`auto-router.latency.json`)
- Cold-start: providers with no history sort last within their bucket

#### Provider Health Checks
- OAuth token verification with TTL cache (60s default)
- Filters unhealthy providers before constraint solving
- Independent of UVI; feeds `isHealthy` into constraint solver
- Health issues surfaced in `/auto-router list`

#### Architecture & Code Quality
- Extracted `src/display.ts` — 42 tests for model spec parsing, target description, hints formatting, cooldown helpers, token normalization
- Pipeline integration tests — 9 end-to-end scenarios (constraint → budget → partition)
- Quota cache tests — 6 tests covering all provider → OAuth mappings
- Balance fetcher retry — exponential backoff (500ms base, 2 retries)
- 17 modular `src/` files from original monolithic `index.ts`

### New Commands
- `/auto-router uvi [show|enable|disable|refresh]`
- `/auto-router shadow [show|enable|disable]`
- `/auto-router rules`
- `/auto-router circuit`
- `/auto-router balance [show|fetch]`
- `/auto-router budget [show|set|clear] [monthly]`
- `/auto-router rate <good|bad> [reason]`
- `/auto-router explain [routeId]`
- `/auto-router shortcuts`

### New Config Options
- `policyRules` in route config (5 rule types with time/day conditions)
- `AUTO_ROUTER_UVI=0` to disable UVI at startup
- `AUTO_ROUTER_UVI_HARD=1` for strict mode
- `AUTO_ROUTER_SHADOW=1` for validation mode
- `billing: "per-token"` and `balanceEndpoint` on route targets

### New Files
- `src/policy-engine.ts` + `tests/policy-engine.test.ts`
- `src/circuit-breaker.ts` + `tests/circuit-breaker.test.ts`
- `src/display.ts` + `tests/display.test.ts`
- `src/balance-fetcher.ts` + `tests/balance-fetcher.test.ts`
- `src/health-check.ts`
- `src/latency-tracker.ts`
- `src/intent-classifier.ts` + `tests/intent-classifier.test.ts`
- `src/feedback-tracker.ts` + `tests/feedback-tracker.test.ts`
- `tests/pipeline-integration.test.ts`
- `tests/quota-cache.test.ts`
- `tests/uvi.test.ts`
- `tests/budget-auditor.test.ts`
- `tests/budget-tracker.test.ts`
- `tests/constraint-solver.test.ts`
- `tests/candidate-partitioner.test.ts`
- `tests/context-analyzer.test.ts`
- `tests/shortcut-parser.test.ts`

---

## 0.1.0

**Release date:** 2025-04

Initial public release.

### Features
- Subscription-first auto-router provider for pi coding agent
- Same-request failover across configured provider/model chains
- Retryable-error cooldown handling
- External route config via `~/.pi/agent/extensions/auto-router.routes.json`
- Alias/profile support
- `/auto-router` command suite for status, listing, search, aliases, reload, and reset
- Default routes for Claude Code, OpenAI Codex, Google Antigravity, NVIDIA DeepSeek, and Ollama Cloud GLM
- Budget tracking with daily limits and persistent stats
- Context-aware routing: token estimation, context classification, capability filtering
- `@` shortcut commands (`@reasoning`, `@swe`, `@long`, `@vision`, `@fast`)
- Constraint solving (vision, reasoning, context window requirements)
- Model registry resolution with fallback
- Context sanitization and stream error resilience
- `index.ts` as the monolithic extension entry point (~3 modules extracted)
