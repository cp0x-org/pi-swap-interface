/**
 * The networks the app lists (catalog.md §2.3): every swap2-assets chain that @cp0x/shared also knows (37),
 * joined on caip2 and shown in the shared display order. The catalog adds the per-chain flags the swap needs
 * (memo, receive-only); the shared row adds slug, name, chain id, explorer.
 */
import {CC_SOURCE_CHAINS, catalogChainId} from "@anywalletkit/swap2-assets";
import type {Chain, Family} from "../contracts/domain";
import {CHAINS, chainByCaip2} from "../shared";
import {EXTRA_CHAINS} from "./extraChains";
import {evmRpcUrls, nearRpcUrls, solanaRpcUrls} from "./rpc";

/** Families whose SOURCE transaction the browser can sign today (Tron: TronLink; TON: TON Connect; NEAR: injected extensions). */
export const SIGNING_FAMILIES: ReadonlySet<Family> = new Set<Family>(["evm", "solana", "tron", "ton", "near"]);

/**
 * Signing families that still pay from a deposit address (QR, D20) while no wallet of theirs is connected — the
 * fallback when there is none or its connection fails. EVM and Solana always ask for a wallet.
 */
export const QR_FALLBACK_FAMILIES: ReadonlySet<Family> = new Set<Family>(["tron", "ton", "near"]);

const ORDER = new Map(CHAINS.map((c, i) => [c.caip2, i]));

/**
 * `rpc` is replaced by the runtime config's list on EVM, Solana and NEAR, so a reader of `Chain.rpc` can never reach an
 * endpoint the operator removed (or Solana's mainnet-beta, which 403s browsers). Other families keep the shared list.
 */
function runtimeRpc(c: {family: Family; chainId?: number; rpc: readonly string[]}): readonly string[] {
  if (c.family === "evm" && c.chainId !== undefined) return evmRpcUrls(c.chainId);
  if (c.family === "solana") return solanaRpcUrls();
  if (c.family === "near") return nearRpcUrls();
  return c.rpc;
}

/**
 * Builds the chain list from the catalog. `extras` adds the 9 catalog-only chains (LTC, DOGE, XRP…). A catalog
 * chain with no shared or extra row is dropped — a test asserts none is, so an SDK bump cannot silently hide one.
 */
export function webChains(opts: {extras?: boolean} = {}): Chain[] {
  const out: Chain[] = [];
  for (const cc of CC_SOURCE_CHAINS) {
    if (cc.hidden) continue;
    const base = chainByCaip2(cc.caip2) ?? (opts.extras ? EXTRA_CHAINS.find((c) => c.caip2 === cc.caip2) : undefined);
    if (!base) continue;
    out.push({
      ...base,
      rpc: runtimeRpc(base),
      catalogKey: cc.key,
      memo: !!cc.memo,
      ...(cc.icon ? {icon: cc.icon} : {}),
      receiveOnly: !!cc.offrampOnly,
    });
  }
  return out.sort((a, b) => (ORDER.get(a.caip2) ?? 1e3) - (ORDER.get(b.caip2) ?? 1e3));
}

/** Every web chain, display order: ethereum, arbitrum, optimism, base, the 6 non-EVM, then the EVM long tail. */
export const CHAIN_LIST: readonly Chain[] = webChains({extras: import.meta.env.VITE_EXTRA_CHAINS === "1"});

const BY_SLUG = new Map(CHAIN_LIST.map((c) => [c.slug, c]));
const BY_CAIP2 = new Map(CHAIN_LIST.map((c) => [c.caip2, c]));

/** By slug (the token key prefix and logo key). */
export const chainBySlugWeb = (slug: string): Chain | undefined => BY_SLUG.get(slug);

/**
 * By CAIP-2. Wallet Standard / WalletConnect may say `solana:5eykt4…` or `bip122:…`: the catalog's alias table
 * normalises those first, so every caller can pass what a wallet reports.
 */
export const chainByCaip2Web = (caip2: string): Chain | undefined => BY_CAIP2.get(caip2) ?? BY_CAIP2.get(catalogChainId(caip2));
