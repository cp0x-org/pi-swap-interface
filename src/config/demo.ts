/**
 * Demo mode (D15): fixtures only — no wallets, no network — for design review
 * and e2e screenshots. On with `?demo=1` in the hash query (or the page
 * query, or runtime config `demo: true`); `?demo=0` forces it off. Decided at
 * boot; toggling needs a reload.
 */
import {parseHash} from "./hash";

/** Which demo wallets are "connected": `demoWallets=none|evm|solana|both` (default evm; none on `#/demo/preview`) — every CTA state is reachable. */
export type DemoWallets = "none" | "evm" | "solana" | "both";

/**
 * The hash (then page) query's demo flag: true / false, or null when it says nothing. A `#/demo/<scene>` path
 * means demo too (unless the query says `demo=0`), so a scene link works without repeating `?demo=1`.
 */
export function demoFromLocation(loc: Pick<Location, "hash" | "search">): boolean | null {
  const route = parseHash(loc.hash);
  const v = route.query.get("demo") ?? new URLSearchParams(loc.search).get("demo");
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  return route.path === "/demo" || route.path.startsWith("/demo/") ? true : null;
}

export function demoWallets(loc: Pick<Location, "hash" | "search"> | undefined = typeof location === "undefined" ? undefined : location): DemoWallets {
  if (!loc) return "evm";
  const route = parseHash(loc.hash);
  // The preview scene is about a visitor without a wallet: it opens with none unless the query says otherwise.
  const v = route.query.get("demoWallets") ?? new URLSearchParams(loc.search).get("demoWallets") ?? (route.path === "/demo/preview" ? "none" : null);
  return v === "none" || v === "solana" || v === "both" ? v : "evm";
}
