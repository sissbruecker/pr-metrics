import { describe, expect, test } from "bun:test";
import { formatDuration, BLANK } from "../src/frontend/format.ts";

describe("formatDuration", () => {
  test("two most-significant non-zero units: 2d 4h (187200)", () => {
    // 2d = 172800, + 4h = 14400 → 187200.
    expect(formatDuration(187200)).toBe("2d 4h");
  });

  test("6h 30m (23400)", () => {
    // 6h = 21600, + 30m = 1800 → 23400.
    expect(formatDuration(23400)).toBe("6h 30m");
  });

  test("single non-zero unit: 30s", () => {
    expect(formatDuration(30)).toBe("30s");
  });

  test("collapses to a single unit when next unit is zero: 2d (exactly 2 days)", () => {
    expect(formatDuration(172800)).toBe("2d");
  });

  test("0 → 0s", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  test("null → em dash blank marker", () => {
    expect(formatDuration(null)).toBe(BLANK);
    expect(formatDuration(null)).toBe("—");
  });

  test("negative → 0s", () => {
    expect(formatDuration(-5)).toBe("0s");
  });

  test("truncates fractional seconds (floored)", () => {
    expect(formatDuration(30.9)).toBe("30s");
  });

  test("skips zero middle units, keeping two non-zero: 45m 10s", () => {
    // 45m = 2700, + 10s = 10 → 2710 (no hours/days).
    expect(formatDuration(2710)).toBe("45m 10s");
  });
});
