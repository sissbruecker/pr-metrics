import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFetchHandler, resolveStaticPath } from "../src/server.ts";

// A throwaway site directory: an index, a stylesheet, a data file, and a
// secret OUTSIDE the served root that traversal attempts aim for.
const base = mkdtempSync(join(tmpdir(), "pr-stats-serve-"));
const site = join(base, "site");
mkdirSync(join(site, "data"), { recursive: true });
writeFileSync(join(site, "index.html"), "<!doctype html><title>t</title>");
writeFileSync(join(site, "styles.css"), "body {}");
writeFileSync(join(site, "data", "repos.json"), JSON.stringify({ repos: [] }));
writeFileSync(join(base, "secret.txt"), "top secret");

afterAll(() => rmSync(base, { recursive: true, force: true }));

const handler = createFetchHandler(site);

describe("static file serving", () => {
  test("/ serves index.html as text/html", async () => {
    const res = await handler(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toStartWith("text/html");
    expect(await res.text()).toContain("<title>t</title>");
  });

  test("a known file is served with its content type", async () => {
    const css = await handler(new Request("http://x/styles.css"));
    expect(css.status).toBe(200);
    expect(css.headers.get("Content-Type")).toStartWith("text/css");

    const json = await handler(new Request("http://x/data/repos.json"));
    expect(json.status).toBe(200);
    expect(json.headers.get("Content-Type")).toStartWith("application/json");
    expect(await json.json()).toEqual({ repos: [] });
  });

  test("an unknown path → 404", async () => {
    const res = await handler(new Request("http://x/nope.js"));
    expect(res.status).toBe(404);
  });

  test("a directory path without index.html → 404", async () => {
    const res = await handler(new Request("http://x/data/"));
    expect(res.status).toBe(404);
  });

  test("non-GET → 405", async () => {
    const res = await handler(new Request("http://x/", { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });
});

describe("path traversal", () => {
  test("percent-encoded .. cannot escape the site directory", async () => {
    // Plain "/../" is normalized away by URL parsing before it ever reaches
    // the handler; the encoded form survives into the pathname, so it is the
    // real attack surface.
    const res = await handler(new Request("http://x/%2e%2e/secret.txt"));
    expect(res.status).toBe(404);
  });

  test("resolveStaticPath rejects escapes and malformed encoding", () => {
    expect(resolveStaticPath(site, "/../secret.txt")).toBeNull();
    expect(resolveStaticPath(site, "/a/../../secret.txt")).toBeNull();
    expect(resolveStaticPath(site, "/%zz")).toBeNull();
    expect(resolveStaticPath(site, "/styles.css")).toBe(join(site, "styles.css"));
    expect(resolveStaticPath(site, "/")).toBe(join(site, "index.html"));
  });
});
