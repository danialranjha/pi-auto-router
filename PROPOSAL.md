# Proposal: Intelligent Routing Policy Engine

## Overview
Transform `pi-auto-router` from a static target selector into a dynamic decision engine that analyzes context, intent, and budgets to select the optimal model.

## Current State
The auto-router has been fully implemented with:

### ✅ Implemented Features
- **Static route definitions** with ordered failover chains
- **Dynamic routing pipeline** (Shortcut Parser → Context Analyzer → Constraint Solver → Budget Auditor → Selector)
- **@ shortcut commands** (`@reasoning`, `@swe`, `@long`, `@fast`, `@vision`) to bias routing
- **Context-aware routing** — estimates token count, classifies context size, filters targets by capability
- **Constraint solving** — matches targets against vision/reasoning/context window requirements
- **Budget tracking** — daily spend tracking per provider with limits and warnings
- **Cooldown/retry logic** — expanded to handle rate limits, quota exhaustion, invalid credentials, and missing/stale auth tokens
- **Auth health detection** — expired OAuth tokens cause retryable failures that rotate to next target
- **Context sanitization** — automatically fixes missing `toolCall.id`, `toolResult.name`, and `tool_call_id` fields to prevent provider validation errors
- **Stream error resilience** — mid-stream errors are caught and trigger failover; `try/catch` around entire streaming loop
- **Model registry fallback** — `resolveModelFromRegistry` falls back through `getModel()`, registry list, and fuzzy matching
- **Route model ID correction** — `deepseek-reasoner` → `deepseek-v4-pro`, `deepseek-chat` → `deepseek-v4-flash`
- **Stale context guard** — `refreshStatus` wrapped in try/catch to prevent crashes in non-interactive mode
- **Alias resolution** with `/auto-router switch`, `/auto-router resolve`
- **UI commands** — `/auto-router status`, `/auto-router list`, `/auto-router explain`, `/auto-router budget`, `/auto-router shortcuts`, `/auto-router search`, `/auto-router show`, `/auto-router debug`, `/auto-router reload`, `/auto-router reset`

## Target Architecture

### 1. Routing Decision Pipeline
The PolicyEngine runs an ordered pipeline of rules:

```
┌─────────────────────────────────────────────────────────────────┐
│  INPUT: User prompt + Context + Route ID                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  1. SHORTCUT PARSER                          │  ✅
    │     Checks for @reasoning, @swe, @long, etc │
    │     → Returns tier hint or null             │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  2. CONTEXT ANALYZER                         │  ✅
    │     Calculates token count, history depth    │
    │     → Returns context classification          │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  3. CONSTRAINT SOLVER                        │  ✅
    │     Matches: vision? reasoning? max_tokens?  │
    │     Filters dead/unhealthy targets           │
    │     → Returns candidate targets               │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  4. BUDGET AUDITOR                           │  ✅
    │     Checks provider quotas/cost estimates    │
    │     → Filters over-budget paths             │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  5. SELECTOR                                   │  ✅
    │     Ranks candidates, picks best             │
    │     → Returns RoutingDecision               │
    └─────────────────────────────────────────────┘
                           │
                           ▼
    ┌─────────────────────────────────────────────┐
    │  6. TARGET EXECUTION                         │  ✅
    │     Iterates targets with:                    │
    │     - Context sanitization                   │
    │     - Streaming error catch                  │
    │     - Retryable error detection              │
    │     - Cooldown management                    │
    │     → Returns success or failover            │
    └─────────────────────────────────────────────┘
```

### 2. Data Structures

```typescript
// Fully implemented in src/types.ts
interface RoutingDecision {
  tier: 'reasoning' | 'swe' | 'long' | 'economy' | 'vision';
  phase: string;
  target: RouteTarget;
  reasoning: string;
  metadata: {
    estimatedTokens: number;
    budgetRemaining: number;
    confidence: number;
  };
}

interface PolicyRule {
  name: string;
  priority: number;
  condition: (ctx: RoutingContext) => boolean;
  action: (ctx: RoutingContext) => RoutingDecision | null;
}

interface RoutingContext {
  prompt: string;
  history: Message[];
  routeId: string;
  estimatedTokens: number;
  classification: ContextClassification;
  availableTargets: RouteTarget[];
  userHint?: Tier;
  budgetState?: BudgetState;
}

interface BudgetState {
  dailySpend: Record<string, number>;
  dailyLimit: Record<string, number>;
}

interface ShortcutEntry {
  tier: Tier;
  description: string;
  pattern: RegExp;
}

type Tier = 'reasoning' | 'swe' | 'long' | 'economy' | 'vision';
type ContextClassification = 'short' | 'medium' | 'long' | 'epic';
```

## 3. Implementation Status

### Phase 1: ✅ Foundation (Core Types & Context Analyzer)
- [x] Define `RoutingDecision`, `PolicyRule`, `RoutingContext` interfaces — `src/types.ts`
- [x] Implement `ContextAnalyzer` — `src/context-analyzer.ts`
  - [x] Token estimation (char count / 4)
  - [x] History depth calculation
  - [x] Context classification (short/medium/long/epic)
- [x] Unit tests for ContextAnalyzer — `tests/context-analyzer.test.ts`
- [x] PolicyEngine integration — `src/policy-engine.ts`

### Phase 2: ✅ Shortcut Parser (@ Commands)
- [x] Define `ShortcutRegistry` with patterns:
  - `@reasoning` → tier: `reasoning`
  - `@swe` → tier: `swe`
  - `@long` → tier: `long`
  - `@vision` → tier: `vision`
  - `@fast` → tier: `economy`
- [x] Implement `parseShortcut()` — `src/shortcut-parser.ts`
- [x] Hook into prompt handling (pre-process before routing)
- [x] Tests for pattern matching — `tests/shortcut-parser.test.ts`
- [x] `/auto-router shortcuts` command

### Phase 3: ✅ Constraint Solver
- [x] Implement `ConstraintSolver` — `src/constraint-solver.ts`
  - [x] Filter by vision requirement
  - [x] Filter by reasoning requirement
  - [x] Filter by contextWindow >= estimated tokens
  - [x] Integrate cooldown/no-auth status
- [x] Tests for constraint combinations — `tests/constraint-solver.test.ts`

### Phase 4: ✅ Budget Auditor & Persistence
- [x] Stats file schema — `auto-router.stats.json` with per-day per-provider spend
- [x] Implement `BudgetTracker` — `src/budget-tracker.ts`
  - [x] Read/write stats file
  - [x] Atomic updates (write to temp, rename)
  - [x] Graceful handling of missing/corrupt stats
- [x] Implement `BudgetAuditor` — `src/budget-auditor.ts`
- [x] `/auto-router budget [show|set|clear]` command
- [x] Budget warnings in routing decisions

### Phase 5: ✅ Integration & Target Selection
- [x] Integrate into `streamAutoRouter()` — calls ContextAnalyzer → inferRequirements → solveConstraints → auditBudget → tryTarget
- [x] `lastRoutingDecision` tracking for UI
- [x] **Context sanitization** (`sanitizeContext`) — fixes missing `toolCall.id`, `toolResult.name`, `tool_call_id` before sending to providers
- [x] **Stream error resilience** — `try/catch` around streaming loop; mid-stream errors trigger failover
- [x] **Model registry fallbacks** — `getModel()` → registry list → fuzzy matching

### Phase 6: ✅ UI Improvements
- [x] Status line with routing hint: `auto-router reasoning | current: Claude Opus 4.7 | healthy: L1: Claude... | no cooldowns`
- [x] `/auto-router explain` — shows last routing decision details
- [x] Budget warnings at thresholds
- [x] Route summary showing target health and auth status

### Phase 7: ⬜ Advanced Features (Future)
- [ ] Performance-based ranking (track latency per provider)
- [ ] Intent classification (code vs creative vs analysis)
- [ ] Dynamic budget reallocation
- [ ] Provider health checks (proactive ping)
- [ ] User feedback loop (`/auto-router rate <good|bad> [reason]`)

## 4. Error Resilience (Post-Proposal Additions)

The following critical resilience features were added beyond the original proposal based on real-world issues:

### 4.1 Context Sanitization
Before sending context to any provider, `sanitizeContext()` ensures:
- Every `toolCall` has a non-empty `id` (generates random fallback if missing)
- Every `toolResult` has a non-empty `tool_call_id` / `toolCallId`
- Every `toolResult` has a non-empty `name` / `toolName` (required by Gemini's `function_response` part)

This prevents `REQUIRED_FIELD_MISSING` and empty-string validation errors.

### 4.2 Retryable Error Detection
`isRetryableError()` expanded to catch:
- Rate limits (429, "too many requests", "quota exhausted")
- Auth failures ("invalid credentials", "invalid google cloud code assist credentials")
- Provider validation errors ("invalid 'input", "call_id", "function_response.name")
- Network errors (timeout, ECONNRESET, 502, 503, 504)
- Budget/balance errors ("insufficient balance", "credits exhausted")

### 4.3 Quota Reset Parsing
`parseResetAfterMs()` extended to handle:
- Short form: `reset after 54s`, `5m`, `2h`
- Full word form: `reset after 54 seconds`, `5 minutes`, `2 hours`

### 4.4 Non-Interactive Mode Safety
- `refreshStatus()` wrapped in try/catch to handle stale extension contexts
- Cooldown applied on missing auth tokens so failover happens immediately

## 5. Integration Flow

```typescript
// Current flow (implemented):
streamAutoRouter()
  → loadRoutesConfig()
  → parseShortcut()           // Check @ shortcuts
  → buildRoutingContext()     // Estimate tokens, classify context
  → inferRequirements()       // Map tier → capability needs
  → solveConstraints()        // Filter targets by capability
  → auditBudget()             // Filter by budget limits
  → tryTarget() for each candidate:
      → sanitizeContext()     // Fix missing fields
      → streamSimple()        // Stream with try/catch wrapper
      → on error:
          if retryable: putOnCooldown → next target
          if terminal: abort
      → on success: record usage, return
```

### Backward Compatibility

- **Routes config**: All existing configs work unchanged
- **Failover loop**: Preserved as ultimate fallback when all targets exhaust
- **Commands**: All existing (`status`, `list`, `show`, `search`, `switch`) work
- **Shadow mode**: Future — `AUTO_ROUTER_SHADOW=1` env var for safe rollout of new features

## 6. Testing Status

| Layer | Status | Details |
|-------|--------|---------|
| **Unit** | ✅ | `context-analyzer.test.ts`, `constraint-solver.test.ts`, `budget-tracker.test.ts`, `policy-engine.test.ts`, `shortcut-parser.test.ts`, `budget-auditor.test.ts` |
| **Verification** | ✅ | All 5 route chains tested non-interactively: subscription-reasoning, subscription-swe, subscription-long-context, subscription-economy, subscription-fast |
| **Shadow mode** | ⬜ | Not yet implemented |
| **Manual QA** | ✅ | `/auto-router` commands verified |

## 7. Module Map

```
index.ts                          — Extension entry point, provider registration, streamAutoRouter, tryTarget, sanitizeContext, UI commands
src/types.ts                      — All type definitions
src/context-analyzer.ts           — Token estimation, history depth, classification
src/constraint-solver.ts          — Target filtering by capability requirements
src/budget-tracker.ts             — Daily spend tracking, limits, persistence
src/budget-auditor.ts             — Budget constraint rule
src/policy-engine.ts              — Pipeline orchestrator (skeleton, integrated into index.ts)
src/shortcut-parser.ts            — @ shortcut parsing, registry
tests/                            — Unit tests for all modules
```

## 8. Success Metrics

- ✅ Zero regressions in existing failover behavior
- ✅ Routing decisions explainable via `/auto-router explain`
- ✅ Budget overruns prevented (warnings at thresholds)
- ✅ @ shortcuts reduce manual route switching
- ✅ Auth token expiration handled gracefully with failover
- ✅ Provider validation errors sanitized before sending
- ✅ All 5 route chains verified in non-interactive mode
