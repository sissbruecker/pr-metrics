import { describe, expect, test } from "bun:test";
import {
  aggregate,
  computeStats,
  computeWindowStart,
  mean,
  median,
  windowMonths,
  type StatsRow,
} from "../src/frontend/stats.ts";
import { measureTtmSeconds } from "../src/frontend/measures.ts";

const MS_DAY = 86_400_000;

/** True for a Saturday/Sunday UTC day, given a day-start epoch ms. */
function isWeekendMs(ms: number): boolean {
  const d = new Date(ms).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * Inverse of `measureTtmSeconds`: return a `ready_for_review_at` ISO timestamp
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

/**
 * Forward counterpart of `readyBefore`: return a `first_review_at` ISO timestamp
 * such that the weekend-excluded TTFR from `readyISO` to it is exactly
 * `weekdaySeconds`. Walks forward from the ready instant, counting only weekday
 * time and skipping whole weekend days.
 */
function reviewAfter(readyISO: string, weekdaySeconds: number): string {
  let remainingMs = weekdaySeconds * 1000;
  let cursor = Date.parse(readyISO);
  while (remainingMs > 0) {
    const dayStart = Math.floor(cursor / MS_DAY) * MS_DAY;
    const nextDay = dayStart + MS_DAY;
    if (isWeekendMs(dayStart)) {
      cursor = nextDay; // weekend day contributes no weekday time
      continue;
    }
    const available = nextDay - cursor;
    if (remainingMs <= available) {
      cursor += remainingMs;
      remainingMs = 0;
    } else {
      remainingMs -= available;
      cursor = nextDay;
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

describe("readyBefore (test helper) round-trips through measureTtmSeconds", () => {
  test("small within-week, weekend-spanning, and multi-week values", () => {
    const merged = "2026-06-15T00:00:00Z"; // Monday midnight
    for (const ttm of [10, 100, 1000, 3600, 7 * 86400, 30 * 86400]) {
      expect(measureTtmSeconds(readyBefore(merged, ttm), merged)).toBe(ttm);
    }
  });
});

describe("aggregate", () => {
  const months = ["2026-05", "2026-06"];

  /**
   * Build a StatsRow, deriving `ready_for_review_at` from a target TTM and, when
   * `ttfr`/`tta` is given, `first_review_at`/`first_approval_at` from that ready
   * point. `ttfr` and `tta` default to null (no review / no approval).
   */
  function row(
    over: {
      merged_at?: string;
      ttm?: number | null;
      ttfr?: number | null;
      tta?: number | null;
      title?: string;
    } = {},
  ): StatsRow {
    const merged_at = over.merged_at ?? "2026-06-15T00:00:00Z";
    const ttm = over.ttm === undefined ? 100 : over.ttm;
    const ready = ttm === null ? null : readyBefore(merged_at, ttm);
    const ttfr = over.ttfr === undefined ? null : over.ttfr;
    const tta = over.tta === undefined ? null : over.tta;
    return {
      merged_at,
      ready_for_review_at: ready,
      first_review_at: ttfr === null || ready === null ? null : reviewAfter(ready, ttfr),
      first_approval_at: tta === null || ready === null ? null : reviewAfter(ready, tta),
      title: over.title ?? "fix: a bug",
    };
  }

  test("per-month count/median/mean over all rows", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 10, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 30, title: "fix: b" }),
      row({ merged_at: "2026-06-03T00:00:00Z", ttm: 50, title: "feat: c" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    // All values: 10, 30, 50. median = 30, mean = 30.
    expect(june.count).toBe(3);
    expect(june.timeToMerge.median).toBe(30);
    expect(june.timeToMerge.mean).toBe(30);
  });

  test("includedCategories keeps only the selected categories", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 10, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 30, title: "fix: b" }),
      row({ merged_at: "2026-06-03T00:00:00Z", ttm: 50, title: "feat: c" }),
    ];
    const { monthly } = aggregate(rows, months, Infinity, new Set(["Fix"]));
    const june = monthly.find((m) => m.month === "2026-06")!;
    // Only the two Fix rows survive: median(10, 30) = 20.
    expect(june.count).toBe(2);
    expect(june.timeToMerge.median).toBe(20);
    expect(june.timeToMerge.mean).toBe(20);
  });

  test("an empty includedCategories set yields all-empty months", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 10, title: "fix: a" }),
      row({ merged_at: "2026-06-03T00:00:00Z", ttm: 50, title: "feat: c" }),
    ];
    const { monthly } = aggregate(rows, months, Infinity, new Set());
    for (const m of monthly) {
      expect(m.count).toBe(0);
      expect(m.timeToMerge).toEqual({ median: null, mean: null, excludedCount: 0 });
    }
  });

  test("an excluded category's outlier does NOT count toward excludedCount", () => {
    const rows: StatsRow[] = [
      row({ ttm: 10, title: "fix: a" }),
      row({ ttm: 1000, title: "chore: noisy outlier" }), // over threshold, but Chore excluded
    ];
    const { monthly } = aggregate(rows, months, 100, new Set(["Fix"]));
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(1); // only the Fix row
    expect(june.timeToMerge.excludedCount).toBe(0); // the Chore outlier was filtered out before the outlier check
  });

  test("empty month → count 0, null median/mean", () => {
    const rows: StatsRow[] = [row({ merged_at: "2026-06-10T00:00:00Z" })];
    const { monthly } = aggregate(rows, months);
    const may = monthly.find((m) => m.month === "2026-05")!;
    expect(may.count).toBe(0);
    expect(may.timeToMerge).toEqual({ median: null, mean: null, excludedCount: 0 });
  });

  test("every month present and ordered", () => {
    const { monthly } = aggregate([], months);
    expect(monthly.map((m) => m.month)).toEqual(months);
  });

  test("null TTM (no ready point) counts toward count but is excluded from median/mean", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: null, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 40, title: "fix: b" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(2);
    expect(june.timeToMerge.median).toBe(40);
    expect(june.timeToMerge.mean).toBe(40);
  });

  test("rows outside the months window are ignored", () => {
    const rows: StatsRow[] = [row({ merged_at: "2020-01-01T00:00:00Z" })];
    const { monthly } = aggregate(rows, months);
    for (const m of monthly) {
      expect(m.count).toBe(0);
    }
  });

  test("rows above the threshold drop from the metric but still count; a row at the threshold feeds it", () => {
    const rows: StatsRow[] = [
      row({ ttm: 10, title: "fix: a" }),
      row({ ttm: 100, title: "fix: b" }), // exactly at threshold → feeds the metric
      row({ ttm: 101, title: "fix: c" }), // over → excluded from median/mean, still counts
    ];
    const { monthly } = aggregate(rows, months, 100);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(3); // outlier still counted in the denominator
    expect(june.timeToMerge.median).toBe(55); // median(10, 100), over the 2 in-cap rows
    expect(june.timeToMerge.mean).toBe(55);
    expect(june.timeToMerge.excludedCount).toBe(1);
  });

  test("null TTM is never excluded by the threshold; the outlier still counts", () => {
    const rows: StatsRow[] = [
      row({ ttm: null, title: "fix: a" }),
      row({ ttm: 1000, title: "fix: b" }), // over threshold → excluded from median/mean
    ];
    const { monthly } = aggregate(rows, months, 100);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(2); // null + outlier both counted
    expect(june.timeToMerge.excludedCount).toBe(1); // only the outlier
    expect(june.timeToMerge.median).toBeNull(); // null didn't feed; outlier was capped
    expect(june.timeToMerge.mean).toBeNull();
  });

  test("emits a timeToFirstReview bucket over the reviewed rows", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 100, ttfr: 10, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 100, ttfr: 30, title: "fix: b" }),
      row({ merged_at: "2026-06-03T00:00:00Z", ttm: 100, ttfr: 50, title: "feat: c" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    // TTFR values 10, 30, 50 → median 30, mean 30.
    expect(june.count).toBe(3);
    expect(june.timeToFirstReview.median).toBe(30);
    expect(june.timeToFirstReview.mean).toBe(30);
    expect(june.timeToFirstReview.excludedCount).toBe(0);
  });

  test("the shared cap drops outliers from BOTH metrics independently", () => {
    const rows: StatsRow[] = [
      // In cap for both.
      row({ ttm: 10, ttfr: 10, title: "fix: a" }),
      // TTM over the cap, TTFR within: excluded from TTM only.
      row({ ttm: 1000, ttfr: 20, title: "fix: b" }),
      // TTM within, TTFR over the cap: excluded from TTFR only.
      row({ ttm: 30, ttfr: 1000, title: "fix: c" }),
    ];
    const { monthly } = aggregate(rows, months, 100);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(3); // every row counts
    // TTM: 10 and 30 feed (1000 excluded) → median 20.
    expect(june.timeToMerge.median).toBe(20);
    expect(june.timeToMerge.excludedCount).toBe(1);
    // TTFR: 10 and 20 feed (1000 excluded) → median 15.
    expect(june.timeToFirstReview.median).toBe(15);
    expect(june.timeToFirstReview.excludedCount).toBe(1);
  });

  test("a row with no first review counts but does not feed TTFR", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 100, ttfr: null, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 100, ttfr: 40, title: "fix: b" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(2); // both count
    expect(june.timeToFirstReview.median).toBe(40); // only the reviewed row feeds
    expect(june.timeToFirstReview.mean).toBe(40);
    expect(june.timeToFirstReview.excludedCount).toBe(0); // null is never an outlier
  });

  test("emits a timeToApproval bucket over the approved rows", () => {
    const rows: StatsRow[] = [
      row({ merged_at: "2026-06-01T00:00:00Z", ttm: 100, tta: 10, title: "fix: a" }),
      row({ merged_at: "2026-06-02T00:00:00Z", ttm: 100, tta: 30, title: "fix: b" }),
      row({ merged_at: "2026-06-03T00:00:00Z", ttm: 100, tta: 50, title: "feat: c" }),
    ];
    const { monthly } = aggregate(rows, months);
    const june = monthly.find((m) => m.month === "2026-06")!;
    // TTA values 10, 30, 50 → median 30, mean 30.
    expect(june.count).toBe(3);
    expect(june.timeToApproval.median).toBe(30);
    expect(june.timeToApproval.mean).toBe(30);
    expect(june.timeToApproval.excludedCount).toBe(0);
  });

  test("the shared cap drops TTA outliers; null approvals never feed", () => {
    const rows: StatsRow[] = [
      row({ ttm: 10, tta: 10, title: "fix: a" }),
      row({ ttm: 10, tta: 1000, title: "fix: b" }), // approval over cap → excluded from TTA
      row({ ttm: 10, tta: null, title: "fix: c" }), // no approval → never feeds, never an outlier
    ];
    const { monthly } = aggregate(rows, months, 100);
    const june = monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(3); // every row counts
    expect(june.timeToApproval.median).toBe(10); // only the in-cap approval feeds
    expect(june.timeToApproval.excludedCount).toBe(1); // only the outlier
  });
});

describe("computeStats (pure, rows in)", () => {
  /**
   * Build a StatsRow, deriving `ready_for_review_at` from a target TTM and, when
   * `ttfr`/`tta` is given, `first_review_at`/`first_approval_at` from that ready
   * point.
   */
  function row(
    merged_at: string,
    ttm: number | null,
    title: string,
    ttfr: number | null = null,
    tta: number | null = null,
  ): StatsRow {
    const ready = ttm === null ? null : readyBefore(merged_at, ttm);
    return {
      merged_at,
      ready_for_review_at: ready,
      first_review_at: ttfr === null || ready === null ? null : reviewAfter(ready, ttfr),
      first_approval_at: tta === null || ready === null ? null : reviewAfter(ready, tta),
      title,
    };
  }

  test("ties window + aggregation together; out-of-window rows drop", () => {
    const rows = [
      row("2026-06-10T00:00:00Z", 200, "feat: a"),
      row("2026-06-12T00:00:00Z", 400, "feat: b"),
      row("2020-01-01T00:00:00Z", 100, "feat: out of window"),
    ];
    const result = computeStats(rows, new Date("2026-06-26T00:00:00Z"));
    expect(result.windowStart).toBe("2025-07-01T00:00:00Z");
    expect(result.months).toHaveLength(12);
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(2);
    expect(june.timeToMerge.median).toBe(300);
    expect(result.monthly.reduce((s, m) => s + m.count, 0)).toBe(2);
  });

  test("applies the version-bump exclusion filter", () => {
    const rows = [
      row("2026-06-10T00:00:00Z", 200, "feat: a"),
      row("2026-06-12T00:00:00Z", 400, "chore(deps): bump lib from 1 to 2"),
    ];
    const result = computeStats(rows, new Date("2026-06-26T00:00:00Z"));
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(1); // the bump PR is excluded entirely
    expect(june.timeToMerge.median).toBe(200);
  });

  test("applies an includedCategories filter", () => {
    const rows = [
      row("2026-06-10T00:00:00Z", 200, "feat: a"),
      row("2026-06-11T00:00:00Z", 400, "fix: b"),
    ];
    const result = computeStats(
      rows,
      new Date("2026-06-26T00:00:00Z"),
      undefined,
      new Set(["Fix"]),
    );
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(1); // only the Fix PR
    expect(june.timeToMerge.median).toBe(400);
  });

  test("applies the default 7-day threshold; outliers count but drop from the metric", () => {
    const rows = [
      row("2026-06-10T00:00:00Z", 3600, "feat: normal"),
      row("2026-06-12T00:00:00Z", 30 * 86400, "feat: outlier"),
    ];
    const result = computeStats(rows, new Date("2026-06-26T00:00:00Z"));
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(2); // outlier still counted in the denominator
    expect(june.timeToMerge.excludedCount).toBe(1);
    expect(june.timeToMerge.median).toBe(3600); // over the single in-cap row
  });

  test("derives timeToFirstReview from first_review_at", () => {
    const rows = [
      row("2026-06-10T00:00:00Z", 200, "feat: a", 100),
      row("2026-06-12T00:00:00Z", 400, "feat: b", 300),
      row("2026-06-14T00:00:00Z", 600, "feat: c", null), // no review
    ];
    const result = computeStats(rows, new Date("2026-06-26T00:00:00Z"));
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(3); // all three counted
    // Only the two reviewed PRs feed TTFR: median(100, 300) = 200.
    expect(june.timeToFirstReview.median).toBe(200);
    expect(june.timeToFirstReview.excludedCount).toBe(0);
  });

  test("derives timeToApproval from first_approval_at", () => {
    const rows = [
      row("2026-06-10T00:00:00Z", 200, "feat: a", 100, 150),
      row("2026-06-12T00:00:00Z", 400, "feat: b", 300, 350),
      row("2026-06-14T00:00:00Z", 600, "feat: c", 500, null), // no approval
    ];
    const result = computeStats(rows, new Date("2026-06-26T00:00:00Z"));
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(3); // all three counted
    // Only the two approved PRs feed TTA: median(150, 350) = 250.
    expect(june.timeToApproval.median).toBe(250);
    expect(june.timeToApproval.excludedCount).toBe(0);
  });

  test("honors an explicit threshold argument", () => {
    const rows = [
      row("2026-06-10T00:00:00Z", 3600, "feat: normal"),
      row("2026-06-12T00:00:00Z", 30 * 86400, "feat: outlier"),
    ];
    const result = computeStats(rows, new Date("2026-06-26T00:00:00Z"), 60 * 86400);
    const june = result.monthly.find((m) => m.month === "2026-06")!;
    expect(june.count).toBe(2);
    expect(june.timeToMerge.excludedCount).toBe(0);
  });
});
