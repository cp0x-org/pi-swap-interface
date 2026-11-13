/**
 * Page-view counting on the hosted interface only (D31): Vercel Web Analytics, served from the page's own origin
 * (`/_vercel/insights/*`, which CSP's 'self' already allows), no cookies. main.tsx loads this module only in a build
 * made with VITE_CP0X_API, so IPFS, `npx`, Docker and self-hosted builds hold none of it (guard-dist fails a bundle
 * that names the script there). Skipped on a local host (dev, e2e) and when the browser asks not to be tracked
 * (Global Privacy Control or Do Not Track). Every event carries the page's origin and path only: never the query or
 * the `#` route, where an address can sit.
 */

/** Vercel's script for this deployment, on the same origin. */
export const ANALYTICS_SCRIPT = "/_vercel/insights/script.js";

interface VaEvent {
  type: "pageview" | "event";
  url: string;
}

type Va = (...args: unknown[]) => void;

/** The parts of `window` this needs (a test passes its own). */
export interface AnalyticsWindow {
  location: Pick<Location, "hostname" | "origin" | "pathname">;
  navigator: Pick<Navigator, "doNotTrack"> & {globalPrivacyControl?: boolean};
  document: Pick<Document, "createElement" | "head">;
  va?: Va;
  vaq?: unknown[][];
}

const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

/** Adds Vercel's script once per page; false when skipped. */
export function startAnalytics(w: AnalyticsWindow = window as unknown as AnalyticsWindow): boolean {
  const {hostname, origin, pathname} = w.location;
  if (LOCAL.test(hostname)) return false;
  if (w.navigator.globalPrivacyControl === true || w.navigator.doNotTrack === "1") return false;
  // The queue Vercel's script reads when it loads (what @vercel/analytics's inject() sets up, without the package).
  w.va ??= (...args: unknown[]) => {
    (w.vaq ??= []).push(args);
  };
  w.va("beforeSend", (e: VaEvent): VaEvent => ({...e, url: origin + pathname}));
  const script = w.document.createElement("script");
  script.src = ANALYTICS_SCRIPT;
  script.defer = true;
  w.document.head.appendChild(script);
  return true;
}
