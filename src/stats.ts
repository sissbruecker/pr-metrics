/**
 * Statistics & aggregation layer.
 *
 * The database does one cheap, filtered fetch of the columns we need; all
 * bucketing, categorizing, and math happens here in TypeScript. (Median is not
 * a SQLite primitive, and the category rules live in app code, so the
 * aggregation cannot be pushed into SQL.)
 *
 * Time-to-merge is computed HERE, in memory, from each row's stored
 * `ready_for_review_at` + `merged_at` (via `computeTtmSeconds` from `src/ttm.ts`)
 * rather than read from a precomputed column. The DB stores only the raw inputs,
 * so changing the TTM definition (or adding a new derived metric) takes effect on
 * the next read with no database recompute or re-sync.
 *
 * The flow is:
 *   1. Compute the trailing-12-month window start from `now`.
 *   2. Run ONE parameterized query for the rows merged within that window.
 *   3. Derive each row's TTM, then bucket by month (`YYYY-MM`), computing
 *      count / median / mean per month over the rows whose derived category is
 *      currently included (the UI's category filter; all categories by default).
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
 *   computed over the non-null derived TTM values only; a null TTM (no usable
 *   `ready_for_review_at`) still contributes to `count` but is excluded from the
 *   median/mean inputs. In practice every merged PR has a usable TTM, so this is
 *   defensive — but it keeps `count` honest as "PRs merged" regardless of TTM
 *   availability.
 * - Empty months (no included PRs that month) report `count: 0` and
 *   `median: null` / `mean: null` — the "blank" the UI renders. All 12 months
 *   are always present and ordered, so tables/charts stay stable. Selecting no
 *   categories yields all-empty months.
 * - Approximate-TTM PRs are INCLUDED in the stats. Separately, the total number
 *   of approximate PRs across the window is reported as `approximateCount` for
 *   a UI footnote.
 */

import type { Database } from "bun:sqlite";
import { categorize, CATEGORIES, type Category } from "./categorize.ts";
import { DEFAULT_TTM_THRESHOLD_DAYS } from "./config.ts";
import { filterRows } from "./filter.ts";
import { computeTtmSeconds } from "./ttm.ts";

/** Seconds in one day, for converting day-denominated thresholds. */
export const SECONDS_PER_DAY = 86400;

/** The subset of PR columns the aggregation needs. */
export interface StatsRow {
  /** ISO 8601 UTC text, e.g. `2026-06-15T09:00:00Z`. */
  merged_at: string;
  /**
   * TTM measurement start point (ISO 8601 UTC text). The time-to-merge is
   * derived in memory from this and `merged_at`; null only in defensive cases
   * (a merged PR always has one in practice), which yields a null TTM.
   */
  ready_for_review_at: string | null;
  /** `0`/`1` — whether the TTM is an approximation. */
  ttm_is_approximate: number;
  /** Raw PR title, used to derive the category. */
  title: string;
}

/** count / median / mean for one bucket. Median/mean are null when count is 0. */
export interface BucketStats {
  /** PRs merged in this bucket (includes approximate-TTM PRs). */
  count: number;
  /** Median TTM in seconds over non-null derived TTMs, or null when none. */
  median: number | null;
  /** Mean TTM in seconds over non-null derived TTMs, or null when none. */
  mean: number | null;
}

/** Stats for a single month, over the currently included categories. */
export interface MonthStats {
  /** Month key, `YYYY-MM`, e.g. `2026-06`. */
  month: string;
  /** Stats across all included categories for this month. */
  all: BucketStats;
}

/** The full aggregated result a JSON endpoint / UI can consume directly. */
export interface StatsResult {
  /** ISO UTC text for the first day of the trailing-12-month window. */
  windowStart: string;
  /** The 12 month keys (`YYYY-MM`) in chronological order. */
  months: string[];
  /**
   * Canonical ordered category list (mirrors `CATEGORIES`). The UI uses it to
   * build the category filter; it is the full set of selectable categories,
   * independent of which are currently included.
   */
  categories: Category[];
  /** One entry per month, in `months` order. */
  monthly: MonthStats[];
  /** Total number of approximate-TTM PRs in the window (for a footnote). */
  approximateCount: number;
  /**
   * Number of PRs in the window dropped as outliers because their derived TTM
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

/**
 * Pure aggregation. Buckets `rows` by month (`substr(merged_at, 1, 7)`) and
 * computes count / median / mean per month over the rows whose derived category
 * is included. Always emits all `months` in order (empty → count 0, null
 * median/mean). Also returns the total count of approximate-TTM rows.
 *
 * `includedCategories` is the category filter: when provided, a row whose
 * derived category is not in the set is dropped before any other accounting —
 * it contributes to neither `count`, median/mean, `approximateCount` nor
 * `excludedCount`. When `undefined` (the default) every category is included.
 * An empty set therefore yields all-empty months.
 *
 * The TTM is derived per row (from `ready_for_review_at` + `merged_at`); rows
 * whose derived TTM exceeds `thresholdSeconds` are treated as outliers and
 * dropped entirely — they contribute to neither `count` nor median/mean nor
 * `approximateCount`, but are tallied in `excludedCount`. Rows with a null TTM
 * have nothing to exceed the threshold and are never excluded. `thresholdSeconds`
 * defaults to `Infinity` (no filtering).
 *
 * Rows whose month falls outside `months` are ignored (defensive — the query
 * already filters by the window start).
 */
export function aggregate(
  rows: StatsRow[],
  months: string[],
  thresholdSeconds: number = Infinity,
  includedCategories?: Set<Category>,
): {
  monthly: MonthStats[];
  approximateCount: number;
  excludedCount: number;
} {
  const monthSet = new Set(months);

  // Per-month accumulators: count and the TTM values feeding median/mean.
  interface Acc {
    count: number;
    ttms: number[];
  }
  const accByMonth = new Map<string, Acc>();

  let approximateCount = 0;
  let excludedCount = 0;

  for (const row of rows) {
    const month = row.merged_at.slice(0, 7);
    if (!monthSet.has(month)) continue;

    // Apply the category filter first, so excluded-category rows count toward
    // nothing — not even the outlier (`excludedCount`) tally below.
    const category = categorize(row.title);
    if (includedCategories && !includedCategories.has(category)) continue;

    // Derive the TTM in memory from the stored start point + merge time. Null
    // when there is no usable start point (defensive — merged PRs always have
    // one in practice).
    const ttmSeconds =
      row.ready_for_review_at === null
        ? null
        : computeTtmSeconds(row.ready_for_review_at, row.merged_at);

    // Drop outliers entirely: a too-large TTM contributes to nothing but the
    // excluded tally. A null TTM has nothing to compare and is never excluded.
    if (ttmSeconds !== null && ttmSeconds > thresholdSeconds) {
      excludedCount += 1;
      continue;
    }

    if (row.ttm_is_approximate === 1) approximateCount += 1;

    let acc = accByMonth.get(month);
    if (!acc) {
      acc = { count: 0, ttms: [] };
      accByMonth.set(month, acc);
    }

    // count reflects PRs merged (including approximate / null-ttm rows);
    // median/mean inputs exclude null TTMs.
    acc.count += 1;
    if (ttmSeconds !== null) acc.ttms.push(ttmSeconds);
  }

  const monthly: MonthStats[] = months.map((month) => {
    const acc = accByMonth.get(month);
    if (!acc) {
      return { month, all: { count: 0, median: null, mean: null } };
    }
    return {
      month,
      all: { count: acc.count, median: median(acc.ttms), mean: mean(acc.ttms) },
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
    `SELECT merged_at, ready_for_review_at, ttm_is_approximate, title
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
 * `includedCategories` is the category filter (see `aggregate`); `undefined`
 * includes every category.
 */
export function computeStats(
  db: Database,
  repoId: number,
  now: Date = new Date(),
  thresholdSeconds: number = DEFAULT_TTM_THRESHOLD_DAYS * SECONDS_PER_DAY,
  includedCategories?: Set<Category>,
): StatsResult {
  const windowStart = computeWindowStart(now);
  const months = windowMonths(now);
  const rows = filterRows(fetchStatsRows(db, repoId, windowStart));
  const { monthly, approximateCount, excludedCount } = aggregate(
    rows,
    months,
    thresholdSeconds,
    includedCategories,
  );
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
