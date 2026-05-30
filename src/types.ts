export type Tier = "reasoning" | "swe" | "long" | "economy" | "vision";

export type ContextClassification = "short" | "medium" | "long" | "epic";

export type BillingModel = "subscription" | "per-token";

export type RouteTarget = {
  provider: string;
  modelId: string;
  authProvider?: string;
  label: string;
  billing?: BillingModel;
  balanceEndpoint?: string;
};

export type Message = {
  role: string;
  content: unknown;
};

export type BalanceState = {
  provider: string;
  currency: string;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
  fetchedAt: number;
  error?: string;
};

export type BudgetState = {
  dailySpend: Record<string, number>;
  dailyLimit: Record<string, number>;
  monthlySpend?: Record<string, number>;
  monthlyLimit?: Record<string, number>;
  balances?: Record<string, BalanceState>;
  utilization?: Record<string, UtilizationSnapshot>;
};

export type QuotaScope = "session" | "weekly" | "monthly" | "daily";

export type QuotaSource = "oauth-usage" | "stale-cache" | "config";

export type QuotaWindow = {
  provider: string;
  scope: QuotaScope;
  usedPercent: number;
  resetsAt?: string;
  resetsInSec?: number;
  windowDurationMs: number;
  source: QuotaSource;
  fetchedAt: number;
};

export type UVIStatus = "ok" | "surplus" | "stressed" | "critical";

export type UtilizationSnapshot = {
  provider: string;
  uvi: number;
  status: UVIStatus;
  windows: QuotaWindow[];
  reason: string;
  error?: string;
  stale?: boolean;
  fetchedAt: number;
};

export type UVIThresholds = {
  stressed: number;
  critical: number;
  surplus: number;
  surplusMinElapsed: number;
};

export const DEFAULT_UVI_THRESHOLDS: UVIThresholds = {
  stressed: 1.5,
  critical: 2.0,
  surplus: 0.5,
  surplusMinElapsed: 0.7,
};

export type DecisionCandidateTrace = {
  provider: string;
  modelId: string;
  label: string;
  billing: BillingModel;
  configRank: number;
  finalRank?: number;
  bucket?: "promoted" | "normal" | "demoted";
  status: "selected" | "eligible" | "constraint_rejected" | "budget_rejected" | "unhealthy" | "cooldown" | "circuit_open";
  reasons: string[];
  avgLatencyMs?: number | null;
  estimatedCostUsd?: number | null;
  uvi?: number | null;
  uviStatus?: UVIStatus;
};

export type DecisionAttemptLog = {
  index: number;
  provider: string;
  modelId: string;
  label: string;
  outcome: "success" | "retryable_failure" | "terminal_error";
  latencyMs: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
};

export type ValidationOutcome = "passed" | "failed";

export type CodeSubtask = "implementation" | "debugging" | "refactor" | "testing" | "review" | "devops";

export type ValidationSignal = {
  kind: "test" | "build";
  toolName: string;
  command: string;
  outcome: ValidationOutcome;
  summary: string;
};

export type DecisionReasoningTrace = {
  shortcut?: { shortcut: string; tier: Tier };
  intent?: { category: string; confidence: number; reasons?: string[]; subtask?: CodeSubtask; subtaskConfidence?: number; subtaskReasons?: string[] };
  followUp?: {
    isFollowUp: boolean;
    isRepair: boolean;
    signals: string[];
    previousRequestId?: string;
    previousProvider?: string;
    previousModelId?: string;
    previousRouteId?: string;
  };
  validation?: {
    testOutcome?: ValidationOutcome;
    buildOutcome?: ValidationOutcome;
    signals: ValidationSignal[];
  };
  heuristics?: {
    sweSubtask?: {
      type: CodeSubtask;
      confidence: number;
      reasons: string[];
      preferProviders?: string[];
    };
  };
  requestedTier?: Tier;
  effectiveTier: Tier;
  classification: ContextClassification;
  estimatedTokens: number;
  strategy?: {
    ruleName?: string;
    tierOverride?: Tier;
    requireProvider?: string;
    preferProviders?: string[];
    excludeProviders?: string[];
    enforceBilling?: BillingModel;
    forceReasoning?: boolean;
    forceVision?: boolean;
    forceMinContext?: number;
  };
  fallback?: {
    constraintFallback: boolean;
    budgetFallback: boolean;
  };
  counts: {
    totalRouteTargets: number;
    healthyTargets: number;
    solvedCandidates: number;
    constraintRejections: number;
    budgetRejections: number;
  };
  warnings: {
    budget: string[];
    uvi: string[];
  };
};

export type RoutingDecision = {
  tier: Tier;
  phase: string;
  target: RouteTarget;
  reasoning: string;
  structured?: DecisionReasoningTrace;
  metadata: {
    estimatedTokens: number;
    budgetRemaining: number;
    confidence: number;
    requestId?: string;
    conversationId?: string;
    candidateTrace?: DecisionCandidateTrace[];
  };
};

export type RoutingContext = {
  prompt: string;
  history: Message[];
  routeId: string;
  estimatedTokens: number;
  classification: ContextClassification;
  availableTargets: RouteTarget[];
  userHint?: Tier;
  budgetState?: BudgetState;
};

export type PolicyRule = {
  name: string;
  priority: number;
  condition: (ctx: RoutingContext) => boolean;
  action: (ctx: RoutingContext) => RoutingDecision | null;
};

export type ShortcutEntry = {
  tier: Tier;
  description: string;
  pattern: RegExp;
};

export type ShortcutRegistry = Record<string, ShortcutEntry>;

export type LatencyRecord = {
  count: number;
  totalMs: number;
  lastMs: number;
  updatedAt: number;
};

export type RoutingHints = {
  /** Override the tier derived from shortcut/intent */
  tierOverride?: Tier;
  /** Force capability constraints regardless of context */
  forceReasoning?: boolean;
  forceVision?: boolean;
  forceMinContext?: number;
  /** Provider-level overrides for the candidate list */
  requireProvider?: string;
  excludeProviders?: string[];
  preferProviders?: string[];
  /** Constrain to a specific billing model */
  enforceBilling?: BillingModel;
};

/** JSON-serializable rule definition loaded from auto-router.routes.json */
export type PolicyRuleConfig = {
  name: string;
  priority: number;
  type: "force-tier" | "prefer-provider" | "exclude-provider" | "force-billing" | "force-constraint";
  tier?: Tier;
  provider?: string | string[];
  billing?: BillingModel;
  constraint?: Partial<{
    reasoning: boolean;
    vision: boolean;
    minContextWindow: number;
  }>;
  condition?: {
    intent?: "code" | "creative" | "analysis" | "general";
    estimatedTokensMin?: number;
    estimatedTokensMax?: number;
    /** HH:MM format in local time. Rule fires only after this time (inclusive). */
    afterTime?: string;
    /** HH:MM format in local time. Rule fires only before this time (exclusive). */
    beforeTime?: string;
    /** Day of week (0=Sun, 6=Sat). Rule fires only on these days. */
    daysOfWeek?: number[];
  };
};

/**
 * A single routing decision log entry, persisted as a JSONL line.
 * Flat structure for easy querying with jq, grep, or analytical tools.
 */
export type DecisionLogEntry = {
  /** Epoch ms when the decision was made */
  timestamp: number;
  /** Unique per routed request */
  requestId: string;
  /** Best-effort conversation/session identifier */
  conversationId: string;
  /** The route ID (model id) that was being routed */
  routeId: string;
  /** Routing tier (swe, reasoning, fast, vision, long, economy) */
  tier: string;
  /** Phase: "shortcut", "default", or "policy" */
  phase: string;
  /** The provider/model originally planned as rank-1 */
  plannedProvider: string;
  plannedModelId: string;
  plannedTargetLabel: string;
  /** The provider/model that actually ran (after failover, if any) */
  provider: string;
  modelId: string;
  targetLabel: string;
  /** Full reasoning string (human-readable) */
  reasoning: string;
  /** Structured machine-readable reasoning */
  reasoningStructured?: DecisionReasoningTrace;
  /** Candidate set with ranking and rejection reasons */
  candidateTrace?: DecisionCandidateTrace[];
  /** Attempt chain for this request */
  attempts?: DecisionAttemptLog[];
  /** Whether this appears to be a follow-up to a previous routed turn */
  isFollowUp?: boolean;
  /** Whether this appears to be a repair/correction follow-up */
  isRepair?: boolean;
  /** Previous routed request in the same conversation, if known */
  previousRequestId?: string;
  /** Most recent observed test outcome from prior tool execution context */
  testOutcome?: ValidationOutcome;
  /** Most recent observed build outcome from prior tool execution context */
  buildOutcome?: ValidationOutcome;
  /** Estimated token count for this request */
  estimatedTokens: number;
  /** Actual input tokens reported by provider, if available */
  inputTokens?: number;
  /** Actual output tokens reported by provider, if available */
  outputTokens?: number;
  /** Actual cost reported by provider, if available */
  costUsd?: number;
  /** Budget remaining for the selected billing scope (USD) */
  budgetRemaining: number;
  /** Confidence score (0.0–1.0) */
  confidence: number;
  /** Outcome of the routing attempt */
  outcome: "success" | "terminal_error" | "exhausted";
  /** Total latency in ms of the executed attempt, or 0 on failure */
  latencyMs: number;
  /** Time to first token / tool event in ms, if available */
  ttftMs?: number;
  /** Which target actually handled the request (label or error summary) */
  selectedTarget: string;
};
