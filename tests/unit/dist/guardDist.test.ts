// @vitest-environment node
// The dist guard (D24/D30): a Standard build may hold its cp0x API origin only as the one bare literal the
// VITE_CP0X_API define emits. A proxy URL an operator put in VITE_SWAP_CONFIG or a runtime-config.json inside dist
// would reach cp0x in Public and Custom too, and wallets' chain lists: it fails, in `--api` mode and in the
// env-driven form Vercel runs.
import {execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";

const API = "https://cp0x-api.example.org";
const HTML = `<!doctype html><html><head><script type="module" src="./assets/index.js"></script></head><body></body></html>`;
/** What the define leaves in the bundle (vite build output, minified). */
const BUNDLE = `var be=ye(\`${API}\`),xe=e=>\`\${e}/api/v2/swap-web\`;`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

/** A fake dist: index.html, assets/index.js and any extra files. */
function dist(js: string, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dist-guard-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), HTML);
  writeFileSync(join(dir, "assets", "index.js"), js);
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
  return dir;
}

/** Run the guard: exit code and everything it printed. */
function guard(args: string[], env: Record<string, string | undefined> = {}): {code: number; out: string} {
  const {VITE_CP0X_API: _drop, ...base} = process.env;
  try {
    const out = execFileSync("node", [".github/scripts/guard-dist.mjs", ...args], {encoding: "utf8", stdio: "pipe", env: {...base, ...env}});
    return {code: 0, out};
  } catch (e) {
    const err = e as {status: number; stdout: string; stderr: string};
    return {code: err.status, out: `${err.stdout}${err.stderr}`};
  }
}

describe("dist guard: the Standard build's cp0x origin", () => {
  it("passes the build's one bare literal, with --api and with the deploy's VITE_CP0X_API", () => {
    const d = dist(BUNDLE);
    expect(guard([d, "--api", API])).toMatchObject({code: 0});
    expect(guard([d], {VITE_CP0X_API: API})).toMatchObject({code: 0});
  });

  it("fails a proxy URL from VITE_SWAP_CONFIG (inlined in the bundle) in both forms", () => {
    const cfg = JSON.stringify(JSON.stringify({api: {lifi: `${API}/api/v2/swap-web/venue/lifi`}, evmRpc: {1: [`${API}/api/v2/swap-web/rpc/1`]}}));
    const d = dist(`${BUNDLE}var cfg=${cfg};`);
    for (const r of [guard([d, "--api", API]), guard([d], {VITE_CP0X_API: API})]) {
      expect(r.code).toBe(1);
      expect(r.out).toContain(`${API} inside a longer string`);
      expect(r.out).toContain("/api/v2/swap-web/venue/lifi");
    }
  });

  it("fails a runtime-config.json in dist that holds a proxy URL, or even the bare origin a second time", () => {
    const proxied = dist(BUNDLE, {"runtime-config.json": JSON.stringify({api: {thorConfirmNodes: [`${API}/api/v2/swap-web/venue/thornode`]}})});
    expect(guard([proxied, "--api", API]).out).toMatch(/runtime-config\.json: https:\/\/cp0x-api\.example\.org inside a longer string/);
    const twice = dist(BUNDLE, {"runtime-config.json": JSON.stringify({api: {lifi: API}})});
    const r = guard([twice, "--api", API]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("appears 2 times as a literal");
  });

  it("fails a host that only starts with the origin, and a build the origin never reached", () => {
    const lookalike = dist(`${BUNDLE}var x="${API}.evil.example";`);
    expect(guard([lookalike, "--api", API]).code).toBe(1);
    const missing = dist(`var be=ye("");`);
    expect(guard([missing, "--api", API]).out).toContain("not in the bundle as its literal");
  });

  it("--no-api allows no cp0x host at all, whatever the environment says", () => {
    const r = guard([dist(BUNDLE), "--no-api"], {VITE_CP0X_API: API});
    expect(r.code).toBe(1);
    expect(r.out).toContain("cp0x host cp0x-api.example.org");
  });
});

describe("dist guard: the hosted page-view count (D31)", () => {
  const COUNT = `var s=document.createElement("script");s.src="/_vercel/insights/script.js";`;

  it("passes the analytics script's one bare literal in a build with the API", () => {
    expect(guard([dist(`${BUNDLE}${COUNT}`), "--api", API])).toMatchObject({code: 0});
  });

  it("fails it in a build without the API, and any other Vercel insights endpoint in either", () => {
    expect(guard([dist(COUNT), "--no-api"]).out).toContain("tracker endpoint /_vercel/insights");
    const speed = guard([dist(`${BUNDLE}${COUNT}var v="/_vercel/speed-insights/script.js";`), "--api", API]);
    expect(speed.code).toBe(1);
    expect(speed.out).toContain("tracker endpoint /_vercel/speed-insights");
    const longer = guard([dist(`${BUNDLE}var u="/_vercel/insights/view";`), "--api", API]);
    expect(longer.code).toBe(1);
    expect(longer.out).toContain("tracker endpoint /_vercel/insights");
  });

  it("fails a second copy of the literal", () => {
    const r = guard([dist(`${BUNDLE}${COUNT}`, {"extra.js": COUNT}), "--api", API]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("/_vercel/insights/script.js appears 2 times");
  });
});

describe("dist guard: the TON Connect manifest (D11)", () => {
  const PAGE = "https://swap.cp0x.com";
  const manifest = (m: Record<string, unknown>) => ({"tonconnect-manifest.json": JSON.stringify(m)});
  const OK = {url: PAGE, name: "cp0x Swap", iconUrl: `${PAGE}/apple-touch-icon.png`};

  it("lets the manifest name the hosted page's origin, in every build", () => {
    expect(guard([dist(`var x=1;`, manifest(OK)), "--no-api"])).toMatchObject({code: 0});
    expect(guard([dist(BUNDLE, manifest(OK)), "--api", API])).toMatchObject({code: 0});
  });

  it("fails a manifest with anything else in it, an icon elsewhere, or a cp0x API URL", () => {
    expect(guard([dist(`var x=1;`, manifest({...OK, termsOfUseUrl: `${PAGE}/terms`})), "--no-api"]).out).toContain("exactly url, name and iconUrl");
    expect(guard([dist(`var x=1;`, manifest({...OK, iconUrl: "https://cdn.cp0x.com/i.png"})), "--no-api"]).out).toContain("iconUrl on it");
    const api = guard([dist(`var x=1;`, manifest({...OK, url: "https://cp0x-api.vercel.app", iconUrl: "https://cp0x-api.vercel.app/i.png"})), "--no-api"]);
    expect(api.code).toBe(1);
    expect(api.out).toContain("cp0x backend reference");
  });

  it("still fails the page's origin anywhere else in dist", () => {
    const r = guard([dist(`var u="${PAGE}/tonconnect-manifest.json";`, manifest(OK)), "--no-api"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("assets/index.js: cp0x host swap.cp0x.com");
  });
});
