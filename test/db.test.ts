import { describe, expect, test } from "bun:test";
import { migrate, openDb } from "../src/db.ts";

/** Read SQLite's stored data-format version. */
function userVersion(db: ReturnType<typeof openDb>): number {
  return (
    db.query<{ user_version: number }, []>("PRAGMA user_version").get()
      ?.user_version ?? 0
  );
}

function seedRepo(db: ReturnType<typeof openDb>): number {
  return db
    .query<{ id: number }, []>(
      `INSERT INTO repos (name, owner, repo, url, backfill_start, created_at)
       VALUES ('n', 'o', 'r', 'u', '2020-01-01', '2020-01-01T00:00:00Z') RETURNING id`,
    )
    .get()!.id;
}

/** Insert a PR row with an explicit (possibly stale) ttm_seconds. */
function insertPr(
  db: ReturnType<typeof openDb>,
  repoId: number,
  number: number,
  ready_for_review_at: string | null,
  merged_at: string | null,
  ttm_seconds: number | null,
): void {
  db.query(
    `INSERT INTO pull_requests
       (repo_id, number, title, url, created_at, merged_at, updated_at,
        ready_for_review_at, ttm_seconds, synced_at)
     VALUES (?, ?, 'fix: x', 'u', '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z',
        ?, ?, '2026-01-01T00:00:00Z')`,
  ).run(repoId, number, merged_at, ready_for_review_at, ttm_seconds);
}

function ttmOf(db: ReturnType<typeof openDb>, number: number): number | null {
  return (
    db
      .query<{ ttm_seconds: number | null }, [number]>(
        `SELECT ttm_seconds FROM pull_requests WHERE number = ?`,
      )
      .get(number)?.ttm_seconds ?? null
  );
}

describe("migrate (data-version recompute)", () => {
  test("openDb stamps a fresh database at the current version", () => {
    const db = openDb(":memory:");
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  test("v1 recomputes stale wall-clock ttm_seconds to weekend-excluded", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);

    // Ready Friday 16:00, merged Monday 10:00. Stale value is the old
    // wall-clock TTM (66h); the weekend-excluding definition is 18h.
    const ready = "2026-01-09T16:00:00Z";
    const merged = "2026-01-12T10:00:00Z";
    insertPr(db, repoId, 1, ready, merged, 66 * 3600);
    // A within-week PR (Tue→Wed) is unaffected by the new definition.
    insertPr(db, repoId, 2, "2026-01-06T10:00:00Z", "2026-01-07T10:00:00Z", 24 * 3600);

    // Simulate an old database file and re-run the migration.
    db.exec("PRAGMA user_version = 0");
    migrate(db);

    expect(ttmOf(db, 1)).toBe(18 * 3600);
    expect(ttmOf(db, 2)).toBe(24 * 3600);
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  test("migrate is idempotent — already-current DB is left untouched", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    insertPr(db, repoId, 1, "2026-01-09T16:00:00Z", "2026-01-12T10:00:00Z", 999);

    // Version is already current, so the stale value is NOT recomputed.
    migrate(db);
    expect(ttmOf(db, 1)).toBe(999);
    db.close();
  });
});
