export type Tier = "reasoning" | "swe" | "long" | "economy" | "vision";

export type ContextClassification = "short" | "medium" | "long" | "epic";

export type RouteTarget = {
  provider: string;
  modelId: string;
  authProvider?: string;
  label: string;
};

export type Message = {
  role: string;
  content: unknown;
};

export type BudgetState = {
  dailySpend: Record<string, number>;
  dailyLimit: Record<string, number>;
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
