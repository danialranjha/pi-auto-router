#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_EVENTS_PATH = path.join(homedir(), '.pi', 'agent', 'extensions', 'auto-router.events.jsonl');
const DEFAULT_RATINGS_PATH = path.join(homedir(), '.pi', 'agent', 'extensions', 'auto-router.ratings.json');

function parseArgs(argv) {
  const options = {
    file: DEFAULT_EVENTS_PATH,
    ratingsFile: DEFAULT_RATINGS_PATH,
    routeId: undefined,
    since: undefined,
    json: false,
    includeLegacyRatings: true,
    limit: 20,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') options.file = argv[++i];
    else if (arg === '--ratings-file') options.ratingsFile = argv[++i];
    else if (arg === '--route') options.routeId = argv[++i];
    else if (arg === '--since') options.since = argv[++i];
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-legacy-ratings') options.includeLegacyRatings = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.limit) || options.limit <= 0) throw new Error(`Invalid --limit value: ${options.limit}`);
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/routing-quality-stats.mjs [options]\n\nOptions:\n  --file <path>            Event JSONL path (default: ~/.pi/agent/extensions/auto-router.events.jsonl)\n  --ratings-file <path>    Legacy ratings JSON path (default: ~/.pi/agent/extensions/auto-router.ratings.json)\n  --route <id>             Filter by routeId\n  --since <iso>            Filter records at/after this ISO time\n  --limit <n>              Row limit per breakdown (default: 20)\n  --json                   Print JSON\n  --no-legacy-ratings      Ignore legacy ratings file and use event feedback only\n  -h, --help               Show help`);
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

async function loadLegacyRatings(file, sinceMs, routeId) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((rating) => {
      if (!rating || typeof rating !== 'object') return false;
      if (sinceMs !== null && typeof rating.timestamp === 'number' && rating.timestamp < sinceMs) return false;
      if (routeId && rating.routeId !== routeId) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function toRequestMap(events, type) {
  const map = new Map();
  for (const event of events) {
    if (event.type === type && event.requestId) map.set(event.requestId, event);
  }
  return map;
}

function buildFeedbackRows(events, legacyRatings) {
  const decisionsByRequest = toRequestMap(events, 'routing.decision');
  const finalsByRequest = toRequestMap(events, 'routing.final');
  const resultsByRequest = new Map();
  for (const event of events) {
    if (event.type !== 'routing.result' || !event.requestId) continue;
    const rows = resultsByRequest.get(event.requestId) ?? [];
    rows.push(event);
    resultsByRequest.set(event.requestId, rows);
  }

  const feedbackRows = [];
  for (const event of events) {
    if (event.type !== 'routing.feedback') continue;
    feedbackRows.push(buildFeedbackRow({
      source: 'event',
      feedback: {
        timestamp: Date.parse(event.timestamp ?? '') || undefined,
        requestId: event.requestId,
        conversationId: event.conversationId,
        routeId: event.routeId,
        provider: event.data?.provider,
        modelId: event.data?.modelId,
        label: event.data?.label,
        rating: event.data?.rating,
        reason: event.data?.reason,
        tags: event.data?.tags,
        tier: event.data?.tier,
        intent: event.data?.intent,
      },
      decisionsByRequest,
      finalsByRequest,
      resultsByRequest,
    }));
  }

  for (const rating of legacyRatings) {
    feedbackRows.push(buildFeedbackRow({
      source: 'legacy-rating',
      feedback: rating,
      decisionsByRequest,
      finalsByRequest,
      resultsByRequest,
    }));
  }

  return dedupeFeedbackRows(feedbackRows).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function buildFeedbackRow({ source, feedback, decisionsByRequest, finalsByRequest, resultsByRequest }) {
  const decision = feedback.requestId ? decisionsByRequest.get(feedback.requestId) : undefined;
  const final = feedback.requestId ? finalsByRequest.get(feedback.requestId) : undefined;
  const results = feedback.requestId ? (resultsByRequest.get(feedback.requestId) ?? []) : [];
  const successResult = results.find((r) => r.data?.outcome === 'success');
  const tier = feedback.tier ?? decision?.data?.tier;
  const intent = feedback.intent ?? decision?.data?.reasoningStructured?.intent?.category;
  const subtask = decision?.data?.reasoningStructured?.intent?.subtask;
  const actualTarget = final?.data?.actualTarget;
  const plannedTarget = decision?.data?.plannedTarget;
  const latencyMs = numberOrNull(successResult?.data?.latencyMs);
  const ttftMs = numberOrNull(successResult?.data?.ttftMs);
  const inputTokens = numberOrNull(successResult?.data?.inputTokens);
  const outputTokens = numberOrNull(successResult?.data?.outputTokens);
  const costUsd = numberOrNull(successResult?.data?.costUsd);
  const attemptCount = results.length;
  const outcome = final?.data?.outcome;

  return {
    source,
    timestamp: typeof feedback.timestamp === 'number' ? feedback.timestamp : undefined,
    requestId: feedback.requestId,
    conversationId: feedback.conversationId,
    routeId: feedback.routeId ?? decision?.routeId,
    rating: feedback.rating,
    reason: feedback.reason,
    tags: Array.isArray(feedback.tags) ? feedback.tags.filter((t) => typeof t === 'string') : [],
    tier,
    intent,
    subtask,
    provider: feedback.provider ?? actualTarget?.provider ?? plannedTarget?.provider,
    modelId: feedback.modelId ?? actualTarget?.modelId ?? plannedTarget?.modelId,
    label: feedback.label ?? actualTarget?.label ?? plannedTarget?.label,
    plannedProvider: plannedTarget?.provider,
    plannedModelId: plannedTarget?.modelId,
    actualProvider: actualTarget?.provider,
    actualModelId: actualTarget?.modelId,
    outcome,
    attemptCount,
    latencyMs,
    ttftMs,
    inputTokens,
    outputTokens,
    costUsd,
  };
}

function dedupeFeedbackRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [
      row.requestId ?? '',
      row.timestamp ?? '',
      row.routeId ?? '',
      row.provider ?? '',
      row.modelId ?? '',
      row.rating ?? '',
      row.reason ?? '',
      row.tags.join(','),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function summarize(feedbackRows, events, limit) {
  const ratedRequests = new Set(feedbackRows.map((row) => row.requestId).filter(Boolean));
  const finals = events.filter((e) => e.type === 'routing.final');
  const eventFeedbackCount = events.filter((e) => e.type === 'routing.feedback').length;
  const legacyFeedbackCount = feedbackRows.filter((row) => row.source === 'legacy-rating').length;

  return {
    totals: {
      ratings: feedbackRows.length,
      eventFeedback: eventFeedbackCount,
      legacyRatings: legacyFeedbackCount,
      ratedRequests: ratedRequests.size,
      good: feedbackRows.filter((row) => row.rating === 'good').length,
      bad: feedbackRows.filter((row) => row.rating === 'bad').length,
      positiveRate: percent(feedbackRows.filter((row) => row.rating === 'good').length, feedbackRows.length),
      coverageVsFinals: percent(ratedRequests.size, finals.length),
      avgLatencyMs: avg(feedbackRows.map((row) => row.latencyMs)),
      avgTtftMs: avg(feedbackRows.map((row) => row.ttftMs)),
      avgCostUsd: avg(feedbackRows.map((row) => row.costUsd)),
      failoverRate: percent(feedbackRows.filter((row) => row.attemptCount > 1).length, feedbackRows.length),
    },
    byRoute: summarizeBreakdown(feedbackRows, (row) => row.routeId ?? '[unknown]', limit),
    byProvider: summarizeBreakdown(feedbackRows, (row) => row.provider ?? '[unknown]', limit),
    byModel: summarizeBreakdown(feedbackRows, (row) => `${row.provider ?? '[unknown]'}/${row.modelId ?? '[unknown]'}`, limit),
    byTier: summarizeBreakdown(feedbackRows, (row) => row.tier ?? '[unknown]', limit),
    byIntent: summarizeBreakdown(feedbackRows, (row) => row.intent ?? '[unknown]', limit),
    bySubtask: summarizeBreakdown(feedbackRows, (row) => row.subtask ?? '[none]', limit),
    byOutcome: summarizeBreakdown(feedbackRows, (row) => row.outcome ?? '[unknown]', limit),
    byTag: summarizeTags(feedbackRows, limit),
    drift: summarizeDrift(feedbackRows, limit),
    recentBad: feedbackRows.filter((row) => row.rating === 'bad').slice(0, limit).map(toRecentRow),
    recentGood: feedbackRows.filter((row) => row.rating === 'good').slice(0, limit).map(toRecentRow),
  };
}

function summarizeBreakdown(rows, keyFn, limit) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, items]) => summarizeRows(key, items))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function summarizeTags(rows, limit) {
  const groups = new Map();
  for (const row of rows) {
    for (const tag of row.tags) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(row);
    }
  }
  return [...groups.entries()]
    .map(([key, items]) => summarizeRows(key, items))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function summarizeDrift(rows, limit) {
  const groups = new Map();
  for (const row of rows) {
    const planned = `${row.plannedProvider ?? '[unknown]'}/${row.plannedModelId ?? '[unknown]'}`;
    const actual = `${row.actualProvider ?? row.provider ?? '[unknown]'}/${row.actualModelId ?? row.modelId ?? '[unknown]'}`;
    const key = `${planned} -> ${actual}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, items]) => summarizeRows(key, items))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function summarizeRows(key, rows) {
  const good = rows.filter((row) => row.rating === 'good').length;
  const bad = rows.filter((row) => row.rating === 'bad').length;
  return {
    key,
    count: rows.length,
    good,
    bad,
    positiveRate: percent(good, rows.length),
    avgLatencyMs: avg(rows.map((row) => row.latencyMs)),
    avgTtftMs: avg(rows.map((row) => row.ttftMs)),
    avgCostUsd: avg(rows.map((row) => row.costUsd)),
    failoverRate: percent(rows.filter((row) => row.attemptCount > 1).length, rows.length),
  };
}

function toRecentRow(row) {
  return {
    timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : undefined,
    requestId: row.requestId,
    routeId: row.routeId,
    rating: row.rating,
    provider: row.provider,
    modelId: row.modelId,
    tier: row.tier,
    intent: row.intent,
    subtask: row.subtask,
    outcome: row.outcome,
    attemptCount: row.attemptCount,
    latencyMs: row.latencyMs,
    ttftMs: row.ttftMs,
    costUsd: row.costUsd,
    tags: row.tags,
    reason: row.reason,
    source: row.source,
  };
}

function avg(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : null;
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

function buildText(summary, file, ratingsFile) {
  const lines = [];
  lines.push(`Routing quality stats from ${file}`);
  lines.push(`Legacy ratings: ${ratingsFile}`);
  lines.push(`Ratings: ${summary.totals.ratings} (good=${summary.totals.good}, bad=${summary.totals.bad}, positive=${fmt(summary.totals.positiveRate)}%)`);
  lines.push(`Coverage vs finals: ${fmt(summary.totals.coverageVsFinals)}%`);
  lines.push(`Failover rate among rated requests: ${fmt(summary.totals.failoverRate)}%`);
  lines.push(`Avg latency=${fmt(summary.totals.avgLatencyMs, 0)}ms ttft=${fmt(summary.totals.avgTtftMs, 0)}ms cost=$${fmt(summary.totals.avgCostUsd, 4)}`);
  lines.push(`Sources: eventFeedback=${summary.totals.eventFeedback} legacyRatings=${summary.totals.legacyRatings}`);
  lines.push('');
  appendBreakdown(lines, 'By route', summary.byRoute);
  appendBreakdown(lines, 'By provider', summary.byProvider);
  appendBreakdown(lines, 'By model', summary.byModel);
  appendBreakdown(lines, 'By tier', summary.byTier);
  appendBreakdown(lines, 'By intent', summary.byIntent);
  appendBreakdown(lines, 'By subtask', summary.bySubtask);
  appendBreakdown(lines, 'By outcome', summary.byOutcome);
  appendBreakdown(lines, 'By tag', summary.byTag);
  appendBreakdown(lines, 'Planned -> actual drift', summary.drift);
  lines.push('');
  lines.push('Recent bad');
  for (const row of summary.recentBad) lines.push(`  ${row.timestamp ?? '-'} ${row.provider ?? '[unknown]'}/${row.modelId ?? '[unknown]'} route=${row.routeId ?? '[unknown]'} outcome=${row.outcome ?? '[unknown]'} tags=${row.tags.join(',') || '-'} reason=${row.reason ?? '-'}`);
  lines.push('');
  lines.push('Recent good');
  for (const row of summary.recentGood) lines.push(`  ${row.timestamp ?? '-'} ${row.provider ?? '[unknown]'}/${row.modelId ?? '[unknown]'} route=${row.routeId ?? '[unknown]'} outcome=${row.outcome ?? '[unknown]'} tags=${row.tags.join(',') || '-'} reason=${row.reason ?? '-'}`);
  return lines.join('\n');
}

function appendBreakdown(lines, title, rows) {
  lines.push(title);
  for (const row of rows) {
    lines.push(`  ${row.key} count=${row.count} good=${row.good} bad=${row.bad} positive=${fmt(row.positiveRate)}% failover=${fmt(row.failoverRate)}% latency=${fmt(row.avgLatencyMs, 0)}ms ttft=${fmt(row.avgTtftMs, 0)}ms cost=$${fmt(row.avgCostUsd, 4)}`);
  }
  lines.push('');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const sinceMs = options.since ? Date.parse(options.since) : null;
  if (options.since && !Number.isFinite(sinceMs)) throw new Error(`Invalid --since value: ${options.since}`);
  const eventsPath = path.resolve(options.file);
  const ratingsPath = path.resolve(options.ratingsFile);
  const events = await loadEvents(eventsPath, sinceMs, options.routeId);
  const legacyRatings = options.includeLegacyRatings ? await loadLegacyRatings(ratingsPath, sinceMs, options.routeId) : [];
  const feedbackRows = buildFeedbackRows(events, legacyRatings);
  const summary = summarize(feedbackRows, events, options.limit);
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(buildText(summary, eventsPath, options.includeLegacyRatings ? ratingsPath : '[disabled]'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
