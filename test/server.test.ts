import { describe, expect, test } from "bun:test";
import { createFetchHandler } from "../src/server.ts";
import { openDb } from "../src/db.ts";
import { CATEGORIES } from "../src/categorize.ts";

/** Seed a repo with a couple of merged PRs in the trailing-12-month window. */
function seed(): { db: ReturnType<typeof openDb>; repoId: number } {
  const db = openDb(":memory:");
  const r = db
    .query<{ id: number }, []>(
      `INSERT INTO repos (name, owner, repo, url, backfill_start, created_at)
       VALUES ('n', 'o', 'r', 'u', '2020-01-01', '2020-01-01T00:00:00Z') RETURNING id`,
    )
    .get();
  const repoId = r!.id;
  const now = new Date().toISOString();
  const insert = db.query(
    `INSERT INTO pull_requests
      (repo_id, number, title, url, created_at, merged_at, updated_at,
       ready_for_review_at, synced_at)
     VALUES (?, ?, ?, 'u', ?, ?, ?, ?, ?)`,
  );
  // Two PRs merged "yesterday" so they land in the current window.
  const mergedAt = now;
  const ready = now;
  insert.run(repoId, 1, "fix: a", now, mergedAt, now, ready, now);
  insert.run(repoId, 2, "feat: b", now, mergedAt, now, ready, now);
  return { db, repoId };
}

describe("GET /api/stats categories filter", () => {
  test("a valid categories subset filters the result", async () => {
    const { db, repoId } = seed();
    const handler = createFetchHandler(db);
    const res = await handler(
      new Request(`http://x/api/stats?repo=${repoId}&categories=Fix`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monthly: { count: number }[] };
    const total = body.monthly.reduce(
      (sum, m) => sum + m.count,
      0,
    );
    expect(total).toBe(1); // only the Fix PR
    db.close();
  });

  test("an unknown category name → 400", async () => {
    const { db, repoId } = seed();
    const handler = createFetchHandler(db);
    const res = await handler(
      new Request(`http://x/api/stats?repo=${repoId}&categories=Bogus`),
    );
    expect(res.status).toBe(400);
    db.close();
  });

  test("absent categories param includes everything", async () => {
    const { db, repoId } = seed();
    const handler = createFetchHandler(db);
    const res = await handler(new Request(`http://x/api/stats?repo=${repoId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monthly: { count: number }[] };
    const total = body.monthly.reduce(
      (sum, m) => sum + m.count,
      0,
    );
    expect(total).toBe(2); // both PRs
    db.close();
  });

  test("an empty categories param includes nothing", async () => {
    const { db, repoId } = seed();
    const handler = createFetchHandler(db);
    const res = await handler(
      new Request(`http://x/api/stats?repo=${repoId}&categories=`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { monthly: { count: number }[] };
    const total = body.monthly.reduce(
      (sum, m) => sum + m.count,
      0,
    );
    expect(total).toBe(0);
    db.close();
  });
});

describe("GET /api/stats count includes outliers", () => {
  test("an outlier still counts in the month but is tallied as excluded", async () => {
    const db = openDb(":memory:");
    const r = db
      .query<{ id: number }, []>(
        `INSERT INTO repos (name, owner, repo, url, backfill_start, created_at)
         VALUES ('n', 'o', 'r', 'u', '2020-01-01', '2020-01-01T00:00:00Z') RETURNING id`,
      )
      .get();
    const repoId = r!.id;
    const insert = db.query(
      `INSERT INTO pull_requests
        (repo_id, number, title, url, created_at, merged_at, updated_at,
         ready_for_review_at, synced_at)
       VALUES (?, ?, ?, 'u', ?, ?, ?, ?, ?)`,
    );
    // Merge "now" (in window). One PR merged immediately (TTM ~0, in cap); one
    // marked ready a year before merge (TTM far over the default 7-day cap).
    const now = new Date();
    const nowISO = now.toISOString();
    const yearAgoISO = new Date(now.getTime() - 365 * 86_400_000).toISOString();
    insert.run(repoId, 1, "fix: fast", nowISO, nowISO, nowISO, nowISO, nowISO);
    insert.run(repoId, 2, "fix: slow", yearAgoISO, nowISO, nowISO, yearAgoISO, nowISO);

    const handler = createFetchHandler(db);
    const res = await handler(new Request(`http://x/api/stats?repo=${repoId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      monthly: { count: number; timeToMerge: { excludedCount: number } }[];
    };
    const totalCount = body.monthly.reduce((s, m) => s + m.count, 0);
    const totalExcluded = body.monthly.reduce(
      (s, m) => s + m.timeToMerge.excludedCount,
      0,
    );
    expect(totalCount).toBe(2); // both PRs counted, outlier included
    expect(totalExcluded).toBe(1); // the slow PR dropped from the metric only
    db.close();
  });
});

describe("GET /api/categories", () => {
  test("returns the canonical category list", async () => {
    const { db } = seed();
    const handler = createFetchHandler(db);
    const res = await handler(new Request("http://x/api/categories"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([...CATEGORIES]);
    db.close();
  });
});
