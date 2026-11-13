/**
 * The static file server behind `npx` (bin/cli.mjs). It has no dependencies and serves a built dist/ with the same
 * headers as Vercel and Docker (bin/headers.mjs). It only serves the files it found at startup, so a request path
 * can never reach outside dist/. Loopback names and IP literals are always accepted as Host and any other name must
 * be listed, which stops DNS rebinding.
 */
import {createHash} from "node:crypto";
import {lstat, readFile, readdir} from "node:fs/promises";
import {createServer} from "node:http";
import {extname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {LOCAL_CONNECT_SOURCES, cacheControlFor, securityHeaders} from "./headers.mjs";

/** Content types for what Vite emits plus the public/ assets (fonts, logos, licence texts). */
export const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".wasm": "application/wasm",
});

const LOOPBACK_NAMES = new Set(["localhost"]);

/** The file the app fetches at boot (D8). The CLI's --config file stands in for it. */
export const RUNTIME_CONFIG_PATH = "/runtime-config.json";

/**
 * A file ready to serve.
 * @typedef {{body: Buffer, type: string, etag: string}} SiteFile
 */

/** @param {Buffer} body */
const etagOf = (body) => `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;

/** @param {string} path */
const typeOf = (path) => MIME[/** @type {keyof typeof MIME} */ (extname(path).toLowerCase())] ?? "application/octet-stream";

/**
 * Read a built site into memory, keyed by URL path ("/index.html"). Symlinks are refused, so the site is exactly
 * the files in the directory.
 * @param {string | URL} where a directory path or file: URL
 * @returns {Promise<Map<string, SiteFile>>}
 */
export async function loadSite(where) {
  const dir = where instanceof URL ? fileURLToPath(where) : where;
  /** @type {Map<string, SiteFile>} */
  const files = new Map();
  /** @param {string} abs @param {string} prefix */
  const walk = async (abs, prefix) => {
    for (const name of await readdir(abs)) {
      const path = join(abs, name);
      const st = await lstat(path);
      if (st.isSymbolicLink()) throw new Error(`${path} is a symlink; the served site must be plain files.`);
      if (st.isDirectory()) await walk(path, `${prefix}${name}/`);
      else if (st.isFile()) {
        const body = await readFile(path);
        files.set(`${prefix}${name}`, {body, type: typeOf(name), etag: etagOf(body)});
      }
    }
  };
  await walk(dir, "/");
  if (!files.has("/index.html")) throw new Error(`${dir} has no index.html. Run \`pnpm build\` first.`);
  return files;
}

/**
 * Whether a request's Host header is one this server answers for.
 * @param {string | undefined} hostHeader
 * @param {readonly string[]} allowedHosts lowercase names; "*" accepts any
 * @returns {boolean}
 */
export function hostAllowed(hostHeader, allowedHosts) {
  if (allowedHosts.includes("*")) return true;
  const host = (hostHeader ?? "").trim().toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  // DNS rebinding always arrives with a domain name, so an IP literal is someone browsing to this address directly.
  const ipLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^\[[0-9a-f:.]+\]$/.test(name);
  return ipLiteral || LOOPBACK_NAMES.has(name) || name.endsWith(".localhost") || allowedHosts.includes(name);
}

/**
 * The decoded URL path, or null when it is not one this server could ever serve (bad escapes, NUL, dot segments,
 * backslashes).
 * @param {string | undefined} url
 * @returns {string | null}
 */
export function requestPath(url) {
  const raw = (url ?? "/").split(/[?#]/, 1)[0] ?? "/";
  let path;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\")) return null;
  if (path.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return path === "/" ? "/index.html" : path;
}

/**
 * Options for createHandler.
 * @typedef {object} HandlerOptions
 * @property {Map<string, SiteFile>} files from loadSite
 * @property {string | URL | null} [configFile] served as /runtime-config.json, re-read on every request
 * @property {readonly string[]} [allowedHosts] extra Host names (lowercase); "*" accepts any
 * @property {readonly string[]} [extraConnect] extra connect-src sources (default: this machine's http ports)
 */

/**
 * The request handler: GET and HEAD only, the shared security headers on every response, immutable caching for
 * assets/ and revalidation for everything else, ETag / 304.
 * @param {HandlerOptions} opts
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void}
 */
export function createHandler(opts) {
  const headers = securityHeaders({extraConnect: opts.extraConnect ?? LOCAL_CONNECT_SOURCES});
  const allowed = (opts.allowedHosts ?? []).map((h) => h.toLowerCase());
  /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} text @param {Record<string, string>} [more] */
  const plain = (res, status, text, more = {}) => {
    const body = Buffer.from(`${text}\n`);
    res.writeHead(status, {...headers, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length, ...more});
    res.end(body);
  };

  /** @param {string} path @returns {Promise<SiteFile | undefined>} */
  const lookup = async (path) => {
    if (path === RUNTIME_CONFIG_PATH && opts.configFile) {
      try {
        const body = await readFile(opts.configFile);
        return {body, type: MIME[".json"], etag: etagOf(body)};
      } catch {
        return undefined; // 404: the app falls back to its built-in defaults
      }
    }
    return opts.files.get(path);
  };

  return (req, res) => {
    if (!hostAllowed(req.headers.host, allowed)) return plain(res, 403, "Forbidden: unknown Host header (see --allowed-host).");
    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "Method not allowed.", {Allow: "GET, HEAD"});
    const path = requestPath(req.url);
    if (!path) return plain(res, 400, "Bad request.");
    lookup(path).then(
      (file) => {
        if (!file) return plain(res, 404, "Not found.");
        const common = {...headers, "Cache-Control": cacheControlFor(path), ETag: file.etag};
        if (req.headers["if-none-match"] === file.etag) {
          res.writeHead(304, common);
          return res.end();
        }
        res.writeHead(200, {...common, "Content-Type": file.type, "Content-Length": file.body.length});
        res.end(req.method === "HEAD" ? undefined : file.body);
      },
      () => plain(res, 500, "Internal error."),
    );
  };
}

/**
 * Options for startServer.
 * @typedef {HandlerOptions & {port: number, host: string}} ServerOptions
 */

/**
 * Listen and resolve once bound. `port: 0` picks a free port (tests). Rejects with the listen error, such as
 * EADDRINUSE, instead of trying another port: the origin (host + port) owns the app's local swap history, so it
 * must not change silently.
 * @param {ServerOptions} opts
 * @returns {Promise<{server: import("node:http").Server, url: string}>}
 */
export function startServer(opts) {
  const server = createServer(createHandler(opts));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({server, url: `http://${browseHost(opts.host)}:${port}/`});
    });
  });
}

/**
 * The host to put in the printed / opened URL: a wildcard bind is reached via 127.0.0.1 (a secure context), and
 * IPv6 literals need brackets.
 * @param {string} host
 * @returns {string}
 */
export function browseHost(host) {
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Loopback binds keep the page a secure context over plain http. Any other address makes it insecure, and NEAR,
 * Chainflip and Solana quotes need crypto.randomUUID / crypto.subtle.
 * @param {string} host
 * @returns {boolean}
 */
export function isLoopbackHost(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
}
