/**
 * CLI subcommand dispatcher.
 *
 * The CLI is the only thing that writes data and the entry point for the UI.
 * Routing, usage/help, and unknown-command handling live here, alongside the
 * real handlers for each subcommand, which wire the already-built modules
 * (config, db, sync, github, generate, server) together.
 */

import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";
import { loadConfig, requireGithubToken, type Config } from "./config.ts";
import { openDb, type RepoRow } from "./db.ts";
import { GitHubClient } from "./github.ts";
import { syncRepo } from "./sync.ts";
import { generateSite } from "./generate.ts";
import { createServer } from "./server.ts";

type Subcommand = "add" | "remove" | "list" | "sync" | "generate" | "serve";

const SUBCOMMANDS: readonly Subcommand[] = ["add", "remove", "list", "sync", "generate", "serve"];

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

const USAGE = `pr-stats — track time-to-merge of GitHub pull requests

Usage:
  pr-stats <command> [options]

Commands:
  add <owner>/<name> [--name <display>] [--backfill-start <YYYY-MM-DD>]
      [--base-branch <branch>]
      Register a repo to track. Defaults: display name to "<owner>/<name>",
      backfill start to ~12 months before today, base branch to "main".
      Only PRs merged into the base branch are synced.

  remove <owner>/<name>
      Remove a tracked repo and its stored PRs (and sync history).

  list
      List tracked repos with last-sync time and stored PR count.

  sync <owner>/<name>
      Run a manual sync for a repo. Requires a GitHub token. Refuses if a
      sync is already running for that repo.

  generate [--out <dir>] [--minify] [--data-only]
      Generate the static site from the local DB: per-repo JSON data files
      plus the bundled web UI. Default output directory "dist".
      --data-only writes only the data files (skips the frontend build).

  serve [--dir <dir>] [--port <n>] [--hostname <h>]
      Serve a generated site as plain static files. Default directory
      "dist", default port 3000. Run \`generate\` first.

Options:
  -h, --help   Show this help

Environment:
  GITHUB_TOKEN                  GitHub API token (or PR_STATS_GITHUB_TOKEN)
  PR_STATS_DB                   Path to the SQLite DB file (default: pr-stats.sqlite)
`;

function printUsage(): void {
  console.log(USAGE);
}

/** Number of months before today used as the default backfill start. */
const DEFAULT_BACKFILL_MONTHS = 12;

/**
 * An expected, user-facing error. Handlers throw this for conditions we know
 * how to explain (unknown repo, duplicate add, missing token, ...); the
 * dispatcher prints the message to stderr and exits non-zero, without a stack
 * trace. Unexpected errors are left to propagate.
 */
class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** Format a `Date` as a `YYYY-MM-DD` UTC date string. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The default backfill start: roughly `DEFAULT_BACKFILL_MONTHS` months ago. */
function defaultBackfillStart(now: Date = new Date()): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - DEFAULT_BACKFILL_MONTHS, now.getUTCDate()),
  );
  return isoDate(d);
}

/**
 * Parse an `owner/name` positional into its parts. Throws a `CliError` if it is
 * missing or malformed.
 */
function parseRepoSlug(slug: string | undefined): { owner: string; repo: string } {
  if (!slug) {
    throw new CliError("Missing required argument: <owner>/<name> (e.g. vaadin/flow).");
  }
  const parts = slug.split("/");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new CliError(`Invalid repo "${slug}". Expected the form <owner>/<name> (e.g. vaadin/flow).`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

/** Validate that `value` is an ISO calendar date (`YYYY-MM-DD`). */
function requireIsoDate(value: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CliError(`Invalid ${flag} "${value}". Expected an ISO date (YYYY-MM-DD).`);
  }
  return value;
}

/**
 * Resolve a tracked repo by its `owner/name`, or throw a clean "not found"
 * error. Centralized so remove/sync share one lookup + message.
 */
function findRepoBySlug(db: Database, owner: string, repo: string): RepoRow {
  const row = db
    .query<RepoRow, [string, string]>(`SELECT * FROM repos WHERE owner = ? AND repo = ?`)
    .get(owner, repo);
  if (!row) {
    throw new CliError(`Repo not tracked: ${owner}/${repo}. Use \`pr-stats list\` to see tracked repos.`);
  }
  return row;
}

// --- Subcommand handlers ----------------------------------------------------

/**
 * `add <owner>/<name> [--name <display>] [--backfill-start <YYYY-MM-DD>]
 *  [--base-branch <branch>]`
 */
function cmdAdd(argv: string[], config: Config): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      "backfill-start": { type: "string" },
      "base-branch": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  const { owner, repo } = parseRepoSlug(positionals[0]);
  const displayName = values.name ?? `${owner}/${repo}`;
  const backfillStart = values["backfill-start"]
    ? requireIsoDate(values["backfill-start"], "--backfill-start")
    : defaultBackfillStart();
  const baseBranch = values["base-branch"] ?? "main";
  const url = `https://github.com/${owner}/${repo}`;

  const db = openDb(config.dbPath);
  // Detect the UNIQUE(owner, repo) conflict up front for a clean message
  // rather than letting SQLite throw a raw constraint error.
  const existing = db
    .query<{ id: number }, [string, string]>(`SELECT id FROM repos WHERE owner = ? AND repo = ?`)
    .get(owner, repo);
  if (existing) {
    throw new CliError(`Already tracked: ${owner}/${repo}.`);
  }

  db.query(
    `INSERT INTO repos (name, owner, repo, url, base_branch, backfill_start, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(displayName, owner, repo, url, baseBranch, backfillStart, new Date().toISOString());

  console.log(
    `Added ${owner}/${repo} (display: "${displayName}", base branch ${baseBranch}, ` +
      `backfill from ${backfillStart}).`,
  );
  return 0;
}

/** `remove <owner>/<name>` */
function cmdRemove(argv: string[], config: Config): number {
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    allowPositionals: true,
    strict: true,
  });

  const { owner, repo } = parseRepoSlug(positionals[0]);
  const db = openDb(config.dbPath);
  const found = findRepoBySlug(db, owner, repo);

  const prCount =
    db
      .query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM pull_requests WHERE repo_id = ?`)
      .get(found.id)?.n ?? 0;

  // Cascade (ON DELETE CASCADE + PRAGMA foreign_keys = ON) removes the repo's
  // pull_requests and sync_runs along with the repo row.
  db.query(`DELETE FROM repos WHERE id = ?`).run(found.id);

  console.log(
    `Removed ${owner}/${repo} and ${prCount} stored pull request${prCount === 1 ? "" : "s"}.`,
  );
  return 0;
}

/** `list` */
function cmdList(argv: string[], config: Config): number {
  parseArgs({ args: argv, options: {}, allowPositionals: false, strict: true });

  const db = openDb(config.dbPath);
  const rows = db
    .query<
      {
        id: number;
        name: string;
        owner: string;
        repo: string;
        last_synced_at: string | null;
        pr_count: number;
      },
      []
    >(
      `SELECT r.id, r.name, r.owner, r.repo, r.last_synced_at,
              (SELECT COUNT(*) FROM pull_requests p WHERE p.repo_id = r.id) AS pr_count
         FROM repos r
        ORDER BY r.owner, r.repo`,
    )
    .all();

  if (rows.length === 0) {
    console.log("No repos tracked yet. Add one with: pr-stats add <owner>/<name>");
    return 0;
  }

  const table = rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    slug: `${r.owner}/${r.repo}`,
    lastSync: r.last_synced_at ?? "never",
    prs: String(r.pr_count),
  }));

  const headers = { id: "ID", name: "NAME", slug: "REPO", lastSync: "LAST SYNC", prs: "PRS" };
  const cols = ["id", "name", "slug", "lastSync", "prs"] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(headers[c].length, ...table.map((row) => row[c].length))]),
  ) as Record<(typeof cols)[number], number>;

  const fmtRow = (row: Record<(typeof cols)[number], string>) =>
    cols.map((c) => row[c].padEnd(widths[c])).join("  ").trimEnd();

  console.log(fmtRow(headers));
  for (const row of table) {
    console.log(fmtRow(row));
  }
  return 0;
}

/** `sync <owner>/<name>` */
async function cmdSync(argv: string[], config: Config): Promise<number> {
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    allowPositionals: true,
    strict: true,
  });

  const { owner, repo } = parseRepoSlug(positionals[0]);
  // requireGithubToken throws a clear, user-facing message if unset; treat it
  // as a CliError so it surfaces without a stack trace.
  let token: string;
  try {
    token = requireGithubToken(config);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const db = openDb(config.dbPath);
  const found = findRepoBySlug(db, owner, repo);
  const client = new GitHubClient(token);

  try {
    const result = await syncRepo(db, client, found);
    const cursor = result.maxMergedAt ?? "unchanged";
    console.log(
      `Synced ${owner}/${repo}: fetched ${result.countFetched} merged pull request${
        result.countFetched === 1 ? "" : "s"
      } (cursor now ${cursor}).`,
    );
    return 0;
  } catch (error) {
    // The engine throws on an already-running sync and on any sync failure
    // (after recording it in sync_runs). Surface a concise message.
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Sync failed for ${owner}/${repo}: ${message}`);
  }
}

/** `generate [--out <dir>] [--minify] [--data-only]` */
async function cmdGenerate(argv: string[], config: Config): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      minify: { type: "boolean" },
      "data-only": { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });

  const outDir = values.out ?? "dist";
  const db = openDb(config.dbPath);
  const result = await generateSite({
    db,
    outDir,
    minify: values.minify ?? false,
    dataOnly: values["data-only"] ?? false,
  });
  const what = values["data-only"] ? "data files" : "static site";
  console.log(
    `Generated ${what} in ${outDir}/ (${result.repoCount} repo${
      result.repoCount === 1 ? "" : "s"
    }, ${result.prCount} merged pull request${result.prCount === 1 ? "" : "s"}).`,
  );
  return 0;
}

/** `serve [--dir <dir>] [--port <n>] [--hostname <h>]` */
async function cmdServe(argv: string[], config: Config): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      port: { type: "string" },
      hostname: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new CliError(`Invalid --port "${values.port}". Expected an integer 0-65535.`);
    }
  }

  const dir = values.dir ?? "dist";
  if (!(await Bun.file(`${dir}/index.html`).exists())) {
    throw new CliError(
      `No generated site found in ${dir}/ (missing index.html). Run \`pr-stats generate\` first.`,
    );
  }

  const server = createServer({
    dir,
    port,
    hostname: values.hostname,
  });
  console.log(`pr-stats UI listening on ${server.url.href}`);
  console.log("Press Ctrl+C to stop.");

  // A listening Bun server keeps the event loop alive; resolve to nothing so
  // the process stays up until interrupted. We never resolve this promise.
  await new Promise<never>(() => {});
  // Unreachable, but keeps the return type honest.
  return 0;
}

type Handler = (argv: string[], config: Config) => number | Promise<number>;

const HANDLERS: Record<Subcommand, Handler> = {
  add: cmdAdd,
  remove: cmdRemove,
  list: cmdList,
  sync: cmdSync,
  generate: cmdGenerate,
  serve: cmdServe,
};

/**
 * Run the CLI against the given argv (defaults to the process args, sans the
 * `bun` and script-path entries). Returns the desired process exit code.
 */
export async function run(argv: string[] = Bun.argv.slice(2)): Promise<number> {
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
    // Top-level --help alongside a command shows general usage; per-command
    // syntax is documented there.
    printUsage();
    return 0;
  }

  const config = loadConfig();
  // Pass the remaining args (everything after the subcommand) to the handler.
  const rest = argv.slice(argv.indexOf(command) + 1);
  try {
    return await HANDLERS[command](rest, config);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      return 1;
    }
    // parseArgs throws a TypeError on unknown/invalid options; surface its
    // message cleanly rather than as a stack trace.
    if (error instanceof TypeError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
