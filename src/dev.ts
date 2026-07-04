/**
 * Frontend dev server with hot reload. Dev-only, not a CLI subcommand:
 *
 *   bun run src/index.ts generate --data-only --out src/frontend
 *   bun run dev
 *
 * Bun's bare `bun src/frontend/index.html` dev server can't be used instead —
 * it answers EVERY route with the HTML entrypoint (SPA fallback), including
 * `/data/*.json`, so the app's data fetches would get HTML back. This wrapper
 * keeps the same bundled-HTML dev experience but serves the generated data
 * files from `src/frontend/data/` (gitignored) alongside it.
 */

import index from "./frontend/index.html";

const server = Bun.serve({
  port: 3000,
  development: { hmr: true, console: true },
  routes: {
    // More specific routes win: data files are read from disk, everything
    // else falls back to the bundled app shell.
    "/data/:file": (req: Bun.BunRequest<"/data/:file">) => {
      const file = Bun.file(
        new URL(`./frontend/data/${req.params.file}`, import.meta.url).pathname,
      );
      return file.exists().then((ok) =>
        ok
          ? new Response(file)
          : new Response(
              "Data file not found. Run: bun run src/index.ts generate --data-only --out src/frontend",
              { status: 404 },
            ),
      );
    },
    "/*": index,
  },
});

console.log(`pr-stats dev server (HMR) on ${server.url.href}`);
