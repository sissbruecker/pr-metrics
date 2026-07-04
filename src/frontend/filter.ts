/**
 * Pull request exclusion filter.
 *
 * Pure functions — no database access, no network. After PRs are queried from
 * the DB, this pass drops the ones that should not count toward the stats. Like
 * categorization, the rules live entirely in code, so changing them re-filters
 * all existing PRs with no re-sync.
 *
 * The only rule for now is version bumps: automated dependency-update PRs
 * (Dependabot/Renovate-style) are noise — they don't reflect real review or
 * merge effort and skew both the counts and the time-to-merge medians. New
 * exclusion rules can be added in `isExcluded` without touching the stats code.
 *
 * Matching mirrors `categorize.ts`: titles are trimmed first and matching is
 * case-insensitive (real-world titles vary between `Bump` and `bump`).
 */

/**
 * Matches version-bump titles, including the scoped Dependabot form:
 *   - `chore: bump …`
 *   - `chore(deps): bump …`
 *   - `chore(deps-dev): bump …`
 * It deliberately does NOT match `feat: bump …` (a real feature) or
 * `Revert "chore: Bump …"` (real work) — both occur in practice.
 */
const VERSION_BUMP = /^chore(\([^)]*\))?:\s*bump\b/i;

/** Whether a PR title is an automated version bump. */
export function isVersionBump(title: string): boolean {
  return VERSION_BUMP.test(title.trim());
}

/**
 * Whether a PR should be excluded from the stats. A PR is excluded if any
 * exclusion rule matches; for now the only rule is version bumps. Add more
 * rules here as they're needed.
 */
export function isExcluded(title: string): boolean {
  return isVersionBump(title);
}

/**
 * Apply the exclusion filter to queried rows, returning only the kept rows in
 * their original order. Generic over any row carrying a `title`.
 */
export function filterRows<T extends { title: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isExcluded(row.title));
}
