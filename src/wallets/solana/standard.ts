/**
 * Which Wallet Standard wallets v1 can use, as pure checks. A Solana wallet is
 * listed only when it is on mainnet, can connect, and signs without sending
 * (`solana:signTransaction` with v0 transactions): the SDK account checks,
 * simulates and broadcasts the exact bytes, and the wallet only signs (D18,
 * engine.md §6.2). Wallets with only `signAndSendTransaction` are hidden.
 */
import {SolanaSignTransaction, type SolanaSignTransactionFeature} from "@solana/wallet-standard-features";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import type {WalletOption} from "../../contracts/wallets";
import {SOLANA_MAINNET_CHAINS} from "../family";
import {dataIcon} from "../options";

type ConnectFeature = StandardConnectFeature[typeof StandardConnect];
type DisconnectFeature = StandardDisconnectFeature[typeof StandardDisconnect];
type EventsFeature = StandardEventsFeature[typeof StandardEvents];
type SignTransactionFeature = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

const onMainnet = (chains: readonly string[]): boolean => chains.some((c) => SOLANA_MAINNET_CHAINS.includes(c));

/** The wallet's feature by name, typed by the caller (features are `unknown` in the standard's own types). */
function feature<T>(wallet: Pick<Wallet, "features">, name: string): T | undefined {
  const f = (wallet.features as Readonly<Record<string, unknown>>)[name];
  return f && typeof f === "object" ? (f as T) : undefined;
}

export const connectFeature = (w: Pick<Wallet, "features">) => feature<ConnectFeature>(w, StandardConnect);
export const disconnectFeature = (w: Pick<Wallet, "features">) => feature<DisconnectFeature>(w, StandardDisconnect);
export const eventsFeature = (w: Pick<Wallet, "features">) => feature<EventsFeature>(w, StandardEvents);
export const signTransactionFeature = (w: Pick<Wallet, "features">) => feature<SignTransactionFeature>(w, SolanaSignTransaction);

/** Why a wallet is not listed, or null when v1 can use it. */
export function solanaUnsupported(wallet: Pick<Wallet, "chains" | "features">): string | null {
  if (!onMainnet(wallet.chains)) return "not on Solana mainnet";
  if (typeof connectFeature(wallet)?.connect !== "function") return "no standard:connect";
  const sign = signTransactionFeature(wallet);
  if (typeof sign?.signTransaction !== "function") return "no solana:signTransaction";
  if (!Array.isArray(sign.supportedTransactionVersions) || !sign.supportedTransactionVersions.includes(0))
    return "no v0 transactions";
  return null;
}

export const isUsableSolanaWallet = (wallet: Pick<Wallet, "chains" | "features">): boolean => solanaUnsupported(wallet) === null;

/**
 * Menu entries for the usable wallets, in registration order. Deduped by name:
 * some wallets register twice (their own Standard wallet plus a legacy
 * adapter shim), and the name is the option id (contract: WalletOption.id).
 */
export function solanaOptions(wallets: readonly Wallet[]): WalletOption[] {
  const seen = new Set<string>();
  const out: WalletOption[] = [];
  for (const w of wallets) {
    if (seen.has(w.name) || !isUsableSolanaWallet(w)) continue;
    seen.add(w.name);
    const icon = dataIcon(w.icon);
    out.push({id: w.name, family: "solana", name: w.name, ...(icon ? {icon} : {}), kind: "wallet-standard"});
  }
  return out;
}

/** The first usable wallet with that name (the option id). */
export const findSolanaWallet = (wallets: readonly Wallet[], name: string): Wallet | undefined =>
  wallets.find((w) => w.name === name && isUsableSolanaWallet(w));

/**
 * The account to sign with: one on mainnet that (when the wallet says)
 * supports `solana:signTransaction`, preferring `prefer` (the address already
 * connected, so a wallet event that only reorders accounts changes nothing).
 */
export function pickSolanaAccount(accounts: readonly WalletAccount[], prefer?: string): WalletAccount | undefined {
  const usable = accounts.filter(
    (a) => onMainnet(a.chains) && (a.features.length === 0 || a.features.includes(SolanaSignTransaction)),
  );
  return (prefer ? usable.find((a) => a.address === prefer) : undefined) ?? usable[0];
}
