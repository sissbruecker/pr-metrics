import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";

// Dispatching to a real handler (e.g. `list`) opens the DB; keep it in-memory
// so running the tests never writes a database file into the working tree.
process.env.PR_STATS_DB = ":memory:";

const tmp = mkdtempSync(join(tmpdir(), "pr-stats-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("unknown command exits non-zero", async () => {
  expect(await run(["bogus"])).toBe(1);
});

test("generate --data-only writes the data files and exits zero", async () => {
  const out = join(tmp, "site");
  expect(await run(["generate", "--data-only", "--out", out])).toBe(0);
  const index = await Bun.file(join(out, "data", "repos.json")).json();
  expect(index.repos).toEqual([]); // in-memory DB tracks no repos
});

test("serve without a generated site exits non-zero", async () => {
  expect(await run(["serve", "--dir", join(tmp, "missing")])).toBe(1);
});

test("no command exits non-zero", async () => {
  expect(await run([])).toBe(1);
});

test("known subcommand dispatches and exits zero", async () => {
  expect(await run(["list"])).toBe(0);
});

test("--help exits zero", async () => {
  expect(await run(["--help"])).toBe(0);
});
