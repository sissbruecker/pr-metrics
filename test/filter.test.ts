import { describe, expect, test } from "bun:test";
import { filterRows, isExcluded, isVersionBump } from "../src/filter.ts";

describe("isVersionBump", () => {
  test("matches plain and scoped version-bump titles", () => {
    expect(isVersionBump("chore: bump date-fns to 4.1.0")).toBe(true);
    expect(isVersionBump("chore(deps): bump org.springframework from 1 to 2")).toBe(true);
    expect(isVersionBump("chore(deps-dev): bump spotless from 2.44.3 to 2.44.5")).toBe(true);
  });

  test("case-insensitive (Bump vs bump)", () => {
    expect(isVersionBump("chore: Bump com.diffplug:spotless from 2.44.3 to 2.44.5")).toBe(true);
    expect(isVersionBump("CHORE: BUMP something")).toBe(true);
  });

  test("leading/trailing whitespace is trimmed before matching", () => {
    expect(isVersionBump("  chore: bump x  ")).toBe(true);
  });

  test("does not match non-bump or non-chore titles", () => {
    expect(isVersionBump("fix: a bug")).toBe(false);
    expect(isVersionBump("feat: bump Highcharts version in SVG Generator")).toBe(false);
    expect(isVersionBump('Revert "chore: Bump org.eclipse.jetty"')).toBe(false);
    expect(isVersionBump("chore: upgrade testbench to 9.4.0.rc1")).toBe(false);
    expect(isVersionBump("bump com.diffplug:spotless")).toBe(false);
  });
});

describe("isExcluded", () => {
  test("delegates to the version-bump rule", () => {
    expect(isExcluded("chore: bump x")).toBe(true);
    expect(isExcluded("fix: a bug")).toBe(false);
  });
});

describe("filterRows", () => {
  test("removes only excluded rows and preserves order", () => {
    const rows = [
      { title: "fix: a bug" },
      { title: "chore: Bump foo from 1 to 2" },
      { title: "feat: a thing" },
      { title: "chore(deps): bump bar" },
      { title: "docs: readme" },
    ];
    expect(filterRows(rows)).toEqual([
      { title: "fix: a bug" },
      { title: "feat: a thing" },
      { title: "docs: readme" },
    ]);
  });

  test("empty input → empty output", () => {
    expect(filterRows([])).toEqual([]);
  });
});
