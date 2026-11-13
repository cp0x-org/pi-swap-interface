/**
 * The 9 swap-catalog chains @cp0x/shared does not carry (catalog.md §2.6). Phase 1.5: listed only with
 * VITE_EXTRA_CHAINS=1, because they still need recipient/refund validators and (xrp, stellar) a memo UI.
 * Native symbol/decimals are the catalog's; explorer bases and paths are proposals, not verified (bot walls).
 */
import type {ChainInfo, ExtraFamily} from "../contracts/domain";

/** A catalog-only chain in the @cp0x/shared shape, with a family the shared list does not know. */
export type ExtraChain = Omit<ChainInfo, "family"> & {family: ExtraFamily};

const x = (slug: string, caip2: string, name: string, family: ExtraFamily, symbol: string, decimals: number, explorer?: string): ExtraChain => ({
  slug,
  caip2,
  name,
  family,
  native: {symbol, decimals},
  rpc: [],
  ...(explorer ? {explorer} : {}),
});

/** Catalog-only chains, catalog order. Joined to the swap catalog by caip2 like the shared rows. */
export const EXTRA_CHAINS: readonly ExtraChain[] = [
  x("litecoin", "litecoin:mainnet", "Litecoin", "ltc", "LTC", 8, "https://blockchair.com/litecoin"),
  x("doge", "doge:mainnet", "Dogecoin", "doge", "DOGE", 8, "https://blockchair.com/dogecoin"),
  x("xrp", "xrp:mainnet", "XRP", "xrp", "XRP", 6, "https://xrpscan.com"),
  x("bch", "bch:mainnet", "Bitcoin Cash", "bch", "BCH", 8, "https://blockchair.com/bitcoin-cash"),
  x("cosmos", "cosmos:cosmoshub-4", "Cosmos", "cosmos", "ATOM", 6, "https://www.mintscan.io/cosmos"),
  x("cardano", "cardano:mainnet", "Cardano", "cardano", "ADA", 6, "https://cardanoscan.io"),
  x("stellar", "stellar:pubnet", "Stellar", "stellar", "XLM", 7, "https://stellar.expert/explorer/public"),
  x("aptos", "aptos:mainnet", "Aptos", "aptos", "APT", 8, "https://explorer.aptoslabs.com"),
  x("sui", "sui:mainnet", "Sui", "sui", "SUI", 9, "https://suiscan.xyz/mainnet"),
];

/**
 * Explorers whose transaction page is not `<explorer>/tx/<hash>` (blockchair, cardanoscan, aptos). The shared
 * `explorerTxUrl` knows only the shared families, so the extras' paths live here, keyed by slug.
 */
export const EXTRA_TX_URL: Readonly<Record<string, (explorer: string, hash: string) => string>> = {
  litecoin: (e, h) => `${e}/transaction/${h}`,
  doge: (e, h) => `${e}/transaction/${h}`,
  bch: (e, h) => `${e}/transaction/${h}`,
  cardano: (e, h) => `${e}/transaction/${h}`,
  aptos: (e, h) => `${e}/txn/${h}?network=mainnet`,
};
