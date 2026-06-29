# pr-stats

Track review-throughput metrics for GitHub pull requests across repositories. A
local, single-user CLI that stores data in a SQLite file and doubles as a
query-only web UI.

## Metrics

Three per-PR metrics are tracked, all measured from the same start point — when
the PR became ready for review — and all **excluding weekends** (Saturdays and
Sundays, in UTC) so they reflect elapsed working time rather than wall clock:

- **Time-to-merge** — ready for review → merged.
- **Time-to-first-review** — ready for review → first review.
- **Time-to-approval** — ready for review → first approval.

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
