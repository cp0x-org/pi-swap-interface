/**
 * What the UI knows about venues beyond the providers themselves (D17): display
 * names, which ones need a claim on arrival, and the approval spender a dry
 * quote leaves unnamed. Routing itself is the real providers' supportsRoute —
 * the mobile capability tables are not ported.
 */
import {CF_VAULTS} from "@anywalletkit/protocol-swap2-chainflip/config";
import {chainByCaip2Web} from "../catalog";

/** Mobile lib/swap/providers.ts PROVIDER_NAMES, plus Curve. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  near_intents: "NEAR Intents",
  lifi: "LI.FI",
  thorchain: "THORChain",
  cctp: "Circle CCTP",
  usdt0: "USDT0",
  chainflip: "Chainflip",
  relay: "Relay",
  symbiosis: "Symbiosis",
  omniston: "Omniston",
  uniswap: "Uniswap",
  curve: "Curve",
  wrap: "Wrap",
  balancer: "Balancer",
  fynd: "Fynd",
  jupiter: "Jupiter",
};

/** A venue's display name; unknown names pass through. */
export const providerName = (p: string): string => PROVIDER_NAMES[p] ?? p;

/**
 * Delivery needs a claim transaction on the destination (the review says "claim
 * on arrival"). Not `!!provider.buildClaim`: usdt0 has one only to retry a
 * reverted delivery.
 */
export const TWO_PHASE: ReadonlySet<string> = new Set(["cctp"]);

/**
 * Inline copy of the SDK's AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS (first entry per
 * chain, snapshot 2026-11-11), so the main bundle never imports the Omniston
 * package. providerMeta.test.ts asserts it equals the package export.
 */
export const OMNISTON_ORDER_PROTOCOL: Readonly<Record<string, string>> = {
  "eip155:1": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:56": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:137": "0xafCF681272AF10959736f45616eeCBC22D7095E2",
  "eip155:8453": "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  "eip155:42161": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:43114": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:196": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:9745": "0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9",
  "eip155:999": "0xD84778bbeEC5D2a8d17c6424249C438EC0b1ABE3",
};

/**
 * The spender an ERC-20 source on `chain` must be approved for when the dry
 * quote names none, or null. Omniston: its gasless order is built after the
 * quote. Chainflip: a dry quote carries no txRequest, so the vault it will call
 * (CF_VAULTS) is named here. Every other EVM venue names
 * txRequest.approvalAddress in its dry quote.
 */
export function orderSpender(provider: string, chain: string): string | null {
  if (provider === "omniston") return OMNISTON_ORDER_PROTOCOL[chain] ?? null;
  if (provider === "chainflip" && chain.startsWith("eip155:")) return CF_VAULTS[chain] ?? null;
  return null;
}

/** One side of a pair as venueScope reads it (a SwapToken fits). */
export interface ScopeSide {
  caip2: string;
  family: string;
  symbol: string;
  /** null = the network's native coin; absent = unknown. */
  contract?: string | null;
}

/** Venues that also swap within one network (their own supportsSameChain); the router asks no other venue then. */
const SAME_CHAIN_VENUES: ReadonlySet<string> = new Set(["lifi", "uniswap", "curve", "wrap", "balancer", "fynd", "jupiter", "omniston"]);

const isSymbol = (x: ScopeSide, ...names: string[]) => names.includes(x.symbol.toUpperCase());

/**
 * Where the protocol itself goes beyond what its module serves here: CCTP to Solana; USDT0 out of Tron or TON (not
 * built in usdt0 0.5.0).
 */
const BEYOND_MODULE: Readonly<Record<"cctp" | "usdt0", ReadonlySet<string>>> = {cctp: new Set(["solana"]), usdt0: new Set(["tron", "ton"])};

/**
 * Non-EVM destinations a module reaches from some EVM networks only: USDT0's Legacy Mesh into TON and Tron
 * (providers.ts meshDestinations). Its third source, Celo, sends a USDT the catalog doesn't list, so the pickers reach
 * it from these two.
 */
const INTO_FROM: Readonly<Partial<Record<"cctp" | "usdt0", Readonly<Record<string, string>>>>> = {
  usdt0: {ton: "Ethereum or Arbitrum", tron: "Ethereum or Arbitrum"},
};

/**
 * A one-coin bridge (CCTP: USDC, USDT0: USDT), by the first reason that holds: a network outside EVM ("yet" where the
 * protocol reaches it but its module doesn't, or the networks it reaches it from), the same network, another coin, then
 * a network the module doesn't list. CCTP covers EVM networks only (19); USDT0 its 16 EVM deployments plus the mesh.
 */
function bridgeScope(provider: "cctp" | "usdt0", coin: string, symbols: readonly string[], from: ScopeSide, to: ScopeSide): string {
  const outside = from.family !== "evm" ? from : to.family !== "evm" ? to : null;
  if (outside) {
    const name = chainByCaip2Web(outside.caip2)?.name ?? outside.family;
    const into = outside === to ? INTO_FROM[provider]?.[to.family] : undefined;
    if (into) return !isSymbol(from, ...symbols) || !isSymbol(to, ...symbols) ? `Moves ${coin} only` : `Into ${name} from ${into} only`;
    return `${name} isn't supported here${BEYOND_MODULE[provider].has(outside.family) ? " yet" : ""}`;
  }
  if (from.caip2 === to.caip2) return "Between networks only";
  if (!isSymbol(from, ...symbols) || !isSymbol(to, ...symbols)) return `Moves ${coin} only`;
  return "Not on one of these networks";
}

/**
 * Why an enabled venue wasn't asked for this pair, in one honest line (the route list's "Not for this pair" group).
 * The decision itself is each provider's supportsRoute (D17); these lines only name the venue's scope, and stay
 * generic ("Doesn't cover this pair") where the answer is in a venue's token list — THORChain has no USDT on Solana,
 * for one, but the app would only be guessing which token is missing.
 */
export function venueScope(provider: string, from: ScopeSide, to: ScopeSide): string {
  const sameNet = from.caip2 === to.caip2;
  const evm = from.family === "evm" && to.family === "evm";
  switch (provider) {
    case "uniswap":
    case "curve":
    case "balancer":
    case "fynd":
      return sameNet ? "Not on this network" : "Same-network swaps only";
    case "wrap":
      return "Wraps only, like ETH ⇄ WETH";
    case "jupiter":
      return sameNet && from.family === "solana" ? "Doesn't list one of these tokens" : "Swaps within Solana only";
    case "cctp":
      return bridgeScope("cctp", "USDC", ["USDC"], from, to);
    case "usdt0":
      return bridgeScope("usdt0", "USDT", ["USDT", "USDT0"], from, to);
    case "relay":
      if (!evm) return "EVM networks only here";
      return sameNet ? "Between networks only" : "Not on one of these networks";
    case "lifi":
      return "Doesn't cover these networks";
    case "omniston":
      // EVM networks and TON only; its one same-network swap is TON ↔ TON; between networks it moves tokens only
      // (omnistonLazy omnistonTokenLegs).
      if (![from, to].every((x) => x.family === "evm" || x.family === "ton")) return "Doesn't cover these networks";
      if (sameNet) return from.family === "evm" ? "Between networks only" : "Doesn't cover this pair";
      return from.contract === null || to.contract === null ? "Tokens only between networks" : "Doesn't cover this pair";
    case "symbiosis":
      // Its chain table has no Solana (EVM, Tron, TON, Bitcoin); it never swaps within one network.
      if (from.family === "solana" || to.family === "solana") return "Solana isn't supported here";
      return sameNet ? "Between networks only" : "Doesn't cover this pair";
  }
  return sameNet && !SAME_CHAIN_VENUES.has(provider) ? "Between networks only" : "Doesn't cover this pair";
}
