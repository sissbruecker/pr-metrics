# Vendored assets

## chart.umd.js

- **Library:** Chart.js
- **Version:** 4.4.1
- **Source:** https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js
- **Build:** UMD bundle (`dist/chart.umd.js`)

Checked into the repo so the UI loads charting locally — no CDN dependency at
runtime. Imported by `main.ts` (the bundler exposes the UMD's `module.exports`
as the default export) and bundled into the generated site's main chunk.

To update, re-download the same UMD build at a new pinned version and update the
version/URL above.
