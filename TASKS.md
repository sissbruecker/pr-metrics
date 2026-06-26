# PR Stats — Implementation Tasks

Derived from `SPEC.md`. Check off each task as it lands. Section references (§) point back to the spec.

---

## 1. Project setup & scaffolding

- [X] Initialize a Bun + TypeScript project (`bun init`), no runtime npm dependencies (§10).
- [X] Set up `tsconfig.json` and project layout (e.g. `src/` for code, `src/ui/` for static UI assets, `test/` for tests).
- [X] Add an entry point that dispatches CLI subcommands via `util.parseArgs` (§10).
- [X] Establish config/env loading: GitHub token from env/config, never hard-coded (§11.1); DB file path.
- [X] Add a `User-Agent` constant for all GitHub requests (mandatory, §11.1).

## 2. Data model (SQLite via `bun:sqlite`)

- [X] Create DB bootstrap that opens `bun:sqlite` and applies schema/migrations on startup (§5, §10).
- [X] Create `repos` table: id, name, owner, repo, url, backfill_start, last_synced_at, created_at; `UNIQUE(owner, repo)` (§5).
- [X] Create `pull_requests` table with all columns: identity, timestamps, `first_review_at`, `ready_for_review_at`, `ttm_seconds`, `ttm_is_approximate`, `was_ever_draft`, branches, size, activity, milestone, JSON columns (labels, assignees, requested_reviewers, draft_events), `synced_at`; `UNIQUE(repo_id, number)` (§4, §5).
- [X] Create `sync_runs` table: id, repo_id, started_at, finished_at, cursor_from, count_fetched, status, error (§2.8, §5).
- [X] Add indexes: `pull_requests(repo_id, merged_at)` and `pull_requests(merged_at)` (§5).
- [X] Store all timestamps as ISO 8601 UTC text; many-valued metadata and draft transitions as JSON text (§5).

## 3. GitHub GraphQL client

- [X] Implement a `fetch`-based POST to `https://api.github.com/graphql` with `Authorization: Bearer`, `User-Agent`, JSON `{ query, variables }` body (§11.1).
- [X] Check `json.errors` on every response (errors arrive as `200 OK`), surface them as failures (§11.1).
- [X] Build the list query: `search(type: ISSUE, first: 50, after: $cursor)` with `rateLimit { remaining resetAt cost }` and `pageInfo` (§11.2).
- [X] Build the search query string: `repo:<owner>/<name> is:pr is:merged merged:>=<cursor> sort:created-asc`; pass values as variables (§11.2, §11.3).
- [X] Select all per-PR fields inline: identity, timestamps, `isDraft`/`merged`, branches, size, milestone, commits.totalCount, reviews(first:1), comments.totalCount, labels, assignees, reviewRequests, and the filtered `timelineItems` (§11.3).
- [X] Implement pagination loop on `pageInfo.hasNextPage`, passing `endCursor` (§11.2).
- [X] Handle the 1000-result search cap: narrow with date ranges (`merged:<start>..<end>`) and page each window for large backfills (§11.2).

## 4. Rate-limit handling

- [X] Read `rateLimit { remaining resetAt }` per page; when near zero, `await Bun.sleep(resetAt - now)` and resume the same run (§2.6, §11.5).
- [X] Honor `403`/`429` with `Retry-After` header (secondary limits) by pausing and resuming (§11.5).
- [X] Fail the run only after repeated exhaustion (§2.6).

## 5. Time-to-merge computation

- [X] Parse `timelineItems.nodes` only (never `totalCount` — it ignores the filter) to derive draft/ready history (§11.4).
- [X] Compute `ready_for_review_at` per the §3.2 rules:
  - [X] Never a draft (empty nodes) → `created_at` (§3.2 row 1, §11.4).
  - [X] Marked ready once → the ready event timestamp (§3.2 row 2).
  - [X] Toggled multiple times → the **last** ready-for-review transition before merge (§3.2 row 3, §11.4).
  - [X] Merged while still draft (last transition is convert-to-draft, or `isDraft` at merge) → `created_at` (§3.2 row 4, §11.4).
  - [X] Draft history unavailable/missing → `created_at` **and** set `ttm_is_approximate = 1` (§3.2 row 5).
- [X] Derive `was_ever_draft` from presence of transition nodes (§11.4).
- [X] Compute and store `ttm_seconds = merged_at − ready_for_review_at` (§3.1, §3.3).
- [X] Store raw draft/ready transitions in `draft_events` so the definition can change without re-syncing (§3.3).
- [X] Capture `first_review_at` from `reviews(first:1)`, null when no reviews; unused by TTM (§2.3, §11.3).

## 6. Sync engine

- [ ] Determine cursor: `backfill_start` on first sync, `last_synced_at` afterwards; filter `merged_at >= cursor` (§2.1, §2.2).
- [ ] Store only merged PRs; ignore open and closed-unmerged (§2.1).
- [ ] Upsert by `(repo_id, number)` with `ON CONFLICT` — idempotent, no duplicates (§2.4).
- [ ] On successful run, advance `last_synced_at` to the **max `merged_at` actually seen**; leave unchanged if zero PRs fetched (§2.5).
- [ ] On partial failure: keep upserted rows, do **not** advance cursor, record `sync_runs.status = error` (§2.5).
- [ ] Write a `sync_runs` row at start (`status = running`) with `cursor_from`; finalize with finished_at, count_fetched, status, error (§2.8).
- [ ] Refuse a new sync for a repo that already has a `running` `sync_runs` row (§2.8).
- [ ] Set `synced_at` on each upserted PR row (§5).

## 7. Categorization (query-time, app code)

- [ ] Implement title-prefix → category rules, first match wins, hard-coded in app code (§6.1, §6.2).
- [ ] Implement default rule set: `fix:`→Fix, `feat:`/`feature:`→Feature, `refactor:`→Refactor, `docs:`→Docs, `chore:`→Chore, `test:`→Test (§6.3).
- [ ] No match → **Uncategorized** (§6.2, §6.4).

## 8. Statistics & aggregation (in-app)

- [ ] Implement the single stats query: `SELECT merged_at, ttm_seconds, ttm_is_approximate, title ... WHERE repo_id = ? AND merged_at >= ? ORDER BY merged_at` (§7.1).
- [ ] Compute the window start: first day of (current month − 11), ISO UTC text — trailing 12 months including current (§7.2).
- [ ] Bucket each row by month via `substr(merged_at, 1, 7)` and by derived category (§7.1).
- [ ] Always represent all 12 months; empty months get count 0 and blank median/mean (§7.2).
- [ ] Compute per `(month, category)` and per-month **"All"**: count, median TTM, mean TTM (§7.3).
- [ ] Include approximate-TTM PRs in stats; count how many in the window are approximate for the footnote (§7.4, §8.4).

## 9. Web server (`Bun.serve`)

- [ ] Implement `Bun.serve` with a small route switch: serve static UI + one JSON stats endpoint; read-only, never writes (§8, §10).
- [ ] JSON stats endpoint: takes a repo (and view params), returns the aggregated 12-month buckets (overall + by-category) and approximate count (§7, §8).
- [ ] Serve static UI assets including vendored Chart.js as a single static asset (§8, §10).

## 10. UI (query-only, client-side)

- [ ] Repo selector — pick one repo; window fixed to trailing 12 months (§8.1).
- [ ] View-mode toggle: **Overall** (default) / **By category** (§8.1).
- [ ] Overall table: 12 month-rows × `count`, `median`, `mean` (§8.2).
- [ ] Overall chart: median & mean as lines over months (count not drawn) (§8.2).
- [ ] By-category metric selector: median / mean / count, default median (§8.3).
- [ ] By-category table: months × categories for selected metric + an **"All"** column (§8.3).
- [ ] By-category chart: one line per category for the selected metric (§8.3).
- [ ] Always show **Uncategorized** as its own category, never hidden (§6.4, §8.3).
- [ ] Format durations human-readably (`2d 4h`, `6h 30m`) from stored seconds (§8.4).
- [ ] Footnote with count of approximate-TTM PRs in the window (§8.4).

## 11. CLI

- [ ] `add` repo — register owner/name, display name, `backfill_start` (§9).
- [ ] `remove` repo — delete repo and its PRs (§9).
- [ ] `list` repos — show tracked repos with last-sync time and stored PR count (§9).
- [ ] `sync` — run a manual sync for a repo; refuse if one is already running (§9, §2.8).
- [ ] `serve` — launch the query-only UI against the local DB (§9, §8).

## 12. Tests (`bun test`)

- [ ] TTM start-point logic across all §3.2 cases (never draft, ready once, multiple toggles, merged-as-draft, missing history).
- [ ] Timeline parsing: ignore `totalCount`, derive from `nodes` only (§11.4).
- [ ] Cursor advancement: max-`merged_at`-seen, no advance on zero rows, no advance on failure (§2.5).
- [ ] Idempotency: re-running a sync produces no duplicates (§2.4).
- [ ] Categorization rules incl. first-match-wins and Uncategorized fallback (§6).
- [ ] Aggregation: median/mean/count, empty-month filling, "All" totals, approximate count (§7).
- [ ] Duration formatting (§8.4).

## 13. Distribution

- [ ] Support `bun run`; optionally `bun build --compile` for a single executable (§10).
