#!/usr/bin/env node
/**
 * Checks a built dist/ against the privacy and CSP promises (ARCHITECTURE.md D13, D24, D30). Exits 1 on a violation.
 * - index.html: no inline scripts, every script and stylesheet same-origin and relative (so it works under a
 *   sub-path and an IPFS CID), and a <meta> CSP, if present, equal to the shared one.
 * - no analytics, tracker or error-reporter endpoints anywhere in the bundle — except, in a build made with
 *   VITE_CP0X_API (`--api`), the one bare literal "/_vercel/insights/script.js" of the hosted page-view count (D31);
 * - no cp0x backend host: a build without VITE_CP0X_API (IPFS, npx, Docker, a plain `pnpm build`) must hold none.
 *   A build made with it (the hosted one, Standard mode) may hold exactly that origin — pass it with `--api` — and
 *   nothing else cp0x, and only ONCE, as the bare string literal the VITE_CP0X_API define emits (`"https://…"`):
 *   every proxy URL is built from it at run time (connection.ts standardSlots, used only in Standard mode and as
 *   health allows). So `<origin>/…` anywhere — a proxy URL an operator put in VITE_SWAP_CONFIG or in a
 *   runtime-config.json inside dist — fails, and so does a second copy. The guard also checks the origin really is
 *   in the bundle (the env reached the build);
 * - CSS loads no remote fonts or images;
 * - tonconnect-manifest.json (D11) names the page to TON wallets: its `url` and `iconUrl` may be the hosted page's
 *   own origin (a cp0x host), which the wallet fetches and the page never does — nothing else in it, and nowhere else.
 * eval / new Function / WebAssembly are only reported, since they may sit in a dependency's dead code. A live use
 * is blocked by the CSP, and the e2e run under that CSP catches it.
 *
 *   node .github/scripts/guard-dist.mjs [dist] [--api <origin> | --no-api]
 *
 * Without either flag the build's own VITE_CP0X_API, if the environment has one, is the allowed origin: on Vercel
 * (`vercel deploy --build-env VITE_CP0X_API=…` runs `pnpm build && pnpm guard:dist`) the guard checks the very
 * build it deploys, and anywhere without the variable it allows no cp0x host at all. `--no-api` allows none
 * whatever the environment says: the IPFS release, CI's plain build and `npm pack` (prepack) use it.
 */
import {readFile, readdir} from "node:fs/promises";
import {extname, join, relative} from "node:path";
import {contentSecurityPolicy} from "../../bin/headers.mjs";

const args = process.argv.slice(2);
const noApi = args.includes("--no-api");
if (noApi) args.splice(args.indexOf("--no-api"), 1);
const apiAt = args.indexOf("--api");
const apiArg = apiAt >= 0 ? args.splice(apiAt, 2)[1] : noApi ? undefined : process.env.VITE_CP0X_API?.trim() || undefined;
const dist = args[0] ?? "dist";
const problems = [];
const notes = [];

/** The one cp0x origin a Standard build may hold (https, or http on localhost / 127.0.0.1 — vite.config.ts's rule). */
function allowedApi(raw) {
  if (raw === undefined) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  const ok = u && (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) && u.pathname === "/" && !u.search && !u.username;
  if (!ok) {
    console.error(`dist guard: --api ${raw} is not an https origin`);
    process.exit(1);
  }
  return u.origin;
}
const api = allowedApi(apiArg);
/** Where the allowed origin was seen as the bare literal (file names); more than one is a problem. */
const apiLiterals = [];
const QUOTES = new Set(['"', "'", "`"]);

/**
 * `raw` with every occurrence of the allowed origin taken out, after checking each: only the bare string literal
 * (`"<origin>"`, '…' or `…`) is allowed; anything longer (`<origin>/api/…`, `<origin>.evil.example`, an escaped
 * copy inside a JSON string) is a problem.
 */
function takeApiOut(raw, rel) {
  if (!api) return raw;
  const parts = raw.split(api);
  for (let i = 0; i < parts.length - 1; i++) {
    const before = parts[i].at(-1) ?? "";
    const after = parts[i + 1][0] ?? "";
    if (QUOTES.has(before) && after === before) apiLiterals.push(rel);
    else problems.push(`${rel}: ${api} inside a longer string (…${(parts[i].slice(-24) + api + parts[i + 1].slice(0, 40)).replace(/\s+/g, " ")}…) — only the VITE_CP0X_API literal may hold it; Standard builds its proxy URLs at run time, so never put them in VITE_SWAP_CONFIG or runtime-config.json`);
  }
  return parts.join("");
}

/** Endpoints of analytics, session replay, ad and error-reporting services. */
const TRACKERS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "sentry.io",
  "ingest.sentry",
  "segment.io",
  "segment.com/analytics",
  "mixpanel.com",
  "posthog.com",
  "hotjar.com",
  "amplitude.com",
  "datadoghq",
  "plausible.io",
  "fullstory.com",
  "logrocket",
  "clarity.ms",
  "/_vercel/insights",
  "/_vercel/speed-insights",
  "vitals.vercel-insights.com",
  "cca-lite.coinbase.com",
];
/** The hosted build's page-view script (src/config/analytics.ts, D31): allowed with `--api` only, as one bare literal. */
const ANALYTICS_SCRIPT = "/_vercel/insights/script.js";
const analyticsLiterals = [];

/** `text` without the analytics script's bare literals (`--api` only), counting them; any other copy stays a tracker. */
function takeAnalyticsOut(text, rel) {
  if (!api) return text;
  let out = text;
  for (const q of QUOTES) {
    const lit = `${q}${ANALYTICS_SCRIPT}${q}`;
    for (let i = out.indexOf(lit); i >= 0; i = out.indexOf(lit)) {
      analyticsLiterals.push(rel);
      out = out.slice(0, i) + out.slice(i + lit.length);
    }
  }
  return out;
}

/** cp0x backends. Links to cp0x pages are fine, but a request to a cp0x API is not. */
const CP0X_BACKENDS = [/cp0x-api/i, /\bapi\.cp0x\./i, /\/api\/v[0-9]+\/logo\/cmc/i];
/** Any URL whose host names cp0x (after the allowed origin, if any, is taken out). */
const CP0X_URL = /\b(?:https?|wss?):\/\/([a-z0-9.-]*cp0x[a-z0-9.-]*)/gi;

/** The TON Connect manifest beside index.html: exactly {url, name, iconUrl}, https, the icon on the url's origin. */
const TON_MANIFEST = "tonconnect-manifest.json";

/** The manifest's page origin (its CP0X_URL exemption), or null after recording why the file is refused. */
function tonManifestOrigin(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    problems.push(`${TON_MANIFEST}: not JSON`);
    return null;
  }
  const keys = m && typeof m === "object" ? Object.keys(m).sort().join(",") : "";
  if (keys !== "iconUrl,name,url" || typeof m.name !== "string" || typeof m.url !== "string" || typeof m.iconUrl !== "string") {
    problems.push(`${TON_MANIFEST}: must hold exactly url, name and iconUrl`);
    return null;
  }
  let url, icon;
  try {
    url = new URL(m.url);
    icon = new URL(m.iconUrl);
  } catch {
    problems.push(`${TON_MANIFEST}: url / iconUrl are not URLs`);
    return null;
  }
  if (url.protocol !== "https:" || url.href !== `${url.origin}/` || icon.origin !== url.origin) {
    problems.push(`${TON_MANIFEST}: url must be an https origin and iconUrl on it`);
    return null;
  }
  return url.origin;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const files = await walk(dist);
const html = await readFile(join(dist, "index.html"), "utf8");

for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] ?? "";
  if (!/\bsrc=/.test(attrs) && (m[2] ?? "").trim()) problems.push("index.html: inline <script> (blocked by script-src 'self')");
}
for (const m of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
  const url = m[1] ?? "";
  if (/^(?:[a-z]+:)?\/\//i.test(url)) problems.push(`index.html: remote reference ${url}`);
  else if (url.startsWith("/")) problems.push(`index.html: absolute path ${url} (breaks under a sub-path or IPFS; use ./)`);
}
const meta = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*content=(["'])(.*?)\1/i);
if (meta && meta[2] !== contentSecurityPolicy({meta: true})) problems.push("index.html: <meta> CSP differs from bin/headers.mjs contentSecurityPolicy({meta: true})");

for (const file of files) {
  const ext = extname(file);
  if (![".js", ".mjs", ".css", ".html", ".json"].includes(ext)) continue;
  const raw = await readFile(file, "utf8");
  const rel = relative(dist, file);
  // The Standard build's own origin, as its one bare literal, is the one cp0x host allowed; everything else cp0x fails.
  const text = takeAnalyticsOut(takeApiOut(raw, rel), rel);
  for (const t of TRACKERS) if (text.includes(t)) problems.push(`${rel}: tracker endpoint ${t}`);
  for (const re of CP0X_BACKENDS) if (re.test(text)) problems.push(`${rel}: cp0x backend reference ${re}`);
  // The manifest's page origin is the one cp0x host it may name (a backend above still fails).
  const origin = rel === TON_MANIFEST ? tonManifestOrigin(raw) : null;
  const hosts = origin ? text.split(origin).join("") : text;
  for (const m of hosts.matchAll(CP0X_URL)) problems.push(`${rel}: cp0x host ${m[1]}${api ? ` (only ${api} is allowed)` : ""}`);
  if (ext === ".css") {
    for (const m of text.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')]+)/gi)) problems.push(`${rel}: remote url() ${m[1]}`);
    if (/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i.test(text)) problems.push(`${rel}: remote @import`);
  }
  if (ext === ".js" || ext === ".mjs") {
    if (/\bnew Function\s*\(|[^.\w]eval\s*\(/.test(text)) notes.push(`${rel}: contains eval/new Function (check it is not on a live path)`);
    if (/WebAssembly\.(?:instantiate|compile)/.test(text)) notes.push(`${rel}: contains WebAssembly (CSP has no 'wasm-unsafe-eval')`);
  }
}

if (api && apiLiterals.length === 0) problems.push(`--api ${api}: the origin is not in the bundle as its literal (did VITE_CP0X_API reach the build?)`);
if (analyticsLiterals.length > 1) problems.push(`${ANALYTICS_SCRIPT} appears ${analyticsLiterals.length} times as a literal (${analyticsLiterals.join(", ")}); src/config/analytics.ts holds it once`);
if (apiLiterals.length > 1) problems.push(`--api ${api}: the origin appears ${apiLiterals.length} times as a literal (${apiLiterals.join(", ")}); the VITE_CP0X_API define emits it once`);

for (const n of notes) console.log(`note: ${n}`);
if (problems.length) {
  console.error(`dist guard: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`dist guard: OK (${files.length} files${api ? `; the one cp0x origin is ${api}` : "; no cp0x host"})`);
