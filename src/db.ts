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
 * - Durations such as `ttm_seconds` are precomputed integers.
 * - Boolean flags are stored as INTEGER `0`/`1`.
 */

import { Database } from "bun:sqlite";
import { computeTtmSeconds } from "./ttm.ts";

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
  /** Precomputed time-to-merge in seconds. */
  ttm_seconds: number | null;
  /** `0`/`1` — whether the TTM is an approximation. */
  ttm_is_approximate: number;
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
  ttm_seconds INTEGER,
  ttm_is_approximate INTEGER NOT NULL DEFAULT 0,
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
 * Current data-format version, tracked in SQLite's `PRAGMA user_version`. Bump
 * this whenever the *definition* of a stored derived value changes so that
 * `migrate` recomputes existing rows in place — no re-sync required, since the
 * raw inputs (timestamps, draft history) are persisted alongside the derived
 * columns.
 *
 * History:
 *   1 — `ttm_seconds` redefined to exclude weekends (was raw wall clock).
 */
const DATA_VERSION = 1;

/**
 * Bring an open database up to {@link DATA_VERSION}, recomputing derived columns
 * whose definition changed since the version stamped in the file. A fresh DB
 * (version 0, no rows) is simply stamped to the current version.
 *
 * Idempotent and cheap: each step is gated on the stored version, and the whole
 * thing is a no-op once the file is current.
 */
export function migrate(db: Database): void {
  const version =
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version ?? 0;
  if (version >= DATA_VERSION) return;

  // v1: recompute ttm_seconds under the weekend-excluding TTM definition from
  // the persisted ready_for_review_at + merged_at (see src/ttm.ts).
  if (version < 1) {
    recomputeTtm(db);
  }

  db.exec(`PRAGMA user_version = ${DATA_VERSION}`);
}

/**
 * Recompute `ttm_seconds` for every merged PR from its stored
 * `ready_for_review_at` and `merged_at`, applying the current TTM definition.
 * Rows missing a `ready_for_review_at` get a null TTM (defensive — merged PRs
 * always have one in practice). Runs in a single transaction.
 */
function recomputeTtm(db: Database): void {
  const rows = db
    .query<
      { id: number; ready_for_review_at: string | null; merged_at: string | null },
      []
    >(
      `SELECT id, ready_for_review_at, merged_at
         FROM pull_requests
        WHERE merged_at IS NOT NULL`,
    )
    .all();

  const update = db.query<unknown, [number | null, number]>(
    `UPDATE pull_requests SET ttm_seconds = ? WHERE id = ?`,
  );

  const apply = db.transaction(() => {
    for (const row of rows) {
      const ttm =
        row.ready_for_review_at === null
          ? null
          : computeTtmSeconds(row.ready_for_review_at, row.merged_at);
      update.run(ttm, row.id);
    }
  });
  apply();
}

/**
 * Open (creating if necessary) the SQLite database at `path`, enable foreign
 * keys, apply the schema, run any pending data migrations, and return the
 * ready-to-use `Database`.
 *
 * Pass `":memory:"` for an ephemeral in-memory database.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  migrate(db);
  return db;
}
