# pr-stats

Track review-throughput metrics for GitHub pull requests across repositories. A
local, single-user CLI that stores data in a SQLite file and generates a static
web UI from it.

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

# Generate the static site (data files + bundled UI) into dist/
bun run src/index.ts generate
bun run src/index.ts generate --out site --minify

# Serve a generated site locally (default directory dist/, port 3000)
bun run src/index.ts serve
bun run src/index.ts serve --dir site --port 8080 --hostname 127.0.0.1
```

Use a specific database file by setting `PR_STATS_DB`:

```sh
PR_STATS_DB=./my-stats.sqlite bun run src/index.ts list
```

## The static site

`generate` writes a fully self-contained site:

```
dist/
  index.html, hashed .js/.css bundles
  data/repos.json              # repo index + generation timestamp
  data/<owner>-<repo>.json     # one repo's merged PRs (five fields per PR)
```

All URLs are relative, so the output works from any static host (GitHub
Pages, an S3 prefix, …) — `serve` is just a convenience for viewing it
locally, since the app fetches its JSON over HTTP. All filtering and
aggregation (trailing-12-month window, categories, outlier threshold) runs in
the browser, so the site only goes stale as the data ages; the generation
timestamp is shown at the bottom of the page.

## Frontend development

The dev server (`src/dev.ts`) runs the UI with hot reload straight from the
source entrypoint, serving the generated data files alongside it. Write the
data files next to the entrypoint first:

```sh
bun run src/index.ts generate --data-only --out src/frontend
bun run dev
```

`src/frontend/data/` is a dev-only artifact and is gitignored. (Bare
`bun src/frontend/index.html` doesn't work here: it answers every route with
the HTML entrypoint, including the `/data/*.json` fetches.)
