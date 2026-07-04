/**
 * Static file server for the generated site.
 *
 * A thin `Bun.serve` wrapper that serves the output of `pr-stats generate`
 * (see `src/generate.ts`) — nothing else. There is no API layer: the frontend
 * fetches the generated JSON data files as plain static assets. The server
 * exists because the app loads data via `fetch`, which `file://` pages can't
 * do; any static host works just as well in production.
 *
 * GET only (any other method → 405). A request path is resolved against the
 * site directory with a resolve + prefix check, so path traversal (including
 * percent-encoded `..`) cannot escape it; `/` and other directory paths map to
 * their `index.html`. Unknown paths return 404. Content types come from
 * `Bun.file`'s extension-based detection.
 */

import { resolve, sep } from "node:path";

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /** Directory containing the generated site (the `generate` output). */
  dir: string;
  /** TCP port to bind. Defaults to `3000`. */
  port?: number;
  /** Hostname to bind. Defaults to Bun's default (all interfaces). */
  hostname?: string;
}

/**
 * Resolve a request pathname to a file path inside `dir`, or null when the
 * path is malformed or escapes the directory. Directory paths (trailing `/`,
 * including `/` itself) resolve to their `index.html`. Purely lexical — the
 * caller still has to check the file exists.
 */
export function resolveStaticPath(dir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return null;
  if (decoded.endsWith("/")) decoded += "index.html";

  const root = resolve(dir);
  const filePath = resolve(root, `.${sep}${decoded.replaceAll("/", sep)}`);
  // The prefix check is what makes traversal impossible: whatever `..` games
  // the (decoded) path plays, the resolved result must stay under the root.
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

/**
 * The core request handler — exported so it can be unit-tested directly with a
 * synthetic `Request` and no live socket.
 */
export function createFetchHandler(dir: string): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const filePath = resolveStaticPath(dir, new URL(req.url).pathname);
    if (filePath !== null) {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    }
    return new Response("Not found", { status: 404 });
  };
}

/**
 * Create and start the static file server over `options.dir`. The returned
 * `Server` has a `.fetch(req)` you can call directly without a network
 * round-trip.
 */
export function createServer(options: CreateServerOptions): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: options.port ?? 3000,
    hostname: options.hostname,
    fetch: createFetchHandler(options.dir),
  });
}
