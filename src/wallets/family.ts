/**
 * Which connector family signs for a chain: EVM (wagmi), Solana (Wallet
 * Standard), Tron (injected TronLink), TON (TON Connect) and NEAR (NEAR
 * Connect's injected wallets) sign in the browser; every other family pays from
 * a deposit address (D20), so it maps to null here.
 */
import type {WalletFamily} from "../contracts/wallets";

/** "eip155:…" → evm, "solana:…" → solana, "tron:…" → tron, "ton:…" → ton, "near:…" → near, else null (no connector). */
export function familyOfCaip2(caip2: string): WalletFamily | null {
  if (caip2.startsWith("eip155:")) return "evm";
  if (caip2.startsWith("solana:")) return "solana";
  if (caip2.startsWith("tron:")) return "tron";
  if (caip2.startsWith("ton:")) return "ton";
  if (caip2.startsWith("near:")) return "near";
  return null;
}

/** The numeric chain id of an "eip155:<id>" caip2, or null when it is not one (the wallet switch needs a number). */
export function evmChainIdOf(caip2: string): number | null {
  const m = /^eip155:([1-9][0-9]*)$/.exec(caip2);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/** Wallet Standard ids of Solana mainnet: the short form wallets announce, and the genesis-hash form some send. */
export const SOLANA_MAINNET_CHAINS: readonly string[] = ["solana:mainnet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];

/** CAIP-2 ids of Tron mainnet: the catalog's decimal form and the hex chain id TronLink and WalletConnect use. */
export const TRON_MAINNET_CHAINS: readonly string[] = ["tron:728126428", "tron:0x2b6653dc"];

/** TON mainnet: the catalog's caip2, and TON Connect's network id ("-239") a wallet must report. */
export const TON_MAINNET = "ton:-239";
export const TON_MAINNET_NETWORK = "-239";

/** NEAR mainnet's CAIP-2 id (the only NEAR network signed here). */
export const NEAR_MAINNET = "near:mainnet";
/** Family name as the copy reads it ("Connect an EVM wallet first."). */
export const familyLabel = (family: WalletFamily): string => ({evm: "EVM", solana: "Solana", tron: "Tron", ton: "TON", near: "NEAR"})[family];
