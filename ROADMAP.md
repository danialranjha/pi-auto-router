# Roadmap

This document outlines potential future features and improvements for `pi-auto-router`. Items are grouped by theme and roughly ordered by estimated impact. Contributions and discussion welcome via [GitHub Issues](https://github.com/danialranjha/pi-auto-router/issues).

---

## 1. Feedback-Driven Policy Rules

Wire the existing `FeedbackTracker` (user ratings via `/auto-router rate`) into the `PolicyEngine` as a condition source.

**Why:** Users already rate routing decisions. Making those ratings actionable as policy conditions would enable rules like:
- "Prefer providers with ≥ 80% positive feedback during business hours"
- "Exclude any provider with < 5 ratings or < 50% positive feedback"
- "Demote providers with 3+ consecutive bad ratings"

**Status:** Requires real feedback data to validate usefulness. The `FeedbackTracker` and `PolicyEngine` are already shipped — this is a wiring task.

**Estimated complexity:** Medium (2–3 new rule condition evaluators, tests, docs)

---

## 2. Architecture: Continue Extracting from `index.ts`

The main entry point (`index.ts`, ~2036 lines) still contains several semi-pure functions that could be extracted into testable modules:

| Function | Est. Lines | Natural Home | Notes |
|----------|-----------|-------------|-------|
| `resolveModelFromRegistry` | ~68 | New `src/model-resolver.ts` | Requires mocking pi SDK `Context` |
| `getPrimaryModelLimits` | ~13 | `src/model-resolver.ts` | Pure — easy extraction |
| `getInnerModel` | ~11 | `src/model-resolver.ts` | Pure — easy extraction |
| `formatModelLine` | ~50 | `src/display.ts` | Display logic, joins existing module |
| `formatCooldowns` | ~25 | `src/cooldown.ts` or `src/display.ts` | Display logic |
| `buildCombinedError` | ~20 | `src/cooldown.ts` | Error formatting |
| `isRetryableError` | ~19 | `src/cooldown.ts` | Classification logic |
| `putOnCooldown` | ~4 | `src/cooldown.ts` | Side-effect — harder to test |
| `loadRoutesConfig` | ~84 | `src/config-loader.ts` | Config parsing, validation |
| `rebuildPolicyEngine` | ~10 | `src/config-loader.ts` | Config wiring |
| `readAuth` | ~8 | `src/auth.ts` | Pure file read |
| `getAccessToken` | ~8 | `src/auth.ts` | Pure lookup |
| `resolveProviderApiKeyFromEnv` | ~13 | `src/auth.ts` | Environment resolution |
| `refreshBalances` | ~45 | `src/balance-fetcher.ts` | Complements existing module |
| `syncUtilizationIntoBudget` | ~32 | `src/budget-tracker.ts` | Complements existing module |

**Impact:** Reduces `index.ts` by ~400 lines, adds ~60+ tests, improves maintainability.

**Estimated complexity:** Low (well-established extraction pattern from `src/display.ts` work)

---

## 3. Auth Module

Extract credential resolution (`readAuth`, `getAccessToken`, `resolveProviderApiKeyFromEnv`, provider → key chain) into `src/auth.ts`.

**Why:** Current auth logic is scattered across `index.ts`. A dedicated module would:
- Make credential resolution testable independently
- Support multiple auth methods (OAuth, API keys, custom headers)
- Provide a single place to add new auth backends
- Enable credential rotation without touching the main router

**Estimated complexity:** Low (~3 functions, 6–10 tests)

---

## 4. Performance Microbenchmark Suite

Add a dedicated benchmark suite for the hot routing path (shortcut parsing → constraint solving → budget audit → partition).

**Why:** With 16 pipeline stages, regressions can hide. A baseline benchmark would:
- Detect latency regressions in CI
- Provide data for optimization decisions
- Validate the 30s TTL design vs. per-request freshness tradeoff
- Measure real-world impact of circuit breaker, UVI, health checks

**Suggested benchmarks:**
- Empty pipeline (zero candidates) — baseline overhead
- 5 candidates, no budget/UVI — constraint solver cost
- 5 candidates, UVI+budget — full pipeline cost
- 20 candidates — scaling cost
- Candidate with circuit breaker open — early-exit path

**Estimated complexity:** Low (~1 new file, `npm run benchmark` script)

---

## 5. Stress / Chaos Testing Suite

Test the router under adversarial conditions to verify resilience properties.

**Why:** Circuit breaker, UVI, cooldowns, and health checks are designed for failure scenarios — they need dedicated stress tests.

**Scenarios:**
- All providers failing simultaneously (circuit breaker + cooldown interaction)
- Quota flipping between blocked/surplus every request (UVI thrash guard)
- 50+ routes with 200+ targets (config scaling)
- Rapid `/auto-router reload` while requests in flight
- Corrupted stats/config files (self-healing)
- Token expiry mid-request cascade

**Estimated complexity:** Medium (requires async test infrastructure, mock servers)

---

## 6. Provider-Agnostic UVI

Extend UVI to support any subscription provider, not just the current hardcoded set (Anthropic, OpenAI Codex, Google).

**Why:** Users with custom or self-hosted providers (Ollama, vLLM, TGI, etc.) can't use UVI today.

**Approaches:**
- **Config-defined quota windows:** Allow users to define UVI windows in route config (`uviWindow: { duration: "1h", limit: 100000 }`) with local token counting
- **Plugin-style quota fetcher:** A small interface users can implement for their provider
- **Proxy-based:** Infer quota from HTTP response headers (e.g. `x-ratelimit-remaining`)

**Estimated complexity:** High (design decision, config schema changes, fallback behavior)

---

## 7. Cost Optimization Engine

Auto-suggest or auto-adjust budget limits based on historical usage patterns.

**Why:** Users set static budgets today. An optimizer could:
- Detect underutilized daily limits and suggest reductions
- Alert when spend is trending above/below budget
- Recommend monthly ↔ daily budget conversions based on volatility
- Auto-suggest per-token budget for providers detected to be pay-per-token

**Estimated complexity:** Medium (analysis logic, suggestion UI, optional auto-apply)

---

## 8. Per-User / Per-Session Routing Profiles

Support routing profiles that vary by user identity or conversation session.

**Why:** In shared pi installations (teams, CI), different users may want different routing:
- "User A: always premium, User B: economy tier"
- "CI sessions: use cheapest available, never reason"
- "After 5 messages in a session: switch to cheaper model"

**Estimated complexity:** Medium (user identity detection, session state, profile config)

---

## 9. Web Dashboard / TUI Integration

Visual dashboard for routing analytics, integrated with pi's TUI or as a standalone web view.

**Why:** The command-line interface is powerful but doesn't scale to visualizing routing patterns over time.

**Features:**
- Real-time route health (latency, error rate, UVI, circuit state)
- Budget burn-down charts (daily/weekly/monthly)
- Routing decision history with a timeline view
- Policy rule simulation sandbox ("what if I changed this rule?")
- Per-provider cost breakdown

**Estimated complexity:** High (requires pi TUI components or a small web server)

---

## 10. Weighted Random / A/B Selection

Support probabilistic routing for A/B testing model variants.

**Why:** When comparing model quality or cost, deterministic routing produces confirmation bias. Weighted random selection lets users:
- Route 10% of traffic to a new model, 90% to the current best
- Collect feedback ratings for each variant
- Auto-escalate the better-performing variant
- Sunset underperformers based on statistically significant results

**Estimated complexity:** Medium (random selection in partitioner, feedback aggregation, auto-escalation logic)

---

## 11. Machine Learning Intent Classifier

Replace the current heuristic keyword classifier with a lightweight ML model.

**Why:** The current classifier is fast (zero latency) but brittle — adding new intents or languages requires code changes. An ML approach could:
- Classify by embedding similarity to labeled examples
- Support user-defined intent categories without code changes
- Improve accuracy over time with feedback
- Detect sub-intents and multi-intent prompts

**Estimated complexity:** High (model choice, embedding service, cold-start UX, fallback to heuristic)

---

## 12. Multi-Step / Sub-Task Routing

Route different parts of a single conversation to different models.

**Why:** The optimal model varies within a conversation:
- Planning/reasoning → Claude Opus / GPT-5
- Code generation → GPT-5 or DeepSeek
- Code review → Claude Sonnet or Gemini
- Documentation → economy model

This requires the router to analyze individual user messages (not just the first one) and potentially split a response across models.

**Estimated complexity:** Very high (conversation-level state, model handoff protocol, consistency guarantees)

---

## 13. Export / Import Route Configurations

Share and version route configurations as portable files.

**Why:** Users often share routing setups ("I use Claude for reasoning and Gemini for vision"). Export/import would enable:
- Shareable config snippets (GitHub gist, etc.)
- Version-controllable config per project
- "Config packs" for different workflows (coding, research, writing)
- Migration between pi installations

**Estimated complexity:** Low (JSON serialization of current config + aliases + budgets)

---

## 14. Provider Resilience Dashboard

Aggregated view of provider health over time, persisted across restarts.

**Why:** Circuit breaker state resets on restart. A persisted resilience history would:
- Show which providers fail most often
- Surface failure patterns (time-of-day, concurrent request volume)
- Track recovery time after circuit opens
- Auto-tune circuit breaker thresholds per provider
- Feed into PolicyEngine as a condition source ("exclude providers with > 10% failure rate in the last hour")

**Estimated complexity:** Medium (persistence format, aggregation queries, display)

---

## 15. Configuration Schema & Validation

Add a JSON Schema for route configuration with detailed validation errors.

**Why:** Current validation (`validateRouteTarget`) is ad-hoc. A formal schema would:
- Provide auto-complete and validation in editors (VS Code, etc.)
- Catch config errors at load time with precise error messages
- Document the config format explicitly
- Enable schema versioning for backward compatibility

**Estimated complexity:** Low (one schema file, integration with existing `loadRoutesConfig`)

---

## 16. Per-Request Budget Overrides

Allow users to set a one-time budget for a specific request.

**Why:** Users occasionally need flexibility: "I know this is a $50 task, route to the best model regardless of budget."

**Syntax ideas:**
- `/auto-router run --budget 10 "analyze this entire codebase"`
- `@budget(10) analyze this entire codebase`
- A `x-auto-router-budget` context field

**Estimated complexity:** Medium (transient override state, interaction with existing budget auditor)

---

## 17. Streaming Budget / UVI Updates

Use push-based mechanisms (SSE, WebSocket, or filesystem watch) to update budget and UVI state instead of polling.

**Why:** Current TTL-based polling adds 100–500ms to prompt latency. Push updates would:
- Eliminate the freshness tradeoff
- Enable sub-second reaction to quota exhaustion
- Reduce overhead on prompt processing

**Estimated complexity:** High (depends on provider push support, fallback to polling)

---

## 18. Provider Auto-Discovery

Auto-discover available providers and their models from the pi registry instead of requiring manual route configuration.

**Why:** Adding a new provider currently requires editing `auto-router.routes.json`. Auto-discovery would:
- Present all available models as routing candidates
- Auto-detect capabilities (vision, reasoning, context window)
- Generate sensible default targets per tier
- Simplify first-time setup

**Estimated complexity:** Medium (registry query API, capability detection, sensible default generation)

---

## 19. Policy Engine: Compound Conditions

Extend PolicyEngine conditions to support AND/OR/NOT logic across multiple condition types.

**Why:** Current conditions are ANDed implicitly. Compound conditions enable:
- "prefer-provider X AND time-of-day 9-5, OR if feedback ≥ 80%"
- "exclude-provider Y if UVI > 1.5 AND budget < $5 remaining"
- "force-tier reasoning if intent=code AND file_ext in [.rs, .go]"

**Estimated complexity:** Medium (condition AST, evaluator changes, backwards-compatible syntax)

---

## 20. Semantic Versioning & Migration Guide

Establish a formal semver policy for config format, command output, and behavior stability.

**Why:** As `pi-auto-router` matures, users need confidence that updates won't break their config or automation.

**Items:**
- Document what constitutes a breaking change (config field removal, command removal, behavior change)
- Add a `version` field to route config for format migration
- Deprecation warning mechanism for obsolete features
- Migration guide in README

**Estimated complexity:** Low (documentation + config version field)

---

*Items above are proposals, not commitments. Feel free to open an issue or PR if any of these interest you.*
