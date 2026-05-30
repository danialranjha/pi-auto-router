#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_EVENTS_PATH = path.join(homedir(), '.pi', 'agent', 'extensions', 'auto-router.events.jsonl');

function parseArgs(argv) {
  const options = { file: DEFAULT_EVENTS_PATH, routeId: undefined, since: undefined, json: false, text: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') options.file = argv[++i];
    else if (arg === '--route') options.routeId = argv[++i];
    else if (arg === '--since') options.since = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--text') options.text = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/routing-stats.mjs [options]\n\nOptions:\n  --file <path>   Event JSONL path (default: ~/.pi/agent/extensions/auto-router.events.jsonl)\n  --route <id>    Filter by routeId\n  --since <iso>   Filter events at/after this ISO time\n  --json          Print JSON\n  --text          Print text\n  -h, --help      Show help`);
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

function summarize(events) {
  const decisions = events.filter((e) => e.type === 'routing.decision');
  const results = events.filter((e) => e.type === 'routing.result');
  const finals = events.filter((e) => e.type === 'routing.final');
  const feedback = events.filter((e) => e.type === 'routing.feedback');
  const requests = new Set(events.map((e) => e.requestId));

  const byRoute = group(finals, (e) => e.routeId, summarizeFinals);
  const byProvider = group(finals, (e) => e.data?.actualTarget?.provider ?? '[unknown]', summarizeFinals);
  const byPlannedActual = group(
    decisions.map((decision) => {
      const final = finals.find((f) => f.requestId === decision.requestId);
      return {
        planned: `${decision.data?.plannedTarget?.provider ?? '[unknown]'}/${decision.data?.plannedTarget?.modelId ?? '[unknown]'}`,
        actual: `${final?.data?.actualTarget?.provider ?? '[unknown]'}/${final?.data?.actualTarget?.modelId ?? '[unknown]'}`,
      };
    }),
    (e) => `${e.planned} -> ${e.actual}`,
    (rows) => ({ count: rows.length }),
  );

  return {
    totals: {
      requests: requests.size,
      decisions: decisions.length,
      results: results.length,
      finals: finals.length,
      feedback: feedback.length,
      successRate: percent(finals.filter((e) => e.data?.outcome === 'success').length, finals.length),
      failoverRate: percent(new Set(results.filter((e) => e.data?.index > 1).map((e) => e.requestId)).size, finals.length),
    },
    byRoute,
    byProvider,
    byPlannedActual,
  };
}

function summarizeFinals(items) {
  const success = items.filter((e) => e.data?.outcome === 'success').length;
  const exhausted = items.filter((e) => e.data?.outcome === 'exhausted').length;
  const terminal = items.filter((e) => e.data?.outcome === 'terminal_error').length;
  return {
    count: items.length,
    successRate: percent(success, items.length),
    exhausted,
    terminalError: terminal,
  };
}

function group(items, keyFn, summarizeFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()]
    .map(([key, rows]) => ({ key, ...summarizeFn(rows) }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

function percent(n, d) {
  return d > 0 ? (n / d) * 100 : 0;
}

function buildText(summary, file) {
  const lines = [];
  lines.push(`Routing stats from ${file}`);
  lines.push(`Requests: ${summary.totals.requests}`);
  lines.push(`Success rate: ${summary.totals.successRate.toFixed(1)}%`);
  lines.push(`Failover rate: ${summary.totals.failoverRate.toFixed(1)}%`);
  lines.push(`Feedback events: ${summary.totals.feedback}`);
  lines.push('');
  lines.push('By route');
  for (const row of summary.byRoute) lines.push(`  ${row.key} count=${row.count} success=${row.successRate.toFixed(1)}% exhausted=${row.exhausted} terminal=${row.terminalError}`);
  lines.push('');
  lines.push('By actual provider');
  for (const row of summary.byProvider) lines.push(`  ${row.key} count=${row.count} success=${row.successRate.toFixed(1)}% exhausted=${row.exhausted} terminal=${row.terminalError}`);
  lines.push('');
  lines.push('Planned -> actual');
  for (const row of summary.byPlannedActual.slice(0, 20)) lines.push(`  ${row.key} count=${row.count}`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const sinceMs = options.since ? Date.parse(options.since) : null;
  if (options.since && !Number.isFinite(sinceMs)) throw new Error(`Invalid --since value: ${options.since}`);
  const events = await loadEvents(path.resolve(options.file), sinceMs, options.routeId);
  const summary = summarize(events);
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(buildText(summary, path.resolve(options.file)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
