/**
 * Static site generation.
 *
 * The `generate` command extracts per-repo JSON data files from the database
 * and bundles the frontend (`src/frontend/index.html` via `Bun.build`, which
 * treats HTML files as first-class entrypoints) into a self-contained static
 * site:
 *
 *   <out>/
 *     index.html, hashed .js/.css bundles
 *     data/repos.json              — repo index + generatedAt
 *     data/<owner>-<repo>.json     — one repo's merged PRs, five columns each
 *
 * This module owns the read-only extraction queries and the file writing; the
 * JSON shapes (`StatsRow` etc.) are imported type-only from the frontend so
 * producer and consumer agree on the contract without runtime coupling.
 *
 * All filtering and aggregation (window, categories, outlier cap, version-bump
 * exclusion) happens client-side over these rows — the export deliberately
 * ships every merged PR with just the five columns the pipeline reads.
 */

import type { Database } from "bun:sqlite";
import {
  repoDataFileName,
  type RepoDataFile,
  type RepoInfo,
  type ReposFile,
  type StatsRow,
} from "./frontend/types.ts";

/** The bundler entrypoint, resolved relative to this source file. */
const FRONTEND_ENTRYPOINT = new URL("./frontend/index.html", import.meta.url).pathname;

/**
 * All merged PRs of one repo, oldest first, with exactly the five columns the
 * stats pipeline reads. No window filter — the trailing-12-month window is
 * applied client-side at view time, so a generated site stays correct across
 * month boundaries (up to data staleness).
 */
export function fetchMergedPrRows(db: Database, repoId: number): StatsRow[] {
  const stmt = db.query<StatsRow, [number]>(
    `SELECT merged_at, ready_for_review_at, first_review_at, first_approval_at, title
       FROM pull_requests
      WHERE repo_id = ?
        AND merged_at IS NOT NULL
      ORDER BY merged_at`,
  );
  return stmt.all(repoId);
}

/** The tracked repos with their stored PR counts, as `repos.json` entries. */
export function listRepoInfos(db: Database): RepoInfo[] {
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
              (SELECT COUNT(*) FROM pull_requests p
                WHERE p.repo_id = r.id AND p.merged_at IS NOT NULL) AS pr_count
         FROM repos r
        ORDER BY r.owner, r.repo`,
    )
    .all();
  return rows.map((r) => ({
    slug: `${r.owner}/${r.repo}`,
    name: r.name,
    owner: r.owner,
    repo: r.repo,
    prCount: r.pr_count,
    lastSyncedAt: r.last_synced_at,
  }));
}

/** Options for {@link generateSite}. */
export interface GenerateOptions {
  /** An already-open database (read-only use). */
  db: Database;
  /** Output directory for the generated site. */
  outDir: string;
  /** Minify the bundled JS/CSS. Off by default. */
  minify?: boolean;
  /**
   * Write only `data/` (skip the frontend bundling). Used by the dev workflow:
   * `generate --data-only --out src/frontend` feeds `bun src/frontend/index.html`.
   */
  dataOnly?: boolean;
  /** The `generatedAt` stamp; injectable for deterministic tests. */
  now?: Date;
}

/** What {@link generateSite} did, for the CLI summary. */
export interface GenerateResult {
  repoCount: number;
  prCount: number;
}

/**
 * Generate the static site: write `data/repos.json` and one
 * `data/<owner>-<repo>.json` per tracked repo, then (unless `dataOnly`) bundle
 * the frontend into `outDir` with `Bun.build`. Directories are created as
 * needed; existing files are overwritten.
 */
export async function generateSite(options: GenerateOptions): Promise<GenerateResult> {
  const { db, outDir } = options;
  const repos = listRepoInfos(db);

  const index: ReposFile = {
    generatedAt: (options.now ?? new Date()).toISOString(),
    repos,
  };
  await Bun.write(`${outDir}/data/repos.json`, JSON.stringify(index));

  let prCount = 0;
  for (const repo of repos) {
    const id = db
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM repos WHERE owner = ? AND repo = ?`,
      )
      .get(repo.owner, repo.repo)!.id;
    const dataFile: RepoDataFile = { repo, pullRequests: fetchMergedPrRows(db, id) };
    prCount += dataFile.pullRequests.length;
    await Bun.write(
      `${outDir}/data/${repoDataFileName(repo.slug)}`,
      JSON.stringify(dataFile),
    );
  }

  if (!options.dataOnly) {
    const result = await Bun.build({
      entrypoints: [FRONTEND_ENTRYPOINT],
      outdir: outDir,
      minify: options.minify ?? false,
    });
    if (!result.success) {
      const details = result.logs.map((log) => String(log)).join("\n");
      throw new Error(`Frontend bundling failed:\n${details}`);
    }
  }

  return { repoCount: repos.length, prCount };
}
