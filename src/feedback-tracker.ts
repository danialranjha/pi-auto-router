import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RATINGS_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "auto-router.ratings.json");

export type RatingValue = "good" | "bad";

export type Rating = {
  provider: string;
  modelId: string;
  routeId: string;
  rating: RatingValue;
  reason?: string;
  tier?: string;
  intent?: string;
  timestamp: number;
};

export type ProviderRatingStats = {
  good: number;
  bad: number;
  total: number;
  lastRatedAt: number;
};

/**
 * Tracks user ratings of routing decisions.
 * Persists to auto-router.ratings.json.
 */
export class FeedbackTracker {
  private ratings: Rating[] = [];
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(RATINGS_PATH, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this.ratings = data.filter(isValidRating);
      }
    } catch {
      // file missing or corrupt — start fresh
    }
    this.loaded = true;
  }

  /** Record a rating for the last routing decision. */
  record(rating: Rating): void {
    this.ratings.push(rating);
    // Keep only last 500 ratings to bound file size
    if (this.ratings.length > 500) {
      this.ratings = this.ratings.slice(-500);
    }
  }

  /** Get the last N ratings, most recent first. */
  getRecent(n = 10): Rating[] {
    return this.ratings.slice(-n).reverse();
  }

  /** Get aggregated stats per provider. */
  getProviderStats(): Record<string, ProviderRatingStats> {
    const stats: Record<string, ProviderRatingStats> = {};
    for (const r of this.ratings) {
      const s = stats[r.provider] ?? { good: 0, bad: 0, total: 0, lastRatedAt: 0 };
      s.total++;
      if (r.rating === "good") s.good++;
      else s.bad++;
      s.lastRatedAt = Math.max(s.lastRatedAt, r.timestamp);
      stats[r.provider] = s;
    }
    return stats;
  }

  /** Get the most recent rating (for displaying in explain). */
  getLast(): Rating | undefined {
    return this.ratings.length > 0 ? this.ratings[this.ratings.length - 1] : undefined;
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(RATINGS_PATH), { recursive: true });
      fs.writeFileSync(RATINGS_PATH, JSON.stringify(this.ratings, null, 2));
    } catch {
      // best-effort
    }
  }

  clear(): void {
    this.ratings = [];
  }
}

function isValidRating(r: unknown): boolean {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.provider === "string" &&
    typeof o.rating === "string" &&
    (o.rating === "good" || o.rating === "bad") &&
    typeof o.timestamp === "number"
  );
}
