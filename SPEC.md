# PR Stats — Functional Spec

An internal tool for tracking the **time to merge** of GitHub pull requests across one or more repositories.

This document specifies *functionality*. Implementation details (API choice, auth, framework, schema DDL) are deliberately out of scope for now.

---

## 1. Overview

- A **CLI** manages repos and runs syncs: add/remove repos, trigger a manual sync, and launch the UI. Sync fetches merged-PR data from GitHub into a local SQLite database.
- The tool tracks **multiple repos**, each with its own metadata and sync state.
- A **query-only UI** presents time-to-merge statistics per month for **one repo at a time**, as a table and a chart, with the ability to break the data down by **category**. The UI never writes data.
- Sync is triggered **manually** (via CLI) for now.

---

## 2. Sync / fetching

### 2.1 What gets fetched

Each sync fetches PRs that were **merged** since the last sync — cursoring on **merge time, not creation time**. A PR opened long before the last sync but merged after it *is* included; a PR merged before the cursor is already stored and skipped.

- Cursor: `merged_at >= last_synced_at`.
- Only **merged** PRs are stored. Open and closed-unmerged PRs are ignored.
- PRs are fetched **ascending by `merged_at`**, so an interrupted run leaves a contiguous prefix and the cursor logic (§2.5) stays correct.

### 2.2 Sync state per repo

- `last_synced_at` — the cursor; advances only on a fully successful run (§2.5).
- `backfill_start` — the earliest merge date to fetch on the **first** sync (default: last 12–24 months, configurable per repo). Prevents pulling unbounded history on initial sync.

### 2.3 Per-PR detail

Computing the TTM start point (§3) requires each PR's **draft/ready transition history**. This is fetched **inline with the list query** (§11) — GraphQL returns each PR's timeline alongside its list fields in one paginated request, so there is no separate per-PR call.

- The timeline is filtered to **only draft/ready transitions** (§11.4).
- `first_review_at` is captured from the same query (the first review's timestamp). It is **not** needed for the TTM metric — it is stored for possible future stats — and is left null when the PR has no reviews.

### 2.4 Idempotency

- Upsert by `(repo_id, number)`.
- The cursor comparison is `>=`, so a PR merged at exactly the boundary is harmlessly re-fetched and upserted — **no separate overlap window is needed**.
- Re-running a sync is always safe — no duplicates, no double counting.

### 2.5 Cursor advancement & failure semantics

- After a run, `last_synced_at` is set to the **maximum `merged_at` actually seen** in that run — data-driven, immune to local/GitHub clock skew. If a run fetches zero PRs, the cursor is left unchanged.
- The cursor advances **only on full success**. If a run fails partway:
  - rows already upserted stay (they are correct and idempotent),
  - `last_synced_at` is **not** advanced, so the next run re-fetches from the old cursor — no gaps,
  - the `sync_runs` row is recorded with `status=error`.

### 2.6 Rate limits

- On hitting a GitHub rate limit, the run **pauses until the limit resets and then resumes** the same run (respecting the reset window). The run fails only after repeated exhaustion.

### 2.7 Post-merge mutability

- Because sync cursors on `merged_at` and never revisits stored PRs, changes made to a PR *after* it merged (e.g. a label added later) are **not** captured. Accepted for v1. An optional "refresh PRs merged in the last N days" pass is deferred (§9).

### 2.8 Trigger & concurrency

- Manual only for now (button / command).
- A second sync for a repo that already has a `sync_runs` row with `status=running` is **refused** until the first completes.
- The `sync_runs` log records each run (start, finish, cursor used, count fetched, status, error) for debugging and for showing "last sync" in the UI.

---

## 3. Time to merge

### 3.1 Definition

**Time to merge = `merged_at` − `ready_for_review_at`.**

The clock starts when the PR became ready for review (i.e. excluding time it sat as a draft), and stops when it was merged. Wall-clock time (not business hours).

### 3.2 Determining the start point (`ready_for_review_at`)

| Case | Rule |
|---|---|
| Opened directly as ready (never a draft) | Start = `created_at` |
| Opened as draft, marked ready once | Start = the `ready_for_review` event timestamp |
| Toggled draft ↔ ready multiple times | Start = the **last** ready-for-review transition before merge |
| Merged while still a draft (e.g. admin merge) | No ready event → fall back to `created_at` |
| Draft history unavailable / missing | Fall back to `created_at`, and **flag the PR** as approximate |

### 3.3 Notes

- Draft/ready transition timestamps are **stored raw** alongside the PR. This lets us later switch the definition (e.g. to "first transition" or "created → merged") without re-syncing.
- The computed `time_to_merge_seconds` is stored on the PR for fast querying, but is always derivable from the stored timestamps.

---

## 4. Metadata captured per PR

Stored raw so categorization and filtering can evolve without re-syncing.

- **Identity:** number, title, body, author, URL
- **Timestamps:** created, merged, closed, updated; first review; draft/ready transitions
- **Branches:** base branch, head branch
- **Classification inputs:** labels, milestone, assignees, requested reviewers
- **Size:** additions, deletions, changed_files, commit count
- **Activity:** review count, comment count
- **Flags:** was-ever-draft, approximate-TTM flag (§3.2)

---

## 5. Data model

SQLite. Conventions:

- **Timestamps** are stored as **ISO 8601 UTC text** (e.g. `2026-06-26T14:30:00Z`). Sortable as text, no timezone ambiguity. Month bucketing uses `substr(merged_at, 1, 7)` → `'2026-06'` at query time (cheap string slice, no per-row date conversion).
- **Many-valued metadata** (labels, reviewers, etc.) and **draft/ready transitions** are stored as **JSON text** columns on the PR row. Categorization needs only `title` today; `json_each`/`->>` remains available if a future rule needs labels.
- **Durations** (`ttm_seconds`) are precomputed integers, so aggregation never re-parses timestamps.

### `repos`

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | display name |
| owner | TEXT | GitHub owner |
| repo | TEXT | GitHub repo name |
| url | TEXT | |
| backfill_start | TEXT | ISO date; earliest merge to fetch on first sync |
| last_synced_at | TEXT | ISO; null until first sync |
| created_at | TEXT | |
| | | UNIQUE(owner, repo) |

### `pull_requests`

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| repo_id | INTEGER | FK → repos.id |
| number | INTEGER | UNIQUE(repo_id, number) |
| title, body, author, url | TEXT | |
| created_at, merged_at, closed_at, updated_at | TEXT | ISO 8601 UTC |
| first_review_at | TEXT | ISO; nullable |
| ready_for_review_at | TEXT | computed TTM start point (§3) |
| ttm_seconds | INTEGER | computed, stored for speed |
| ttm_is_approximate | INTEGER | 0/1 flag |
| was_ever_draft | INTEGER | 0/1 |
| base_branch, head_branch | TEXT | |
| additions, deletions, changed_files, commit_count | INTEGER | |
| review_count, comment_count | INTEGER | |
| milestone | TEXT | nullable |
| labels, assignees, requested_reviewers | TEXT | JSON arrays |
| draft_events | TEXT | JSON array of `{type, at}` transitions |
| synced_at | TEXT | ISO; when this row was last written |

### `sync_runs`

| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| repo_id | INTEGER | FK → repos.id |
| started_at, finished_at | TEXT | ISO |
| cursor_from | TEXT | the `merged_at` cursor used for this run |
| count_fetched | INTEGER | |
| status | TEXT | running / success / error |
| error | TEXT | message if failed |

### Indexes

- `pull_requests(repo_id, merged_at)` — scoped month queries.
- `pull_requests(merged_at)` — cross-repo aggregation.

Categories are **not** a column — they are derived at query time (§6).

---

## 6. Categorization

### 6.1 Principle

Store raw PR data; **derive categories at query time** via rules. The rules are **hard-coded in application code** — changing them is a code change, and re-categorizes everything instantly with no re-sync.

### 6.2 Rules

- A rule maps a **title prefix → category** (conventional-commit style).
- First matching rule wins.
- No match → **Uncategorized**.

### 6.3 Default rule set (editable)

| Title prefix | Category |
|---|---|
| `fix:` | Fix |
| `feat:` / `feature:` | Feature |
| `refactor:` | Refactor |
| `docs:` | Docs |
| `chore:` | Chore |
| `test:` | Test |
| *(none match)* | Uncategorized |

### 6.4 In the UI

- Data can be shown **combined** (all PRs) or **grouped by category** (a series/column per category).
- **Uncategorized** is shown as its own group when grouping — never hidden, so totals stay honest.

---

## 7. Statistics & aggregation

### 7.1 Where aggregation happens

The DB does a single cheap **filtered fetch**; the app does the bucketing, categorizing, and math. This is the natural split because (a) median is not a SQLite primitive, and (b) category rules are hard-coded in app code (§6).

The one query the UI runs:

```sql
SELECT merged_at, ttm_seconds, ttm_is_approximate, title
FROM pull_requests
WHERE repo_id = :repo
  AND merged_at >= :window_start      -- 1st day of (current month − 11), ISO UTC text
ORDER BY merged_at;
```

Per returned row the app derives the **month** (`substr(merged_at,1,7)`) and the **category** (title-prefix rule), then accumulates per bucket.

### 7.2 Window

- **Trailing 12 months including the current month.** Not configurable for now.
- All 12 months are always represented. A month with no merged PRs is shown with count 0 and blank median/mean, so the table rows and chart x-axis stay continuous.

### 7.3 Stats per bucket

For each `(month, category)` group, and for the per-month **"All"** total across categories:

- **count** — PRs merged that month
- **median** TTM — robust to the long right tail
- **mean** TTM — runs higher than median when a few PRs sit open for weeks

(The in-memory model makes adding p75/p90 later trivial.)

### 7.4 Approximate values

- PRs flagged `ttm_is_approximate` (§3.2) are **included** in the stats. The UI footnotes how many PRs in the window were approximate.

---

## 8. UI

Query-only. Read-only against the SQLite DB; launched via the CLI (§9).

### 8.1 Scope selection

- Pick **one repo**.
- Window is fixed to the trailing 12 months (§7.2).
- Toggle between two view modes: **Overall** (default) and **By category**.

### 8.2 Overall view (default)

- **Table:** 12 month-rows × columns `count`, `median`, `mean`.
- **Chart:** median & mean plotted as lines over the months. (PR count is read from the table, not drawn on the chart.)

### 8.3 By-category view

Only one metric fits legibly per category, so the view shows a single metric chosen by a **selector (median / mean / count), defaulting to median**.

- **Table:** months × categories for the selected metric, plus an **"All"** column.
- **Chart:** one line per category for the selected metric.
- **Uncategorized** is always shown as its own category — never hidden.

### 8.4 Display

- Durations formatted human-readably (e.g. `2d 4h`, `6h 30m`); stored as seconds.
- Footnote: count of approximate-TTM PRs in the window (§7.4).

---

## 9. CLI

The CLI is the only thing that writes data and is the entry point for the UI.

- **Add repo** — register a repo (owner/name, display name, `backfill_start`).
- **Remove repo** — delete a repo and its PRs.
- **List repos** — show tracked repos with last-sync time and stored PR count.
- **Sync** — run a manual sync for a repo (the logic in §2); refuses if one is already running for that repo.
- **Serve UI** — launch the query-only UI against the local DB.

---

## 10. Tech stack

**Runtime: Bun + TypeScript.** The tool is a local, single-user CLI that doubles as a query-only web server. The stack rests almost entirely on Bun built-ins, so runtime npm dependencies are effectively **zero**.

| Capability | Choice | Source |
|---|---|---|
| Runtime / language | Bun + TypeScript | — |
| CLI arg parsing | `util.parseArgs` (Node-compat) | built-in |
| SQLite | `bun:sqlite` — synchronous, prepared statements, `ON CONFLICT` upserts, transactions | built-in |
| GitHub API | `fetch` against GitHub **GraphQL** | built-in |
| Rate-limit pause/resume (§2.6) | `await Bun.sleep(resetMs)` in the sync loop | built-in |
| Web server | `Bun.serve` — static UI + one JSON stats endpoint | built-in |
| Aggregation (§7) | plain TypeScript (median/mean/bucketing) | — |
| Dates | ISO 8601 UTC strings + `substr`-style slicing; no date lib | — |
| Charts (§8) | Chart.js, vendored as a single static asset, drawn client-side | vendored asset |
| Tests | `bun test` | built-in |
| Distribution | `bun run`, or `bun build --compile` for a single executable | built-in |

### Notable decisions

- **GraphQL over REST** for GitHub — the draft/ready timeline (`READY_FOR_REVIEW_EVENT` / `CONVERT_TO_DRAFT_EVENT`) plus size/review fields are fetched alongside the PR list in one paginated query, collapsing the §2.3 per-PR detail into the list fetch — no second round trip, and easier on the rate limit.
- **No GitHub SDK (Octokit)** — plain `fetch` keeps dependencies at zero; the spec needs only a list/search query plus timeline fields.
- **Charts client-side** (Chart.js), not server-rendered SVG — simplest path to the §8.2–8.3 line charts; the server stays a thin JSON-over-SQLite layer. (uPlot is a smaller alternative if asset size matters.)
- **No web framework** — `Bun.serve` with a small route switch is enough for one read-only page and one query endpoint.

This resolves the "API choice, auth, framework" item below; exact schema DDL is the data model in §5.

---

## 11. Driving the GitHub API

GitHub **GraphQL v4** (`POST https://api.github.com/graphql`), plain `fetch`, no SDK (§10). The shapes below are verified working against `vaadin/flow-components#9607`.

### 11.1 Request mechanics

- **Auth:** `Authorization: Bearer <token>`. A classic token with `repo` scope (or fine-grained read access to the target repos) is sufficient. Read the token from config/env — never hard-code it.
- **`User-Agent` header is mandatory** — GitHub rejects requests without one.
- Body is `{ query, variables }` as JSON. Always pass values as GraphQL **variables**, never string-interpolated into the query.
- Errors come back as `200 OK` with a top-level `errors` array — check `json.errors` on every response, don't rely on HTTP status alone.

### 11.2 List query — finding merged PRs

Use `search(type: ISSUE)` with a query string, **not** `repository.pullRequests` — search lets us filter on merge state and sort by merge time, which the cursor logic (§2.5) depends on.

```graphql
query($q: String!, $cursor: String) {
  rateLimit { remaining resetAt cost }
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { <fields, see §11.3> } }
  }
}
```

- **Query string:** `repo:<owner>/<name> is:pr is:merged merged:>=<cursor> sort:created-asc`
  - `merged:>=<ISO date>` applies the §2.1 cursor (`backfill_start` on first sync, `last_synced_at` after). GitHub's search `merged:` filter accepts a date or datetime.
  - `sort:created-asc` — search cannot sort by `merged_at`, so we sort ascending by creation as the stable ordering. The actual cursor advancement still uses the **max `merged_at` seen** (§2.5), computed app-side from the returned rows, so this sort choice doesn't affect correctness — it only keeps interrupted runs from skipping rows.
- **Pagination:** loop on `pageInfo.hasNextPage`, passing `endCursor` as `$cursor`. Search caps results at **1000 per query**; for a backfill that exceeds this, narrow the window with date ranges (`merged:<start>..<end>`) and page each window.
- The draft/ready timeline and all size/review fields are fetched **inline per node** (§11.3) — no second per-PR round trip (§2.3, §10).

### 11.3 Fields per PR

All of §4 comes from one PullRequest selection:

```graphql
number title url body
author { login }
createdAt mergedAt closedAt updatedAt
isDraft merged
baseRefName headRefName
additions deletions changedFiles
milestone { title }
commits { totalCount }
reviews(first: 1) { totalCount nodes { submittedAt } }
comments { totalCount }
labels(first: 20) { nodes { name } }
assignees(first: 10) { nodes { login } }
reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
timelineItems(first: 100, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) {
  nodes {
    __typename
    ... on ReadyForReviewEvent { createdAt }
    ... on ConvertToDraftEvent { createdAt }
  }
}
```

- `first_review_at` is the first review's `submittedAt` (reviews come back in creation order, so `first: 1` is the earliest). It is unused by the TTM metric (§3) and stored only for possible future stats; null when the PR has no reviews. `totalCount` on the same connection gives `review_count`.

### 11.4 Draft/ready timeline — the key gotcha

`timelineItems` is filtered to the two transition events (§3.2). **`timelineItems.totalCount` ignores the `itemTypes` filter** — it returns the count of *all* timeline events (e.g. 22 for #9607, which had zero draft transitions). Therefore:

- Derive `was_ever_draft` and `ready_for_review_at` **only from the `nodes` array**, never from `totalCount`.
- Empty `nodes` → PR was never a draft → start = `created_at` (§3.2 row 1).
- One or more `ReadyForReviewEvent` nodes → start = the **latest** such `createdAt` before merge (§3.2 row 3). Sort the nodes by timestamp app-side.
- If a PR merged while still a draft (`CONVERT_TO_DRAFT_EVENT` is the last transition, or `isDraft` true at merge) → no usable ready event → fall back to `created_at` (§3.2 row 4).
- `first: 100` covers the transition history of any realistic PR; if a PR ever exceeds it, page the connection (rare — would only matter for pathological draft toggling).

### 11.5 Rate limits (§2.6)

- Every query selects `rateLimit { remaining resetAt cost }`. GraphQL bills by **query cost** (typically 1 per page here), not per HTTP request; `remaining` is out of 5000/hr.
- Before/after each page, if `remaining` is near zero, `await Bun.sleep(resetAt - now)` then resume the same run.
- GitHub may also return a `403`/`429` with a `Retry-After` header on secondary limits — honor it the same way (pause and resume).

---

## 12. Open / deferred

- Exact schema DDL — derived from the data model in §5 at implementation time.
- Multi-repo aggregation — UI is single-repo for now; the aggregate-into-one model is designed for but not built.
- Configurable time window — fixed to trailing 12 months for now (§7.2).
- Business-hours-aware TTM — deferred; current metric is wall-clock. Raw timestamps are retained so it can be added later.
- Alternative TTM definitions (first transition, created → merged) — supported by stored data, not exposed in UI yet.
- Tail percentiles (p75/p90) — easy to add to the in-memory aggregation (§7.3), not surfaced yet.
- Automated/scheduled sync — manual only for now.
- "Refresh PRs merged in the last N days" pass to pick up post-merge metadata edits (§2.7) — deferred.
