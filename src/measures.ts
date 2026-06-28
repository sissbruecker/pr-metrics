/**
 * Per-PR measures: pure derivations of a single scalar from one pull request's
 * fields.
 *
 * Pure functions — no database access, no network. Each function takes the
 * fields of a single PR and returns one derived value. This is deliberately
 * the *per-PR* half of the pipeline: aggregation across many PRs (medians,
 * means, grouping, thresholds) lives in `src/stats.ts`. New per-PR measures
 * (e.g. review-cycle count, PR size) belong here; anything that summarizes a
 * population of PRs belongs in `stats.ts`.
 *
 * Two measures live here today, both sharing the same `ready_for_review_at`
 * start point and the same weekend-exclusion logic:
 *   - time-to-merge (TTM): `ready_for_review_at` → `merged_at`.
 *   - time-to-first-review (TTFR): `ready_for_review_at` → `first_review_at`.
 *
 * Each computes the elapsed time in whole seconds, EXCLUDING weekends
 * (Saturdays and Sundays, in UTC).
 *
 * A PR that becomes ready on a Friday afternoon and merges first thing Monday
 * is credited only with the working time at each end, not the ~66h of wall
 * clock that spans the weekend. This keeps the metric reflecting elapsed
 * *working* time and removes the weekend-spanning inflation that otherwise
 * dominates some months.
 *
 * Weekend handling is deliberately simple: whole weekend *days* are removed in
 * UTC. It does not model working hours (nights still count) or public holidays
 * — both are reasonable future refinements. Because the start point feeding
 * this is the draft-aware `ready_for_review_at`, the weekend exclusion composes
 * with that start point unchanged.
 *
 * The metric is derived in memory at read time (see `src/stats.ts`) from the
 * stored `ready_for_review_at` + `merged_at`, so the definition can change
 * without re-syncing. Resolving that draft-aware start point from a PR's raw
 * timeline is a separate, sync-time concern and lives in `src/sync.ts`.
 */

/** Seconds in one full day. */
const SECONDS_PER_DAY = 86400;
/** Milliseconds in one full day. */
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

/** True when a UTC day-of-week index (0=Sun … 6=Sat) is Saturday or Sunday. */
function isWeekendDay(utcDay: number): boolean {
  return utcDay === 0 || utcDay === 6;
}

/**
 * Whole seconds in the half-open interval `[startISO, endISO)` that fall on a
 * weekday (Mon–Fri, UTC). Weekend seconds are excluded; partial weekday
 * segments at the interval ends are counted. Equivalent to wall-clock seconds
 * minus any seconds landing on a Saturday or Sunday.
 *
 * Returns 0 for an empty or inverted interval (`end <= start`) and for an
 * unparseable timestamp — `measureTtmSeconds` layers the merged/unmerged and
 * NaN→null policy on top.
 *
 * Walks the interval one UTC calendar day at a time; TTM windows are at most
 * days-to-weeks, so this is a handful of iterations and written for obvious
 * correctness rather than cleverness.
 */
export function weekendExcludedSeconds(
  startISO: string,
  endISO: string,
): number {
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  if (endMs <= startMs) return 0;

  let businessMs = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const dayStart = Math.floor(cursor / MS_PER_DAY) * MS_PER_DAY;
    const nextDay = dayStart + MS_PER_DAY;
    const segEnd = Math.min(nextDay, endMs);
    if (!isWeekendDay(new Date(dayStart).getUTCDay())) {
      businessMs += segEnd - cursor;
    }
    cursor = nextDay;
  }
  return Math.floor(businessMs / 1000);
}

/**
 * Compute whole-second TTM from `ready_for_review_at` to `mergedAt`, EXCLUDING
 * weekends (see module docs). Returns `null` when the PR is not merged or when
 * either timestamp is unparseable; otherwise a non-negative integer count of
 * weekday seconds.
 */
export function measureTtmSeconds(
  readyForReviewAt: string,
  mergedAt: string | null,
): number | null {
  if (mergedAt === null) {
    return null;
  }
  const startMs = Date.parse(readyForReviewAt);
  const mergeMs = Date.parse(mergedAt);
  if (Number.isNaN(startMs) || Number.isNaN(mergeMs)) {
    return null;
  }
  return weekendExcludedSeconds(readyForReviewAt, mergedAt);
}

/**
 * Compute whole-second time-to-first-review (TTFR) from `ready_for_review_at` to
 * `firstReviewAt`, EXCLUDING weekends (see module docs). Returns `null` when the
 * PR has no review yet (`firstReviewAt` is null) or either timestamp is
 * unparseable; otherwise a non-negative integer count of weekday seconds.
 *
 * A review submitted before the PR became ready (a review on a still-draft PR)
 * gives an inverted interval, which `weekendExcludedSeconds` reports as 0.
 */
export function measureTtfrSeconds(
  readyForReviewAt: string,
  firstReviewAt: string | null,
): number | null {
  if (firstReviewAt === null) {
    return null;
  }
  const startMs = Date.parse(readyForReviewAt);
  const reviewMs = Date.parse(firstReviewAt);
  if (Number.isNaN(startMs) || Number.isNaN(reviewMs)) {
    return null;
  }
  return weekendExcludedSeconds(readyForReviewAt, firstReviewAt);
}
