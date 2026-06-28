/**
 * Time-to-merge (TTM) metric.
 *
 * Pure functions — no database access, no network. Given a pull request's
 * `ready_for_review_at` start point and `merged_at`, compute the elapsed
 * time-to-merge in whole seconds, EXCLUDING weekends (Saturdays and Sundays,
 * in UTC).
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
 * unparseable timestamp — `computeTtmSeconds` layers the merged/unmerged and
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
export function computeTtmSeconds(
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
