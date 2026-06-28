import { describe, expect, test } from "bun:test";
import {
  measureTtaSeconds,
  measureTtfrSeconds,
  measureTtmSeconds,
  weekendExcludedSeconds,
} from "../src/measures.ts";

describe("measureTtmSeconds", () => {
  test("null mergedAt → null; unparseable → null; weekday diff exact", () => {
    expect(measureTtmSeconds("2026-03-02T00:00:00Z", null)).toBeNull();
    expect(measureTtmSeconds("nope", "2026-03-02T00:00:00Z")).toBeNull();
    // 2026-03-02 is a Monday, so the 30s falls entirely on a weekday.
    expect(measureTtmSeconds("2026-03-02T00:00:00Z", "2026-03-02T00:00:30Z")).toBe(30);
  });

  test("within-week interval equals the wall-clock difference", () => {
    // Monday → Tuesday: exactly 1 day, no weekend.
    expect(measureTtmSeconds("2026-03-02T00:00:00Z", "2026-03-03T00:00:00Z")).toBe(86400);
  });

  test("credits a weekend-spanning PR only with working time", () => {
    // ready Friday 16:00 → merged Monday 10:00 → Fri 8h + Mon 10h = 18h.
    expect(measureTtmSeconds("2026-01-09T16:00:00Z", "2026-01-12T10:00:00Z")).toBe(18 * 3600);
  });
});

describe("measureTtfrSeconds", () => {
  test("null firstReviewAt → null; unparseable → null; weekday diff exact", () => {
    expect(measureTtfrSeconds("2026-03-02T00:00:00Z", null)).toBeNull();
    expect(measureTtfrSeconds("nope", "2026-03-02T00:00:00Z")).toBeNull();
    // 2026-03-02 is a Monday, so the 30s falls entirely on a weekday.
    expect(measureTtfrSeconds("2026-03-02T00:00:00Z", "2026-03-02T00:00:30Z")).toBe(30);
  });

  test("credits a weekend-spanning wait only with working time", () => {
    // ready Friday 16:00 → first review Monday 10:00 → Fri 8h + Mon 10h = 18h.
    expect(measureTtfrSeconds("2026-01-09T16:00:00Z", "2026-01-12T10:00:00Z")).toBe(18 * 3600);
  });

  test("a review before the ready point (inverted interval) → 0", () => {
    expect(measureTtfrSeconds("2026-03-03T00:00:00Z", "2026-03-02T00:00:00Z")).toBe(0);
  });
});

describe("measureTtaSeconds", () => {
  test("null firstApprovalAt → null; unparseable → null; weekday diff exact", () => {
    expect(measureTtaSeconds("2026-03-02T00:00:00Z", null)).toBeNull();
    expect(measureTtaSeconds("nope", "2026-03-02T00:00:00Z")).toBeNull();
    // 2026-03-02 is a Monday, so the 30s falls entirely on a weekday.
    expect(measureTtaSeconds("2026-03-02T00:00:00Z", "2026-03-02T00:00:30Z")).toBe(30);
  });

  test("credits a weekend-spanning wait only with working time", () => {
    // ready Friday 16:00 → first approval Monday 10:00 → Fri 8h + Mon 10h = 18h.
    expect(measureTtaSeconds("2026-01-09T16:00:00Z", "2026-01-12T10:00:00Z")).toBe(18 * 3600);
  });

  test("an approval before the ready point (inverted interval) → 0", () => {
    expect(measureTtaSeconds("2026-03-03T00:00:00Z", "2026-03-02T00:00:00Z")).toBe(0);
  });
});

describe("weekend exclusion", () => {
  const H = 3600;
  const D = 86400;

  test("a within-week interval is unchanged (Tue→Wed)", () => {
    expect(
      weekendExcludedSeconds("2026-01-06T10:00:00Z", "2026-01-07T10:00:00Z"),
    ).toBe(24 * H);
  });

  test("Friday afternoon → Monday morning drops the whole weekend", () => {
    // Fri 16:00 → Mon 10:00: wall clock 66h, business = Fri 8h + Mon 10h.
    expect(
      weekendExcludedSeconds("2026-01-09T16:00:00Z", "2026-01-12T10:00:00Z"),
    ).toBe(18 * H);
  });

  test("an interval entirely inside a weekend is zero", () => {
    expect(
      weekendExcludedSeconds("2026-01-10T09:00:00Z", "2026-01-11T09:00:00Z"),
    ).toBe(0);
  });

  test("spanning a full week removes exactly two weekend days", () => {
    expect(
      weekendExcludedSeconds("2026-01-05T00:00:00Z", "2026-01-12T00:00:00Z"),
    ).toBe(5 * D);
  });

  test("empty and inverted intervals are zero", () => {
    expect(
      weekendExcludedSeconds("2026-01-06T10:00:00Z", "2026-01-06T10:00:00Z"),
    ).toBe(0);
    expect(
      weekendExcludedSeconds("2026-01-07T10:00:00Z", "2026-01-06T10:00:00Z"),
    ).toBe(0);
  });

  test("never exceeds the wall-clock difference", () => {
    const start = "2026-01-09T16:00:00Z";
    const end = "2026-01-12T10:00:00Z";
    const wall = Math.floor((Date.parse(end) - Date.parse(start)) / 1000);
    expect(weekendExcludedSeconds(start, end)).toBeLessThanOrEqual(wall);
  });
});
