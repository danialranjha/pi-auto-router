# Proposal: Intelligent Routing Policy Engine

## Overview
Transform `pi-auto-router` from a static target selector into a dynamic decision engine that analyzes context, intent, and budgets to select the optimal model.

**Status:** ✅ Fully shipped. 146/146 tests pass. All phases complete.

## Shipped Features
- Static route definitions with ordered failover chains
- Dynamic routing pipeline (Shortcut Parser → Context Analyzer → Constraint Solver → Budget Auditor → Selector)
- `@` shortcut commands (`@reasoning`, `@swe`, `@long`, `@fast`, `@vision`)
- Context-aware routing (token estimation, context classification, capability filtering)
- Constraint solving (vision, reasoning, context window requirements)
- Budget tracking (daily spend, limits, persistent stats)
- **Utilization Velocity Index (UVI)** — real-time OAuth quota monitoring with promote/demote/block
- **Provider health checks** — auth token verification with TTL cache; filters unhealthy providers before routing
- **Shadow mode** (`AUTO_ROUTER_SHADOW=1`) — run full pipeline without changing routing; safety net for new features
- **UVI hard mode** (`AUTO_ROUTER_UVI_HARD=1`) — excludes stressed providers entirely; `🛡️ uvi-hard` in status line
- **Performance-based ranking** — rolling average per-provider latency; sorts candidates within UVI buckets fastest-first
- **Intent classification** — heuristic keyword/pattern classifier (code/creative/analysis/general); maps to tier hints
- **User feedback loop** (`/auto-router rate <good|bad> [reason]`) — persists per-provider ratings
- Cooldown/retry logic for rate limits, quota exhaustion, auth failures
- Context sanitization, stream error resilience, model registry fallback, stale context guard
- Status line with tier, budget warnings, UVI, health, shadow, and hard-mode indicators
- All UI commands (`status`, `list`, `show`, `search`, `switch`, `aliases`, `explain`, `shortcuts`, `budget`, `uvi`, `shadow`, `rate`, `reload`, `reset`)

## Pipeline Architecture

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
    │  2. INTENT CLASSIFIER                        │  ✅
    │     Heuristic: code, creative, analysis, gen │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  3. CONTEXT ANALYZER                         │  ✅
    │     Token count, history depth, classification │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  4. CONSTRAINT SOLVER                        │  ✅
    │     vision? reasoning? ctx? cooldown? health?│
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  5. BUDGET AUDITOR                           │  ✅
    │     USD limits + UVI dynamic reallocation    │
    └──────────────────────┬──────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────┐
    │  6. SELECTOR                                   │  ✅
    │     Partition → sort by latency → [promoted,  │
    │     normal, demoted]                          │
    └─────────────────────────────────────────────┘
                           │
                           ▼
    ┌─────────────────────────────────────────────┐
    │  7. TARGET EXECUTION                         │  ✅
    │     Sanitize → Stream → Failover on error    │
    └─────────────────────────────────────────────┘
```

## Module Map

```
src/types.ts                  — Shared types
src/context-analyzer.ts       — Token estimation, context classification
src/shortcut-parser.ts        — @ shortcut parsing
src/constraint-solver.ts      — Capability/capability/health/cooldown filtering
src/policy-engine.ts          — Rule registry skeleton
src/budget-tracker.ts         — Daily spend persistence
src/budget-auditor.ts         — USD + UVI constraint rules
src/candidate-partitioner.ts  — Promote/normal/demote bucketing + hard mode
src/uvi.ts                    — UVI math (compute, classify, aggregate)
src/quota-fetcher.ts          — OAuth usage API clients (vendored from pi-usage-bars)
src/quota-cache.ts            — TTL-gated quota snapshot cache
src/health-check.ts           — Auth token health verification
src/latency-tracker.ts        — Rolling avg per-provider latency
src/intent-classifier.ts      — Heuristic intent classification
src/feedback-tracker.ts       — User rating persistence
```

## Success Metrics
- ✅ Zero regressions in existing failover behavior
- ✅ Routing decisions explainable via `/auto-router explain`
- ✅ Budget overruns prevented (warnings at thresholds)
- ✅ `@` shortcuts reduce manual route switching
- ✅ Auth token expiration handled gracefully with failover
- ✅ Provider validation errors sanitized before sending
- ✅ All 5 route chains verified in non-interactive mode
- ✅ All Tier 1–3 features verified end-to-end with pi -p
