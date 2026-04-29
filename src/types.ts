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

export type RoutingDecision = {
  tier: Tier;
  phase: string;
  target: RouteTarget;
  reasoning: string;
  metadata: {
    estimatedTokens: number;
    budgetRemaining: number;
    confidence: number;
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
  /** The route ID (model id) that was being routed */
  routeId: string;
  /** Routing tier (swe, reasoning, fast, vision, long, economy) */
  tier: string;
  /** Phase: "shortcut", "default", or "policy" */
  phase: string;
  /** The provider that was selected */
  provider: string;
  /** The model ID that was selected */
  modelId: string;
  /** Human-readable target label */
  targetLabel: string;
  /** Full reasoning string (shortcut info, intent, budget, strategy hints) */
  reasoning: string;
  /** Estimated token count for this request */
  estimatedTokens: number;
  /** Budget remaining for the selected billing scope (USD) */
  budgetRemaining: number;
  /** Confidence score (0.0–1.0) */
  confidence: number;
  /** Outcome of the routing attempt */
  outcome: "success" | "terminal_error" | "exhausted";
  /** Latency in ms of the successful call, or 0 on failure */
  latencyMs: number;
  /** Which target actually handled the request (label or error summary) */
  selectedTarget: string;
};
