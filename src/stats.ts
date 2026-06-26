/**
 * Statistics & aggregation layer.
 *
 * The database does one cheap, filtered fetch of the columns we need; all
 * bucketing, categorizing, and math happens here in TypeScript. (Median is not
 * a SQLite primitive, and the category rules live in app code, so the
 * aggregation cannot be pushed into SQL.)
 *
 * The flow is:
 *   1. Compute the trailing-12-month window start from `now`.
 *   2. Run ONE parameterized query for the rows merged within that window.
 *   3. Bucket each row by month (`YYYY-MM`) and by derived category, then
 *      compute count / median / mean per `(month, category)` group and a
 *      per-month "All" total across categories.
 *
 * The aggregation is kept pure (it takes rows in, not a database) so it can be
 * tested without SQLite. The thin `fetchStatsRows` reader runs the query, and
 * `computeStats` ties window + fetch + aggregation together for an endpoint.
 *
 * Design decisions:
 * - Median uses the standard definition: sort the values, take the middle one
 *   for odd-length input, or the average of the two middle values for
 *   even-length input. No rounding is applied — values stay as exact numbers
 *   (seconds), and presentation/rounding is left to the UI.
 * - Mean is the arithmetic mean, also unrounded.
 * - `count` reflects every PR merged that month (in that category, or all),
 *   including PRs flagged as having an approximate TTM. Median/mean are
 *   computed over the non-null `ttm_seconds` values only; a null `ttm_seconds`
 *   still contributes to `count` but is excluded from the median/mean inputs.
 *   In practice every merged PR has a `ttm_seconds`, so this is defensive — but
 *   it keeps `count` honest as "PRs merged" regardless of TTM availability.
 * - Empty groups (a month with no PRs, or a category with no PRs that month)
 *   report `count: 0` and `median: null` / `mean: null` — the "blank" the UI
 *   renders. All 12 months are always present and ordered, and every category
 *   in `CATEGORIES` is always present per month, so tables/charts stay stable.
 * - Approximate-TTM PRs are INCLUDED in the stats. Separately, the total number
 *   of approximate PRs across the window is reported as `approximateCount` for
 *   a UI footnote.
 */

import type { Database } from "bun:sqlite";
import { categorize, CATEGORIES, type Category } from "./categorize.ts";
import { DEFAULT_TTM_THRESHOLD_DAYS } from "./config.ts";

/** Seconds in one day, for converting day-denominated thresholds. */
export const SECONDS_PER_DAY = 86400;

/** The subset of PR columns the aggregation needs. */
export interface StatsRow {
  /** ISO 8601 UTC text, e.g. `2026-06-15T09:00:00Z`. */
  merged_at: string;
  /** Precomputed time-to-merge in seconds; null only in defensive cases. */
  ttm_seconds: number | null;
  /** `0`/`1` — whether the TTM is an approximation. */
  ttm_is_approximate: number;
  /** Raw PR title, used to derive the category. */
  title: string;
}

/** count / median / mean for one bucket. Median/mean are null when count is 0. */
export interface BucketStats {
  /** PRs merged in this bucket (includes approximate-TTM PRs). */
  count: number;
  /** Median TTM in seconds over non-null `ttm_seconds`, or null when none. */
  median: number | null;
  /** Mean TTM in seconds over non-null `ttm_seconds`, or null when none. */
  mean: number | null;
}

/** Stats for a single month: the per-month "All" total plus per-category. */
export interface MonthStats {
  /** Month key, `YYYY-MM`, e.g. `2026-06`. */
  month: string;
  /** Stats across ALL categories for this month. */
  all: BucketStats;
  /**
   * Stats per category. Always contains every category in `CATEGORIES`
   * (in canonical order), with empty categories reported as count 0.
   */
  byCategory: Record<Category, BucketStats>;
}

/** The full aggregated result a JSON endpoint / UI can consume directly. */
export interface StatsResult {
  /** ISO UTC text for the first day of the trailing-12-month window. */
  windowStart: string;
  /** The 12 month keys (`YYYY-MM`) in chronological order. */
  months: string[];
  /** Canonical ordered category list (mirrors `CATEGORIES`). */
  categories: Category[];
  /** One entry per month, in `months` order. */
  monthly: MonthStats[];
  /** Total number of approximate-TTM PRs in the window (for a footnote). */
  approximateCount: number;
  /**
   * Number of PRs in the window dropped as outliers because their `ttm_seconds`
   * exceeded `ttmThresholdSeconds` (for a footnote). Excluded PRs count toward
   * neither `count` nor median/mean nor `approximateCount`.
   */
  excludedCount: number;
  /** The TTM outlier threshold actually applied, in seconds. */
  ttmThresholdSeconds: number;
}

/**
 * Median of a list of numbers. Returns null for an empty array (the "blank"
 * used for empty buckets). For even-length input, returns the average of the
 * two middle values. Does not mutate the input. No rounding is applied.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Arithmetic mean of a list of numbers. Returns null for an empty array. No
 * rounding is applied.
 */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Compute the window start: the first day (UTC midnight) of the month that is
 * 11 months before `now`'s month, as ISO 8601 UTC text. This yields a trailing
 * 12-month window that INCLUDES the current month.
 *
 * Example: now = 2026-06-26 → current month 2026-06; 11 months earlier is
 * 2025-07; window start = "2025-07-01T00:00:00Z".
 */
export function computeWindowStart(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const start = new Date(Date.UTC(year, month - 11, 1, 0, 0, 0, 0));
  const y = start.getUTCFullYear();
  const m = String(start.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01T00:00:00Z`;
}

/**
 * The ordered list of 12 month keys (`YYYY-MM`) in the trailing-12-month
 * window ending at `now`'s month (inclusive), oldest first.
 */
export function windowMonths(now: Date): string[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - i, 1));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    months.push(`${y}-${m}`);
  }
  return months;
}

/** Build an empty per-category map with every category at count 0. */
function emptyByCategory(): Record<Category, BucketStats> {
  const out = {} as Record<Category, BucketStats>;
  for (const c of CATEGORIES) {
    out[c] = { count: 0, median: null, mean: null };
  }
  return out;
}

/**
 * Pure aggregation. Buckets `rows` by month (`substr(merged_at, 1, 7)`) and by
 * derived category, then computes count / median / mean per `(month, category)`
 * and a per-month "All" total. Always emits all `months` in order and every
 * category in `CATEGORIES` per month (empty → count 0, null median/mean). Also
 * returns the total count of approximate-TTM rows.
 *
 * Rows whose `ttm_seconds` exceeds `thresholdSeconds` are treated as outliers
 * and dropped entirely — they contribute to neither `count` nor median/mean nor
 * `approximateCount`, but are tallied in `excludedCount`. Rows with a null
 * `ttm_seconds` have no TTM to exceed the threshold and are never excluded.
 * `thresholdSeconds` defaults to `Infinity` (no filtering).
 *
 * The "All" total is computed over ALL rows merged that month regardless of
 * category — it is NOT the sum of the per-category medians.
 *
 * Rows whose month falls outside `months` are ignored (defensive — the query
 * already filters by the window start).
 */
export function aggregate(
  rows: StatsRow[],
  months: string[],
  thresholdSeconds: number = Infinity,
): {
  monthly: MonthStats[];
  approximateCount: number;
  excludedCount: number;
} {
  const monthSet = new Set(months);

  // Per-month accumulators: TTM values for "All" and per category.
  interface Acc {
    allCount: number;
    allTtms: number[];
    catCount: Record<Category, number>;
    catTtms: Record<Category, number[]>;
  }
  const accByMonth = new Map<string, Acc>();
  const newAcc = (): Acc => {
    const catCount = {} as Record<Category, number>;
    const catTtms = {} as Record<Category, number[]>;
    for (const c of CATEGORIES) {
      catCount[c] = 0;
      catTtms[c] = [];
    }
    return { allCount: 0, allTtms: [], catCount, catTtms };
  };

  let approximateCount = 0;
  let excludedCount = 0;

  for (const row of rows) {
    const month = row.merged_at.slice(0, 7);
    if (!monthSet.has(month)) continue;

    // Drop outliers entirely: a too-large TTM contributes to nothing but the
    // excluded tally. A null TTM has nothing to compare and is never excluded.
    if (row.ttm_seconds !== null && row.ttm_seconds > thresholdSeconds) {
      excludedCount += 1;
      continue;
    }

    if (row.ttm_is_approximate === 1) approximateCount += 1;

    let acc = accByMonth.get(month);
    if (!acc) {
      acc = newAcc();
      accByMonth.set(month, acc);
    }

    const category = categorize(row.title);

    // count reflects PRs merged (including approximate / null-ttm rows).
    acc.allCount += 1;
    acc.catCount[category] += 1;

    // median/mean inputs exclude null ttm_seconds.
    if (row.ttm_seconds !== null) {
      acc.allTtms.push(row.ttm_seconds);
      acc.catTtms[category].push(row.ttm_seconds);
    }
  }

  const monthly: MonthStats[] = months.map((month) => {
    const acc = accByMonth.get(month);
    if (!acc) {
      return { month, all: { count: 0, median: null, mean: null }, byCategory: emptyByCategory() };
    }
    const byCategory = {} as Record<Category, BucketStats>;
    for (const c of CATEGORIES) {
      const ttms = acc.catTtms[c];
      byCategory[c] = {
        count: acc.catCount[c],
        median: median(ttms),
        mean: mean(ttms),
      };
    }
    return {
      month,
      all: {
        count: acc.allCount,
        median: median(acc.allTtms),
        mean: mean(acc.allTtms),
      },
      byCategory,
    };
  });

  return { monthly, approximateCount, excludedCount };
}

/**
 * Run EXACTLY the single stats query, parameterized, and return the rows.
 * Kept separate from `aggregate` so the aggregation can be tested without a DB.
 */
export function fetchStatsRows(
  db: Database,
  repoId: number,
  windowStart: string,
): StatsRow[] {
  const stmt = db.query<StatsRow, [number, string]>(
    `SELECT merged_at, ttm_seconds, ttm_is_approximate, title
       FROM pull_requests
      WHERE repo_id = ?
        AND merged_at >= ?
      ORDER BY merged_at`,
  );
  return stmt.all(repoId, windowStart);
}

/**
 * Top-level entry point: compute the window, fetch the rows, and aggregate.
 * `now` is injected for deterministic windows in tests; defaults to the current
 * time. `thresholdSeconds` is the TTM outlier cap (PRs above it are excluded);
 * it defaults to the 7-day default and is overridden per request by the server.
 */
export function computeStats(
  db: Database,
  repoId: number,
  now: Date = new Date(),
  thresholdSeconds: number = DEFAULT_TTM_THRESHOLD_DAYS * SECONDS_PER_DAY,
): StatsResult {
  const windowStart = computeWindowStart(now);
  const months = windowMonths(now);
  const rows = fetchStatsRows(db, repoId, windowStart);
  const { monthly, approximateCount, excludedCount } = aggregate(rows, months, thresholdSeconds);
  return {
    windowStart,
    months,
    categories: [...CATEGORIES],
    monthly,
    approximateCount,
    excludedCount,
    ttmThresholdSeconds: thresholdSeconds,
  };
}
