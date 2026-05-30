# pi-auto-router

A subscription-first automatic model/provider failover extension for [pi coding agent](https://github.com/badlogic/pi-mono).

It exposes a custom provider with opinionated routing profiles:

- `auto-router/subscription-reasoning`
- `auto-router/subscription-swe`
- `auto-router/subscription-long-context`
- `auto-router/subscription-economy`
- `auto-router/subscription-fast`

Unlike a simple model switcher, `auto-router` can retry the **same request** across a configured route chain when a provider hits retryable failures like rate limits, temporary overload, or transient network/server errors.

## Highlights

- **Subscription-first routing** across multiple providers
- **Same-request failover** before substantive output starts
- **Cooldown tracking** for temporarily failing providers/models
- **Circuit breaker** pattern for repeatedly failing providers (closed→open→half-open)
- **External JSON config** for route definitions, aliases, **and policy rules**
- **Intelligent routing policy engine** — context analysis, `@` shortcuts, capability/constraint solving, time-of-day/weekday rule conditions
- **Policy rules** — force tiers, prefer/exclude providers, enforce billing/constraints, per-route scoping, dry-run traces
- **Per-provider budget tracking** with daily/monthly limits, persistent stats, and audit-driven failover
- **Utilization Velocity Index (UVI)** — real-time OAuth quota monitoring that adjusts routing priority on the fly
- **Cost-aware ranking** — estimated USD cost as secondary tiebreaker within latency-sorted UVI buckets
- **Routing decision explainer** so you can see why a target was selected
- **Richer operator commands** for status, route inspection, search, aliases, reloads, budgets, UVI, rules, circuit status, and explanations

## Install

### From GitHub

```bash
pi install git:github.com/danialranjha/pi-auto-router
```

### Update

To update to the latest version from GitHub:

```bash
pi update git:github.com/danialranjha/pi-auto-router
```

Alternatively, if you are developing locally:

```bash
cd /path/to/pi-auto-router
git pull
npm install
npm run build
```

Then reload the extension inside pi:

```text
/auto-router reload
```

### Try without installing

```bash
pi -e git:github.com/danialranjha/pi-auto-router
```

## Quick start

1. Install the package
2. Reload pi with `/reload`
3. Open `/model`
4. Select one of:
   - `auto-router/subscription-reasoning`
   - `auto-router/subscription-swe`
   - `auto-router/subscription-long-context`
   - `auto-router/subscription-economy`
   - `auto-router/subscription-fast`
5. Inspect routing with:

```text
/auto-router list
```

## Config file

`auto-router` reads its config from:

```text
~/.pi/agent/extensions/auto-router.routes.json
```

If the file is missing or invalid, it falls back to built-in defaults.

A starter config is included in the repo as:

```text
auto-router.routes.example.json
```

Copy it into place and customize:

```bash
mkdir -p ~/.pi/agent/extensions
cp auto-router.routes.example.json ~/.pi/agent/extensions/auto-router.routes.json
```

## Example config

```json
{
  "routes": {
    "subscription-reasoning": {
      "name": "Reasoning & Agentic Router",
      "reasoning": true,
      "input": ["text", "image"],
      "targets": [
        {
          "provider": "claude-agent-sdk",
          "modelId": "claude-opus-4-7",
          "label": "L1: Claude Opus 4.7 (Frontier)"
        },
        {
          "provider": "google",
          "modelId": "gemini-2.5-pro",
          "label": "L2: Gemini 2.5 Pro (API Key)",
          "billing": "per-token"
        },
        {
          "provider": "openai-codex",
          "modelId": "gpt-5.4",
          "authProvider": "openai-codex",
          "label": "L3: GPT-5.4"
        },
        {
          "provider": "ollama",
          "modelId": "glm-5.1:cloud",
          "label": "L4: GLM-5.1 (Ollama Cloud Last Resort)"
        }
      ]
    }
  },
  "aliases": {
    "reasoning": ["auto-router/subscription-reasoning"],
    "swe": ["auto-router/subscription-swe"],
    "claude": [
      "claude-agent-sdk/claude-opus-4-7",
      "claude-agent-sdk/claude-opus-4-6"
    ]
  }
}
```

## Target fields

Each route target supports:

- `provider` — pi provider id
- `modelId` — model id under that provider
- `label` — human-readable label
- `authProvider` — optional auth provider lookup in `~/.pi/agent/auth.json`
- `billing` — optional: `"per-token"` for pay-per-token endpoints (default: `"subscription"`)
- `balanceEndpoint` — optional custom balance API URL (falls back to built-in registry)

Use `authProvider` for providers whose OAuth/access token should be read from pi auth storage.
Skip it for providers that authenticate internally or don’t require pi-managed tokens for the request path.

For Gemini API-key routes, use your installed Gemini provider id (examples here use `google`), omit `authProvider`, set `billing` to `"per-token"`, and provide `GOOGLE_API_KEY` or `GOOGLE_KEY` in the environment.

## Commands

`auto-router` registers:

- `/auto-router`
- `/auto-router status`
- `/auto-router switch <route|alias|provider/model>`
- `/auto-router list`
- `/auto-router show <routeId>`
- `/auto-router search <query>`
- `/auto-router aliases`
- `/auto-router resolve <alias>`
- `/auto-router models`
- `/auto-router explain [routeId]` — show the last routing decision (tier, target, confidence, reasoning)
- `/auto-router shortcuts` — list available `@` shortcuts
- `/auto-router balance [show|fetch]` — view/fetch balances for pay-per-token providers
- `/auto-router budget [show|set <provider> <usd> [monthly]|clear <provider> [monthly]]` — view/manage daily/monthly per-provider budgets
- `/auto-router uvi [show|enable|disable|refresh]` — view/manage Utilization Velocity Index monitoring
- `/auto-router shadow [show|enable|disable]` — run pipeline in shadow mode (log but don't change routing)
- `/auto-router rules` — show active policy rules and last applied strategy hints
- `/auto-router circuit` — show circuit breaker state for all providers
- `/auto-router reload`
- `/auto-router reset` — clears cooldowns, decision history, and budget warnings

### Example operator flows

```text
/auto-router switch reasoning
/auto-router switch claude
/auto-router switch subscription-swe
/auto-router list
/auto-router show subscription-reasoning
/auto-router search gemini
/auto-router aliases
/auto-router resolve reasoning
/auto-router explain
/auto-router shortcuts
/auto-router budget show
/auto-router budget set google 20.00 monthly
/auto-router budget set deepseek 20.00 monthly
/auto-router balance show
/auto-router balance fetch
/auto-router uvi show
/auto-router uvi enable
/auto-router reload
```

## Troubleshooting with routing analytics scripts

The router also writes an append-only event log at:

```text
~/.pi/agent/extensions/auto-router.events.jsonl
```

You can inspect that log with three repo scripts:

- `node scripts/routing-stats.mjs` — top-level routing/event counters
- `node scripts/routing-quality-stats.mjs` — feedback and quality breakdowns
- `node scripts/routing-session-stats.mjs` — per-session routing behavior, UVI progression, failover drift, latency, and cost

### `routing-session-stats.mjs`

Use this when you want to answer questions like:

- Is UVI actually changing provider selection?
- Which providers/models are dominating by day?
- Are failovers planner-driven or error-driven?
- What recurring provider errors are being masked by failover?
- Which model is faster or cheaper over the current window?

Basic usage:

```bash
node scripts/routing-session-stats.mjs
```

Useful filters:

```bash
# Last 14 section rows, top 5 models/providers per daily chart
node scripts/routing-session-stats.mjs --limit 14 --daily-top 5

# Only one route
node scripts/routing-session-stats.mjs --route subscription-swe

# Only recent activity
node scripts/routing-session-stats.mjs --since 2026-05-28T00:00:00

# JSON for further scripting
node scripts/routing-session-stats.mjs --json
```

What the report shows:

- `Daily routing composition` — actual provider/model mix by day
- `Session-start UVI timeline` — latest local day’s UVI state over time, grouped by actual model
- `UVI selection mix by day` — how much of each day ran under `ok` vs `surplus` vs other UVI states
- `Latency distribution by model` — how often each model landed in latency buckets (`0-2s`, `2-5s`, …)
- `Cost distribution by model` — how often each model landed in cost buckets
- `Drift overview` — counts planner drift vs failover drift and the dominant drift codes
- `Top drift-triggering errors` — recurring upstream errors that caused failover
- `Planned → actual drift` — concrete routed requests where the final model differed from the planner’s first choice

Sample output (real troubleshooting use case):

```text
Routing session stats from /Users/danial/.pi/agent/extensions/auto-router.events.jsonl
Sessions: 1349 success=99.0% failover=1.9% latency=8500ms ttft=4658ms cost=$0.0422

Daily routing composition (window: 2026-05-08T12:47:59 → 2026-05-29T22:20:10 (local))
  2026-05-29  total=161  ███████████████████▓  █ openai-codex/gpt-5.4 92.5% | ▓ deepseek/deepseek-v4-flash 7.5%
              providers=2 models=2 success=98.1% latency=8573ms
  2026-05-28  total=100  ██████████████████▓▓  █ deepseek/deepseek-v4-flash 89.0% | ▓ openai-codex/gpt-5.4 11.0%
              providers=2 models=2 success=98.0% latency=5073ms

Session-start UVI timeline (latest local day: 2026-05-29)
  00h         04h         08h         12h         16h         20h      24h
  ┼───────────┼───────────┼───────────┼───────────┼───────────┼──────────┼
                                      ▓▓▓▓                    ▓▓    ▓▓      openai-codex/gpt-5.4 n=149 12:07-22:20
                                 ▓    ▓ ▓▓                    ▓             deepseek/deepseek-v4-flash n=12 10:24-20:16
  legend: █ ok  ▓ surplus  ▒ stressed  ░ critical  ▁ unknown

Drift overview (window: 2026-05-08T12:47:59 → 2026-05-29T22:20:10 (local))
  total=26 failover=26 planner=0
  actual_cheaper         n= 26 share=100.0% ████████████
  actual_promoted        n= 26 share=100.0% ████████████
  failover_after_error   n= 26 share=100.0% ████████████
  rank_fallback          n= 26 share=100.0% ████████████

Top drift-triggering errors (window: 2026-05-08T12:47:59 → 2026-05-29T22:20:10 (local))
  n= 22 share=84.6% error=L3: GPT-5.4 (Alternative SOTA): Codex error: {"type":"error","error":{"type":"invalid_request_error","message":"Duplicate item found with id msg_3..."
```

How to use it to troubleshoot:

1. Start with `Daily routing composition` to see which model/provider actually got traffic.
2. Check `Session-start UVI timeline` and `UVI selection mix by day` to see whether UVI state coincides with routing shifts.
3. If `Planned → actual drift` is non-empty, inspect `Drift overview` first:
   - `planner > 0` suggests routing logic itself is choosing alternates
   - `failover > 0` suggests runtime/provider errors are forcing the switch
4. Use `Top drift-triggering errors` to find the dominant upstream/provider failure signature.
5. Compare `Latency distribution by model` and `Cost distribution by model` to decide whether a fallback provider is merely surviving errors or is also a better latency/cost target.

In practice, this script is best for debugging questions like:

- “Why did OpenAI end up on DeepSeek?”
- “Is UVI promotion actually changing traffic share?”
- “Are we masking a provider bug with failover?”
- “Should a fallback become a primary candidate?”

## `@` shortcuts

Prefix any prompt with one of these tokens to bias routing toward a specific tier. The shortcut is parsed off the front of the prompt (so the model never sees it) and translated into capability requirements before constraint solving:

| Shortcut      | Tier        | Effect                                                              |
| ------------- | ----------- | ------------------------------------------------------------------- |
| `@reasoning`  | `reasoning` | Requires reasoning-capable models                                   |
| `@swe`        | `swe`       | Requires reasoning-capable models (software-engineering oriented)   |
| `@long`       | `long`      | Requires `contextWindow ≥ max(estimatedTokens, 100k)`               |
| `@vision`     | `vision`    | Requires multimodal/vision-capable models                           |
| `@fast`       | `fast`      | Hint only — currently does not constrain candidates                 |

Example:

```text
@vision describe what's in this screenshot
@long summarize this 80-page document …
@reasoning prove that there are infinitely many primes
```

Use `/auto-router explain` after a request to see how the shortcut influenced the decision.

## Intent classification

When no `@` shortcut is used, the router automatically classifies your prompt into one of four categories using keyword/pattern heuristics:

| Intent     | Routing hint | Trigger examples                                          |
| ---------- | ------------ | --------------------------------------------------------- |
| `code`     | `swe` tier   | "implement a function", "debug the error", code blocks, file paths |
| `creative` | `economy` tier| "write a poem", "draft a blog post", "create a story"      |
| `analysis` | `long` tier  | "analyze this code", "summarize the document", "compare X and Y" |
| `general`  | (no hint)    | Short prompts, greetings, meta-questions                  |

The intent classification appears in `/auto-router explain` reasoning (e.g. `intent code (71%) → tier=swe`). It runs instantly with zero latency — no LLM calls required.

## Budgets

`auto-router` tracks daily **and** monthly input/output tokens and estimated cost per provider, persisted at:

```text
~/.pi/agent/extensions/auto-router.stats.json
```

### Daily budgets (subscription providers)

When you set a daily limit for a subscription provider, the budget auditor runs before each request:

- **≥ 80% of limit** → soft warning (surfaces in routing reasoning and the status line)
- **≥ 100% of limit** → that provider is excluded from the candidate set; routing falls back to the next allowed target
- If **all** candidates are over budget, routing falls back to the healthy list (so you’re never fully blocked) but the reasoning records the budget event

Manage budgets with:

```text
/auto-router budget show
/auto-router budget set claude-agent-sdk 10.00
/auto-router budget set google 20.00 monthly
/auto-router budget clear openai-codex
```

### Monthly budgets (per-token providers)

For pay-per-token providers like DeepSeek, set a **monthly** budget. The system auto-detects per-token providers when a monthly limit is set — no config tag needed:

```text
/auto-router budget set deepseek 20.00 monthly
/auto-router budget clear deepseek monthly
```

The auditor uses the same thresholds (80% → warning, 100% → block) against monthly spend. Balance data is fetched from the provider's API (e.g. `GET https://api.deepseek.com/user/balance`) and API keys are resolved from `~/.pi/agent/auth.json` first, then environment variables (`DEEPSEEK_API_KEY`, `DEEPSEEK_KEY`).

View balances with:

```text
/auto-router balance show
/auto-router balance fetch
```

### UVI for per-token providers

Per-token UVI is computed the same way as subscription UVI:

```
UVI = (monthly_spend / monthly_budget) / elapsed_fraction_of_month
```

This means per-token providers appear in `/auto-router uvi show` and the status line alongside subscription providers. Per-token UVI is **always computed** when a monthly budget is set, regardless of whether subscription UVI is enabled.

The selected target’s remaining budget is reported in `decision.metadata.budgetRemaining` and visible via `/auto-router explain`.

### UVI interplay with budgets

When UVI is enabled, the budget auditor layers **quota-based dynamic reallocation** on top of USD limits:

| UVI status  | Threshold                        | Effect                                        |
| ----------- | -------------------------------- | --------------------------------------------- |
| `critical`  | UVI ≥ 2.0                        | **Blocks** the provider — excluded from routing |
| `stressed`  | UVI ≥ 1.5                        | **Demotes** all targets from that provider to the end of the trial order |
| `surplus`   | UVI ≤ 0.5 _and_ window ≥ 70% elapsed | **Promotes** targets to the front of the trial order |

Critical UVI overrides a healthy USD budget. A provider with `UVI=2.0` is blocked even if it's only spent $0.20 of a $10.00 daily limit.

UVI status also appears in `/auto-router budget` and `/auto-router explain` output.

## Utilization Velocity Index (UVI)

UVI measures how fast you're consuming quota or budget and adjusts routing priority in real time. For subscription providers, it fetches usage data from provider quota APIs (`openai-codex`, `anthropic`). For per-token providers such as Gemini API-key routes or DeepSeek, it uses monthly spend vs. budget. UVI is computed as:

```
UVI = consumed_fraction / elapsed_fraction_of_window
```

- **UVI ≈ 1.0** → on pace (e.g., 50% used at 50% elapsed)
- **UVI ≥ 1.5** → burning fast — stressed (candidates demoted)
- **UVI ≥ 2.0** → on track to exhaust early — critical (provider blocked)
- **UVI ≤ 0.5** and window ≥ 70% elapsed → underutilized — surplus (candidates promoted)

### Enabling / Disabling UVI

UVI is **enabled by default**. To opt out:

```text
/auto-router uvi disable
# or set the environment variable:
# AUTO_ROUTER_UVI=0
```

Re-enable:

```text
/auto-router uvi enable
```

UVI refreshes automatically before each prompt (throttled to once per 30 seconds). You can also force a refresh:

```text
/auto-router uvi refresh
```

### Viewing UVI state

```text
/auto-router uvi show
```

Example output:

```text
UVI (enabled):
  anthropic              UVI= 1.64 stressed  | 5hr@38%, 7d@68%
  openai-codex           UVI= 0.81 ok        | 1m@5%, 1d@61%
  google                 UVI= 0.22 ok        | monthly@18%
```

When a provider’s UVI is `stressed` or `critical`, it also appears in the status line:

```text
| uvi: anthropic=1.64 stressed
```

### Disabling

```text
/auto-router uvi disable
```

_Note: UVI requires valid OAuth tokens in `~/.pi/agent/auth.json`. If a token is expired and can't be refreshed, that provider shows an error in `uvi show`._

### UVI Hard Mode

By default, UVI uses a **tiebreaker** strategy: stressed providers are deprioritized but still tried if all other candidates fail. Enable hard mode to **completely exclude** stressed providers:

```bash
AUTO_ROUTER_UVI_HARD=1
```

When active, the status line shows `🛡️ uvi-hard`. Demoted providers will not be tried at all — useful when you want strict quota protection near exhaustion. Surplus promotions still use tiebreaker ordering (promoted first, normal as fallback).

## Shadow mode

Shadow mode runs the full routing pipeline (shortcut parsing, context analysis, constraint solving, budget auditing, UVI reordering) but uses **legacy config-order targets** for actual routing. This lets you validate new routing logic without affecting your experience.

```text
/auto-router shadow enable
# or set the environment variable:
# AUTO_ROUTER_SHADOW=1
```

Once enabled, the status line shows `🔬 shadow`. Use `/auto-router shadow show` to compare what the pipeline would have picked vs. what was actually used:

```text
Shadow mode: 🟢 enabled

Last shadow comparison:
  Route: subscription-reasoning
    Pipeline would pick: Gemini 2.5 Pro → Claude Opus 4.6 → GPT-5.4
    Actually used:      Claude Opus 4.6 → Gemini 2.5 Pro → GPT-5.4
    Match: ❌ different
```

Disable with `/auto-router shadow disable`.

## Performance-based ranking

The router tracks per-provider request latency (time-to-response) using a rolling average and uses it as a **tiebreaker within UVI buckets**. Candidates are ordered:

1. Promoted (UVI surplus), sorted fastest → slowest
2. Normal, sorted fastest → slowest
3. Demoted (UVI stressed), sorted fastest → slowest

Providers with no latency history sort last within their bucket (cold start). Data persists in `~/.pi/agent/extensions/auto-router.latency.json` and survives restarts.

View latency data in `/auto-router list` (shows per-target ⏱ avg) and `/auto-router explain` (includes avg latency in reasoning). Reset with `/auto-router reset`.

## User feedback

Rate routing decisions to help improve selection over time:

```text
/auto-router rate good
/auto-router rate bad
/auto-router rate good "fast and accurate"
/auto-router rate bad "too verbose"
```

Ratings are persisted in `~/.pi/agent/extensions/auto-router.ratings.json`. Per-provider stats appear in `/auto-router explain` (e.g. `ratings: 12👍 3👎 (15 total, 80% good)`). Reset with `/auto-router reset`.

## Status line

The status line surfaces routing state at a glance:

```text
auto-router Subscription Premium Router 🔬 shadow | tier=reasoning (0.90) | current: GPT-5.4 | healthy: …, … | ⚠ google: 87% of $20.00 monthly budget used | uvi: anthropic=1.64 stressed
```

- `🔬 shadow` appears when shadow mode is enabled
- `tier=<tier> (<confidence>)` appears once a routing decision has been recorded
- `⚠ …` appears when one or more candidate providers are at 80%+ of their daily limit
- `uvi: …` appears when one or more providers have `stressed` or `critical` UVI status

## Behavior notes

- Only **retryable** errors trigger automatic failover
- Route targets that can’t be resolved from the registry are also treated as failoverable so the chain can keep moving
- Failover happens only **before substantive output starts**
- Once a provider/model emits real content, the router stays on that target
- Retryable failures put the target on a temporary cooldown
- Cooldowns are currently in-memory and reset on pi reload/restart

## Default routes

The repository ships with opinionated defaults oriented around subscription-backed providers plus API-key Gemini and Ollama Cloud fallback:

- Claude Code via `claude-agent-sdk`
- OpenAI Codex
- Google Gemini via API key (`google`, billed per-token)
- NVIDIA DeepSeek (`deepseek-ai/deepseek-v3.2`)
- Ollama Cloud (`glm-5.1:cloud`)

You should edit `~/.pi/agent/extensions/auto-router.routes.json` to match your own environment.

## Development

To work on `auto-router` in your local dev environment:

```bash
# 1. Clone the repo
git clone git@github.com:danialranjha/pi-auto-router.git
cd pi-auto-router

# 2. Install dependencies
npm install

# 3. Copy the example config into place
mkdir -p ~/.pi/agent/extensions
cp auto-router.routes.example.json ~/.pi/agent/extensions/auto-router.routes.json

# 4. Run pi with the local extension loaded
pi -e /absolute/path/to/pi-auto-router
```

After making changes to `index.ts`, reload the extension inside pi without restarting:

```text
/auto-router reload
```

Use the built-in debug commands to verify routing and model resolution:

```text
/auto-router status
/auto-router list
/auto-router debug
/auto-router test-resolve <alias>
```

### Tests

The routing policy modules under `src/` are covered by a `node:test` + `tsx` suite:

```bash
npm test
```

## Architecture

The intelligent routing layer lives in `src/` and is composed of small, focused modules:

| Module                    | Responsibility                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `types.ts`                | Shared types: `Tier`, `RouteTarget`, `RoutingContext`, `RoutingDecision`, `RoutingHints`, `PolicyRuleConfig`, etc. |
| `context-analyzer.ts`     | Token estimation (`chars/4`), context classification (short/medium/long/epic), `RoutingContext` build |
| `shortcut-parser.ts`      | Parses `@reasoning`/`@swe`/`@long`/`@vision`/`@fast` from prompts; strips the token before dispatch  |
| `constraint-solver.ts`    | Filters candidates by capability, cooldown, health, circuit breaker state, and tier-derived requirements |
| `policy-engine.ts`        | Priority-ordered rule engine: 5 rule types (force-tier, prefer/exclude-provider, force-billing, force-constraint); time-of-day/weekday conditions; per-route scoping; dry-run traces via `/auto-router explain` |
| `budget-tracker.ts`       | Persistent daily/monthly token/cost stats per provider with atomic writes; daily limits              |
| `budget-auditor.ts`       | Pure `auditBudget(provider, state)` returning `ok \| warning \| blocked`; integrates UVI for dynamic reallocation |
| `balance-fetcher.ts`      | Fetches balances from pay-per-token providers (DeepSeek) with exponential backoff retry; builds synthetic monthly UVI windows |
| `uvi.ts`                  | Computes UVI from quota windows (`consumed_fraction / elapsed_fraction`); classifies as `critical`, `stressed`, `ok`, or `surplus` |
| `quota-fetcher.ts`        | Pulls real-time usage data from OpenAI, Anthropic, and Google OAuth quota APIs; token refresh + error handling |
| `quota-cache.ts`          | TTL-gated cache for quota snapshots; batches fetches, emits per-provider `UtilizationSnapshot`       |
| `health-check.ts`         | Provider health cache — verifies OAuth tokens; independent of UVI; feeds `isHealthy` into constraint solver |
| `circuit-breaker.ts`      | Circuit breaker state machine (closed→open→half-open) for repeatedly failing providers; `/auto-router circuit` command + status line segment |
| `candidate-partitioner.ts`| Partitions candidates into `[promoted, normal, demoted]` buckets based on budget audit + UVI; supports hard mode exclusion; cost-aware secondary tiebreaker |
| `latency-tracker.ts`      | Tracks per-provider request latency (rolling average, max 100 samples); used for performance-based ranking within UVI buckets |
| `intent-classifier.ts`    | Heuristic intent classifier (code/creative/analysis/general) with file extension, documentation pattern, and conversation depth awareness |
| `feedback-tracker.ts`     | User ratings of routing decisions (`/auto-router rate`); persists to auto-router.ratings.json; per-provider stats |
| `display.ts`              | Pure display utilities: model spec parsing, target description, hints formatting, cooldown helpers, token normalization |

`index.ts` wires these together inside `streamAutoRouter`:

1. Parse `@` shortcut from the last user message
2. Build `RoutingContext` (prompt, history, healthy targets, budget state, feedback stats)
3. Run PolicyEngine pre-constraint evaluation (tier overrides, provider exclusions, constraint tuning)
4. Run `solveConstraints` over healthy targets with capability data from the model registry
5. Run `auditBudget` per remaining candidate; drop blocked, warn at 80%+; apply UVI-based demote/promote reordering
6. Run PolicyEngine post-partition hints (requireProvider, preferProviders sorting, cost tiebreaker)
7. Order candidates: `[…promoted (surplus UVI), …normal, …demoted (stressed UVI)]` with latency + cost sort
8. Record a `RoutingDecision` (phase, tier, target, confidence, reasoning, estimated tokens, budget remaining, hints trace)
9. Stream from the selected target with same-request failover; circuit breaker tracks success/failure

## Roadmap

High-priority future directions for `pi-auto-router`:

| Area | Feature | Priority |
|------|---------|----------|
| **Policies** | [Feedback-driven rules](ROADMAP.md#1-feedback-driven-policy-rules) — wire user ratings into PolicyEngine conditions | ⭐⭐⭐ |
| **Architecture** | [Continue extracting from `index.ts`](ROADMAP.md#2-architecture-continue-extracting-from-indexts) — testable modules for auth, config, cooldowns, model resolution | ⭐⭐⭐ |
| **Testing** | [Performance benchmarks](ROADMAP.md#4-performance-microbenchmark-suite) + [Chaos testing](ROADMAP.md#5-stress--chaos-testing-suite) for the hot path | ⭐⭐⭐ |
| **Provider support** | [Provider-agnostic UVI](ROADMAP.md#6-provider-agnostic-uvi) — custom/self-hosted providers get quota awareness | ⭐⭐ |
| **Config** | [JSON Schema validation](ROADMAP.md#15-configuration-schema--validation) + [Export/import configs](ROADMAP.md#13-export--import-route-configurations) | ⭐⭐ |
| **Advanced routing** | [Multi-step routing](ROADMAP.md#12-multi-step--sub-task-routing), [Weighted A/B selection](ROADMAP.md#10-weighted-random--ab-selection), [ML intent classifier](ROADMAP.md#11-machine-learning-intent-classifier) | ⭐ |
| **Observability** | [Web dashboard / TUI integration](ROADMAP.md#9-web-dashboard--tui-integration), [Resilience dashboard](ROADMAP.md#14-provider-resilience-dashboard) | ⭐ |

See [ROADMAP.md](./ROADMAP.md) for full details on each item.

---

## License

MIT
