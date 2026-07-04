import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMergedPrRows, generateSite, listRepoInfos } from "../src/generate.ts";
import type { RepoDataFile, ReposFile } from "../src/frontend/types.ts";
import { openDb } from "../src/db.ts";

function seedRepo(db: ReturnType<typeof openDb>, owner = "o", repo = "r"): number {
  const r = db
    .query<{ id: number }, [string, string, string]>(
      `INSERT INTO repos (name, owner, repo, url, backfill_start, created_at)
       VALUES (?, ?, ?, 'u', '2020-01-01', '2020-01-01T00:00:00Z') RETURNING id`,
    )
    .get(`${owner}/${repo}`, owner, repo);
  return r!.id;
}

function insertPr(
  db: ReturnType<typeof openDb>,
  repoId: number,
  number: number,
  merged_at: string | null,
  title: string,
): void {
  db.query(
    `INSERT INTO pull_requests
      (repo_id, number, title, url, created_at, merged_at, updated_at,
       ready_for_review_at, first_review_at, first_approval_at, synced_at)
     VALUES (?, ?, ?, 'u', '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', null, null, '2026-01-01T00:00:00Z')`,
  ).run(repoId, number, title, merged_at);
}

describe("fetchMergedPrRows", () => {
  test("returns only merged PRs of the given repo, oldest first, with the five columns", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    const otherId = seedRepo(db, "o", "other");
    insertPr(db, repoId, 1, "2026-06-15T00:00:00Z", "fix: newer");
    insertPr(db, repoId, 2, "2026-06-10T00:00:00Z", "fix: older");
    insertPr(db, repoId, 3, null, "fix: unmerged");
    insertPr(db, otherId, 1, "2026-06-12T00:00:00Z", "fix: other repo");

    const rows = fetchMergedPrRows(db, repoId);
    expect(rows.map((r) => r.title)).toEqual(["fix: older", "fix: newer"]);
    expect(rows[0]).toEqual({
      merged_at: "2026-06-10T00:00:00Z",
      ready_for_review_at: "2026-01-01T00:00:00Z",
      first_review_at: null,
      first_approval_at: null,
      title: "fix: older",
    });
    db.close();
  });

  test("does not apply a window: old merges are included", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    insertPr(db, repoId, 1, "2020-01-01T00:00:00Z", "fix: ancient");
    expect(fetchMergedPrRows(db, repoId)).toHaveLength(1);
    db.close();
  });
});

describe("listRepoInfos", () => {
  test("lists repos ordered by owner/repo with merged-PR counts", () => {
    const db = openDb(":memory:");
    const bId = seedRepo(db, "o", "b");
    const aId = seedRepo(db, "o", "a");
    insertPr(db, bId, 1, "2026-06-10T00:00:00Z", "fix: x");
    insertPr(db, bId, 2, null, "fix: unmerged");

    const repos = listRepoInfos(db);
    expect(repos.map((r) => r.slug)).toEqual(["o/a", "o/b"]);
    expect(repos[1]).toEqual({
      slug: "o/b",
      name: "o/b",
      owner: "o",
      repo: "b",
      prCount: 1, // only the merged PR
      lastSyncedAt: null,
    });
    db.close();
  });
});

describe("generateSite (temp dir integration)", () => {
  const out = mkdtempSync(join(tmpdir(), "pr-stats-generate-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("writes parseable data files and a site whose HTML references resolve", async () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db, "acme", "widgets");
    insertPr(db, repoId, 1, "2026-06-10T00:00:00Z", "fix: a");
    insertPr(db, repoId, 2, "2026-06-12T00:00:00Z", "feat: b");

    const now = new Date("2026-07-04T00:00:00Z");
    const result = await generateSite({ db, outDir: out, now });
    expect(result).toEqual({ repoCount: 1, prCount: 2 });

    // Data files exist and parse into the agreed shapes.
    const index = (await Bun.file(join(out, "data", "repos.json")).json()) as ReposFile;
    expect(index.generatedAt).toBe("2026-07-04T00:00:00.000Z");
    expect(index.repos.map((r) => r.slug)).toEqual(["acme/widgets"]);
    expect(index.repos[0]!.prCount).toBe(2);

    const data = (await Bun.file(
      join(out, "data", "acme-widgets.json"),
    ).json()) as RepoDataFile;
    expect(data.repo.slug).toBe("acme/widgets");
    expect(data.pullRequests.map((p) => p.title)).toEqual(["fix: a", "feat: b"]);

    // The bundled HTML exists and every local script/stylesheet it references
    // was emitted alongside it.
    const htmlPath = join(out, "index.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = await Bun.file(htmlPath).text();
    const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(join(out, ref))).toBe(true);
    }
    db.close();
  });
});
