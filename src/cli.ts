/**
 * CLI subcommand dispatcher.
 *
 * Routing, usage/help, and unknown-command handling are real and working.
 * The individual subcommand handlers are stubs for now — the actual logic
 * (data model, sync, serve) lands in later tasks.
 */

import { parseArgs } from "node:util";
import { loadConfig, type Config } from "./config.ts";

type Subcommand = "add" | "remove" | "list" | "sync" | "serve";

const SUBCOMMANDS: readonly Subcommand[] = ["add", "remove", "list", "sync", "serve"];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

const USAGE = `pr-stats — track time-to-merge of GitHub pull requests

Usage:
  pr-stats <command> [options]

Commands:
  add      Register a repo to track (owner/name, display name, backfill start)
  remove   Remove a tracked repo and its stored PRs
  list     List tracked repos with last-sync time and stored PR count
  sync     Run a manual sync for a repo
  serve    Launch the query-only web UI against the local DB

Options:
  -h, --help   Show this help

Environment:
  GITHUB_TOKEN   GitHub API token (or PR_STATS_GITHUB_TOKEN)
  PR_STATS_DB    Path to the SQLite DB file (default: pr-stats.sqlite)
`;

function printUsage(): void {
  console.log(USAGE);
}

/** Placeholder until the real handlers land in later tasks. */
function notYetImplemented(command: Subcommand): void {
  console.log(`'${command}' is not yet implemented.`);
}

// --- Subcommand handlers (stubs) --------------------------------------------

function cmdAdd(_argv: string[], _config: Config): void {
  notYetImplemented("add");
}

function cmdRemove(_argv: string[], _config: Config): void {
  notYetImplemented("remove");
}

function cmdList(_argv: string[], _config: Config): void {
  notYetImplemented("list");
}

function cmdSync(_argv: string[], _config: Config): void {
  notYetImplemented("sync");
}

function cmdServe(_argv: string[], _config: Config): void {
  notYetImplemented("serve");
}

const HANDLERS: Record<Subcommand, (argv: string[], config: Config) => void> = {
  add: cmdAdd,
  remove: cmdRemove,
  list: cmdList,
  sync: cmdSync,
  serve: cmdServe,
};

/**
 * Run the CLI against the given argv (defaults to the process args, sans the
 * `bun` and script-path entries). Returns the desired process exit code.
 */
export function run(argv: string[] = Bun.argv.slice(2)): number {
  // Split off the leading subcommand, then let each handler parse its own
  // options. We parse the top level loosely so `--help` works before/without
  // a command, and unknown commands are reported clearly.
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0];

  if (!command) {
    printUsage();
    // Showing help with no command is informational, not an error, unless
    // the user did not ask for it.
    return values.help ? 0 : 1;
  }

  if (!isSubcommand(command)) {
    console.error(`Unknown command: '${command}'\n`);
    printUsage();
    return 1;
  }

  if (values.help) {
    // Top-level --help alongside a command still shows general usage for now;
    // per-command help can be added when the handlers grow real options.
    printUsage();
    return 0;
  }

  const config = loadConfig();
  // Pass the remaining args (everything after the subcommand) to the handler.
  const rest = argv.slice(argv.indexOf(command) + 1);
  HANDLERS[command](rest, config);
  return 0;
}
