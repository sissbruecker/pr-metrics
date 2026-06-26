import { expect, test } from "bun:test";
import { run } from "../src/cli.ts";

test("unknown command exits non-zero", () => {
  expect(run(["bogus"])).toBe(1);
});

test("no command exits non-zero", () => {
  expect(run([])).toBe(1);
});

test("known subcommand dispatches and exits zero", () => {
  expect(run(["list"])).toBe(0);
});

test("--help exits zero", () => {
  expect(run(["--help"])).toBe(0);
});
