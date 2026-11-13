#!/usr/bin/env node
/**
 * Refreshes the self-hosted copy of TON Connect's official wallets list (ARCHITECTURE.md D11). The page never fetches
 * config.ton.org: our TON Connect (its `walletsListSource`) and TON Connect UI's modal read
 * public/tonconnect-wallets.json beside index.html, which is https://config.ton.org/wallets-v2.json — every wallet,
 * unmodified — except each `image`, rewritten to the wallet's icon copied into public/logos/ton-wallets/<app_name>.png
 * (a relative URL, so it resolves under a sub-path or an IPFS CID; downscaled to 96 px with macOS `sips` when larger,
 * the modal shows them at 60 px). It also writes src/wallets/ton/officialWallets.ts (app name, name and JS bridge key:
 * what the connect menu needs at boot) and copies, unmodified, the two images TON Connect UI hardcodes on GitHub,
 * which vite.config.ts points at public/logos/tonconnect/ at build time. tests/unit/wallets/ton.test.ts keeps the three
 * consistent. Everything downloaded is data: names are checked before they become file names, images must decode.
 *
 *   node .github/scripts/ton-wallets.mjs     # macOS (sips); review the diff, then commit
 */
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const LIST_URL = "https://config.ton.org/wallets-v2.json";
/** The images @tonconnect/ui 2.4.4 hardcodes and loads in the connect flow (vite.config.ts TONCONNECT_UI_ASSETS). */
const UI_ASSETS = [
  "https://raw.githubusercontent.com/ton-connect/sdk/main/assets/ton-icon-48.png",
  "https://raw.githubusercontent.com/ton-connect/sdk/main/assets/tg.png",
];
const MAX_PX = 96;
/** An app name becomes a file name: no path separators, no leading dot. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const root = fileURLToPath(new URL("../../", import.meta.url));
const listFile = join(root, "public/tonconnect-wallets.json");
const iconDir = join(root, "public/logos/ton-wallets");
const uiDir = join(root, "public/logos/tonconnect");
const tableFile = join(root, "src/wallets/ton/officialWallets.ts");

async function download(url) {
  if (!url.startsWith("https://")) throw new Error(`not an https URL: ${url}`);
  const res = await fetch(url, {redirect: "error"});
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sipsSize = (file) => {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], {encoding: "utf8"});
  const px = (k) => Number(new RegExp(`${k}: (\\d+)`).exec(out)?.[1]);
  return {w: px("pixelWidth"), h: px("pixelHeight")};
};

/**
 * Writes `bytes` as a PNG at `dest`, at most MAX_PX on its longer side, or as they came with `asIs` (sips decodes them
 * either way, so a download that is no image fails here).
 */
async function writeIcon(bytes, dest, tmp, asIs = false) {
  const src = join(tmp, "in");
  await writeFile(src, bytes);
  const {w, h} = sipsSize(src);
  if (!(w > 0 && h > 0)) throw new Error(`${dest}: not an image`);
  if (asIs) return writeFile(dest, bytes);
  const args = ["-s", "format", "png", ...(Math.max(w, h) > MAX_PX ? ["-Z", String(MAX_PX)] : []), src, "--out", dest];
  execFileSync("sips", args, {stdio: "ignore"});
}

const list = JSON.parse((await download(LIST_URL)).toString("utf8"));
if (!Array.isArray(list) || !list.length) throw new Error(`${LIST_URL}: not a wallets list`);
const tmp = await mkdtemp(join(tmpdir(), "ton-wallets-"));
try {
  await mkdir(iconDir, {recursive: true});
  await mkdir(uiDir, {recursive: true});
  const kept = new Set();
  for (const w of list) {
    if (typeof w?.app_name !== "string" || !SAFE_NAME.test(w.app_name)) throw new Error(`unexpected app_name: ${JSON.stringify(w?.app_name)}`);
    if (typeof w.name !== "string" || typeof w.image !== "string") throw new Error(`${w.app_name}: no name or image`);
    const file = `${w.app_name}.png`;
    if (kept.has(file.toLowerCase())) throw new Error(`${w.app_name}: two wallets share this icon file`);
    kept.add(file.toLowerCase());
    await writeIcon(await download(w.image), join(iconDir, file), tmp);
    w.image = `logos/ton-wallets/${file}`;
  }
  for (const f of await readdir(iconDir)) if (!kept.has(f.toLowerCase())) await rm(join(iconDir, f));
  for (const url of UI_ASSETS) await writeIcon(await download(url), join(uiDir, url.slice(url.lastIndexOf("/") + 1)), tmp, true);
  await writeFile(listFile, `${JSON.stringify(list, null, 2)}\n`);

  const date = new Date().toISOString().slice(0, 10);
  const rows = list.map((w) => {
    const key = w.bridge?.find?.((b) => b?.type === "js")?.key;
    return `  {appName: ${JSON.stringify(w.app_name)}, name: ${JSON.stringify(w.name)}${typeof key === "string" ? `, jsBridgeKey: ${JSON.stringify(key)}` : ""}},`;
  });
  await writeFile(
    tableFile,
    [
      "/**",
      ` * TON Connect's official wallets (${LIST_URL}, fetched ${date}): app name, name and`,
      " * JS bridge key, what the connect menu needs at boot. Written by .github/scripts/ton-wallets.mjs with",
      " * public/tonconnect-wallets.json (the whole list, which TON Connect and its modal read); do not edit by hand.",
      " */",
      "export const OFFICIAL_TON_WALLETS: readonly {appName: string; name: string; jsBridgeKey?: string}[] = [",
      ...rows,
      "];",
      "",
    ].join("\n"),
  );
  console.log(`wrote ${list.length} wallets to public/tonconnect-wallets.json, their icons and src/wallets/ton/officialWallets.ts`);
} finally {
  await rm(tmp, {recursive: true, force: true});
}
