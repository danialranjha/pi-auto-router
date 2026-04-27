import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_FIVE_HOUR_WINDOW_MS,
  CLAUDE_SEVEN_DAY_WINDOW_MS,
  CODEX_PRIMARY_WINDOW_MS,
  CODEX_SECONDARY_WINDOW_MS,
  GOOGLE_DAILY_WINDOW_MS,
  fetchAllUsages,
  fetchClaudeUsage,
  fetchCodexUsage,
  fetchGoogleUsage,
  parseGoogleQuotaBuckets,
  parseRetryAfterMs,
  readPercentCandidate,
  usageToWindows,
  type FetchLike,
  type FetchResponseLike,
} from "../src/quota-fetcher.ts";

function mockResponse(body: any, init: { status?: number; ok?: boolean; headers?: Record<string, string> } = {}): FetchResponseLike {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  const headers = init.headers ?? {};
  return {
    ok,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
  };
}

function mockFetch(map: Record<string, FetchResponseLike | ((url: string, init?: RequestInit) => FetchResponseLike)>): FetchLike {
  return async (url, init) => {
    for (const [pattern, response] of Object.entries(map)) {
      if (url.includes(pattern)) {
        return typeof response === "function" ? response(url, init) : response;
      }
    }
    return mockResponse({ error: "no match" }, { status: 404, ok: false });
  };
}

describe("readPercentCandidate", () => {
  it("treats 0..1 floats as fractions", () => {
    assert.equal(readPercentCandidate(0.42), 42);
  });
  it("treats integers 0..100 as percents", () => {
    assert.equal(readPercentCandidate(72), 72);
  });
  it("rejects out-of-range values", () => {
    assert.equal(readPercentCandidate(-5), null);
    assert.equal(readPercentCandidate(150), null);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses numeric seconds", () => {
    assert.equal(parseRetryAfterMs("30", 0), 30_000);
  });
  it("parses HTTP date strings", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const ms = parseRetryAfterMs(future, Date.now())!;
    assert.ok(ms >= 59_000 && ms <= 61_000);
  });
  it("returns null for garbage", () => {
    assert.equal(parseRetryAfterMs("nope"), null);
  });
});

describe("parseGoogleQuotaBuckets", () => {
  it("picks claude bucket first for antigravity", () => {
    const data = {
      buckets: [
        { tokenType: "REQUESTS", modelId: "claude-3-5-sonnet", remainingFraction: 0.2 },
        { tokenType: "REQUESTS", modelId: "gemini-pro", remainingFraction: 0.8 },
        { tokenType: "REQUESTS", modelId: "gemini-flash", remainingFraction: 0.9 },
      ],
    };
    const result = parseGoogleQuotaBuckets(data, "antigravity");
    assert.ok(result);
    // 1 - 0.2 = 0.8 → 80%
    assert.equal(Math.round(result!.session), 80);
  });

  it("picks gemini-pro first for gemini provider", () => {
    const data = {
      buckets: [
        { tokenType: "REQUESTS", modelId: "gemini-pro", remainingFraction: 0.5 },
        { tokenType: "REQUESTS", modelId: "gemini-flash", remainingFraction: 0.7 },
      ],
    };
    const result = parseGoogleQuotaBuckets(data, "gemini");
    assert.ok(result);
    assert.equal(Math.round(result!.session), 50);
  });

  it("returns null when no buckets present", () => {
    assert.equal(parseGoogleQuotaBuckets({}, "gemini"), null);
  });

  it("captures resetTime from primary and secondary buckets", () => {
    const primaryReset = "2026-04-27T00:00:00.000Z";
    const secondaryReset = "2026-04-27T06:00:00.000Z";
    const data = {
      buckets: [
        { tokenType: "REQUESTS", modelId: "gemini-2.5-pro", remainingFraction: 0.3, resetTime: primaryReset },
        { tokenType: "REQUESTS", modelId: "gemini-2.5-flash", remainingFraction: 0.6, resetTime: secondaryReset },
      ],
    };
    const result = parseGoogleQuotaBuckets(data, "gemini");
    assert.ok(result);
    assert.equal(result!.sessionResetsAt, primaryReset);
    assert.equal(result!.weeklyResetsAt, secondaryReset);
  });
});

describe("usageToWindows google resetTime", () => {
  it("derives windowDurationMs from per-bucket resetTime", () => {
    const fetchedAt = 1_700_000_000_000;
    const sessionReset = new Date(fetchedAt + 6 * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(fetchedAt + 4 * 24 * 60 * 60 * 1000).toISOString();
    const windows = usageToWindows("google-gemini-cli", {
      session: 30,
      weekly: 65,
      sessionResetsAt: sessionReset,
      weeklyResetsAt: weeklyReset,
      fetchedAt,
    });
    assert.equal(windows.length, 2);
    // session (primary bucket)
    assert.equal(windows[0].scope, "session");
    assert.equal(windows[0].resetsAt, sessionReset);
    assert.equal(windows[0].windowDurationMs, 6 * 60 * 60 * 1000);
    assert.equal(windows[0].usedPercent, 30);
    // weekly (secondary bucket)
    assert.equal(windows[1].scope, "weekly");
    assert.equal(windows[1].resetsAt, weeklyReset);
    assert.equal(windows[1].windowDurationMs, 4 * 24 * 60 * 60 * 1000);
    assert.equal(windows[1].usedPercent, 65);
  });

  it("falls back to GOOGLE_DAILY_WINDOW_MS when resetsAt is missing or stale", () => {
    const fetchedAt = 1_700_000_000_000;
    const stale = new Date(fetchedAt - 1000).toISOString();
    const windows = usageToWindows("google-antigravity", {
      session: 10,
      weekly: 10,
      sessionResetsAt: stale,
      weeklyResetsAt: undefined,
      fetchedAt,
    });
    assert.equal(windows.length, 2);
    assert.equal(windows[0].windowDurationMs, GOOGLE_DAILY_WINDOW_MS);
    assert.equal(windows[1].windowDurationMs, GOOGLE_DAILY_WINDOW_MS);
  });
});

describe("fetchCodexUsage", () => {
  it("extracts both windows from rate_limit shape", async () => {
    const fetchFn = mockFetch({
      "/wham/usage": mockResponse({
        rate_limit: {
          primary_window: { used_percent: 35, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 12, reset_after_seconds: 86400 },
        },
      }),
    });
    const usage = await fetchCodexUsage("token", { fetchFn });
    assert.equal(usage.session, 35);
    assert.equal(usage.weekly, 12);
    assert.equal(usage.sessionResetsInSec, 3600);
    assert.equal(usage.weeklyResetsInSec, 86400);
  });

  it("surfaces fetch errors", async () => {
    const fetchFn = mockFetch({
      "/wham/usage": mockResponse({}, { status: 401, ok: false }),
    });
    const usage = await fetchCodexUsage("token", { fetchFn });
    assert.match(usage.error ?? "", /HTTP 401/);
  });
});

describe("fetchClaudeUsage", () => {
  it("extracts five_hour and seven_day windows", async () => {
    const sessionReset = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const fetchFn = mockFetch({
      "/api/oauth/usage": mockResponse({
        five_hour: { utilization: 0.4, resets_at: sessionReset },
        seven_day: { utilization: 0.18, resets_at: weeklyReset },
      }),
    });
    const usage = await fetchClaudeUsage("token", { fetchFn });
    assert.equal(usage.session, 40);
    assert.equal(usage.weekly, 18);
    assert.equal(usage.sessionResetsAt, sessionReset);
    assert.equal(usage.weeklyResetsAt, weeklyReset);
  });

  it("captures retry-after on failures", async () => {
    const fetchFn = mockFetch({
      "/api/oauth/usage": mockResponse({}, { status: 429, ok: false, headers: { "retry-after": "120" } }),
    });
    const usage = await fetchClaudeUsage("token", { fetchFn });
    assert.match(usage.error ?? "", /HTTP 429/);
    assert.equal(usage.sessionResetsInSec, 120);
  });
});

describe("fetchGoogleUsage", () => {
  it("uses provided projectId and parses buckets", async () => {
    const fetchFn = mockFetch({
      ":retrieveUserQuota": mockResponse({
        buckets: [
          { tokenType: "REQUESTS", modelId: "gemini-2.5-pro", remainingFraction: 0.6 },
          { tokenType: "REQUESTS", modelId: "gemini-2.5-flash", remainingFraction: 0.9 },
        ],
      }),
    });
    const usage = await fetchGoogleUsage("token", "https://x/:retrieveUserQuota", "proj-1", "gemini", { fetchFn });
    assert.equal(usage.error, undefined);
    assert.equal(Math.round(usage.session), 40);
  });

  it("returns error when projectId discovery fails", async () => {
    const fetchFn = mockFetch({});
    const usage = await fetchGoogleUsage("token", "https://x/:retrieveUserQuota", undefined, "gemini", {
      fetchFn,
      env: {},
    });
    assert.match(usage.error ?? "", /missing projectId|HTTP 404/);
  });
});

describe("fetchAllUsages", () => {
  it("only fetches providers present in auth", async () => {
    let codexCalls = 0;
    let anthropicCalls = 0;
    const fetchFn: FetchLike = async (url) => {
      if (url.includes("/wham/usage")) {
        codexCalls++;
        return mockResponse({ rate_limit: { primary_window: { used_percent: 10 }, secondary_window: { used_percent: 5 } } });
      }
      if (url.includes("/api/oauth/usage")) {
        anthropicCalls++;
        return mockResponse({ five_hour: { utilization: 0.3 }, seven_day: { utilization: 0.1 } });
      }
      return mockResponse({}, { status: 404, ok: false });
    };
    const result = await fetchAllUsages({
      auth: { "openai-codex": { access: "x" } },
      fetchFn,
    });
    assert.equal(codexCalls, 1);
    assert.equal(anthropicCalls, 0);
    assert.ok(result["openai-codex"]);
    assert.equal(result.anthropic, undefined);
  });
});

describe("usageToWindows", () => {
  it("emits two windows for codex with reset seconds", () => {
    const windows = usageToWindows("openai-codex", {
      session: 25,
      weekly: 10,
      sessionResetsInSec: 3600,
      weeklyResetsInSec: 86400,
      fetchedAt: 1_700_000_000_000,
    });
    assert.equal(windows.length, 2);
    assert.equal(windows[0].scope, "session");
    assert.equal(windows[0].windowDurationMs, CODEX_PRIMARY_WINDOW_MS);
    assert.equal(windows[1].scope, "weekly");
    assert.equal(windows[1].windowDurationMs, CODEX_SECONDARY_WINDOW_MS);
  });

  it("emits two windows for anthropic with reset timestamps", () => {
    const sessionReset = new Date(1_700_000_000_000 + 3 * 60 * 60 * 1000).toISOString();
    const weeklyReset = new Date(1_700_000_000_000 + 5 * 24 * 60 * 60 * 1000).toISOString();
    const windows = usageToWindows("anthropic", {
      session: 60,
      weekly: 25,
      sessionResetsAt: sessionReset,
      weeklyResetsAt: weeklyReset,
      fetchedAt: 1_700_000_000_000,
    });
    assert.equal(windows.length, 2);
    assert.equal(windows[0].windowDurationMs, CLAUDE_FIVE_HOUR_WINDOW_MS);
    assert.equal(windows[1].windowDurationMs, CLAUDE_SEVEN_DAY_WINDOW_MS);
    assert.equal(windows[0].resetsAt, sessionReset);
  });

  it("emits two windows for google providers (session + weekly)", () => {
    const windows = usageToWindows("google-antigravity", {
      session: 40,
      weekly: 50,
      fetchedAt: 1_700_000_000_000,
    });
    assert.equal(windows.length, 2);
    assert.equal(windows[0].scope, "session");
    assert.equal(windows[0].windowDurationMs, GOOGLE_DAILY_WINDOW_MS);
    assert.equal(windows[0].usedPercent, 40);
    assert.equal(windows[1].scope, "weekly");
    assert.equal(windows[1].windowDurationMs, GOOGLE_DAILY_WINDOW_MS);
    assert.equal(windows[1].usedPercent, 50);
  });

  it("returns empty when usage is missing or errored", () => {
    assert.equal(usageToWindows("anthropic", null).length, 0);
    assert.equal(usageToWindows("anthropic", { session: 0, weekly: 0, error: "boom" }).length, 0);
  });

  it("marks source as stale-cache when usage is stale", () => {
    const windows = usageToWindows("openai-codex", {
      session: 10,
      weekly: 5,
      stale: true,
      fetchedAt: 1_700_000_000_000,
    });
    assert.equal(windows[0].source, "stale-cache");
  });
});
