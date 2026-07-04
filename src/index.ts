#!/usr/bin/env bun
/**
 * pr-stats CLI entry point.
 *
 * Invoke with:  bun run src/index.ts <command> [options]
 * Commands:     add | remove | list | sync | generate | serve
 */

import { run } from "./cli.ts";

process.exit(await run());
