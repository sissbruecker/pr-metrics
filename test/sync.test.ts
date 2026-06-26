import { beforeEach, describe, expect, test } from "bun:test";
import { syncRepo } from "../src/sync.ts";
import { GitHubClient, type PullRequestNode } from "../src/github.ts";
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
