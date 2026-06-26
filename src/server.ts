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
 *   GET /api/stats?repo=<id>
 *     Resolve the repo by `repos.id` and return the aggregated trailing-12-month
 *     buckets from `computeStats` as JSON. The response carries BOTH the
 *     per-month "All" totals and the per-category breakdown plus the
 *     approximate-TTM count, so a single request covers every UI view mode (the
 *     UI toggles client-side).
 *       - missing / non-numeric `repo` → 400
 *       - unknown repo id              → 404
 *
 *   GET /api/repos
 *     A tiny supporting read endpoint (NOT a second stats endpoint): returns the
 *     tracked repos with their stored PR count so the UI's repo selector can be
 *     populated. Read-only.
 *
 *   GET /<path>
 *     Serve a static file from the UI assets directory (`src/ui/`). `/` maps to
 *     `index.html`. Returns 404 when the file does not exist. Path traversal
 *     (`..` escaping the UI directory) is rejected with 403. This is where the
 *     vendored Chart.js (`/chart.umd.js`) is served from.
 *
 * `index.html` / `app.js` are produced by a later task; until then `/` simply
 * 404s, but the static-serving machinery and the vendored Chart.js asset work.
 */

import type { Database } from "bun:sqlite";
import { openDb, type RepoRow } from "./db.ts";
import { computeStats } from "./stats.ts";

/** Directory holding the static UI assets, resolved relative to this module. */
const UI_DIR = new URL("./ui/", import.meta.url).pathname;

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
  return json(computeStats(db, repoId));
}

/**
 * Resolve a request pathname to a file under the UI directory, or null if it
 * would escape that directory (path traversal). `/` resolves to `index.html`.
 */
export function resolveStaticPath(pathname: string): string | null {
  // Decode percent-encoding (e.g. %2e%2e) before the traversal check.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Reject any segment that is exactly `..` — the simplest robust guard.
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) return null;

  const rel = segments.length === 0 ? "index.html" : segments.join("/");
  const full = UI_DIR + rel;
  // Defense in depth: the resolved path must stay within UI_DIR.
  if (!full.startsWith(UI_DIR)) return null;
  return full;
}

/** Handle a static-file request. */
async function handleStatic(pathname: string): Promise<Response> {
  const filePath = resolveStaticPath(pathname);
  if (filePath === null) {
    return errorResponse(403, "Forbidden");
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return errorResponse(404, "Not found");
  }
  const contentType = contentTypeFor(filePath);
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
