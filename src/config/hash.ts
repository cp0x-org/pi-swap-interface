/**
 * Hash routing (D22): the same dist/ works on Vercel, any IPFS gateway
 * (/ipfs/<cid>/), nginx and `npx`, because the server only ever serves
 * index.html. One screen, so the "route" is a path plus a query:
 * `#/?pay=<tokenKey>&receive=<tokenKey>&amount=<decimal>&swap=<id>&demo=1`.
 */
import {useSyncExternalStore} from "react";

export interface HashRoute {
  /** "/" for the swap screen. */
  path: string;
  query: URLSearchParams;
}

/** "#/swap?pay=x" → {path: "/swap", query}; "" or "#" → {path: "/"}. */
export function parseHash(hash: string): HashRoute {
  const h = hash.replace(/^#/, "");
  const q = h.indexOf("?");
  const path = (q >= 0 ? h.slice(0, q) : h) || "/";
  return {path: path.startsWith("/") ? path : `/${path}`, query: new URLSearchParams(q >= 0 ? h.slice(q + 1) : "")};
}

/** The hash a route serializes to (empty query → no "?"). */
export function formatHash(route: HashRoute): string {
  const qs = route.query.toString();
  return `#${route.path}${qs ? `?${qs}` : ""}`;
}

export const readHash = (): HashRoute => parseHash(typeof location === "undefined" ? "" : location.hash);

/**
 * Patch the hash query: a string sets a key, null deletes it. `replace` (default
 * true) keeps form edits out of the back-button history.
 */
export function setHashQuery(patch: Readonly<Record<string, string | null>>, opts: {replace?: boolean} = {}): void {
  const route = readHash();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) route.query.delete(k);
    else route.query.set(k, v);
  }
  const next = formatHash(route);
  if (next === location.hash || (next === "#/" && location.hash === "")) return;
  if (opts.replace ?? true) history.replaceState(history.state, "", next);
  else history.pushState(history.state, "", next);
  // replaceState/pushState do not fire hashchange: tell the subscribers ourselves.
  dispatchEvent(new HashChangeEvent("hashchange"));
}

const subscribe = (cb: () => void) => {
  addEventListener("hashchange", cb);
  return () => removeEventListener("hashchange", cb);
};
const snapshot = () => (typeof location === "undefined" ? "" : location.hash);

/** The current route; re-renders on every hash change. */
export function useHashRoute(): HashRoute {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  return parseHash(hash);
}
