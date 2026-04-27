# Proposal: Intelligent Routing Policy Engine

## Overview
Transform `pi-auto-router` from a static target selector into a dynamic decision engine that analyzes context, intent, and budgets to select the optimal model.

## Current State
Phases 1–6 are **complete**. Phase 7 (UVI dynamic budget reallocation) is **shipped**. 105/105 tests pass.

### ✅ Completed
- Static route definitions with ordered failover chains
- Dynamic routing pipeline (Shortcut Parser → Context Analyzer → Constraint Solver → Budget Auditor → Selector)
- `@` shortcut commands (`@reasoning`, `@swe`, `@long`, `@fast`, `@vision`)
- Context-aware routing (token estimation, context classification, capability filtering)
- Constraint solving (vision, reasoning, context window requirements)
- Budget tracking (daily spend, limits, persistent stats)
- Utilization Velocity Index (UVI) — real-time OAuth quota monitoring with promote/demote/block
- Cooldown/retry logic for rate limits, quota exhaustion, auth failures
- Context sanitization (`toolCall.id`, `toolResult.name`, `tool_call_id` fixes)
- Stream error resilience, model registry fallback, stale context guard
- Status line, `/auto-router explain`, `/auto-router budget`, `/auto-router uvi`
- All UI commands (`status`, `list`, `show`, `search`, `switch`, `aliases`, `reload`, `reset`, etc.)

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  INPUT: User prompt + Context + Route ID                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  1. SHORTCUT PARSER                          │  ✅
    │     Checks for @reasoning, @swe, @long, etc │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  2. CONTEXT ANALYZER                         │  ✅
    │     Token count, history depth, classification │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  3. CONSTRAINT SOLVER                        │  ✅
    │     vision? reasoning? max_tokens? cooldown? │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  4. BUDGET AUDITOR                           │  ✅
    │     USD limits + UVI dynamic reallocation    │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  5. SELECTOR                                   │  ✅
    │     Partition → [promoted, normal, demoted]  │
    └─────────────────────────────────────────────┘
                           │
                           ▼
    ┌─────────────────────────────────────────────┐
    │  6. TARGET EXECUTION                         │  ✅
    │     Sanitize → Stream → Failover on error    │
    └─────────────────────────────────────────────┘
```

## Remaining Work

### Tier 1: Quick Wins
| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| 1 | **Provider health checks** — proactive auth verification before routing to avoid wasted failover attempts | Low | High | ✅ |
| 2 | **Shadow mode** (`AUTO_ROUTER_SHADOW=1`) — run full pipeline without changing routing; safety net for new features | Low | Medium | ✅ |
| 3 | **Hard-override env flag** for UVI surplus promotion — currently tiebreaker-only; flag to make surplus promotion override normal priority | Low | Low-Medium | ⬜ |

### Tier 2: High-Impact
| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| 4 | **Performance-based ranking** — track `(provider, tier, contextSize) → p50/p95` latency; rank candidates by historical speed | Medium | High |
| 5 | **Default-on for UVI** — flip the default after real-world validation | Low | Medium |

### Tier 3: Speculative / Design-Heavy
| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| 6 | **User feedback loop** (`/auto-router rate <good|bad>`) — learn from user ratings over time | Medium | Medium |
| 7 | **Intent classification** — classify prompts as code/creative/analysis to inform tier selection | Medium | Low-Medium |

## Success Metrics
- ✅ Zero regressions in existing failover behavior
- ✅ Routing decisions explainable via `/auto-router explain`
- ✅ Budget overruns prevented (warnings at thresholds)
- ✅ `@` shortcuts reduce manual route switching
- ✅ Auth token expiration handled gracefully with failover
- ✅ Provider validation errors sanitized before sending
- ✅ All 5 route chains verified in non-interactive mode

## Backward Compatibility
- Routes config: all existing configs work unchanged
- Failover loop: preserved as ultimate fallback when all targets exhaust
- Commands: all existing commands work
