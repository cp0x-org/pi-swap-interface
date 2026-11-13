// @vitest-environment node
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {parseCliArgs} from "../../../bin/cli.mjs";
import {LOCAL_CONNECT_SOURCES, contentSecurityPolicy, securityHeaders} from "../../../bin/headers.mjs";
import {browseHost, createHandler, hostAllowed, isLoopbackHost, loadSite, requestPath, startServer} from "../../../bin/server.mjs";
import type {ServerHandle, SiteFile} from "../../../bin/server.mjs";

const SITE = new URL("./fixtures/site/", import.meta.url);
const CONFIG = new URL("./fixtures/runtime-config.json", import.meta.url);

/** Drive the handler without a socket: enough to check status and headers for any Host header. */
function call(handler: ReturnType<typeof createHandler>, req: {method?: string; url?: string; host?: string; ifNoneMatch?: string}) {
  return new Promise<{status: number; headers: Record<string, string | number>; body: string}>((resolve) => {
    let status = 0;
    let headers: Record<string, string | number> = {};
    handler(
      {method: req.method ?? "GET", url: req.url ?? "/", headers: {host: req.host ?? "127.0.0.1:4173", "if-none-match": req.ifNoneMatch}},
      {
        writeHead(s, h) {
          status = s;
          headers = h ?? {};
        },
        end(body) {
          resolve({status, headers, body: body ? new TextDecoder().decode(body) : ""});
        },
      },
    );
  });
}

describe("requestPath", () => {
  it("maps / to index.html and strips the query and fragment", () => {
    expect(requestPath("/")).toBe("/index.html");
    expect(requestPath("/?demo=1")).toBe("/index.html");
    expect(requestPath("/assets/a.js?v=1#x")).toBe("/assets/a.js");
    expect(requestPath("/logos/a%20b.svg")).toBe("/logos/a b.svg");
  });

  it("refuses traversal, NUL, backslashes and bad escapes", () => {
    for (const bad of ["/../package.json", "/%2e%2e/package.json", "/assets/../../x", "/a/./b", "/%00", "/a\\b", "/%E0%A4%A", "relative"])
      expect(requestPath(bad), bad).toBeNull();
  });
});

describe("hostAllowed", () => {
  it("accepts loopback names and IP literals, refuses unknown names (DNS rebinding)", () => {
    for (const ok of ["127.0.0.1:4173", "localhost:4173", "LOCALHOST", "[::1]:4173", "app.localhost:1", "192.168.1.20:4173"]) expect(hostAllowed(ok, []), ok).toBe(true);
    for (const bad of ["evil.example:4173", "localhost.evil.example", "", undefined]) expect(hostAllowed(bad, []), String(bad)).toBe(false);
  });

  it("accepts listed names, or any with *", () => {
    expect(hostAllowed("swap.example.org", ["swap.example.org"])).toBe(true);
    expect(hostAllowed("swap.example.org:443", ["swap.example.org"])).toBe(true);
    expect(hostAllowed("other.example.org", ["swap.example.org"])).toBe(false);
    expect(hostAllowed("anything.example", ["*"])).toBe(true);
  });
});

describe("handler", () => {
  let files: Map<string, SiteFile>;
  beforeAll(async () => {
    files = await loadSite(SITE);
  });

  it("loads every fixture file keyed by URL path", () => {
    expect([...files.keys()].sort()).toEqual(["/assets/app-abc123.js", "/index.html", "/logos/mark.svg"]);
  });

  it("serves index.html with the shared headers, local connect-src and revalidation", async () => {
    const r = await call(createHandler({files}), {url: "/"});
    expect(r.status).toBe(200);
    expect(r.body).toContain("<title>fixture</title>");
    expect(r.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["Cache-Control"]).toBe("no-cache");
    const {"Content-Security-Policy": _csp, ...rest} = securityHeaders();
    expect(r.headers).toMatchObject(rest);
    expect(r.headers["Content-Security-Policy"]).toBe(contentSecurityPolicy({extraConnect: LOCAL_CONNECT_SOURCES}));
  });

  it("caches assets/ forever and answers 304 to a matching ETag", async () => {
    const h = createHandler({files});
    const first = await call(h, {url: "/assets/app-abc123.js"});
    expect(first.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(first.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    const again = await call(h, {url: "/assets/app-abc123.js", ifNoneMatch: String(first.headers.ETag)});
    expect(again.status).toBe(304);
    expect(again.body).toBe("");
  });

  it("answers HEAD without a body, and refuses other methods with 405", async () => {
    const h = createHandler({files});
    const head = await call(h, {method: "HEAD", url: "/logos/mark.svg"});
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["Content-Type"]).toBe("image/svg+xml");
    const post = await call(h, {method: "POST", url: "/"});
    expect(post.status).toBe(405);
    expect(post.headers.Allow).toBe("GET, HEAD");
  });

  it("puts the security headers on errors too, and refuses a foreign Host", async () => {
    const h = createHandler({files});
    const missing = await call(h, {url: "/nope.js"});
    expect(missing.status).toBe(404);
    expect(missing.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect((await call(h, {url: "/%2e%2e/package.json"})).status).toBe(400);
    expect((await call(h, {host: "evil.example"})).status).toBe(403);
    expect((await call(createHandler({files, allowedHosts: ["Swap.Example.org"]}), {host: "swap.example.org"})).status).toBe(200);
  });

  it("runtime-config.json: 404 by default (the app keeps its defaults), the --config file when given", async () => {
    expect((await call(createHandler({files}), {url: "/runtime-config.json"})).status).toBe(404);
    const r = await call(createHandler({files, configFile: CONFIG}), {url: "/runtime-config.json"});
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({demo: true});
    expect(r.headers["Cache-Control"]).toBe("no-cache");
    const gone = await call(createHandler({files, configFile: new URL("./missing.json", CONFIG)}), {url: "/runtime-config.json"});
    expect(gone.status).toBe(404);
  });
});

describe("startServer", () => {
  let handle: ServerHandle;
  beforeAll(async () => {
    handle = await startServer({files: await loadSite(SITE), port: 0, host: "127.0.0.1"});
  });
  afterAll(() => new Promise<void>((done) => void handle.server.close(() => done())));

  it("serves over real HTTP on 127.0.0.1", async () => {
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("fixture");
  });
});

describe("cli args", () => {
  it("defaults to 127.0.0.1:4370 (not Vite's preview 4173), the bundled dist/ and opening the browser", () => {
    const o = parseCliArgs([]);
    expect(o).toMatchObject({port: 4370, host: "127.0.0.1", configFile: null, allowedHosts: [], openBrowser: true, help: false});
    expect(o.dir.replaceAll("\\", "/")).toMatch(/\/dist\/?$/);
  });

  it("parses every option", () => {
    const o = parseCliArgs(["--port", "5000", "--host", "0.0.0.0", "--no-browser", "--allowed-host", "a.example", "--allowed-host", "b.example", "--config", "cfg.json"]);
    expect(o).toMatchObject({port: 5000, host: "0.0.0.0", openBrowser: false, allowedHosts: ["a.example", "b.example"]});
    expect(o.configFile?.replaceAll("\\", "/")).toMatch(/\/cfg\.json$/);
  });

  it("rejects a bad port and unknown flags", () => {
    expect(() => parseCliArgs(["--port", "70000"])).toThrow(/--port/);
    expect(() => parseCliArgs(["--port", "abc"])).toThrow(/--port/);
    expect(() => parseCliArgs(["--bogus"])).toThrow();
  });

  it("opens a wildcard bind through 127.0.0.1 and flags non-loopback binds", () => {
    expect(browseHost("0.0.0.0")).toBe("127.0.0.1");
    expect(browseHost("::1")).toBe("[::1]");
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
  });
});
