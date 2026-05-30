#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_EVENTS_PATH = path.join(homedir(), '.pi', 'agent', 'extensions', 'auto-router.events.jsonl');
const UVI_STATES = ['ok', 'surplus', 'stressed', 'critical', 'unknown'];
const UVI_STATE_SHADES = {
  ok: '█',
  surplus: '▓',
  stressed: '▒',
  critical: '░',
  unknown: '▁',
};
const UVI_STATE_PRIORITY = {
  ok: 0,
  surplus: 1,
  stressed: 2,
  critical: 3,
  unknown: -1,
};
const TIMELINE_WIDTH = 72;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDayKey(timestampMs) {
  if (!Number.isFinite(timestampMs)) return '[unknown]';
  const date = new Date(timestampMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatLocalTimeHM(timestampMs) {
  if (!Number.isFinite(timestampMs)) return '--:--';
  const date = new Date(timestampMs);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatLocalTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs)) return undefined;
  const date = new Date(timestampMs);
  return `${formatLocalDayKey(timestampMs)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function getLocalMinuteOfDay(timestampMs) {
  if (!Number.isFinite(timestampMs)) return 0;
  const date = new Date(timestampMs);
  return date.getHours() * 60 + date.getMinutes();
}

function parseArgs(argv) {
  const options = {
    file: DEFAULT_EVENTS_PATH,
    routeId: undefined,
    since: undefined,
    json: false,
    limit: 25,
    dailyTop: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') options.file = argv[++i];
    else if (arg === '--route') options.routeId = argv[++i];
    else if (arg === '--since') options.since = argv[++i];
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--daily-top') options.dailyTop = Number(argv[++i]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) throw new Error(`Invalid --limit value: ${options.limit}`);
  if (!Number.isFinite(options.dailyTop) || options.dailyTop <= 0) throw new Error(`Invalid --daily-top value: ${options.dailyTop}`);
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/routing-session-stats.mjs [options]\n\nOptions:\n  --file <path>       Event JSONL path (default: ~/.pi/agent/extensions/auto-router.events.jsonl)\n  --route <id>        Filter by routeId\n  --since <iso>       Filter events at/after this ISO time\n  --limit <n>         Max rows per section (default: 25)\n  --daily-top <n>     Top models/providers to show per day (default: 3)\n  --json              Print JSON\n  -h, --help          Show help`);
}

async function loadEvents(file, sinceMs, routeId) {
  const events = [];
  try {
    await fs.access(file);
  } catch {
    return events;
  }
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(event.timestamp ?? '');
    if (sinceMs !== null && Number.isFinite(ts) && ts < sinceMs) continue;
    if (routeId && event.routeId !== routeId) continue;
    events.push(event);
  }
  return events;
}

function summarize(events, limit, dailyTop) {
  const sessions = buildSessions(events).sort((a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0));
  return {
    window: summarizeWindow(sessions),
    totals: summarizeTotals(sessions),
    dailyRoutingComposition: summarizeDailyRoutingComposition(sessions, limit, dailyTop),
    sessionStartUviTimeline: summarizeSessionStartUviTimeline(sessions, dailyTop),
    dailyUviMix: summarizeDailyUviMix(sessions, limit),
    latencyDistributionByModel: summarizeBucketDistributionByModel(sessions, limit, 'latencyMs'),
    costDistributionByModel: summarizeBucketDistributionByModel(sessions, limit, 'costUsd'),
    recentSessions: sessions.slice(0, limit).map(toDisplaySession),
    driftSessions: sessions.filter((s) => s.plannedSpec !== s.actualSpec).slice(0, limit).map(toDisplaySession),
  };
}

function buildSessions(events) {
  const byRequest = new Map();
  for (const event of events) {
    if (!event?.requestId) continue;
    const row = byRequest.get(event.requestId) ?? {
      requestId: event.requestId,
      conversationId: event.conversationId,
      routeId: event.routeId,
      firstTimestamp: undefined,
      lastTimestamp: undefined,
      plannedProvider: undefined,
      plannedModelId: undefined,
      actualProvider: undefined,
      actualModelId: undefined,
      outcome: undefined,
      latencyMs: null,
      ttftMs: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      attemptCount: 0,
      selectedUvi: undefined,
    };

    const ts = Date.parse(event.timestamp ?? '');
    if (Number.isFinite(ts)) {
      row.firstTimestamp = row.firstTimestamp == null ? ts : Math.min(row.firstTimestamp, ts);
      row.lastTimestamp = row.lastTimestamp == null ? ts : Math.max(row.lastTimestamp, ts);
    }
    if (event.conversationId) row.conversationId = event.conversationId;
    if (event.routeId) row.routeId = event.routeId;

    if (event.type === 'routing.decision') {
      row.plannedProvider = event.data?.plannedTarget?.provider;
      row.plannedModelId = event.data?.plannedTarget?.modelId;
      row.selectedUvi = normalizeUvi(event.data?.selectedUvi) ?? row.selectedUvi;
    }

    if (event.type === 'routing.candidates' && !row.selectedUvi) {
      const selected = Array.isArray(event.data?.candidates)
        ? event.data.candidates.find((candidate) => candidate?.status === 'selected')
        : undefined;
      row.selectedUvi = inferUviFromCandidate(selected) ?? row.selectedUvi;
    }

    if (event.type === 'routing.result') {
      row.attemptCount = Math.max(row.attemptCount, Number(event.data?.index) || 0);
      if (event.data?.outcome === 'success') {
        row.actualProvider = event.data?.provider ?? row.actualProvider;
        row.actualModelId = event.data?.modelId ?? row.actualModelId;
        row.latencyMs = numberOrNull(event.data?.latencyMs);
        row.ttftMs = numberOrNull(event.data?.ttftMs);
        row.costUsd = numberOrNull(event.data?.costUsd);
        row.inputTokens = numberOrNull(event.data?.inputTokens);
        row.outputTokens = numberOrNull(event.data?.outputTokens);
      }
    }

    if (event.type === 'routing.final') {
      row.outcome = event.data?.outcome;
      row.actualProvider = event.data?.actualTarget?.provider ?? row.actualProvider;
      row.actualModelId = event.data?.actualTarget?.modelId ?? row.actualModelId;
      row.selectedUvi = normalizeUvi(event.data?.actualUvi) ?? row.selectedUvi;
    }

    byRequest.set(event.requestId, row);
  }

  return [...byRequest.values()].map((session) => {
    const plannedSpec = `${session.plannedProvider ?? '[unknown]'}/${session.plannedModelId ?? '[unknown]'}`;
    const actualSpec = `${session.actualProvider ?? session.plannedProvider ?? '[unknown]'}/${session.actualModelId ?? session.plannedModelId ?? '[unknown]'}`;
    const inferredOutcome = session.outcome ?? (session.attemptCount > 0 ? 'incomplete' : session.plannedProvider ? 'missing_final' : '[unknown]');
    return {
      ...session,
      plannedSpec,
      actualSpec,
      outcome: inferredOutcome,
      uviStatus: session.selectedUvi?.status ?? 'unknown',
      uviValue: session.selectedUvi?.uvi ?? null,
    };
  });
}

function normalizeUvi(value) {
  if (!value || typeof value !== 'object') return null;
  const status = typeof value.status === 'string' ? value.status : undefined;
  const uvi = Number.isFinite(value.uvi) ? value.uvi : null;
  const bucket = typeof value.bucket === 'string' ? value.bucket : undefined;
  const inferredStatus = status ?? inferStatusFromBucket(bucket);
  return inferredStatus ? { status: inferredStatus, uvi, bucket } : null;
}

function inferUviFromCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const status = typeof candidate.uviStatus === 'string' ? candidate.uviStatus : inferStatusFromBucket(candidate.bucket);
  const uvi = Number.isFinite(candidate.uvi) ? candidate.uvi : null;
  return status ? { status, uvi, bucket: candidate.bucket } : null;
}

function inferStatusFromBucket(bucket) {
  if (bucket === 'promoted') return 'surplus';
  if (bucket === 'demoted') return 'stressed';
  if (bucket === 'normal') return 'ok';
  return null;
}

function summarizeWindow(sessions) {
  const timestamps = sessions.map((s) => s.firstTimestamp).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    startMs: timestamps[0] ?? null,
    endMs: timestamps[timestamps.length - 1] ?? null,
  };
}

function summarizeTotals(sessions) {
  const success = sessions.filter((s) => s.outcome === 'success').length;
  const failovers = sessions.filter((s) => s.attemptCount > 1).length;
  return {
    sessions: sessions.length,
    successRate: percent(success, sessions.length),
    failoverRate: percent(failovers, sessions.length),
    avgLatencyMs: avg(sessions.map((s) => s.latencyMs)),
    avgTtftMs: avg(sessions.map((s) => s.ttftMs)),
    avgCostUsd: avg(sessions.map((s) => s.costUsd)),
  };
}

function summarizeDailyRoutingComposition(sessions, limit, topN) {
  const groups = new Map();
  for (const session of sessions) {
    const day = formatLocalDayKey(session.firstTimestamp);
    const key = session.actualSpec;
    const dayRow = groups.get(day) ?? {
      day,
      total: 0,
      success: 0,
      avgLatency: [],
      counts: new Map(),
      providers: new Set(),
      models: new Set(),
    };
    dayRow.total += 1;
    dayRow.success += session.outcome === 'success' ? 1 : 0;
    if (Number.isFinite(session.latencyMs)) dayRow.avgLatency.push(session.latencyMs);
    dayRow.counts.set(key, (dayRow.counts.get(key) ?? 0) + 1);
    dayRow.providers.add(session.actualProvider ?? session.plannedProvider ?? '[unknown]');
    dayRow.models.add(key);
    groups.set(day, dayRow);
  }

  const shades = ['█', '▓', '▒', '░'];
  return [...groups.values()]
    .map((row) => {
      const sorted = [...row.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const visible = (sorted.length <= topN ? sorted : sorted.slice(0, topN - 1)).map(([key, count], index) => ({
        key,
        count,
        sharePct: percent(count, row.total),
        shade: shades[index] ?? '░',
      }));
      if (sorted.length > topN) {
        const otherCount = sorted.slice(topN - 1).reduce((sum, [, count]) => sum + count, 0);
        visible.push({ key: 'others', count: otherCount, sharePct: percent(otherCount, row.total), shade: '░' });
      }
      const barRaw = visible.map((item) => item.shade.repeat(Math.max(1, Math.round((item.sharePct / 100) * 20)))).join('');
      return {
        key: row.day,
        total: row.total,
        successRate: percent(row.success, row.total),
        avgLatencyMs: avg(row.avgLatency),
        providerCount: row.providers.size,
        modelCount: row.models.size,
        bar: barRaw.slice(0, 20).padEnd(20, ' '),
        segments: visible,
      };
    })
    .sort((a, b) => String(b.key).localeCompare(String(a.key)))
    .slice(0, limit);
}

function summarizeRouteModelShareByDay(sessions, limit) {
  const days = new Map();
  const routeModelTotals = new Map();

  for (const session of sessions) {
    const day = formatLocalDayKey(session.firstTimestamp);
    const routeId = session.routeId ?? '[unknown]';
    const actualSpec = session.actualSpec;

    const dayRow = days.get(day) ?? new Map();
    const routeRow = dayRow.get(routeId) ?? { day, routeId, total: 0, counts: new Map() };
    routeRow.total += 1;
    routeRow.counts.set(actualSpec, (routeRow.counts.get(actualSpec) ?? 0) + 1);
    dayRow.set(routeId, routeRow);
    days.set(day, dayRow);

    const routeTotals = routeModelTotals.get(routeId) ?? new Map();
    routeTotals.set(actualSpec, (routeTotals.get(actualSpec) ?? 0) + 1);
    routeModelTotals.set(routeId, routeTotals);
  }

  const stableRouteOrders = new Map(
    [...routeModelTotals.entries()].map(([routeId, counts]) => [
      routeId,
      [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([key]) => key),
    ]),
  );

  return [...days.entries()]
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .slice(0, limit)
    .map(([day, routes]) => ({
      day,
      routes: [...routes.values()]
        .map((route) => {
          const stableOrder = stableRouteOrders.get(route.routeId) ?? [];
          const present = [...route.counts.entries()].sort((a, b) => {
            const rankA = stableOrder.indexOf(a[0]);
            const rankB = stableOrder.indexOf(b[0]);
            return rankA - rankB || b[1] - a[1] || a[0].localeCompare(b[0]);
          });
          const shades = ['█', '▓', '▒', '░'];
          const visible = (present.length <= 4 ? present : present.slice(0, 3)).map(([key, count], index) => ({
            key,
            count,
            sharePct: percent(count, route.total),
            shade: shades[index],
          }));
          if (present.length > 4) {
            const otherCount = present.slice(3).reduce((sum, [, count]) => sum + count, 0);
            visible.push({ key: 'others', count: otherCount, sharePct: percent(otherCount, route.total), shade: '░' });
          }
          const barSegments = visible.map((row) => row.shade.repeat(Math.max(1, Math.round((row.sharePct / 100) * 20)))).join('');
          return {
            routeId: route.routeId,
            total: route.total,
            bar: barSegments.slice(0, 20).padEnd(20, ' '),
            models: visible,
          };
        })
        .sort((a, b) => b.total - a.total || a.routeId.localeCompare(b.routeId)),
    }));
}

function summarizeSessionStartUviTimeline(sessions, topN) {
  const dated = sessions.filter((session) => Number.isFinite(session.firstTimestamp));
  if (dated.length === 0) return null;

  const latestDay = dated
    .map((session) => formatLocalDayKey(session.firstTimestamp))
    .sort((a, b) => b.localeCompare(a))[0];

  const latestSessions = dated
    .filter((session) => formatLocalDayKey(session.firstTimestamp) === latestDay)
    .sort((a, b) => a.firstTimestamp - b.firstTimestamp);

  const groups = new Map();
  for (const session of latestSessions) {
    const key = session.actualSpec;
    const row = groups.get(key) ?? {
      key,
      count: 0,
      firstMs: session.firstTimestamp,
      lastMs: session.firstTimestamp,
      slots: Array.from({ length: TIMELINE_WIDTH }, () => ({ state: null, count: 0 })),
      states: { ok: 0, surplus: 0, stressed: 0, critical: 0, unknown: 0 },
    };
    row.count += 1;
    row.firstMs = Math.min(row.firstMs, session.firstTimestamp);
    row.lastMs = Math.max(row.lastMs, session.firstTimestamp);
    row.states[session.uviStatus] += 1;

    const minuteOfDay = getLocalMinuteOfDay(session.firstTimestamp);
    const slot = Math.min(TIMELINE_WIDTH - 1, Math.max(0, Math.floor((minuteOfDay / 1440) * TIMELINE_WIDTH)));
    const current = row.slots[slot];
    if (!current.state || (UVI_STATE_PRIORITY[session.uviStatus] ?? -1) >= (UVI_STATE_PRIORITY[current.state] ?? -1)) {
      current.state = session.uviStatus;
    }
    current.count += 1;
    groups.set(key, row);
  }

  const rows = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, topN)
    .map((row) => ({
      key: row.key,
      count: row.count,
      firstHour: formatLocalTimeHM(row.firstMs),
      lastHour: formatLocalTimeHM(row.lastMs),
      line: row.slots.map((slot) => slot.state ? UVI_STATE_SHADES[slot.state] : ' ').join(''),
      states: row.states,
    }));

  return {
    day: latestDay,
    width: TIMELINE_WIDTH,
    rows,
    legend: UVI_STATES.map((state) => `${UVI_STATE_SHADES[state]} ${state}`).join('  '),
    axisLabels: buildTimelineAxisLabels(TIMELINE_WIDTH),
    axisTicks: buildTimelineAxisTicks(TIMELINE_WIDTH),
  };
}

function summarizeDailyUviMix(sessions, limit) {
  const groups = new Map();
  for (const session of sessions) {
    const day = formatLocalDayKey(session.firstTimestamp);
    const row = groups.get(day) ?? { key: day, total: 0, ok: 0, surplus: 0, stressed: 0, critical: 0, unknown: 0, success: 0, latencies: [] };
    row.total += 1;
    row[session.uviStatus] += 1;
    if (session.outcome === 'success') row.success += 1;
    if (Number.isFinite(session.latencyMs)) row.latencies.push(session.latencyMs);
    groups.set(day, row);
  }
  return [...groups.values()]
    .map((row) => {
      const segments = UVI_STATES
        .filter((state) => row[state] > 0)
        .map((state) => ({
          state,
          count: row[state],
          sharePct: percent(row[state], row.total),
          shade: UVI_STATE_SHADES[state],
        }));
      const barRaw = segments.map((segment) => segment.shade.repeat(Math.max(1, Math.round((segment.sharePct / 100) * 20)))).join('');
      return {
        key: row.key,
        total: row.total,
        successRate: percent(row.success, row.total),
        avgLatencyMs: avg(row.latencies),
        bar: barRaw.slice(0, 20).padEnd(20, ' '),
        labels: segments.map((segment) => `${segment.shade} ${segment.state} ${fmt(segment.sharePct)}%`).join(' | '),
      };
    })
    .sort((a, b) => String(b.key).localeCompare(String(a.key)))
    .slice(0, limit);
}

function summarizeBucketDistributionByModel(sessions, limit, field) {
  const groups = new Map();
  for (const session of sessions) {
    const value = session[field];
    const row = groups.get(session.actualSpec) ?? { key: session.actualSpec, count: 0, values: [] };
    row.count += 1;
    if (Number.isFinite(value)) row.values.push(value);
    groups.set(session.actualSpec, row);
  }

  const bucketDefs = field === 'latencyMs'
    ? [
        { min: 0, max: 2_000, label: '0-2s' },
        { min: 2_000, max: 5_000, label: '2-5s' },
        { min: 5_000, max: 10_000, label: '5-10s' },
        { min: 10_000, max: 20_000, label: '10-20s' },
        { min: 20_000, max: 40_000, label: '20-40s' },
        { min: 40_000, max: Infinity, label: '40s+' },
      ]
    : [
        { min: 0, max: 0.01, label: '$0-.01' },
        { min: 0.01, max: 0.03, label: '.01-.03' },
        { min: 0.03, max: 0.1, label: '.03-.10' },
        { min: 0.1, max: 0.25, label: '.10-.25' },
        { min: 0.25, max: Infinity, label: '.25+' },
      ];

  const rows = [...groups.values()]
    .map((row) => {
      const buckets = bucketDefs.map((bucket) => ({ ...bucket, count: 0 }));
      for (const value of row.values) {
        const match = buckets.find((bucket) => value >= bucket.min && value < bucket.max) ?? buckets[buckets.length - 1];
        match.count += 1;
      }
      const maxBucket = Math.max(1, ...buckets.map((bucket) => bucket.count));
      return {
        key: row.key,
        count: row.count,
        p50: percentile(row.values, 50),
        buckets: buckets.map((bucket) => ({
          label: bucket.label,
          count: bucket.count,
          bar: '█'.repeat(Math.max(0, Math.round((bucket.count / maxBucket) * 12))),
        })),
      };
    })
    .sort((a, b) => b.count - a.count || (b.p50 ?? -1) - (a.p50 ?? -1) || a.key.localeCompare(b.key))
    .slice(0, limit);

  return rows;
}

function toDisplaySession(session) {
  return {
    timestamp: formatLocalTimestamp(session.firstTimestamp),
    requestId: session.requestId,
    conversationId: session.conversationId,
    routeId: session.routeId,
    planned: session.plannedSpec,
    actual: session.actualSpec,
    uviStatus: session.uviStatus,
    uviValue: session.uviValue,
    outcome: session.outcome ?? '[unknown]',
    attemptCount: session.attemptCount,
    latencyMs: session.latencyMs,
    ttftMs: session.ttftMs,
    costUsd: session.costUsd,
  };
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : null;
}

function percentile(values, p) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[index];
}

function percent(n, d) {
  return d > 0 ? (n / d) * 100 : 0;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function fmt(value, digits = 1) {
  return value === null || value === undefined ? '-' : Number(value).toFixed(digits);
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : '-';
}

function bar(percentValue, width = 20) {
  const clamped = Math.max(0, Math.min(100, percentValue));
  const filled = Math.round((clamped / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function buildTimelineAxisLabels(width) {
  const chars = Array.from({ length: width }, () => ' ');
  for (let hour = 0; hour <= 20; hour += 4) {
    const label = `${String(hour).padStart(2, '0')}h`;
    const pos = Math.min(width - label.length, Math.floor((hour / 24) * width));
    for (let i = 0; i < label.length; i++) chars[pos + i] = label[i];
  }
  const end = '24h';
  for (let i = 0; i < end.length; i++) chars[width - end.length + i] = end[i];
  return chars.join('');
}

function buildTimelineAxisTicks(width) {
  const chars = Array.from({ length: width }, () => '─');
  for (let hour = 0; hour <= 24; hour += 4) {
    const pos = Math.min(width - 1, Math.floor((hour / 24) * width));
    chars[pos] = '┼';
  }
  return chars.join('');
}

function buildText(summary, file) {
  const lines = [];
  lines.push(`Routing session stats from ${file}`);
  lines.push(`Window: ${formatLocalTimestamp(summary.window.startMs) ?? '[unknown]'} → ${formatLocalTimestamp(summary.window.endMs) ?? '[unknown]'} (local)`);
  lines.push(`Sessions in window: ${summary.totals.sessions} success=${fmt(summary.totals.successRate)}% failover=${fmt(summary.totals.failoverRate)}% latency=${fmt(summary.totals.avgLatencyMs, 0)}ms ttft=${fmt(summary.totals.avgTtftMs, 0)}ms cost=$${fmt(summary.totals.avgCostUsd, 4)}`);
  lines.push('');

  lines.push('Daily routing composition');
  for (const day of summary.dailyRoutingComposition) {
    const labels = day.segments.map((row) => `${row.shade} ${row.key} ${fmt(row.sharePct)}%`).join(' | ');
    lines.push(`  ${day.key}  total=${String(day.total).padStart(3)}  ${day.bar}  ${labels}`);
    lines.push(`              providers=${day.providerCount} models=${day.modelCount} success=${fmt(day.successRate)}% latency=${fmt(day.avgLatencyMs, 0)}ms`);
  }
  lines.push('');

  lines.push(`Session-start UVI timeline (latest local day: ${summary.sessionStartUviTimeline?.day ?? 'n/a'})`);
  if (!summary.sessionStartUviTimeline || summary.sessionStartUviTimeline.rows.length === 0) {
    lines.push('  none');
  } else {
    lines.push(`  ${summary.sessionStartUviTimeline.axisLabels}`);
    lines.push(`  ${summary.sessionStartUviTimeline.axisTicks}`);
    for (const row of summary.sessionStartUviTimeline.rows) {
      lines.push(`  ${row.line}  ${row.key} n=${row.count} ${row.firstHour}-${row.lastHour}`);
    }
    lines.push(`  legend: ${summary.sessionStartUviTimeline.legend}`);
  }
  lines.push('');

  lines.push('UVI selection mix by day');
  for (const row of summary.dailyUviMix) lines.push(`  ${row.key}  total=${String(row.total).padStart(3)}  ${row.bar}  ${row.labels.padEnd(30)} success=${fmt(row.successRate)}% latency=${fmt(row.avgLatencyMs, 0)}ms`);
  lines.push('');

  lines.push('Latency distribution by model (window above)');
  for (const row of summary.latencyDistributionByModel) {
    lines.push(`  ${row.key}  p50=${fmt(row.p50, 0)}ms n=${row.count}`);
    for (const bucket of row.buckets) lines.push(`    ${bucket.label.padEnd(8)} ${bucket.bar.padEnd(12)} ${bucket.count}`);
  }
  lines.push('');

  lines.push('Cost distribution by model (window above)');
  for (const row of summary.costDistributionByModel) {
    lines.push(`  ${row.key}  p50=$${fmt(row.p50, 4)} n=${row.count}`);
    for (const bucket of row.buckets) lines.push(`    ${bucket.label.padEnd(8)} ${bucket.bar.padEnd(12)} ${bucket.count}`);
  }
  lines.push('');

  lines.push('Planned → actual drift');
  if (summary.driftSessions.length === 0) lines.push('  none');
  for (const row of summary.driftSessions) lines.push(`  ${row.timestamp ?? '-'} planned=${row.planned} actual=${row.actual} uvi=${row.uviStatus} outcome=${row.outcome} req=${shortId(row.requestId)}`);

  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const sinceMs = options.since ? Date.parse(options.since) : null;
  if (options.since && !Number.isFinite(sinceMs)) throw new Error(`Invalid --since value: ${options.since}`);
  const file = path.resolve(options.file);
  const events = await loadEvents(file, sinceMs, options.routeId);
  const summary = summarize(events, options.limit, options.dailyTop);
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(buildText(summary, file));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
