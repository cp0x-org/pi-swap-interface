/**
 * cp0x Swap's HTTP response headers, in one place. bin/server.mjs sends them; vercel.json and
 * docker/security-headers.conf carry the same values as static text, and tests/unit/dist/headers.test.ts fails when
 * a copy drifts. Plain JavaScript with no dependencies, so `npx` can run it as published.
 */

/**
 * Content-Security-Policy directives, in order. Why each one is as it is:
 * - script-src 'self': Vite emits only same-origin module chunks; no dependency needs eval or WebAssembly.
 * - style-src 'unsafe-inline': vaul and Radix's scroll lock (react-remove-scroll-bar) insert <style> elements at
 *   runtime, and the scroll lock's CSS changes per page (the scrollbar gap), so it cannot be hashed. Scripts stay
 *   strict, and an inline style cannot run code.
 * - img-src data: blob:: EIP-6963 and Wallet Standard wallet icons are data: URIs. Every logo is bundled and
 *   nothing is hotlinked — TON Connect UI's wallet icons and its own images too (ARCHITECTURE.md D11).
 * - connect-src https: wss:: operators and users choose their own RPCs and API bases (runtime-config.json), so a
 *   fixed host list would break them. Sending data anywhere still takes code, and script-src admits only the
 *   bundle's own files.
 * - frame-src verify.walletconnect.org: WalletConnect loads its Verify attestation in a hidden iframe before each
 *   proposal and request. If the iframe is blocked, every WalletConnect prompt waits 5 s for a timeout.
 * - frame-ancestors 'none': nobody may embed the app yet (embedding is a later stage).
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const CSP_DIRECTIVES = Object.freeze([
  ["default-src", "'self'"],
  ["script-src", "'self'"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", "'self' data: blob:"],
  ["font-src", "'self'"],
  ["connect-src", "'self' https: wss:"],
  ["frame-src", "https://verify.walletconnect.org"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["form-action", "'self'"],
  ["frame-ancestors", "'none'"],
]);

/**
 * Sources the local `npx` server adds to connect-src, so that a node on this machine works (runtime config accepts
 * http://localhost and http://127.0.0.1 RPCs). Public deployments do not get them.
 */
// No http://[::1]:* — CSP host-sources can't name an IPv6 literal; Chrome ignores the entry with a console error.
export const LOCAL_CONNECT_SOURCES = Object.freeze(["http://127.0.0.1:*", "http://localhost:*"]);

/**
 * The CSP header value. `extraConnect` is appended to connect-src (the CLI passes LOCAL_CONNECT_SOURCES).
 * `meta: true` leaves out the directives a <meta http-equiv> CSP ignores (frame-ancestors). That form is for hosts
 * that cannot send headers, such as IPFS gateways.
 * @param {{extraConnect?: readonly string[], meta?: boolean}} [opts]
 * @returns {string}
 */
export function contentSecurityPolicy(opts = {}) {
  const extra = opts.extraConnect ?? [];
  return CSP_DIRECTIVES.filter(([name]) => !(opts.meta && name === "frame-ancestors"))
    .map(([name, value]) => (name === "connect-src" && extra.length ? `${name} ${value} ${extra.join(" ")}` : `${name} ${value}`))
    .join("; ");
}

/**
 * Powerful features the app never uses, turned off for this page and anything it frames. Clipboard stays on for
 * this origin only: "Paste" reads an address and the copy buttons write one. The list holds only feature names
 * that current browsers know, so the console shows no warnings.
 */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "idle-detection=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "serial=()",
  "usb=()",
  "xr-spatial-tracking=()",
  "clipboard-read=(self)",
  "clipboard-write=(self)",
].join(", ");

/**
 * Headers sent with every response. Opener policy same-origin-allow-popups: other sites cannot get a handle on this
 * window, and wallet popups this page opens (WalletConnect, a smart-wallet sign-in) still work.
 * @param {{extraConnect?: readonly string[]}} [opts]
 * @returns {Record<string, string>}
 */
export function securityHeaders(opts = {}) {
  return {
    "Content-Security-Policy": contentSecurityPolicy({extraConnect: opts.extraConnect}),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
}

/** Vite puts content-hashed files under assets/, so they never change. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** index.html, runtime-config.json, fonts and logos keep their names: the browser revalidates them every time. */
export const REVALIDATE_CACHE = "no-cache";

/**
 * The Cache-Control value for a URL path (leading "/", already decoded).
 * @param {string} path
 * @returns {string}
 */
export function cacheControlFor(path) {
  return path.startsWith("/assets/") ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
}
