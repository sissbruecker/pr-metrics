import { expect, test } from "bun:test";
import {
  buildSearchQueryString,
  buildWindowedSearchQueryString,
} from "../src/github.ts";

test("buildSearchQueryString restricts to the base branch", () => {
  const q = buildSearchQueryString("octo", "repo", "main", "2026-01-01");
  expect(q).toContain("base:main");
  expect(q).toBe(
    "repo:octo/repo is:pr is:merged base:main merged:>=2026-01-01 sort:created-asc",
  );
});

test("buildWindowedSearchQueryString restricts to the base branch", () => {
  const q = buildWindowedSearchQueryString("octo", "repo", "main", "2026-01-01", "2026-01-31");
  expect(q).toContain("base:main");
  expect(q).toBe(
    "repo:octo/repo is:pr is:merged base:main merged:2026-01-01..2026-01-31 sort:created-asc",
  );
});

test("a non-default base branch flows into the query", () => {
  const q = buildWindowedSearchQueryString("octo", "repo", "master", "2026-01-01", "2026-01-31");
  expect(q).toContain("base:master");
});
