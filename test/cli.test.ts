import { expect, test } from "bun:test";
import { run } from "../src/cli.ts";

// Dispatching to a real handler (e.g. `list`) opens the DB; keep it in-memory
// so running the tests never writes a database file into the working tree.
process.env.PR_STATS_DB = ":memory:";

test("unknown command exits non-zero", async () => {
  expect(await run(["bogus"])).toBe(1);
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
