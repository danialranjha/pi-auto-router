/**
 * Fetches account balances from pay-per-token providers (e.g. DeepSeek).
 * Extensible provider registry maps provider names to balance API endpoints.
 */

import type { BalanceState } from "./types.ts";

// ─── Retry helper ────────────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff.
 * Retries on any error (network failures, timeouts, non-2xx responses).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 4_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// ─── Known balance endpoints ─────────────────────────────────────────────────

export const BALANCE_ENDPOINTS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/user/balance",
  // openrouter: "https://openrouter.ai/api/v1/credits",      // future
  // together:    "https://api.together.xyz/v1/account",       // future
};

export type BalanceFetchResult = {
  provider: string;
  currency: string;
  totalBalance: number;
  grantedBalance: number;
  toppedUpBalance: number;
  error?: string;
};

// ─── Per-provider fetchers ───────────────────────────────────────────────────

async function fetchDeepSeekBalance(apiKey: string): Promise<Omit<BalanceFetchResult, "provider">> {
  const response = await retryWithBackoff(
    () => fetch("https://api.deepseek.com/user/balance", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12_000),
    }),
    { maxRetries: 2, baseDelayMs: 500 },
  );

  if (!response.ok) {
    return {
      currency: "USD",
      totalBalance: 0,
      grantedBalance: 0,
      toppedUpBalance: 0,
      error: `HTTP ${response.status}`,
    };
  }

  const data = await response.json();
  const balanceInfos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];

  if (balanceInfos.length === 0) {
    return {
      currency: "USD",
      totalBalance: 0,
      grantedBalance: 0,
      toppedUpBalance: 0,
      error: "no balance_infos in response",
    };
  }

  // Prefer USD if available, otherwise use the first entry.
  const usdInfo = balanceInfos.find(
    (b: any) => String(b?.currency ?? "").toUpperCase() === "USD",
  );
  const info = usdInfo ?? balanceInfos[0];

  // Ensure numeric values
  const totalBalance = parseFloat(
    String(info?.total_balance ?? "0").replace(",", ""),
  );
  const grantedBalance = parseFloat(
    String(info?.granted_balance ?? "0").replace(",", ""),
  );
  const toppedUpBalance = parseFloat(
    String(info?.topped_up_balance ?? "0").replace(",", ""),
  );

  return {
    currency: String(info?.currency ?? "USD").toUpperCase(),
    totalBalance: Number.isFinite(totalBalance) ? totalBalance : 0,
    grantedBalance: Number.isFinite(grantedBalance) ? grantedBalance : 0,
    toppedUpBalance: Number.isFinite(toppedUpBalance) ? toppedUpBalance : 0,
  };
}

// ─── Fetcher registry ────────────────────────────────────────────────────────

type BalanceFetcher = (
  apiKey: string,
) => Promise<Omit<BalanceFetchResult, "provider">>;

const FETCHERS: Record<string, BalanceFetcher> = {
  deepseek: fetchDeepSeekBalance,
};

// ─── Public API ──────────────────────────────────────────────────────────────

export async function fetchProviderBalance(
  provider: string,
  apiKey: string,
  endpoint?: string,
): Promise<BalanceFetchResult> {
  const fetcher = FETCHERS[provider.toLowerCase()];
  if (!fetcher && !endpoint) {
    return {
      provider,
      currency: "USD",
      totalBalance: 0,
      grantedBalance: 0,
      toppedUpBalance: 0,
      error: `no balance fetcher for provider "${provider}" and no custom endpoint`,
    };
  }

  // If a custom endpoint is provided but no fetcher, we can still try.
  // For now, only fetcher-backed providers are supported.
  if (!fetcher) {
    return {
      provider,
      currency: "USD",
      totalBalance: 0,
      grantedBalance: 0,
      toppedUpBalance: 0,
      error: `balance endpoint configured (${endpoint}) but no parser for "${provider}"`,
    };
  }

  try {
    const result = await fetcher(apiKey);
    return { provider, ...result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      provider,
      currency: "USD",
      totalBalance: 0,
      grantedBalance: 0,
      toppedUpBalance: 0,
      error: msg,
    };
  }
}

export async function fetchAllBalances(
  providers: Array<{
    provider: string;
    apiKey: string;
    balanceEndpoint?: string;
  }>,
): Promise<Record<string, BalanceState>> {
  const results: Record<string, BalanceState> = {};
  const tasks = providers.map(async ({ provider, apiKey, balanceEndpoint }) => {
    const result = await fetchProviderBalance(provider, apiKey, balanceEndpoint);
    results[provider] = {
      provider,
      currency: result.currency,
      totalBalance: result.totalBalance,
      grantedBalance: result.grantedBalance,
      toppedUpBalance: result.toppedUpBalance,
      fetchedAt: Date.now(),
      error: result.error,
    };
  });
  await Promise.all(tasks);
  return results;
}

// ─── UVI helpers ─────────────────────────────────────────────────────────────

/**
 * Build a synthetic monthly QuotaWindow for a per-token provider so the
 * existing UVI pipeline can compute utilization velocity the same way it
 * does for subscription providers.
 *
 * usedPercent = (monthlySpend / monthlyBudget) × 100
 * windowDurationMs = milliseconds in the calendar month
 */
export function buildMonthlyQuotaWindow(
  provider: string,
  monthlySpend: number,
  monthlyBudget: number,
  now = Date.now(),
): {
  provider: string;
  scope: "monthly";
  usedPercent: number;
  resetsAt: string;
  windowDurationMs: number;
  source: "config";
  fetchedAt: number;
} | null {
  if (!Number.isFinite(monthlyBudget) || monthlyBudget <= 0) return null;
  const usedPercent = Math.min(100, Math.max(0, (monthlySpend / monthlyBudget) * 100));

  const d = new Date(now);
  const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const windowDurationMs = endOfMonth - startOfMonth;

  return {
    provider,
    scope: "monthly",
    usedPercent,
    resetsAt: new Date(endOfMonth).toISOString(),
    windowDurationMs,
    source: "config",
    fetchedAt: now,
  };
}
