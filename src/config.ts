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
 * are excluded from the stats. Overridable per request from the UI and via the
 * `PR_STATS_TTM_THRESHOLD_DAYS` env var.
 */
export const DEFAULT_TTM_THRESHOLD_DAYS = 7;

export interface Config {
  /** GitHub API token (classic with `repo` scope, or fine-grained read). */
  githubToken: string | undefined;
  /** Path to the SQLite database file. */
  dbPath: string;
  /** Default TTM outlier threshold in days (the UI can override per request). */
  ttmThresholdDays: number;
}

/**
 * Load configuration from the environment.
 *
 * - `GITHUB_TOKEN` (or `PR_STATS_GITHUB_TOKEN`) — the GitHub API token.
 * - `PR_STATS_DB` — overrides the SQLite DB file path (default `pr-stats.sqlite`).
 * - `PR_STATS_TTM_THRESHOLD_DAYS` — overrides the default TTM outlier threshold
 *   in days (default `7`). Ignored unless it parses to a finite value `>= 1`.
 */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  return {
    githubToken: env.PR_STATS_GITHUB_TOKEN ?? env.GITHUB_TOKEN,
    dbPath: env.PR_STATS_DB ?? DEFAULT_DB_PATH,
    ttmThresholdDays: parseTtmThresholdDays(env.PR_STATS_TTM_THRESHOLD_DAYS),
  };
}

/**
 * Parse the TTM threshold env var into a number of days. Falls back to
 * `DEFAULT_TTM_THRESHOLD_DAYS` for anything that is not a finite value `>= 1`.
 */
function parseTtmThresholdDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TTM_THRESHOLD_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_TTM_THRESHOLD_DAYS;
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
