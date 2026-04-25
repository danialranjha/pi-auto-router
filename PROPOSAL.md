# Proposal: Intelligent Routing Policy Engine

## Overview
Transform `pi-auto-router` from a static target selector into a dynamic decision engine that analyzes context, intent, and budgets to select the optimal model.

## 1. Routing Decision Pipeline
The engine will run an ordered pipeline of rules:
1. **Shortcut Parser**: Handles `@reasoning`, `@swe`, etc.
2. **Context Analyzer**: Calculates token counts and history depth.
3. **Constraint Solver**: Matches capabilities (vision, max_tokens) and checks health/cooldowns.
4. **Budget Auditor**: Ensures the selected path doesn't exceed provider quotas.

## 2. New Data Structures
```typescript
interface RoutingDecision {
  tier: 'reasoning' | 'swe' | 'long' | 'economy';
  phase: string; // The rule that made the final call
  target: RouteTarget;
  reasoning: string; // "Large context (150k) triggered @long fallback"
  metadata: {
    estimatedTokens: number;
    budgetRemaining: number;
  };
}
```

## 3. Implementation Steps
- [ ] Define `RoutingDecision` and `PolicyRule` types.
- [ ] Implement `PolicyEngine` class.
- [ ] Add `ContextSafeguard` (token counting logic).
- [ ] Implement `@` command interceptors.
- [ ] Add persistent budget tracking in `~/.pi/agent/extensions/auto-router.stats.json`.
- [ ] Update UI to display routing reasoning.
