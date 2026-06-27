import { describe, expect, test } from "bun:test";
import {
  aggregate,
  computeStats,
  computeWindowStart,
  fetchStatsRows,
  mean,
  median,
  windowMonths,
  type StatsRow,
} from "../src/stats.ts";
import { CATEGORIES } from "../src/categorize.ts";
import { computeTtmSeconds } from "../src/ttm.ts";
import { openDb } from "../src/db.ts";

const MS_DAY = 86_400_000;

/** True for a Saturday/Sunday UTC day, given a day-start epoch ms. */
function isWeekendMs(ms: number): boolean {
  const d = new Date(ms).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * Inverse of `computeTtmSeconds`: return a `ready_for_review_at` ISO timestamp
 * such that the weekend-excluded TTM from it to `mergedISO` is exactly
 * `weekdaySeconds`. Walks backward from the merge instant, counting only weekday
 * time and skipping whole weekend days — so tests can express a target TTM in
 * round numbers regardless of where the merge falls relative to a weekend.
 */
function readyBefore(mergedISO: string, weekdaySeconds: number): string {
  let remainingMs = weekdaySeconds * 1000;
  let cursor = Date.parse(mergedISO);
  while (remainingMs > 0) {
    const dayStart = Math.floor((cursor - 1) / MS_DAY) * MS_DAY;
    if (isWeekendMs(dayStart)) {
      cursor = dayStart; // weekend day contributes no weekday time
      continue;
    }
    const available = cursor - dayStart;
    if (remainingMs <= available) {
      cursor -= remainingMs;
      remainingMs = 0;
    } else {
      remainingMs -= available;
      cursor = dayStart;
    }
  }
  return new Date(cursor).toISOString();
}

describe("median", () => {
  test("odd-length → middle value", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test("even-length → average of the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("empty → null", () => {
    expect(median([])).toBeNull();
  });

  test("numeric sort (not lexicographic): [10,2,100] → 10", () => {
    expect(median([10, 2, 100])).toBe(10);
  });

  test("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("mean", () => {
  test("arithmetic mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  test("empty → null", () => {
    expect(mean([])).toBeNull();
  });
});

describe("readyBefore (test helper) round-trips through computeTtmSeconds", () => {
  test("small within-week, weekend-spanning, and multi-week values", () => {
    const merged = "2026-06-15T00:00:00Z"; // Monday midnight
    for (const ttm of [10, 100, 1000, 3600, 7 * 86400, 30 * 86400]) {
      expect(computeTtmSeconds(readyBefore(merged, ttm), merged)).toBe(ttm);
    }
  });
});

describe("aggregate", () => {
  const months = ["2026-05", "2026-06"];

  /** Build a StatsRow, deriving `ready_for_review_at` from a target TTM. */
  function row(
    over: {
      merged_at?: string;
      ttm?: number | null;
      ttm_is_approximate?: number;
      title?: string;
    } = {},
  ): StatsRow {
    const merged_at = over.merged_at ?? "2026-06-15T00:00:00Z";
    const ttm = over.ttm === undefined ? 100 : over.ttm;
    return {
      merged_at,
      ready_for_review_at: ttm === null ? null : readyBefore(merged_at, ttm),
      ttm_is_approximate: over.ttm_is_approximate ?? 0,
      title: over.title ?? "fix: a bug",
    };
  }

  test("per-(month,category) count/median/mean", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 10, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 30, title: "fix: b" }),
      row({ merged_at: "2026-06-03T00:00:00Z", ttm: 50, title: "feat: c" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.byCategory.Fix.count).toBe(2);
    expect(june.byCategory.Fix.median).toBe(20); // median(10,30)
    expect(june.byCategory.Fix.mean).toBe(20);
    expect(june.byCategory.Feature.count).toBe(1);
    expect(june.byCategory.Feature.median).toBe(50);
  });

  test('"All" is computed over ALL rows, NOT the mean of category medians', () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 10, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 30, title: "fix: b" }),
      row({ merged_at: "2026-06-03T00:00:00Z", ttm: 50, title: "feat: c" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    // All values: 10, 30, 50. median = 30 (over all rows), mean = 30.
    // Mean of category medians would be (20 + 50) / 2 = 35 — explicitly NOT this.
    expect(june.all.count).toBe(3);
    expect(june.all.median).toBe(30);
    expect(june.all.mean).toBe(30);
  });

  test("empty month → count 0, null median/mean, ALL categories present", () => {
    const rows: StatsRow[] = [row({ merged_at: "2026-06-10T00:00:00Z" })];
    const { monthly } = aggregate(rows, months);
    const may = monthly.find((m) => m.month === "2026-05")!;
    expect(may.all.count).toBe(0);
    expect(may.all.median).toBeNull();
    expect(may.all.mean).toBeNull();
    for (const c of CATEGORIES) {
      expect(may.byCategory[c]).toEqual({ count: 0, median: null, mean: null });
    }
  });

  test("every month present and every category present per month", () => {
    const { monthly } = aggregate([], months);
    expect(monthly.map((m) => m.month)).toEqual(months);
    for (const m of monthly) {
      expect(Object.keys(m.byCategory).sort()).toEqual([...CATEGORIES].sort());
    }
  });

  test("approximateCount totals ttm_is_approximate === 1 rows", () => {
    const rows: StatsRow[] = [
      row({ ttm_is_approximate: 1 }),
      row({ ttm_is_approximate: 0 }),
      row({ ttm_is_approximate: 1 }),
    ];
    const { approximateCount } = aggregate(rows, months);
    expect(approximateCount).toBe(2);
  });

  test("null TTM (no ready point) counts toward count but is excluded from median/mean", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: null, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 40, title: "fix: b" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.byCategory.Fix.count).toBe(2);
    expect(june.byCategory.Fix.median).toBe(40);
    expect(june.byCategory.Fix.mean).toBe(40);
  });

  test("rows outside the months window are ignored", () => {
    const rows: StatsRow[] = [row({ merged_at: "2020-01-01T00:00:00Z" })];
    const { monthly } = aggregate(rows, months);
    for (const m of monthly) {
      expect(m.all.count).toBe(0);
    }
  });

  test("rows above the threshold are excluded entirely; a row at the threshold is kept", () => {
    const rows: StatsRow[] = [
      row({ ttm: 10, title: "fix: a" }),
      row({ ttm: 100, title: "fix: b" }), // exactly at threshold → kept
      row({ ttm: 101, title: "fix: c", ttm_is_approximate: 1 }), // over → excluded
    ];
    const { monthly, excludedCount, approximateCount } = aggregate(rows, months, 100);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.byCategory.Fix.count).toBe(2);
    expect(june.byCategory.Fix.median).toBe(55); // median(10, 100)
    expect(june.byCategory.Fix.mean).toBe(55);
    expect(excludedCount).toBe(1);
    // The excluded outlier contributes to neither count nor the approximate tally.
    expect(approximateCount).toBe(0);
  });

  test("null TTM is never excluded by the threshold", () => {
    const rows: StatsRow[] = [
      row({ ttm: null, title: "fix: a" }),
      row({ ttm: 1000, title: "fix: b" }), // over threshold → excluded
    ];
    const { monthly, excludedCount } = aggregate(rows, months, 100);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.byCategory.Fix.count).toBe(1); // null kept, 1000 excluded
    expect(excludedCount).toBe(1);
  });
});

describe("fetchStatsRows + computeStats (in-memory DB)", () => {
  function seedRepo(db: ReturnType<typeof openDb>): number {
    const r = db
      .query<{ id: number }, []>(
        `INSERT INTO repos (name, owner, repo, url, backfill_start, created_at)
         VALUES ('n', 'o', 'r', 'u', '2020-01-01', '2020-01-01T00:00:00Z') RETURNING id`,
      )
      .get();
    return r!.id;
  }

  /** Insert a PR, deriving `ready_for_review_at` from a target TTM. */
  function insertPr(
    db: ReturnType<typeof openDb>,
    number: number,
    repoId: number,
    merged_at: string,
    ttm: number | null,
    title: string,
    approx = 0,
  ): void {
    const ready = ttm === null ? null : readyBefore(merged_at, ttm);
    db.query(
      `INSERT INTO pull_requests
        (repo_id, number, title, url, created_at, merged_at, updated_at,
         ready_for_review_at, ttm_is_approximate, synced_at)
       VALUES (?, ?, ?, 'u', '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', ?, ?, '2026-01-01T00:00:00Z')`,
    ).run(repoId, number, title, merged_at, ready, approx);
  }

  test("fetchStatsRows filters by repo and windowStart", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    insertPr(db, 1, repoId, "2026-06-15T00:00:00Z", 100, "fix: in window");
    insertPr(db, 2, repoId, "2020-01-01T00:00:00Z", 100, "fix: out of window");
    const rows = fetchStatsRows(db, repoId, "2025-07-01T00:00:00Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("fix: in window");
    db.close();
  });

  test("computeStats ties window + fetch + aggregation together", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    insertPr(db, 1, repoId, "2026-06-10T00:00:00Z", 200, "feat: a");
    insertPr(db, 2, repoId, "2026-06-12T00:00:00Z", 400, "feat: b", 1);
    const result = computeStats(db, repoId, new Date("2026-06-26T00:00:00Z"));
    expect(result.windowStart).toBe("2025-07-01T00:00:00Z");
    expect(result.months).toHaveLength(12);
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.byCategory.Feature.count).toBe(2);
    expect(june.byCategory.Feature.median).toBe(300);
    expect(result.approximateCount).toBe(1);
    db.close();
  });

  test("computeStats applies the default 7-day threshold and reports excludedCount", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    insertPr(db, 1, repoId, "2026-06-10T00:00:00Z", 3600, "feat: normal");
    insertPr(db, 2, repoId, "2026-06-12T00:00:00Z", 30 * 86400, "feat: outlier");
    const result = computeStats(db, repoId, new Date("2026-06-26T00:00:00Z"));
    expect(result.ttmThresholdSeconds).toBe(7 * 86400);
    expect(result.excludedCount).toBe(1);
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.byCategory.Feature.count).toBe(1); // outlier dropped
    expect(june.byCategory.Feature.median).toBe(3600);
    db.close();
  });

  test("computeStats honors an explicit threshold argument", () => {
    const db = openDb(":memory:");
    const repoId = seedRepo(db);
    insertPr(db, 1, repoId, "2026-06-10T00:00:00Z", 3600, "feat: normal");
    insertPr(db, 2, repoId, "2026-06-12T00:00:00Z", 30 * 86400, "feat: outlier");
    const result = computeStats(db, repoId, new Date("2026-06-26T00:00:00Z"), 60 * 86400);
    expect(result.ttmThresholdSeconds).toBe(60 * 86400);
    expect(result.excludedCount).toBe(0);
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.byCategory.Feature.count).toBe(2);
    db.close();
  });
});
