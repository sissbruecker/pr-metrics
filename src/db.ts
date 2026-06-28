/**
 * Data model & SQLite persistence layer.
 *
 * Opens a `bun:sqlite` database and applies the schema idempotently on startup
 * (every statement uses `IF NOT EXISTS`, so opening an existing DB is a no-op).
 *
 * Conventions:
 * - All timestamps are stored as ISO 8601 UTC text (e.g. `2026-06-26T14:30:00Z`).
 * - Many-valued metadata (labels, assignees, requested reviewers) and the draft
 *   transition history are stored as JSON-text columns on the PR row.
 * - Only raw, sync-time facts are stored. Derived metrics such as time-to-merge
 *   are NOT persisted — they are computed in memory at aggregation time from the
 *   stored timestamps (see {@link computeStats} / `src/ttm.ts`), so the metric
 *   definition can change without re-syncing or recomputing the database.
 * - The `ready_for_review_at` start point IS persisted (the draft-resolution it
 *   depends on uses sync-time state not otherwise stored) — a sync-time fact,
 *   not a metric definition.
 * - Boolean flags are stored as INTEGER `0`/`1`.
 */

import { Database } from "bun:sqlite";

/** A tracked repository. */
export interface RepoRow {
  id: number;
  /** Display name. */
  name: string;
  /** GitHub owner (org or user). */
  owner: string;
  /** GitHub repository name. */
  repo: string;
  url: string;
  /** Base branch PRs must target to be synced (default `main`). */
  base_branch: string;
  /** ISO date — earliest merge to fetch on the first sync. */
  backfill_start: string;
  /** ISO timestamp; null until the first successful sync. */
  last_synced_at: string | null;
  created_at: string;
}

/**
 * A single pull request. Timestamps are ISO 8601 UTC text; `labels`,
 * `assignees`, `requested_reviewers`, and `draft_events` are JSON-text columns.
 */
export interface PullRequestRow {
  id: number;
  repo_id: number;
  number: number;
  title: string;
  body: string | null;
  author: string | null;
  url: string;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  /** ISO timestamp of the first review, if any. */
  first_review_at: string | null;
  /** Computed start point for the time-to-merge measurement. */
  ready_for_review_at: string | null;
  /** `0`/`1` — whether the PR was ever in draft state. */
  was_ever_draft: number;
  base_branch: string | null;
  head_branch: string | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  commit_count: number | null;
  review_count: number | null;
  comment_count: number | null;
  milestone: string | null;
  /** JSON array of label names. */
  labels: string;
  /** JSON array of assignee logins. */
  assignees: string;
  /** JSON array of requested reviewer logins. */
  requested_reviewers: string;
  /** JSON array of `{ type, at }` draft/ready transitions. */
  draft_events: string;
  /** ISO timestamp of when this row was last written. */
  synced_at: string;
}

/** A record of one sync attempt against a repository. */
export interface SyncRunRow {
  id: number;
  repo_id: number;
  started_at: string;
  finished_at: string | null;
  /** The `merged_at` cursor used for this run. */
  cursor_from: string | null;
  count_fetched: number;
  /** `running` | `success` | `error`. */
  status: string;
  /** Error message if the run failed. */
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  url TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  backfill_start TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(owner, repo)
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  updated_at TEXT NOT NULL,
  first_review_at TEXT,
  ready_for_review_at TEXT,
  was_ever_draft INTEGER NOT NULL DEFAULT 0,
  base_branch TEXT,
  head_branch TEXT,
  additions INTEGER,
  deletions INTEGER,
  changed_files INTEGER,
  commit_count INTEGER,
  review_count INTEGER,
  comment_count INTEGER,
  milestone TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  assignees TEXT NOT NULL DEFAULT '[]',
  requested_reviewers TEXT NOT NULL DEFAULT '[]',
  draft_events TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  cursor_from TEXT,
  count_fetched INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_pull_requests_repo_merged
  ON pull_requests(repo_id, merged_at);

CREATE INDEX IF NOT EXISTS idx_pull_requests_merged
  ON pull_requests(merged_at);
`;

/**
 * Apply the schema to an open database. Safe to call repeatedly — every
 * statement uses `IF NOT EXISTS`.
 */
export function initSchema(db: Database): void {
  db.exec(SCHEMA);
}

/**
 * Open (creating if necessary) the SQLite database at `path`, enable foreign
 * keys, apply the schema, and return the ready-to-use `Database`.
 *
 * There is no data migration step: the database stores only raw sync-time facts,
 * and every derived metric (time-to-merge) is computed in memory at read time
 * from those facts (see `src/stats.ts`). A change to a metric definition takes
 * effect on the next read with no recompute, so nothing in the file needs to be
 * rewritten when the definition evolves.
 *
 * Pass `":memory:"` for an ephemeral in-memory database.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  return db;
}
