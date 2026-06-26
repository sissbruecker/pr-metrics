# pr-stats

Track the time-to-merge of GitHub pull requests across repositories. A local,
single-user CLI that stores data in a SQLite file and doubles as a query-only
web UI.

## Requirements

- [Bun](https://bun.sh) (the project is built and run with Bun; it uses
  `bun:sqlite` and Bun's HTTP server).

## Install

```sh
bun install
```

## Configuration

Configured entirely through environment variables:

- `GITHUB_TOKEN` — GitHub API token used by `sync` (alias: `PR_STATS_GITHUB_TOKEN`).
  Only the `sync` command needs it.
- `PR_STATS_DB` — path to the SQLite database file (default: `pr-stats.sqlite`).
- `PR_STATS_TTM_THRESHOLD_DAYS` — default time-to-merge outlier cap, in days
  (default: `7`). PRs whose time-to-merge exceeds this are excluded from the
  stats. The web UI can override it per session; this variable only sets the
  default. Ignored unless it parses to a number ≥ 1.

You can place these in a `.env` file at the project root (it is gitignored).

## Run with `bun run`

Run any command directly through Bun:

```sh
bun run src/index.ts <command> [options]
# or via the package script:
bun run start <command> [options]
```

### Commands

```sh
# Show help
bun run src/index.ts --help

# Register a repo to track (display name defaults to "<owner>/<name>",
# backfill start defaults to ~12 months ago, base branch defaults to "main").
# Only PRs merged into the base branch are synced.
bun run src/index.ts add vaadin/flow
bun run src/index.ts add vaadin/flow --name "Flow" --backfill-start 2024-01-01
bun run src/index.ts add vaadin/flow --base-branch master

# List tracked repos with last-sync time and stored PR count
bun run src/index.ts list

# Run a manual sync for a repo (requires GITHUB_TOKEN)
GITHUB_TOKEN=ghp_xxx bun run src/index.ts sync vaadin/flow

# Remove a tracked repo and its stored PRs / sync history
bun run src/index.ts remove vaadin/flow

# Launch the query-only web UI (default port 3000)
bun run src/index.ts serve
bun run src/index.ts serve --port 8080 --hostname 127.0.0.1
```

Use a specific database file by setting `PR_STATS_DB`:

```sh
PR_STATS_DB=./my-stats.sqlite bun run src/index.ts list
```

Change the default time-to-merge outlier cap for the UI by setting
`PR_STATS_TTM_THRESHOLD_DAYS` (the UI can still override it per session):

```sh
PR_STATS_TTM_THRESHOLD_DAYS=14 bun run src/index.ts serve
```

## Build a single executable

Compile a self-contained binary (the UI assets are embedded into it, so no
source files are needed at runtime):

```sh
bun run compile      # produces ./pr-stats
```

Then run it like any binary — every command works, including `serve`:

```sh
./pr-stats --help
./pr-stats add vaadin/flow
./pr-stats list
PR_STATS_DB=./my-stats.sqlite ./pr-stats serve --port 8080
```

The compiled `pr-stats` binary is a build artifact and is gitignored.
