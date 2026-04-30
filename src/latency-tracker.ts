import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { LatencyRecord } from "./types.ts";

const STATS_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.stats.json");
const LATENCY_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.latency.json");

/**
 * Tracks per-provider latency (time-to-first-token) for performance-based ranking.
 * Data persists in auto-router.stats.json alongside budget data.
 */
export class LatencyTracker {
  private records = new Map<string, LatencyRecord>();
  private loaded = false;

  /** Load latency records from the latency file. */
  load(): void {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(LATENCY_PATH, "utf-8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const [provider, rec] of Object.entries(data)) {
          if (isValidRecord(rec)) {
            this.records.set(provider, rec as LatencyRecord);
          }
        }
      }
    } catch {
      // file missing or corrupt — start fresh
    }
    this.loaded = true;
  }

  /** Record a latency sample (time-to-first-token in ms). */
  recordLatency(provider: string, ms: number): void {
    if (ms <= 0) return;
    const existing = this.records.get(provider);
    const now = Date.now();
    if (existing) {
      const MAX_SAMPLES = 100;
      // Rolling average: decay old samples so we adapt to changes.
      // Cap total count to MAX_SAMPLES to prevent unbounded accumulation.
      const count = Math.min(existing.count + 1, MAX_SAMPLES);
      const decayWeight = count < MAX_SAMPLES ? 1 : (MAX_SAMPLES - 1) / MAX_SAMPLES;
      this.records.set(provider, {
        count,
        totalMs: existing.totalMs * decayWeight + ms,
        lastMs: ms,
        updatedAt: now,
      });
    } else {
      this.records.set(provider, {
        count: 1,
        totalMs: ms,
        lastMs: ms,
        updatedAt: now,
      });
    }
  }

  /** Get average latency for a provider, or null if no data. */
  getAvgLatency(provider: string): number | null {
    const rec = this.records.get(provider);
    if (!rec || rec.count === 0) return null;
    return rec.totalMs / rec.count;
  }

  /** Get all latency records. */
  getAll(): ReadonlyMap<string, LatencyRecord> {
    return this.records;
  }

  /** Save latency records to a separate file (avoids race with budget-tracker saves). */
  save(): void {
    try {
      const data: Record<string, LatencyRecord> = {};
      for (const [provider, rec] of this.records) {
        data[provider] = rec;
      }
      fs.mkdirSync(path.dirname(LATENCY_PATH), { recursive: true });
      fs.writeFileSync(LATENCY_PATH, JSON.stringify(data, null, 2));
    } catch {
      // best-effort; don't crash if save fails
    }
  }

  /** Clear all latency data. */
  clear(): void {
    this.records.clear();
  }
}

export function isValidRecord(rec: unknown): boolean {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Record<string, unknown>;
  return (
    typeof r.count === "number" &&
    typeof r.totalMs === "number" &&
    r.count >= 0 &&
    r.totalMs >= 0
  );
}
