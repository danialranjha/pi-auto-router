# pi-auto-router

A subscription-first automatic model/provider failover extension for [pi coding agent](https://github.com/badlogic/pi-mono).

It exposes a custom provider with opinionated routing profiles:

- `auto-router/subscription-premium`
- `auto-router/subscription-coding`
- `auto-router/subscription-fast`

Unlike a simple model switcher, `auto-router` can retry the **same request** across a configured route chain when a provider hits retryable failures like rate limits, temporary overload, or transient network/server errors.

## Highlights

- **Subscription-first routing** across multiple providers
- **Same-request failover** before substantive output starts
- **Cooldown tracking** for temporarily failing providers/models
- **External JSON config** for route definitions and aliases
- **Intelligent routing policy engine** — context analysis, `@` shortcuts, capability/constraint solving
- **Per-provider budget tracking** with daily limits, persistent stats, and audit-driven failover
- **Utilization Velocity Index (UVI)** — real-time OAuth quota monitoring that adjusts routing priority on the fly
- **Routing decision explainer** so you can see why a target was selected
- **Richer operator commands** for status, route inspection, search, aliases, reloads, budgets, UVI, and explanations

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
   - `auto-router/subscription-premium`
   - `auto-router/subscription-coding`
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
    "subscription-premium": {
      "name": "Subscription Premium Router",
      "reasoning": true,
      "input": ["text", "image"],
      "targets": [
        {
          "provider": "claude-agent-sdk",
          "modelId": "claude-opus-4-6",
          "label": "Claude Opus 4.6 via Claude Code"
        },
        {
          "provider": "google-antigravity",
          "modelId": "gemini-3.1-pro-high",
          "authProvider": "google-antigravity",
          "label": "Gemini 3.1 Pro"
        },
        {
          "provider": "openai-codex",
          "modelId": "gpt-5.4",
          "authProvider": "openai-codex",
          "label": "GPT-5.4"
        },
        {
          "provider": "ollama",
          "modelId": "glm-5.1:cloud",
          "label": "GLM-5.1 via Ollama Cloud Subscription"
        }
      ]
    }
  },
  "aliases": {
    "premium": ["auto-router/subscription-premium"],
    "claude": [
      "claude-agent-sdk/claude-opus-4-6",
      "claude-agent-sdk/claude-opus-4-5"
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

Use `authProvider` for providers whose OAuth/access token should be read from pi auth storage.
Skip it for providers that authenticate internally or don’t require pi-managed tokens for the request path.

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
- `/auto-router budget [show|set <provider> <usd>|clear <provider>]` — view/manage daily per-provider budgets
- `/auto-router uvi [show|enable|disable|refresh]` — view/manage Utilization Velocity Index monitoring
- `/auto-router reload`
- `/auto-router reset` — clears cooldowns, decision history, and budget warnings

### Example operator flows

```text
/auto-router switch premium
/auto-router switch claude
/auto-router switch subscription-fast
/auto-router list
/auto-router show subscription-premium
/auto-router search gemini
/auto-router aliases
/auto-router resolve premium
/auto-router explain
/auto-router shortcuts
/auto-router budget show
/auto-router budget set google-antigravity 5.00
/auto-router uvi show
/auto-router uvi enable
/auto-router reload
```

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

## Budgets

`auto-router` tracks daily input/output tokens and estimated cost per provider, persisted at:

```text
~/.pi/agent/extensions/auto-router.stats.json
```

When you set a daily limit, the budget auditor runs before each request:

- **≥ 80% of limit** → soft warning (surfaces in routing reasoning and the status line)
- **≥ 100% of limit** → that provider is excluded from the candidate set; routing falls back to the next allowed target
- If **all** candidates are over budget, routing falls back to the healthy list (so you’re never fully blocked) but the reasoning records the budget event

Manage budgets with:

```text
/auto-router budget show
/auto-router budget set claude-agent-sdk 10.00
/auto-router budget set google-antigravity 5.00
/auto-router budget clear openai-codex
```

The selected target’s remaining daily budget is reported in `decision.metadata.budgetRemaining` and visible via `/auto-router explain`.

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

UVI measures how fast you're consuming OAuth quota windows and adjusts routing priority in real time. It fetches usage data from the provider quota APIs (`openai-codex`, `anthropic`, `google-gemini-cli`, `google-antigravity`) and computes:

```
UVI = consumed_fraction / elapsed_fraction_of_window
```

- **UVI ≈ 1.0** → on pace (e.g., 50% used at 50% elapsed)
- **UVI ≥ 1.5** → burning fast — stressed (candidates demoted)
- **UVI ≥ 2.0** → on track to exhaust early — critical (provider blocked)
- **UVI ≤ 0.5** and window ≥ 70% elapsed → underutilized — surplus (candidates promoted)

### Enabling UVI

```text
/auto-router uvi enable
# or set the environment variable:
# AUTO_ROUTER_UVI=1
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
  openai-codex            UVI= 0.81 ok        | 1m@5%, 1d@61%
  google-antigravity      UVI= 0.00 ok        | daily@1%
  google-gemini-cli       UVI= 0.00 ok        | daily@1%
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

## Status line

The status line surfaces routing state at a glance:

```text
auto-router Subscription Premium Router | tier=reasoning (0.90) | current: GPT-5.4 | healthy: …, … | ⚠ google-antigravity: 87% of $5.00 daily budget used | uvi: anthropic=1.64 stressed
```

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

The repository ships with opinionated defaults oriented around subscription-backed providers plus Ollama Cloud fallback:

- Claude Code via `claude-agent-sdk`
- OpenAI Codex
- Google Antigravity
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
| `types.ts`                | Shared types: `Tier`, `RouteTarget`, `RoutingContext`, `RoutingDecision`, `BudgetState`, etc.        |
| `context-analyzer.ts`     | Token estimation (`chars/4`), context classification (short/medium/long/epic), `RoutingContext` build |
| `shortcut-parser.ts`      | Parses `@reasoning`/`@swe`/`@long`/`@vision`/`@fast` from prompts; strips the token before dispatch  |
| `constraint-solver.ts`    | Filters candidates by capability, cooldown, and tier-derived requirements                            |
| `policy-engine.ts`        | Priority-ordered rule registry with shadow mode + last-decision tracking                             |
| `budget-tracker.ts`       | Persistent daily token/cost stats per provider with atomic writes; daily limits                      |
| `budget-auditor.ts`       | Pure `auditBudget(provider, state)` returning `ok | warning | blocked`; integrates UVI for dynamic reallocation |
| `uvi.ts`                  | Computes UVI from quota windows (`consumed_fraction / elapsed_fraction`); classifies as `critical`, `stressed`, `ok`, or `surplus` |
| `quota-fetcher.ts`        | Pulls real-time usage data from OpenAI, Anthropic, and Google OAuth quota APIs; token refresh + error handling |
| `quota-cache.ts`          | TTL-gated cache for quota snapshots; batches fetches, emits per-provider `UtilizationSnapshot`       |

`index.ts` wires these together inside `streamAutoRouter`:

1. Parse `@` shortcut from the last user message
2. Build `RoutingContext` (prompt, history, healthy targets, budget state)
3. Run `solveConstraints` over healthy targets with capability data from the model registry
4. Run `auditBudget` per remaining candidate; drop blocked, warn at 80%+; apply UVI-based demote/promote reordering
5. Order candidates: `[…promoted (surplus UVI), …normal, …demoted (stressed UVI)]`
6. Record a `RoutingDecision` (phase, tier, target, confidence, reasoning, estimated tokens, budget remaining)
7. Stream from the selected target with same-request failover; on success, record token usage

## License

MIT
