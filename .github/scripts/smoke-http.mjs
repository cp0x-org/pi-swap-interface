#!/usr/bin/env node
/**
 * HTTP smoke test for a running deployment (the Docker image or the npx server in CI, or any URL by hand). It
 * checks the shared security headers, the cache split, 404 for unknown paths, 405 for writes, and what
 * runtime-config.json answers.
 *
 *   node .github/scripts/smoke-http.mjs <base-url> [--local] [--config <expected.json>]
 *     --local   expect the npx server's extra connect-src sources (http://127.0.0.1:* http://localhost:* http://[::1]:*)
 *     --config  expect runtime-config.json to serve exactly this JSON (default: expect 404)
 */
import {readFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import {IMMUTABLE_CACHE, LOCAL_CONNECT_SOURCES, REVALIDATE_CACHE, securityHeaders} from "../../bin/headers.mjs";

const {values, positionals} = parseArgs({allowPositionals: true, options: {local: {type: "boolean", default: false}, config: {type: "string"}}});
const base = positionals[0];
if (!base) throw new Error("usage: smoke-http.mjs <base-url> [--local] [--config file]");
const url = (p) => new URL(p, base.endsWith("/") ? base : `${base}/`).href;
const expected = securityHeaders(values.local ? {extraConnect: LOCAL_CONNECT_SOURCES} : {});
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

function checkHeaders(res, label) {
  for (const [k, v] of Object.entries(expected)) check(res.headers.get(k) === v, `${label}: ${k}`);
}

const index = await fetch(url("./"));
const html = await index.text();
check(index.status === 200, `GET / → 200 (got ${index.status})`);
checkHeaders(index, "GET /");
check(index.headers.get("cache-control") === REVALIDATE_CACHE, `GET / Cache-Control ${REVALIDATE_CACHE}`);

const asset = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1];
check(!!asset, "index.html references ./assets/*.js");
if (asset) {
  const res = await fetch(url(asset));
  await res.arrayBuffer();
  check(res.status === 200, `GET /${asset} → 200`);
  check(res.headers.get("cache-control") === IMMUTABLE_CACHE, `GET /${asset} Cache-Control immutable`);
  checkHeaders(res, `GET /${asset}`);
}

const missing = await fetch(url("does-not-exist.js"));
await missing.arrayBuffer();
check(missing.status === 404, `unknown path → 404 (got ${missing.status})`);
checkHeaders(missing, "404");

const post = await fetch(url("./"), {method: "POST", body: "x"});
await post.arrayBuffer();
check(post.status === 405, `POST / → 405 (got ${post.status})`);

const cfg = await fetch(url("runtime-config.json"));
if (values.config) {
  const want = JSON.parse(await readFile(values.config, "utf8"));
  const got = cfg.status === 200 ? await cfg.json() : null;
  check(JSON.stringify(got) === JSON.stringify(want), "runtime-config.json serves the mounted file");
  check(cfg.headers.get("cache-control") === REVALIDATE_CACHE, `runtime-config.json Cache-Control ${REVALIDATE_CACHE}`);
} else {
  await cfg.arrayBuffer();
  check(cfg.status === 404, `runtime-config.json → 404 when none is provided (got ${cfg.status})`);
}

if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
