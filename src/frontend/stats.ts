/**
 * Statistics & aggregation layer.
 *
 * Pure functions — no database access, no network. The frontend loads a repo's
 * generated JSON rows once and all bucketing, categorizing, and math happens
 * here, in the browser. (This module also backs the `generate`-side tests,
 * which is why it never touches I/O.)
 *
 * Each metric is computed HERE, in memory, from a row's stored timestamps (via
 * the `measure*` functions in `./measures.ts`) rather than read from a
 * precomputed column: time-to-merge from `ready_for_review_at` + `merged_at`,
 * time-to-first-review from `ready_for_review_at` + `first_review_at`. The data
 * files carry only the raw inputs, so changing a metric's definition (or adding
 * a new one) takes effect on the next regeneration/reload with no database
 * recompute or re-sync.
 *
 * The flow is:
 *   1. Compute the trailing-12-month window start from `now`.
 *   2. Drop the excluded rows (version bumps — see `./filter.ts`).
 *   3. Derive each row's metrics, then bucket by month (`YYYY-MM`), computing a
 *      shared `count` plus per-metric median / mean per month over the rows
 *      whose derived category is currently included (the UI's category filter;
 *      all categories by default).
 *
 * Metric-ready shape: each month carries a shared `count` (the denominator) and
 * one named metric bucket per metric (`timeToMerge` and `timeToFirstReview`
 * today). Adding a metric later means deriving another per-row value,
 * accumulating it, and emitting one more named bucket alongside the others —
 * nothing else moves. The outlier cap is applied per metric: it governs only
 * whether a row's value feeds THAT metric's median/mean (and bumps THAT metric's
 * `excludedCount`); the row still counts toward the shared `count`.
 *
 * Design decisions:
 * - Median uses the standard definition: sort the values, take the middle one
 *   for odd-length input, or the average of the two middle values for
 *   even-length input. No rounding is applied — values stay as exact numbers
 *   (seconds), and presentation/rounding is left to the UI.
 * - Mean is the arithmetic mean, also unrounded.
 * - `count` reflects every PR merged that month (in the included categories),
 *   INCLUDING outliers above the threshold. Outliers and null-TTM rows still
 *   count; they just don't feed the metric's median/mean. So `count` is the
 *   stable denominator; the per-metric "feeding" total is
 *   `count - timeToMerge.excludedCount` (minus any null-TTM rows). This keeps
 *   `count` honest as "PRs merged" regardless of TTM availability or outliers.
 * - Empty months (no included PRs that month) report `count: 0` and a bucket of
 *   `median: null` / `mean: null` / `excludedCount: 0` — the "blank" the UI
 *   renders. All 12 months are always present and ordered, so tables/charts stay
 *   stable. Selecting no categories yields all-empty months.
 */

import { categorize, type Category } from "./categorize.ts";
import { filterRows } from "./filter.ts";
import { measureTtaSeconds, measureTtfrSeconds, measureTtmSeconds } from "./measures.ts";
import type { StatsRow } from "./types.ts";

export type { StatsRow };

/** Seconds in one day, for converting day-denominated thresholds. */
export const SECONDS_PER_DAY = 86400;

/**
 * Default outlier threshold, in days, applied to every metric's median/mean. A
 * PR whose derived measure (time-to-merge, time-to-first-review, …) exceeds this
 * is dropped from that metric's median/mean. The UI seeds its threshold input
 * with this and recomputes locally when the user overrides it.
 */
export const DEFAULT_OUTLIER_THRESHOLD_DAYS = 7;

/**
 * One metric's stats for a single month. Median/mean are over the in-cap,
 * non-null derived values only (null when none survive); `excludedCount` is the
 * number of this month's rows whose value exceeded the threshold and so was
 * dropped from median/mean (it still counts toward the month's shared `count`).
 */
export interface MetricBucket {
  /** Median in seconds over in-cap, non-null derived values, or null when none. */
  median: number | null;
  /** Mean in seconds over in-cap, non-null derived values, or null when none. */
  mean: number | null;
  /** Rows this month dropped from THIS metric's median/mean as outliers. */
  excludedCount: number;
}

/** Stats for a single month, over the currently included categories. */
export interface MonthStats {
  /** Month key, `YYYY-MM`, e.g. `2026-06`. */
  month: string;
  /**
   * Total PRs merged this month in the included categories, INCLUDING outliers
   * and null-TTM rows — the shared denominator across all metric buckets.
   */
  count: number;
  /** Time-to-merge metric bucket for this month. */
  timeToMerge: MetricBucket;
  /** Time-to-first-review metric bucket for this month. */
  timeToFirstReview: MetricBucket;
  /** Time-to-approval metric bucket for this month. */
  timeToApproval: MetricBucket;
}

/** The full aggregated result the UI renders directly. */
export interface StatsResult {
  /** ISO UTC text for the first day of the trailing-12-month window. */
  windowStart: string;
  /** The 12 month keys (`YYYY-MM`) in chronological order. */
  months: string[];
  /** One entry per month, in `months` order. */
  monthly: MonthStats[];
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
 * computes a shared `count` plus the per-metric `timeToMerge`,
 * `timeToFirstReview`, and `timeToApproval` buckets per month over the rows whose
 * derived category is included. Always emits all `months` in order (empty →
 * count 0, null median/mean, excludedCount 0).
 *
 * `includedCategories` is the category filter: when provided, a row whose
 * derived category is not in the set is dropped before any other accounting — it
 * contributes to nothing, not even the per-metric `excludedCount` tally. When
 * `undefined` (the default) every category is included. An empty set therefore
 * yields all-empty months.
 *
 * Once a row passes the window + category filters it is counted (`count += 1`)
 * unconditionally — outliers stay in the denominator. Each metric is then
 * derived per row (TTM from `ready_for_review_at` + `merged_at`, TTFR from
 * `ready_for_review_at` + `first_review_at`); the cap is applied PER METRIC: a
 * derived value above `thresholdSeconds` is dropped from THAT metric's
 * median/mean and tallied in THAT metric's `excludedCount`, but the row still
 * counts. A null measure has nothing to exceed the threshold (never an outlier)
 * and simply doesn't feed median/mean. `thresholdSeconds` defaults to `Infinity`
 * (no filtering).
 *
 * Rows whose month falls outside `months` are ignored — with the full merged
 * history in hand this is what applies the trailing-12-month window.
 */
export function aggregate(
  rows: StatsRow[],
  months: string[],
  thresholdSeconds: number = Infinity,
  includedCategories?: Set<Category>,
): {
  monthly: MonthStats[];
} {
  const monthSet = new Set(months);

  // Per-month accumulators: the shared count, plus the in-cap values feeding
  // each metric's median/mean and that metric's per-month outlier tally.
  interface Acc {
    count: number;
    ttms: number[];
    ttmExcluded: number;
    ttfrs: number[];
    ttfrExcluded: number;
    ttas: number[];
    ttaExcluded: number;
  }
  const accByMonth = new Map<string, Acc>();

  for (const row of rows) {
    const month = row.merged_at.slice(0, 7);
    if (!monthSet.has(month)) continue;

    // Apply the category filter first, so excluded-category rows count toward
    // nothing — not even the per-metric outlier tally below.
    const category = categorize(row.title);
    if (includedCategories && !includedCategories.has(category)) continue;

    let acc = accByMonth.get(month);
    if (!acc) {
      acc = {
        count: 0,
        ttms: [],
        ttmExcluded: 0,
        ttfrs: [],
        ttfrExcluded: 0,
        ttas: [],
        ttaExcluded: 0,
      };
      accByMonth.set(month, acc);
    }

    // A surviving row always counts (outliers stay in the denominator). The cap
    // only governs whether its value feeds a metric below.
    acc.count += 1;

    // Derive each metric in memory from the stored timestamps. Both share the
    // `ready_for_review_at` start point; a null start point (defensive — merged
    // PRs always have one in practice) yields a null measure for both.
    const ttmSeconds =
      row.ready_for_review_at === null
        ? null
        : measureTtmSeconds(row.ready_for_review_at, row.merged_at);
    const ttfrSeconds =
      row.ready_for_review_at === null
        ? null
        : measureTtfrSeconds(row.ready_for_review_at, row.first_review_at);
    const ttaSeconds =
      row.ready_for_review_at === null
        ? null
        : measureTtaSeconds(row.ready_for_review_at, row.first_approval_at);

    // Per-metric filtering: a too-large value is excluded from THAT metric's
    // median/mean (and tallied), but the row already counted above. A null
    // measure has nothing to compare and is never an outlier; it just doesn't
    // feed. The same `thresholdSeconds` cap governs every metric.
    if (ttmSeconds !== null && ttmSeconds > thresholdSeconds) {
      acc.ttmExcluded += 1;
    } else if (ttmSeconds !== null) {
      acc.ttms.push(ttmSeconds);
    }
    if (ttfrSeconds !== null && ttfrSeconds > thresholdSeconds) {
      acc.ttfrExcluded += 1;
    } else if (ttfrSeconds !== null) {
      acc.ttfrs.push(ttfrSeconds);
    }
    if (ttaSeconds !== null && ttaSeconds > thresholdSeconds) {
      acc.ttaExcluded += 1;
    } else if (ttaSeconds !== null) {
      acc.ttas.push(ttaSeconds);
    }
  }

  const monthly: MonthStats[] = months.map((month) => {
    const acc = accByMonth.get(month);
    if (!acc) {
      return {
        month,
        count: 0,
        timeToMerge: { median: null, mean: null, excludedCount: 0 },
        timeToFirstReview: { median: null, mean: null, excludedCount: 0 },
        timeToApproval: { median: null, mean: null, excludedCount: 0 },
      };
    }
    return {
      month,
      count: acc.count,
      timeToMerge: {
        median: median(acc.ttms),
        mean: mean(acc.ttms),
        excludedCount: acc.ttmExcluded,
      },
      timeToFirstReview: {
        median: median(acc.ttfrs),
        mean: mean(acc.ttfrs),
        excludedCount: acc.ttfrExcluded,
      },
      timeToApproval: {
        median: median(acc.ttas),
        mean: mean(acc.ttas),
        excludedCount: acc.ttaExcluded,
      },
    };
  });

  return { monthly };
}

/**
 * Top-level entry point: compute the window, apply the exclusion filter, and
 * aggregate the given rows. `rows` is a repo's full merged-PR history (the
 * generated data file); rows outside the trailing-12-month window are dropped
 * by the aggregation. `now` is injected for deterministic windows in tests;
 * defaults to the current time. `thresholdSeconds` is the shared outlier cap (a
 * PR above it drops from the metric's median/mean but still counts); it
 * defaults to the 7-day default. `includedCategories` is the category filter
 * (see `aggregate`); `undefined` includes every category.
 */
export function computeStats(
  rows: StatsRow[],
  now: Date = new Date(),
  thresholdSeconds: number = DEFAULT_OUTLIER_THRESHOLD_DAYS * SECONDS_PER_DAY,
  includedCategories?: Set<Category>,
): StatsResult {
  const windowStart = computeWindowStart(now);
  const months = windowMonths(now);
  const { monthly } = aggregate(
    filterRows(rows),
    months,
    thresholdSeconds,
    includedCategories,
  );
  return {
    windowStart,
    months,
    monthly,
  };
}
