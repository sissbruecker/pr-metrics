/**
 * Centralized configuration & environment loading.
 *
 * The GitHub token is read from the environment — never hard-coded.
 * The SQLite DB file path has a sensible default and is overridable via env.
 */

/** Default location of the SQLite database file, relative to the cwd. */
export const DEFAULT_DB_PATH = "pr-stats.sqlite";

/**
 * Default time-to-merge outlier threshold, in days. PRs whose TTM exceeds this
 * are excluded from the stats metric. The UI can override it per request; this
 * is the fallback applied when a request omits the threshold.
 */
export const DEFAULT_TTM_THRESHOLD_DAYS = 7;

export interface Config {
  /** GitHub API token (classic with `repo` scope, or fine-grained read). */
  githubToken: string | undefined;
  /** Path to the SQLite database file. */
  dbPath: string;
}

/**
 * Load configuration from the environment.
 *
 * - `GITHUB_TOKEN` (or `PR_STATS_GITHUB_TOKEN`) — the GitHub API token.
 * - `PR_STATS_DB` — overrides the SQLite DB file path (default `pr-stats.sqlite`).
 */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  return {
    githubToken: env.PR_STATS_GITHUB_TOKEN ?? env.GITHUB_TOKEN,
    dbPath: env.PR_STATS_DB ?? DEFAULT_DB_PATH,
  };
}

/**
 * Return the GitHub token, throwing a clear error if it is not set.
 * Commands that talk to GitHub (e.g. `sync`) should call this.
 */
export function requireGithubToken(config: Config): string {
  if (!config.githubToken) {
    throw new Error(
      "No GitHub token found. Set the GITHUB_TOKEN (or PR_STATS_GITHUB_TOKEN) environment variable. " +
        "A classic token with `repo` scope, or fine-grained read access to the target repos, is sufficient.",
    );
  }
  return config.githubToken;
}
