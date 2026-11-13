/// <reference types="vitest/config" />
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {defineConfig, loadEnv, type Plugin, type Rolldown} from "vite";
import react from "@vitejs/plugin-react";
import {securityHeaders} from "./bin/headers.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {version: string};

/**
 * LICENSE and THIRD_PARTY_NOTICES.md go into dist/ itself, so EVERY distribution serves them next to index.html —
 * the hosted (Vercel) build included, not only npm, Docker and IPFS (the Reown/WalletConnect licence asks for its
 * notice on the website). The footer links to the notices.
 */
const licences = (): Plugin => ({
  name: "cp0x-licences",
  apply: "build",
  generateBundle() {
    for (const fileName of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
      this.emitFile({type: "asset", fileName, source: readFileSync(new URL(`./${fileName}`, import.meta.url), "utf8")});
  },
});

/**
 * The images @tonconnect/ui 2.4.4 hardcodes on GitHub and shows in its connect modal (the TON mark in the middle of
 * its QR, Telegram's on "Wallet in Telegram"), served from public/logos/tonconnect/ instead (D11, D13: the CSP's
 * img-src is 'self'). Relative, so they resolve under a sub-path. Its WalletConnect icon is left alone: it shows only
 * once WalletConnect is initialized inside TON Connect, which this app never does.
 */
const TONCONNECT_UI_ASSETS: Readonly<Record<string, string>> = {
  "https://raw.githubusercontent.com/ton-connect/sdk/main/assets/ton-icon-48.png": "logos/tonconnect/ton-icon-48.png",
  "https://raw.githubusercontent.com/ton-connect/sdk/main/assets/tg.png": "logos/tonconnect/tg.png",
};

/**
 * Its iOS `:active` fix sets an inline `ontouchstart=""` on <body>, which script-src 'self' refuses (a CSP violation
 * on every modal); an empty passive touchstart listener is the same fix without inline script.
 */
const TONCONNECT_UI_INLINE_HANDLER: readonly [string, string] = [
  `document.body.setAttribute("ontouchstart", "");`,
  `document.body.addEventListener("touchstart", () => {}, { passive: true });`,
];

/**
 * Rewrites those in the @tonconnect/ui module only (no patch of the package); a version that moved one fails the
 * build, not the CSP. `pnpm dev` pre-bundles the package in its dependency optimizer, where no plugin transform
 * reaches it, so the same rewrite runs there too (optimizeDeps below): dev serves what the build ships, and fails as
 * loudly.
 */
const tonConnectUi = (): Rolldown.Plugin => ({
  name: "cp0x-tonconnect-ui",
  transform(code, id) {
    if (!/[\\/]@tonconnect[\\/]ui[\\/]lib[\\/]index\.mjs$/.test(id.split("?")[0]!)) return;
    const edits = Object.entries(TONCONNECT_UI_ASSETS).map(([remote, local]) => {
      if (!existsSync(new URL(`./public/${local}`, import.meta.url))) this.error(`public/${local} is missing: run node .github/scripts/ton-wallets.mjs`);
      return [JSON.stringify(remote), JSON.stringify(local)] as const;
    });
    let out = code;
    for (const [from, to] of [...edits, TONCONNECT_UI_INLINE_HANDLER]) {
      if (!out.includes(from)) this.error(`@tonconnect/ui no longer holds ${from}: update vite.config.ts`);
      out = out.replaceAll(from, to);
    }
    return {code: out, map: null};
  },
});

/**
 * VITE_CP0X_API (ARCHITECTURE D30): the cp0x API origin of the hosted build, passed per deploy
 * (`vercel deploy --build-env VITE_CP0X_API=https://cp0x-api.vercel.app`). Checked here, so a typo fails the build
 * instead of shipping a broken Standard mode: an https origin, or plain http only for localhost / 127.0.0.1 (a local
 * API under `pnpm dev`; the shipped CSP connects to https: only). Normalised to the bare origin. "" when unset: the
 * Standard mode then does not exist and the bundle holds no cp0x host (D24, checked by guard-dist.mjs).
 */
export function cp0xApiOrigin(raw: string | undefined): string {
  const v = raw?.trim() ?? "";
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`VITE_CP0X_API is not a URL: ${v}`);
  }
  const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !local) throw new Error("VITE_CP0X_API must be an https origin (plain http only for localhost or 127.0.0.1)");
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password)
    throw new Error("VITE_CP0X_API must be a bare origin such as https://cp0x-api.vercel.app (no path, query or credentials)");
  return u.origin;
}

// Static SPA: relative asset paths and hash routing so the same dist/ works on
// Vercel, any IPFS gateway (/ipfs/<cid>/), Docker/nginx and `npx`.
export default defineConfig(({mode}) => ({
  base: "./",
  plugins: [react(), licences(), tonConnectUi()],
  define: {
    // Some provider deps read process.env.NODE_ENV / global at import time.
    global: "globalThis",
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
    // Unit tests never see a deploy's value: they pass the origin they test with.
    "import.meta.env.VITE_CP0X_API": JSON.stringify(mode === "test" ? "" : cp0xApiOrigin(loadEnv(mode, process.cwd(), "VITE_").VITE_CP0X_API)),
  },
  resolve: {
    alias: {
      buffer: "buffer/",
      // Files copied verbatim from the wallet keep `import … from "@cp0x/shared"` (src/shared = the web subset).
      "@cp0x/shared": fileURLToPath(new URL("./src/shared/index.ts", import.meta.url)),
    },
    // One copy of each, or instanceof checks and pinned tables diverge (WalletConnect pulls a second viem peer set).
    dedupe: ["viem", "@anywalletkit/core", "@anywalletkit/protocol-swap2-core", "@anywalletkit/swap2-assets", "@solana/kit"],
  },
  // `pnpm dev` only: the pre-bundled @tonconnect/ui gets the build's rewrite (tonConnectUi above).
  optimizeDeps: {rolldownOptions: {plugins: [tonConnectUi()]}},
  build: {
    target: "es2022",
    // Off while the repository is private: a source map hands the whole source to every visitor. SWAP_SOURCEMAP=1
    // turns them on for a local debugging build (and for every build once the source is public).
    sourcemap: process.env.SWAP_SOURCEMAP === "1",
    chunkSizeWarningLimit: 1500,
  },
  // The hosted header set (CSP included), so `vite preview` — and with it every e2e run — runs under the policy the
  // app ships with: a dependency that needs eval or WebAssembly, or a blocked request, fails CI instead of production.
  preview: {host: "127.0.0.1", headers: securityHeaders()},
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },
}));
