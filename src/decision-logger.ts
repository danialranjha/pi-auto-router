import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { DecisionLogEntry } from "./types.ts";

const DEFAULT_DECISIONS_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.decisions.jsonl");

/**
 * Append-only JSONL decision logger.
 *
 * Each routing decision is written as one JSON line, making the log:
 * - Append-friendly (no file rewrite)
 * - Greppable / pipeable through `jq -s .` for batch analysis
 * - Safe under concurrent access (moderate concurrency — each write is a tiny O_APPEND)
 * - Easy to truncate or rotate manually
 *
 * Default cap: keep the last 10,000 entries to bound disk usage (~2–5 MB).
 */
export class DecisionLogger {
  private entries: DecisionLogEntry[] = [];
  private loaded = false;
  private readonly maxEntries: number;
  private readonly filePath: string;

  constructor(maxEntries = 10_000, filePath?: string) {
    this.maxEntries = maxEntries;
    this.filePath = filePath ?? DEFAULT_DECISIONS_PATH;
  }

  /** Load all entries from the JSONL file on disk. */
  load(): void {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const parsed: DecisionLogEntry[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as DecisionLogEntry;
          if (isValidEntry(entry)) parsed.push(entry);
        } catch {
          // skip corrupt lines
        }
      }
      this.entries = parsed;
    } catch {
      // file missing or unreadable — start fresh
      this.entries = [];
    }
    this.loaded = true;
  }

  /** Append a single decision log entry. Writes to disk immediately. */
  log(entry: DecisionLogEntry): void {
    this.load();
    this.entries.push(entry);

    // Enforce cap (prune oldest)
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    this._appendToFile(entry);
  }

  /** Log up to N entries at once (avoids N separate fsyncs on bulk import). */
  logBatch(entries: DecisionLogEntry[]): void {
    if (entries.length === 0) return;
    this.load();
    this.entries.push(...entries);

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    this._writeAllToFile();
  }

  /** Query entries with an optional filter function. */
  query(filter?: (entry: DecisionLogEntry) => boolean): DecisionLogEntry[] {
    this.load();
    if (!filter) return [...this.entries];
    return this.entries.filter(filter);
  }

  /** Return the N most recent entries (newest first). */
  getRecent(n = 20): DecisionLogEntry[] {
    this.load();
    return this.entries.slice(-n).reverse();
  }

  /** Return summary statistics grouped by provider. */
  getProviderStats(): Record<string, { attempts: number; successes: number; failures: number; avgLatencyMs: number; lastUsed: number }> {
    this.load();
    const stats: Record<string, { attempts: number; successes: number; failures: number; totalLatencyMs: number; lastUsed: number }> = {};
    for (const e of this.entries) {
      const s = stats[e.provider] ?? { attempts: 0, successes: 0, failures: 0, totalLatencyMs: 0, lastUsed: 0 };
      s.attempts++;
      if (e.outcome === "success") {
        s.successes++;
        s.totalLatencyMs += e.latencyMs;
      } else {
        s.failures++;
      }
      s.lastUsed = Math.max(s.lastUsed, e.timestamp);
      stats[e.provider] = s;
    }
    const result: Record<string, { attempts: number; successes: number; failures: number; avgLatencyMs: number; lastUsed: number }> = {};
    for (const [provider, s] of Object.entries(stats)) {
      result[provider] = {
        ...s,
        avgLatencyMs: s.successes > 0 ? Math.round(s.totalLatencyMs / s.successes) : 0,
      };
    }
    return result;
  }

  /** Return summary statistics grouped by tier. */
  getTierStats(): Record<string, { count: number; successRate: number; avgConfidence: number }> {
    this.load();
    const stats: Record<string, { count: number; successes: number; totalConfidence: number }> = {};
    for (const e of this.entries) {
      const s = stats[e.tier] ?? { count: 0, successes: 0, totalConfidence: 0 };
      s.count++;
      if (e.outcome === "success") s.successes++;
      s.totalConfidence += e.confidence;
      stats[e.tier] = s;
    }
    const result: Record<string, { count: number; successRate: number; avgConfidence: number }> = {};
    for (const [tier, s] of Object.entries(stats)) {
      result[tier] = {
        count: s.count,
        successRate: s.count > 0 ? s.successes / s.count : 0,
        avgConfidence: s.count > 0 ? s.totalConfidence / s.count : 0,
      };
    }
    return result;
  }

  /** Total number of logged decisions. */
  get count(): number {
    this.load();
    return this.entries.length;
  }

  /** Clear all entries from memory and disk. */
  clear(): void {
    this.entries = [];
    this.loaded = true; // mark as loaded so subsequent load() doesn't re-read
    try {
      fs.writeFileSync(this.filePath, "");
    } catch {
      // best-effort
    }
  }

  /** Get the backing file path (for manual inspection / rotation). */
  get logFilePath(): string {
    return this.filePath;
  }

  // ── private helpers ──

  private _appendToFile(entry: DecisionLogEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
    } catch {
      // best-effort
    }
  }

  private _writeAllToFile(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const data = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      fs.writeFileSync(this.filePath, data);
    } catch {
      // best-effort
    }
  }
}

export function isValidEntry(e: unknown): e is DecisionLogEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.timestamp === "number" &&
    typeof o.routeId === "string" &&
    typeof o.tier === "string" &&
    typeof o.phase === "string" &&
    typeof o.provider === "string" &&
    typeof o.outcome === "string" &&
    ["success", "terminal_error", "exhausted"].includes(o.outcome as string)
  );
}
