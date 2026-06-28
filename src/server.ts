/**
 * Read-only web server.
 *
 * A thin `Bun.serve` wrapper with a small hand-rolled route switch (no web
 * framework). It is strictly query-only: it opens / receives an already-open
 * SQLite database and NEVER issues a write (no INSERT/UPDATE/DELETE). The CLI
 * `serve` command launches it; tests can drive it with an in-memory database.
 *
 * Routes (GET only; any other method → 405):
 *
 *   GET /api/stats?repo=<id>[&thresholdDays=<days>][&categories=<csv>]
 *     Resolve the repo by `repos.id` and return the aggregated trailing-12-month
 *     stats from `computeStats` as JSON: per month a shared `count` plus a
 *     `timeToMerge`, `timeToFirstReview`, and `timeToApproval` metric bucket
 *     ({median, mean, excludedCount}). Optional `thresholdDays` is the outlier
 *     cap (in days) shared by every metric. Optional `categories` is a
 *     comma-separated subset of the known categories; when present, only those
 *     categories' PRs feed the metrics (empty string → none). When absent, all
 *     categories are included.
 *       - missing / non-numeric `repo`           → 400
 *       - invalid `thresholdDays` / `categories` → 400
 *       - unknown repo id                        → 404
 *
 *   GET /api/repos
 *     A tiny supporting read endpoint (NOT a second stats endpoint): returns the
 *     tracked repos with their stored PR count so the UI's repo selector can be
 *     populated. Read-only.
 *
 *   GET /api/categories
 *     The canonical category list (the static `CATEGORIES` constant) for the UI's
 *     category filter. Independent of any repo or stats query. Read-only.
 *
 *   GET /<path>
 *     Serve one of a fixed set of embedded UI assets. `/` maps to `index.html`.
 *     Any path that is not a known asset returns 404. The assets are embedded
 *     into the module (see `STATIC_ASSETS`) so they are served identically under
 *     `bun run` and from a `bun build --compile` standalone binary. This is where
 *     the vendored Chart.js (`/chart.umd.js`) is served from.
 */

import type { Database } from "bun:sqlite";
import { openDb, type RepoRow } from "./db.ts";
import { computeStats, SECONDS_PER_DAY } from "./stats.ts";
import { CATEGORIES, type Category } from "./categorize.ts";
import { DEFAULT_OUTLIER_THRESHOLD_DAYS } from "./config.ts";

// Embed the UI assets into the module. With `with { type: "file" }`, Bun copies
// each asset into a `--compile` standalone binary AND resolves it on disk under
// `bun run`; the imported value is a path that `Bun.file(...)` can open in both
// modes. This is what lets the compiled binary serve the UI with no `src/ui/`
// directory present on disk.
import indexHtml from "./ui/index.html" with { type: "file" };
import stylesCss from "./ui/styles.css" with { type: "file" };
import chartJs from "./ui/chart.umd.js" with { type: "file" };
// app.js / format.js are real JS modules on disk, so TypeScript (with allowJs)
// types them by their source exports rather than as a `type: "file"` string. A
// namespace import sidesteps that — at runtime the `file` import exposes only a
// `default` holding the embedded asset's path.
import * as appJsAsset from "./ui/app.js" with { type: "file" };
import * as formatJsAsset from "./ui/format.js" with { type: "file" };
const appJs = (appJsAsset as unknown as { default: string }).default;
const formatJs = (formatJsAsset as unknown as { default: string }).default;

/**
 * The static assets the server will serve, keyed by request path. `/` serves
 * the app shell. Because only these known paths are served, path traversal is
 * impossible — an unknown path simply 404s.
 *
 * Each value is the embedded asset's file path. At runtime Bun gives these
 * `type: "file"` imports a string path; TypeScript types them as their on-disk
 * module shape (or `HTMLBundle`), so we coerce to `string` here.
 */
const STATIC_ASSETS: Record<string, string> = {
  "/": indexHtml as unknown as string,
  "/index.html": indexHtml as unknown as string,
  "/app.js": appJs,
  "/format.js": formatJs,
  "/styles.css": stylesCss as unknown as string,
  "/chart.umd.js": chartJs as unknown as string,
};

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /** An already-open database. Mutually exclusive with `dbPath`. */
  db?: Database;
  /** Path to a SQLite DB file to open (e.g. `":memory:"`). */
  dbPath?: string;
  /** TCP port to bind. Defaults to `3000`. */
  port?: number;
  /** Hostname to bind. Defaults to Bun's default (all interfaces). */
  hostname?: string;
}

/** A repo plus its stored PR count, as returned by `GET /api/repos`. */
interface RepoListEntry {
  id: number;
  name: string;
  owner: string;
  repo: string;
  last_synced_at: string | null;
  pr_count: number;
}

/** Build a JSON `Response` with the right content type. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Build a small JSON error `Response`. */
function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

/**
 * Map a file extension to a Content-Type. Bun.file infers many types, but we
 * set the common UI ones explicitly so `.js` is `text/javascript` (Bun may
 * report `application/javascript`) and unusual extensions still get something
 * reasonable.
 */
function contentTypeFor(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf(".");
  const ext = dot === -1 ? "" : pathname.slice(dot).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return undefined;
  }
}

/** Query the tracked repos with their stored PR counts (read-only). */
function listRepos(db: Database): RepoListEntry[] {
  const stmt = db.query<RepoListEntry, []>(
    `SELECT r.id, r.name, r.owner, r.repo, r.last_synced_at,
            (SELECT COUNT(*) FROM pull_requests p WHERE p.repo_id = r.id) AS pr_count
       FROM repos r
      ORDER BY r.owner, r.repo`,
  );
  return stmt.all();
}

/** Look up a single repo by id, or null if it does not exist (read-only). */
function findRepo(db: Database, id: number): RepoRow | null {
  const stmt = db.query<RepoRow, [number]>(`SELECT * FROM repos WHERE id = ?`);
  return stmt.get(id) ?? null;
}

/** Handle `GET /api/stats`. */
function handleStats(db: Database, url: URL): Response {
  const repoParam = url.searchParams.get("repo");
  if (repoParam === null || repoParam.trim() === "") {
    return errorResponse(400, "Missing required query parameter: repo");
  }
  const repoId = Number(repoParam);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return errorResponse(400, `Invalid repo id: ${repoParam}`);
  }
  if (findRepo(db, repoId) === null) {
    return errorResponse(404, `Unknown repo id: ${repoId}`);
  }

  // Optional outlier threshold, in days, shared by every metric. Absent → use
  // the default cap.
  let thresholdSeconds = DEFAULT_OUTLIER_THRESHOLD_DAYS * SECONDS_PER_DAY;
  const thresholdDaysParam = url.searchParams.get("thresholdDays");
  if (thresholdDaysParam !== null) {
    const thresholdDays = Number(thresholdDaysParam);
    if (!Number.isInteger(thresholdDays) || thresholdDays < 1) {
      return errorResponse(
        400,
        `Invalid thresholdDays: ${thresholdDaysParam}. Expected an integer >= 1.`,
      );
    }
    thresholdSeconds = thresholdDays * SECONDS_PER_DAY;
  }

  // Optional category filter, comma-separated. Absent → all categories. An empty
  // string is a valid "none selected" (yields all-empty months). Any unknown
  // name is a client error.
  let includedCategories: Set<Category> | undefined;
  const categoriesParam = url.searchParams.get("categories");
  if (categoriesParam !== null) {
    const names = categoriesParam === "" ? [] : categoriesParam.split(",");
    const known = new Set<string>(CATEGORIES);
    for (const name of names) {
      if (!known.has(name)) {
        return errorResponse(400, `Unknown category: ${name}`);
      }
    }
    includedCategories = new Set(names as Category[]);
  }

  return json(computeStats(db, repoId, undefined, thresholdSeconds, includedCategories));
}

/**
 * Resolve a request pathname to an embedded asset's file path, or null if no
 * asset is registered for that path. `/` resolves to `index.html`. Only the
 * fixed `STATIC_ASSETS` paths resolve, so path traversal cannot occur.
 */
export function resolveStaticPath(pathname: string): string | null {
  return STATIC_ASSETS[pathname] ?? null;
}

/** Handle a static-file request. */
async function handleStatic(pathname: string): Promise<Response> {
  const filePath = resolveStaticPath(pathname);
  if (filePath === null) {
    return errorResponse(404, "Not found");
  }
  // Use the request path (not the on-disk path) for the content type: under
  // `--compile`, embedded asset paths may not carry the original extension.
  const contentType = contentTypeFor(pathname === "/" ? "index.html" : pathname);
  const file = Bun.file(filePath);
  const headers = contentType ? { "Content-Type": contentType } : undefined;
  return new Response(file, headers ? { headers } : undefined);
}

/**
 * The core request handler — exported so it can be unit-tested directly with a
 * synthetic `Request` and no live socket.
 */
export function createFetchHandler(
  db: Database,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    switch (url.pathname) {
      case "/api/stats":
        return handleStats(db, url);
      case "/api/repos":
        return json(listRepos(db));
      case "/api/categories":
        return json([...CATEGORIES]);
      default:
        return handleStatic(url.pathname);
    }
  };
}

/**
 * Create and start the read-only web server.
 *
 * Provide either an already-open `db` (preferred for tests / the CLI, which
 * owns the connection) or a `dbPath` to open here. The returned `Server` has a
 * `.fetch(req)` you can call directly without a network round-trip.
 */
export function createServer(
  options: CreateServerOptions,
): ReturnType<typeof Bun.serve> {
  const db = options.db ?? openDb(options.dbPath ?? ":memory:");
  const handler = createFetchHandler(db);
  return Bun.serve({
    port: options.port ?? 3000,
    hostname: options.hostname,
    fetch: handler,
  });
}
