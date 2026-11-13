/**
 * Explorer links for any caip2 the app shows, aliases included (`solana:5eykt4…`). The shared helpers decide for
 * the shared families, except two web corrections the shared copy keeps verbatim (catalog.md risk 10): NEAR and
 * Zcash. Their `/tx/` pages could not be probed (bot walls); nearblocks documents `/txns/<hash>` and blockchair
 * uses `/transaction/<hash>`, so those routes are used here. Extras' routes are proposals (catalog.md §2.6).
 */
import {catalogChainId} from "@anywalletkit/swap2-assets";
import type {Chain, ChainFamily} from "../contracts/domain";
import {explorerAddressUrl, explorerTxUrl} from "../shared";
import {EXTRA_CHAINS, EXTRA_TX_URL} from "./extraChains";
import {chainByCaip2Web} from "./network";

const SHARED: ReadonlySet<string> = new Set<ChainFamily>(["evm", "solana", "ton", "tron", "btc", "near", "zcash"]);

/** Account pages of the extras whose route is not `/address/<a>`. */
const EXTRA_ADDRESS_URL: Readonly<Record<string, (explorer: string, a: string) => string>> = {
  xrp: (e, a) => `${e}/account/${a}`,
  stellar: (e, a) => `${e}/account/${a}`,
  aptos: (e, a) => `${e}/account/${a}?network=mainnet`,
  sui: (e, a) => `${e}/account/${a}`,
};

/** Links work for every catalog chain, listed or not (a record may outlive VITE_EXTRA_CHAINS). */
function chainFor(caip2: string): Omit<Chain, "catalogKey" | "memo" | "receiveOnly"> | undefined {
  const id = catalogChainId(caip2);
  return chainByCaip2Web(id) ?? EXTRA_CHAINS.find((c) => c.caip2 === id);
}

/** The explorer page of a transaction, or undefined when the chain has no verified explorer (Katana, Arc). */
export function txUrl(caip2: string, hash: string): string | undefined {
  const c = chainFor(caip2);
  if (!c?.explorer || !hash) return undefined;
  if (c.family === "near") return `${c.explorer}/txns/${hash}`;
  if (c.family === "zcash") return `${c.explorer}/transaction/${hash}`;
  const extra = EXTRA_TX_URL[c.slug];
  if (extra) return extra(c.explorer, hash);
  if (SHARED.has(c.family)) return explorerTxUrl({...c, family: c.family as ChainFamily}, hash);
  return `${c.explorer}/tx/${hash}`;
}

/** The explorer page of an address, or undefined when the chain has no verified explorer. */
export function addressUrl(caip2: string, address: string): string | undefined {
  const c = chainFor(caip2);
  if (!c?.explorer || !address) return undefined;
  const extra = EXTRA_ADDRESS_URL[c.slug];
  if (extra) return extra(c.explorer, address);
  if (SHARED.has(c.family)) return explorerAddressUrl({...c, family: c.family as ChainFamily}, address);
  return `${c.explorer}/address/${address}`;
}
