import { beforeEach, describe, expect, test } from "bun:test";
import {
  deriveReadyForReviewAt,
  extractPrMetadata,
  parseDraftEvents,
  syncRepo,
  type DraftEvent,
} from "../src/sync.ts";
import {
  GitHubClient,
  type PullRequestNode,
  type TimelineEventNode,
} from "../src/github.ts";
import { openDb } from "../src/db.ts";
import type { Database } from "bun:sqlite";
import type { RepoRow } from "../src/db.ts";

/** Build a well-formed merged PullRequestNode. */
function prNode(over: Partial<PullRequestNode> = {}): PullRequestNode {
  return {
    number: 1,
    title: "fix: thing",
    url: "https://example.com/pr/1",
    body: null,
    author: { login: "octocat" },
    createdAt: "2026-01-01T00:00:00Z",
    mergedAt: "2026-01-02T00:00:00Z",
    closedAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    isDraft: false,
    merged: true,
    baseRefName: "main",
    headRefName: "feature",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    milestone: null,
    commits: { totalCount: 1 },
    reviews: { totalCount: 0, nodes: [] },
    comments: { totalCount: 0 },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    reviewRequests: { nodes: [] },
    timelineItems: { nodes: [] },
    ...over,
  };
}

/** A GraphQL response document for the list query, with a healthy rate limit. */
function listDoc(
  nodes: PullRequestNode[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      rateLimit: { remaining: 5000, resetAt: "2030-01-01T00:00:00Z", cost: 1 },
      search: {
        pageInfo: { hasNextPage, endCursor },
        nodes,
      },
    },
  };
}

/** Build a Response-like object the client can consume. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A scripted fake fetch. Each call returns (and consumes) the next queued
 * response. A queued entry may be a value or a function that throws.
 */
function makeFakeFetch(responses: Array<unknown | (() => never)>): {
  fetch: typeof fetch;
  callCount: () => number;
} {
  let i = 0;
  const fetchImpl = (async () => {
    const entry = responses[i];
    i++;
    if (typeof entry === "function") {
      (entry as () => never)();
    }
    return jsonResponse(entry);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, callCount: () => i };
}

/** Insert a repo and return its RepoRow. */
function seedRepo(db: Database, over: Partial<RepoRow> = {}): RepoRow {
  const backfill_start = over.backfill_start ?? "2026-01-01";
  const last_synced_at = over.last_synced_at ?? null;
  const r = db
    .query<RepoRow, [string | null]>(
      `INSERT INTO repos (name, owner, repo, url, backfill_start, last_synced_at, created_at)
       VALUES ('Test', 'octo', 'repo', 'u', '${backfill_start}', ?, '2026-01-01T00:00:00Z')
       RETURNING *`,
    )
    .get(last_synced_at);
  return r!;
}

const NOW = () => new Date("2026-01-15T00:00:00Z");
// A single window covering the whole test range, so paging is deterministic.
const ONE_WINDOW = () => [{ start: "2026-01-01", end: "2026-01-15" }];

function prCount(db: Database, repoId: number): number {
  return db
    .query<{ c: number }, [number]>(`SELECT COUNT(*) AS c FROM pull_requests WHERE repo_id = ?`)
    .get(repoId)!.c;
}

function lastSyncedAt(db: Database, repoId: number): string | null {
  return db
    .query<{ last_synced_at: string | null }, [number]>(
      `SELECT last_synced_at FROM repos WHERE id = ?`,
    )
    .get(repoId)!.last_synced_at;
}

function lastSyncRun(db: Database, repoId: number) {
  return db
    .query<{ status: string; error: string | null; count_fetched: number }, [number]>(
      `SELECT status, error, count_fetched FROM sync_runs WHERE repo_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId)!;
}

describe("cursor advancement", () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  test("advances to max merged_at seen (NOT the last row, which is created-ordered)", async () => {
    const repo = seedRepo(db);
    // PRs are created-ascending in the query; merged_at varies and is NOT in
    // ascending order. The cursor must take the string-max of merged_at.
    const nodes = [
      prNode({ number: 1, mergedAt: "2026-01-05T00:00:00Z" }),
      prNode({ number: 2, mergedAt: "2026-01-10T00:00:00Z" }), // max
      prNode({ number: 3, mergedAt: "2026-01-03T00:00:00Z" }), // last row, NOT max
    ];
    const { fetch } = makeFakeFetch([listDoc(nodes)]);
    const client = new GitHubClient("t", { fetch });

    const result = await syncRepo(db, client, repo, { now: NOW, windows: ONE_WINDOW });
    expect(result.status).toBe("success");
    expect(result.countFetched).toBe(3);
    expect(result.maxMergedAt).toBe("2026-01-10T00:00:00Z");
    expect(lastSyncedAt(db, repo.id)).toBe("2026-01-10T00:00:00Z");
  });

  test("no advance on zero rows; records success", async () => {
    const repo = seedRepo(db, { last_synced_at: "2026-01-08T00:00:00Z" });
    const { fetch } = makeFakeFetch([listDoc([])]);
    const client = new GitHubClient("t", { fetch });

    const result = await syncRepo(db, client, repo, { now: NOW, windows: ONE_WINDOW });
    expect(result.status).toBe("success");
    expect(result.countFetched).toBe(0);
    // last_synced_at unchanged.
    expect(lastSyncedAt(db, repo.id)).toBe("2026-01-08T00:00:00Z");
    expect(lastSyncRun(db, repo.id).status).toBe("success");
  });

  test("no advance on failure; keeps earlier-page rows; records error", async () => {
    const repo = seedRepo(db, { last_synced_at: "2026-01-01T00:00:00Z" });
    // First page succeeds (hasNextPage), second page throws.
    const page1 = listDoc([prNode({ number: 1, mergedAt: "2026-01-05T00:00:00Z" })], true, "CUR1");
    const { fetch } = makeFakeFetch([
      page1,
      () => {
        throw new Error("network down");
      },
    ]);
    const client = new GitHubClient("t", { fetch });

    await expect(syncRepo(db, client, repo, { now: NOW, windows: ONE_WINDOW })).rejects.toThrow(
      "network down",
    );
    // Earlier-page row was kept.
    expect(prCount(db, repo.id)).toBe(1);
    // Cursor NOT advanced.
    expect(lastSyncedAt(db, repo.id)).toBe("2026-01-01T00:00:00Z");
    const run = lastSyncRun(db, repo.id);
    expect(run.status).toBe("error");
    expect(run.error).toContain("network down");
  });
});

describe("idempotency", () => {
  test("re-running a sync produces no duplicates and upserts values", async () => {
    const db = openDb(":memory:");
    const repo = seedRepo(db);
    const buildNodes = () => [
      prNode({ number: 1, title: "fix: a", mergedAt: "2026-01-05T00:00:00Z" }),
      prNode({ number: 2, title: "feat: b", mergedAt: "2026-01-06T00:00:00Z" }),
    ];

    const first = makeFakeFetch([listDoc(buildNodes())]);
    await syncRepo(db, new GitHubClient("t", { fetch: first.fetch }), repo, {
      now: NOW,
      windows: ONE_WINDOW,
    });
    expect(prCount(db, repo.id)).toBe(2);

    // Re-run with a fresh fetch generator. Re-read the repo so the cursor is current.
    const repo2 = db.query<RepoRow, [number]>(`SELECT * FROM repos WHERE id = ?`).get(repo.id)!;
    // Change a value to prove upsert (not insert).
    const second = makeFakeFetch([
      listDoc([
        prNode({ number: 1, title: "fix: a updated", mergedAt: "2026-01-05T00:00:00Z" }),
        prNode({ number: 2, title: "feat: b", mergedAt: "2026-01-06T00:00:00Z" }),
      ]),
    ]);
    await syncRepo(db, new GitHubClient("t", { fetch: second.fetch }), repo2, {
      now: NOW,
      windows: ONE_WINDOW,
    });

    // Still exactly 2 rows — no duplicates.
    expect(prCount(db, repo.id)).toBe(2);
    const title = db
      .query<{ title: string }, [number, number]>(
        `SELECT title FROM pull_requests WHERE repo_id = ? AND number = ?`,
      )
      .get(repo.id, 1)!.title;
    expect(title).toBe("fix: a updated");
    db.close();
  });
});

describe("concurrency guard", () => {
  test("refuses a sync when a running run exists for the repo", async () => {
    const db = openDb(":memory:");
    const repo = seedRepo(db);
    db.query(
      `INSERT INTO sync_runs (repo_id, started_at, status) VALUES (?, '2026-01-01T00:00:00Z', 'running')`,
    ).run(repo.id);
    const { fetch } = makeFakeFetch([listDoc([])]);
    const client = new GitHubClient("t", { fetch });
    await expect(syncRepo(db, client, repo, { now: NOW, windows: ONE_WINDOW })).rejects.toThrow(
      /already running/i,
    );
    db.close();
  });
});

// ---------------------------------------------------------------------------
// PR metadata extraction
// ---------------------------------------------------------------------------

/** Build a timeline node. */
function timelineNode(typename: string, createdAt: string): TimelineEventNode {
  return { __typename: typename, createdAt };
}

const READY = "ReadyForReviewEvent";
const DRAFT = "ConvertToDraftEvent";

describe("ready_for_review_at start-point logic (all five cases)", () => {
  test("never a draft → ready_for_review_at === createdAt", () => {
    const input = prNode({
      createdAt: "2026-03-01T10:00:00Z",
      mergedAt: "2026-03-02T10:00:00Z",
      timelineItems: { nodes: [] },
    });
    const result = extractPrMetadata(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T10:00:00Z");
    expect(result.was_ever_draft).toBe(0);
  });

  test("opened as draft, marked ready once → start = the ReadyForReviewEvent timestamp", () => {
    const input = prNode({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-05T00:00:00Z",
      timelineItems: { nodes: [timelineNode(READY, "2026-03-02T12:00:00Z")] },
    });
    const result = extractPrMetadata(input);
    expect(result.ready_for_review_at).toBe("2026-03-02T12:00:00Z");
    expect(result.was_ever_draft).toBe(1);
  });

  test("toggled multiple times → start = LAST ready transition before merge (sorted app-side, post-merge excluded)", () => {
    const merged = "2026-03-10T00:00:00Z";
    // Fed deliberately OUT OF ORDER to prove app-side chronological sorting.
    // Includes a ready event AFTER mergedAt that must be excluded.
    const nodes = [
      timelineNode(READY, "2026-03-08T00:00:00Z"), // last ready BEFORE merge → expected
      timelineNode(DRAFT, "2026-03-03T00:00:00Z"),
      timelineNode(READY, "2026-03-02T00:00:00Z"),
      timelineNode(READY, "2026-03-12T00:00:00Z"), // AFTER merge → must be excluded
      timelineNode(DRAFT, "2026-03-05T00:00:00Z"),
      timelineNode(READY, "2026-03-06T00:00:00Z"),
    ];
    const input = prNode({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: merged,
      timelineItems: { nodes },
    });
    const result = extractPrMetadata(input);
    expect(result.ready_for_review_at).toBe("2026-03-08T00:00:00Z");
    expect(result.was_ever_draft).toBe(1);
  });

  test("merged while still draft (a): isDraft true → fall back to createdAt", () => {
    const input = prNode({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-05T00:00:00Z",
      isDraft: true,
      // Even with a ready event, draft-at-merge forces the fallback.
      timelineItems: { nodes: [timelineNode(READY, "2026-03-02T00:00:00Z")] },
    });
    const result = extractPrMetadata(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T00:00:00Z");
    expect(result.was_ever_draft).toBe(1);
  });

  test("merged while still draft (b): last in-window transition is ConvertToDraftEvent → fall back to createdAt", () => {
    const input = prNode({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-10T00:00:00Z",
      isDraft: false,
      timelineItems: {
        nodes: [
          timelineNode(READY, "2026-03-02T00:00:00Z"),
          timelineNode(DRAFT, "2026-03-08T00:00:00Z"), // last before merge → in draft
        ],
      },
    });
    const result = extractPrMetadata(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T00:00:00Z");
    expect(result.was_ever_draft).toBe(1);
  });

  test("missing/unusable history: unparseable transition timestamp → fall back to createdAt", () => {
    const input = prNode({
      createdAt: "2026-03-01T00:00:00Z",
      mergedAt: "2026-03-05T00:00:00Z",
      timelineItems: { nodes: [timelineNode(READY, "not-a-timestamp")] },
    });
    const result = extractPrMetadata(input);
    expect(result.ready_for_review_at).toBe("2026-03-01T00:00:00Z");
    expect(result.was_ever_draft).toBe(1);
  });
});

describe("first_review_at extraction", () => {
  test("first_review_at comes from reviews.nodes[0].submittedAt", () => {
    const withReview = extractPrMetadata(
      prNode({ reviews: { totalCount: 1, nodes: [{ submittedAt: "2026-03-02T08:00:00Z" }] } }),
    );
    expect(withReview.first_review_at).toBe("2026-03-02T08:00:00Z");
  });

  test("first_review_at is null when there are no reviews", () => {
    const noReview = extractPrMetadata(prNode({ reviews: { totalCount: 0, nodes: [] } }));
    expect(noReview.first_review_at).toBeNull();
  });
});

describe("deriveReadyForReviewAt boundary & edge cases", () => {
  test("ready event exactly at mergedAt is eligible (inclusive upper bound)", () => {
    const events: DraftEvent[] = [{ type: "ready_for_review", at: "2026-03-05T00:00:00Z" }];
    const start = deriveReadyForReviewAt(events, "2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z", false);
    expect(start).toBe("2026-03-05T00:00:00Z");
  });

  test("empty events → createdAt", () => {
    expect(deriveReadyForReviewAt([], "2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z", false)).toBe(
      "2026-03-01T00:00:00Z",
    );
  });

  test("not merged (null mergedAt) → considers all events, last ready wins", () => {
    const events: DraftEvent[] = [
      { type: "ready_for_review", at: "2026-03-02T00:00:00Z" },
      { type: "convert_to_draft", at: "2026-03-03T00:00:00Z" },
      { type: "ready_for_review", at: "2026-03-04T00:00:00Z" },
    ];
    expect(deriveReadyForReviewAt(events, "2026-03-01T00:00:00Z", null, false)).toBe(
      "2026-03-04T00:00:00Z",
    );
  });
});

describe("parseDraftEvents (timeline parsing — nodes-only)", () => {
  test("empty nodes → no events (drives never-draft regardless of any totalCount)", () => {
    // The type does not even carry totalCount; behavior is driven purely by nodes.
    expect(parseDraftEvents([])).toEqual([]);
    const result = extractPrMetadata(
      prNode({ createdAt: "2026-01-01T00:00:00Z", timelineItems: { nodes: [] } }),
    );
    expect(result.was_ever_draft).toBe(0);
    expect(result.ready_for_review_at).toBe("2026-01-01T00:00:00Z");
  });

  test("normalizes __typename → type and sorts chronologically", () => {
    const events = parseDraftEvents([
      timelineNode(READY, "2026-03-05T00:00:00Z"),
      timelineNode(DRAFT, "2026-03-01T00:00:00Z"),
      timelineNode(READY, "2026-03-03T00:00:00Z"),
    ]);
    expect(events).toEqual([
      { type: "convert_to_draft", at: "2026-03-01T00:00:00Z" },
      { type: "ready_for_review", at: "2026-03-03T00:00:00Z" },
      { type: "ready_for_review", at: "2026-03-05T00:00:00Z" },
    ]);
  });

  test("drops unknown typenames", () => {
    const events = parseDraftEvents([
      timelineNode("SomeOtherEvent", "2026-03-02T00:00:00Z"),
      timelineNode(READY, "2026-03-01T00:00:00Z"),
      timelineNode("MergedEvent", "2026-03-03T00:00:00Z"),
    ]);
    expect(events).toEqual([{ type: "ready_for_review", at: "2026-03-01T00:00:00Z" }]);
  });
});
