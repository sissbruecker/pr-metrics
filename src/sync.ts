/**
 * Sync engine.
 *
 * Fetches pull requests merged since the last sync for a single repository,
 * resolves the draft-aware `ready_for_review_at` start point, and upserts them
 * into the database. The time-to-merge duration itself is NOT computed or stored
 * here — it is derived in memory at read time from the stored timestamps (see
 * `src/stats.ts`), so the metric definition can change without re-syncing.
 *
 * Cursoring is on *merge time*: each run fetches PRs with `merged_at >= cursor`,
 * where the cursor is the repo's `backfill_start` on the first sync and its
 * `last_synced_at` thereafter. A PR opened long ago but merged after the cursor
 * is therefore included.
 *
 * Only merged PRs are stored. Upserts key on `(repo_id, number)` so a run is
 * idempotent — re-running produces no duplicates, and the inclusive `>=` cursor
 * means a boundary PR is harmlessly re-written.
 *
 * Cursor advancement is computed app-side from the maximum `merged_at` actually
 * seen during the run (immune to clock skew). It only advances on a fully
 * successful run that fetched at least one PR; a zero-PR run leaves it untouched.
 *
 * Failure semantics: rows already upserted before an error are kept (they are
 * correct and idempotent), the cursor is NOT advanced, and the run's `sync_runs`
 * row is finalized with `status = "error"` and the error message.
 *
 * Concurrency: a repo that already has a `running` `sync_runs` row is refused.
 */

import type { Database } from "bun:sqlite";
import type {
  GitHubClient,
  PullRequestNode,
  TimelineEventNode,
} from "./github.ts";
import type { RepoRow } from "./db.ts";

/** A `[start, end]` merge-date window for the windowed search. */
export interface DateWindow {
  /** Inclusive lower bound (ISO date or datetime). */
  start: string;
  /** Inclusive upper bound (ISO date or datetime). */
  end: string;
}

/** Options for {@link syncRepo} — all injectable for testing. */
export interface SyncOptions {
  /**
   * Wall-clock source for `now` (returns a `Date`). Defaults to `() => new Date()`.
   * Used to stamp `started_at`/`finished_at`/`synced_at` and to bound the last
   * date window at the present moment.
   */
  now?: () => Date;
  /**
   * Override the window generator. Given the cursor and the current time, return
   * the sequence of merge-date windows to page through. Defaults to
   * {@link monthlyWindows}.
   */
  windows?: (cursor: string, now: Date) => DateWindow[];
}

/** The outcome of a sync run. */
export interface SyncResult {
  /** Number of merged PR rows upserted during the run. */
  countFetched: number;
  /** Maximum `merged_at` (ISO text) seen during the run, or null if none. */
  maxMergedAt: string | null;
  /** Final status of the run. */
  status: "success" | "error";
  /** The cursor the run started from. */
  cursorFrom: string | null;
  /** The `sync_runs` row id for this run. */
  syncRunId: number;
}

/**
 * Generate one window per calendar month from `cursor` up to `now` (inclusive of
 * the present). Windows are contiguous and use whole-day boundaries on the
 * `YYYY-MM-DD` form GitHub's search accepts; the inclusive `merged:start..end`
 * range plus the inclusive `>=` cursor mean overlapping boundary days only cause
 * harmless re-upserts.
 *
 * Monthly granularity is a sensible default: it keeps each window well under
 * GitHub's 1000-result search cap for typical repos while keeping the number of
 * queries small. For an incremental sync the range is tiny (often a single
 * window) but the same path is used — one code path, no special-casing.
 */
export function monthlyWindows(cursor: string, now: Date): DateWindow[] {
  const startMs = Date.parse(cursor);
  if (Number.isNaN(startMs)) {
    throw new Error(`Invalid sync cursor (not a parseable date): ${cursor}`);
  }
  const start = new Date(startMs);
  // Anchor windows on the first of the cursor's month, in UTC.
  let windowStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
  );
  // Never cursor into the future; if cursor > now, produce no windows.
  if (windowStart.getTime() > now.getTime()) {
    return [];
  }

  const windows: DateWindow[] = [];
  const nowDay = isoDate(now);
  while (true) {
    const nextMonth = new Date(
      Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + 1, 1),
    );
    // The window ends the day before the next month begins...
    const lastDayOfMonth = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000);
    // ...but never past the present day.
    const end = lastDayOfMonth.getTime() > now.getTime() ? now : lastDayOfMonth;
    windows.push({ start: isoDate(windowStart), end: isoDate(end) });
    if (isoDate(end) === nowDay || end.getTime() >= now.getTime()) {
      break;
    }
    windowStart = nextMonth;
  }
  return windows;
}

/** Format a `Date` as a `YYYY-MM-DD` UTC date string. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// PR metadata extraction
//
// Turn a raw GitHub PR node into the derived fields the `pull_requests` table
// stores: the draft-aware `ready_for_review_at` start point, the draft/review
// flags, the first review timestamp, and the raw draft transitions (persisted
// verbatim so the TTM definition can change without re-syncing). This is the
// sync-time counterpart to the read-time TTM metric in `src/ttm.ts`.
//
// Determining `ready_for_review_at`:
// - Never a draft (no transition nodes) → `created_at`.
// - Opened as draft, marked ready once → that `ready_for_review` timestamp.
// - Toggled draft ↔ ready multiple times → the LAST ready-for-review
//   transition that occurs at/before the merge.
// - Merged while still a draft (the last transition before merge is a
//   convert-to-draft, or `isDraft` is true at merge) → no usable ready event,
//   fall back to `created_at`.
// - Draft history unavailable/missing (e.g. an unparseable transition
//   timestamp) → fall back to `created_at`.
// ---------------------------------------------------------------------------

/** GraphQL typename for a "marked ready for review" transition. */
const READY_FOR_REVIEW_TYPENAME = "ReadyForReviewEvent";
/** GraphQL typename for a "converted to draft" transition. */
const CONVERT_TO_DRAFT_TYPENAME = "ConvertToDraftEvent";

/** A normalized draft/ready transition kind. */
export type DraftEventType = "ready_for_review" | "convert_to_draft";

/**
 * A single normalized draft/ready transition. Persisted verbatim (as a JSON
 * array) in the `draft_events` column so the TTM definition can evolve without
 * re-syncing.
 */
export interface DraftEvent {
  /** Normalized transition kind. */
  type: DraftEventType;
  /** ISO 8601 timestamp of the transition. */
  at: string;
}

/**
 * The derived `pull_requests` fields extracted from a PR node. Field names line
 * up with the columns the upsert persists. `draft_events` is returned as a
 * parsed array — the persistence layer is responsible for JSON-stringifying it
 * — not pre-serialized here.
 */
export interface PrMetadata {
  /** Computed start point for the TTM measurement (ISO timestamp). */
  ready_for_review_at: string;
  /** `0`/`1` — whether the PR was ever in draft state. */
  was_ever_draft: 0 | 1;
  /** First review's `submittedAt`, or `null` when there are no reviews. */
  first_review_at: string | null;
  /** Raw normalized transitions, in chronological order. */
  draft_events: DraftEvent[];
}

/**
 * Normalize the raw timeline nodes into {@link DraftEvent}s, sorted into
 * chronological order. Input order is not trusted, so we sort by timestamp.
 * Unknown typenames are dropped (the query only selects the two relevant ones,
 * but this keeps the parser defensive).
 */
export function parseDraftEvents(nodes: TimelineEventNode[]): DraftEvent[] {
  const events: DraftEvent[] = [];
  for (const node of nodes) {
    const type = normalizeEventType(node.__typename);
    if (type === null) {
      continue;
    }
    events.push({ type, at: node.createdAt });
  }
  // Stable chronological sort — don't trust the order GitHub returned.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

/** Map a GraphQL typename to a normalized transition kind, or `null`. */
function normalizeEventType(typename: string): DraftEventType | null {
  switch (typename) {
    case READY_FOR_REVIEW_TYPENAME:
      return "ready_for_review";
    case CONVERT_TO_DRAFT_TYPENAME:
      return "convert_to_draft";
    default:
      return null;
  }
}

/**
 * Derive the `ready_for_review_at` start point from the (already chronological)
 * transitions, given the PR's `createdAt`, `mergedAt`, and draft-at-merge flag.
 *
 * Returns the resolved start point; falls back to `createdAt` whenever there is
 * no usable ready event.
 *
 * Boundary: a ready event whose timestamp equals `mergedAt` is considered to be
 * "at/before merge" and is eligible (inclusive upper bound).
 */
export function deriveReadyForReviewAt(
  events: DraftEvent[],
  createdAt: string,
  mergedAt: string | null,
  isDraftAtMerge: boolean,
): string {
  // Never a draft: no transitions at all → measure from creation.
  if (events.length === 0) {
    return createdAt;
  }

  // Consider only transitions at/before the merge. If the PR is not merged,
  // there is no merge boundary, so consider everything.
  const mergeMs = mergedAt === null ? null : Date.parse(mergedAt);
  const inWindow =
    mergeMs === null ? events : events.filter((e) => Date.parse(e.at) <= mergeMs);

  // If the PR is still a draft at merge, the merge happened while in draft
  // (e.g. an admin merge) — there is no usable ready event regardless of
  // history, so fall back to creation.
  if (isDraftAtMerge) {
    return createdAt;
  }

  // The last in-window transition determines the state going into the merge.
  const last = inWindow.length > 0 ? inWindow[inWindow.length - 1] : undefined;

  // Last transition is convert-to-draft → merged while in draft → fall back.
  if (last !== undefined && last.type === "convert_to_draft") {
    return createdAt;
  }

  // Otherwise use the LAST ready-for-review transition in the window.
  for (let i = inWindow.length - 1; i >= 0; i--) {
    const event = inWindow[i];
    if (event !== undefined && event.type === "ready_for_review") {
      return event.at;
    }
  }

  // No ready-for-review transition before merge (e.g. all transitions happened
  // after the merge boundary, or only convert-to-draft exists) → fall back.
  return createdAt;
}

/**
 * Extract the derived {@link PrMetadata} from a {@link PullRequestNode}. Only a
 * handful of fields are read (`createdAt`, `mergedAt`, `isDraft`, `reviews`,
 * `timelineItems`); the result's field names align with the `pull_requests`
 * columns and `draft_events` is returned unserialized.
 */
export function extractPrMetadata(pr: PullRequestNode): PrMetadata {
  const events = parseDraftEvents(pr.timelineItems.nodes);
  const wasEverDraft: 0 | 1 = events.length > 0 ? 1 : 0;

  const readyForReviewAt = deriveReadyForReviewAt(
    events,
    pr.createdAt,
    pr.mergedAt,
    pr.isDraft,
  );

  // first_review_at: the first review's submittedAt (the query selects only the
  // earliest review), null when there are no reviews.
  const firstReview = pr.reviews.nodes[0];
  const firstReviewAt = firstReview?.submittedAt ?? null;

  return {
    ready_for_review_at: readyForReviewAt,
    was_ever_draft: wasEverDraft,
    first_review_at: firstReviewAt,
    draft_events: events,
  };
}

/**
 * The `pull_requests` upsert. Keys on `(repo_id, number)` so re-running a sync
 * updates the existing row rather than inserting a duplicate.
 */
const UPSERT_SQL = `
INSERT INTO pull_requests (
  repo_id, number, title, body, author, url,
  created_at, merged_at, closed_at, updated_at,
  first_review_at, ready_for_review_at, was_ever_draft,
  base_branch, head_branch, additions, deletions, changed_files,
  commit_count, review_count, comment_count, milestone,
  labels, assignees, requested_reviewers, draft_events, synced_at
) VALUES (
  $repo_id, $number, $title, $body, $author, $url,
  $created_at, $merged_at, $closed_at, $updated_at,
  $first_review_at, $ready_for_review_at, $was_ever_draft,
  $base_branch, $head_branch, $additions, $deletions, $changed_files,
  $commit_count, $review_count, $comment_count, $milestone,
  $labels, $assignees, $requested_reviewers, $draft_events, $synced_at
)
ON CONFLICT(repo_id, number) DO UPDATE SET
  title = excluded.title,
  body = excluded.body,
  author = excluded.author,
  url = excluded.url,
  created_at = excluded.created_at,
  merged_at = excluded.merged_at,
  closed_at = excluded.closed_at,
  updated_at = excluded.updated_at,
  first_review_at = excluded.first_review_at,
  ready_for_review_at = excluded.ready_for_review_at,
  was_ever_draft = excluded.was_ever_draft,
  base_branch = excluded.base_branch,
  head_branch = excluded.head_branch,
  additions = excluded.additions,
  deletions = excluded.deletions,
  changed_files = excluded.changed_files,
  commit_count = excluded.commit_count,
  review_count = excluded.review_count,
  comment_count = excluded.comment_count,
  milestone = excluded.milestone,
  labels = excluded.labels,
  assignees = excluded.assignees,
  requested_reviewers = excluded.requested_reviewers,
  draft_events = excluded.draft_events,
  synced_at = excluded.synced_at
`;

/** Map a PR node + its extracted metadata into the bound upsert parameters. */
function toUpsertParams(
  repoId: number,
  node: PullRequestNode,
  syncedAt: string,
): Record<string, string | number | null> {
  const meta = extractPrMetadata(node);
  const labels = node.labels.nodes.map((l) => l.name);
  const assignees = node.assignees.nodes.map((a) => a.login);
  const requestedReviewers = node.reviewRequests.nodes
    .map((r) => r.requestedReviewer?.login ?? null)
    .filter((login): login is string => login !== null);

  return {
    $repo_id: repoId,
    $number: node.number,
    $title: node.title,
    $body: node.body,
    $author: node.author?.login ?? null,
    $url: node.url,
    $created_at: node.createdAt,
    $merged_at: node.mergedAt,
    $closed_at: node.closedAt,
    $updated_at: node.updatedAt,
    $first_review_at: meta.first_review_at,
    $ready_for_review_at: meta.ready_for_review_at,
    $was_ever_draft: meta.was_ever_draft,
    $base_branch: node.baseRefName,
    $head_branch: node.headRefName,
    $additions: node.additions,
    $deletions: node.deletions,
    $changed_files: node.changedFiles,
    $commit_count: node.commits.totalCount,
    $review_count: node.reviews.totalCount,
    $comment_count: node.comments.totalCount,
    $milestone: node.milestone?.title ?? null,
    $labels: JSON.stringify(labels),
    $assignees: JSON.stringify(assignees),
    $requested_reviewers: JSON.stringify(requestedReviewers),
    $draft_events: JSON.stringify(meta.draft_events),
    $synced_at: syncedAt,
  };
}

/**
 * Run a sync for a single repository.
 *
 * On a fully successful run the repo's `last_synced_at` is advanced (in the
 * `repos` table) to the maximum `merged_at` actually seen, but only when at
 * least one PR was fetched. On error, already-upserted rows are kept, the cursor
 * is left unchanged, the `sync_runs` row is finalized with `status = "error"`,
 * and the error is re-thrown so callers (the CLI) can surface it.
 *
 * @throws if the repo already has a `running` `sync_runs` row.
 * @throws (re-throws) on any error during paging/upserting, after recording it.
 */
export async function syncRepo(
  db: Database,
  client: GitHubClient,
  repo: RepoRow,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? (() => new Date());
  const generateWindows = options.windows ?? monthlyWindows;

  // 1. Refuse a concurrent sync for this repo.
  const running = db
    .query<{ id: number }, [number]>(
      `SELECT id FROM sync_runs WHERE repo_id = ? AND status = 'running' LIMIT 1`,
    )
    .get(repo.id);
  if (running) {
    throw new Error(
      `A sync is already running for repo ${repo.owner}/${repo.repo} ` +
        `(sync_runs id ${running.id}). Refusing to start another.`,
    );
  }

  // 2. Determine the cursor: backfill_start on first sync, else last_synced_at.
  const cursor = repo.last_synced_at ?? repo.backfill_start;

  // 3. Insert the sync_runs row in the running state.
  const startedAt = now().toISOString();
  const runInsert = db
    .query<{ id: number }, [number, string, string | null]>(
      `INSERT INTO sync_runs (repo_id, started_at, cursor_from, status)
       VALUES (?, ?, ?, 'running') RETURNING id`,
    )
    .get(repo.id, startedAt, cursor);
  const syncRunId = runInsert!.id;

  const upsert = db.query(UPSERT_SQL);
  let countFetched = 0;
  let maxMergedAt: string | null = null;

  try {
    const windows = generateWindows(cursor, now());
    for await (const page of client.paginateWindowed(
      repo.owner,
      repo.repo,
      repo.base_branch,
      windows,
    )) {
      // Each page's upserts run in their own transaction, so a mid-run throw on
      // a later page leaves earlier pages committed (the failure contract keeps
      // already-upserted rows).
      const upsertPage = db.transaction((nodes: PullRequestNode[]) => {
        let pageCount = 0;
        let pageMax: string | null = null;
        const syncedAt = now().toISOString();
        for (const node of nodes) {
          // Defensively skip anything not actually merged.
          if (!node.merged || node.mergedAt === null) {
            continue;
          }
          upsert.run(toUpsertParams(repo.id, node, syncedAt));
          pageCount++;
          if (pageMax === null || node.mergedAt > pageMax) {
            pageMax = node.mergedAt;
          }
        }
        return { pageCount, pageMax };
      });

      const { pageCount, pageMax } = upsertPage(page.nodes);
      countFetched += pageCount;
      if (pageMax !== null && (maxMergedAt === null || pageMax > maxMergedAt)) {
        maxMergedAt = pageMax;
      }
    }
  } catch (error) {
    // Keep already-upserted rows; do NOT advance the cursor. Record the failure.
    const message = error instanceof Error ? error.message : String(error);
    db.query(
      `UPDATE sync_runs SET finished_at = ?, count_fetched = ?, status = 'error', error = ?
       WHERE id = ?`,
    ).run(now().toISOString(), countFetched, message, syncRunId);
    throw error;
  }

  // 5. Success: finalize the run and advance the cursor (only if PRs were seen).
  db.query(
    `UPDATE sync_runs SET finished_at = ?, count_fetched = ?, status = 'success', error = NULL
     WHERE id = ?`,
  ).run(now().toISOString(), countFetched, syncRunId);

  if (countFetched > 0 && maxMergedAt !== null) {
    db.query(`UPDATE repos SET last_synced_at = ? WHERE id = ?`).run(maxMergedAt, repo.id);
  }

  return {
    countFetched,
    maxMergedAt,
    status: "success",
    cursorFrom: cursor,
    syncRunId,
  };
}
