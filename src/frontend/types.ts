/**
 * Shapes of the generated JSON data files.
 *
 * These types are the contract between the `generate` command (the producer,
 * which extracts them from the database) and the frontend (the consumer, which
 * fetches them and computes everything else locally). `src/generate.ts` imports
 * them type-only, so there is no runtime coupling.
 */

/** The subset of PR columns the stats pipeline needs — one entry per merged PR. */
export interface StatsRow {
  /** ISO 8601 UTC text, e.g. `2026-06-15T09:00:00Z`. */
  merged_at: string;
  /**
   * TTM measurement start point (ISO 8601 UTC text). The time-to-merge is
   * derived in memory from this and `merged_at`; null only in defensive cases
   * (a merged PR always has one in practice), which yields a null TTM.
   */
  ready_for_review_at: string | null;
  /**
   * ISO 8601 UTC text of the first review's submission, or null when the PR has
   * no review. The time-to-first-review is derived in memory from this and
   * `ready_for_review_at`; null (no review, or no start point) yields a null TTFR.
   */
  first_review_at: string | null;
  /**
   * ISO 8601 UTC text of the first approval's submission, or null when the PR has
   * no approval. The time-to-approval is derived in memory from this and
   * `ready_for_review_at`; null (no approval, or no start point) yields a null TTA.
   */
  first_approval_at: string | null;
  /** Raw PR title, used to derive the category and the exclusion filter. */
  title: string;
}

/** One tracked repository, as listed in `data/repos.json`. */
export interface RepoInfo {
  /** `owner/repo`, the stable key the UI selects by. */
  slug: string;
  /** Display name. */
  name: string;
  owner: string;
  repo: string;
  /** Number of merged PRs in this repo's data file. */
  prCount: number;
  /** ISO timestamp of the last successful sync, or null if never synced. */
  lastSyncedAt: string | null;
}

/** `data/repos.json`: the repo index plus the generation timestamp. */
export interface ReposFile {
  /** ISO timestamp of when the site was generated. */
  generatedAt: string;
  repos: RepoInfo[];
}

/** `data/<owner>-<repo>.json`: one repo's merged PRs. */
export interface RepoDataFile {
  repo: RepoInfo;
  pullRequests: StatsRow[];
}

/**
 * The name of a repo's data file under `data/`, derived from its slug
 * (`owner/repo` → `owner-repo.json`). Shared by the generator and the UI so
 * they always agree.
 */
export function repoDataFileName(slug: string): string {
  return `${slug.replace("/", "-")}.json`;
}
