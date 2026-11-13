/**
 * NEAR wallets as browser extensions inject them, by NEAR Connect's protocol (the EIP-6963 of NEAR): the page fires
 * `near-selector-ready`, each wallet answers with a `near-wallet-injected` event whose `detail` is its API. Only
 * that protocol is used — NEAR Connect itself (@hot-labs/near-connect) is not: it fetches a wallet manifest from
 * GitHub and runs each wallet's script from its own host in a sandboxed iframe, which the CSP and D24 rule out.
 * Web, mobile and Ledger NEAR wallets therefore don't appear; NEAR still pays from a deposit address without one.
 *
 * Pure checks here; runtime.ts listens and connects. Nothing here signs: getSigner hands the wallet to execute.
 */
import type {NearInjectedWallet} from "../../contracts/execution";
import type {WalletOption} from "../../contracts/wallets";
import {dataIcon} from "../options";

/** The page asks extensions to announce their NEAR wallets. */
export const NEAR_READY_EVENT = "near-selector-ready";
/** An extension announces one NEAR wallet (`detail` = its API). */
export const NEAR_INJECTED_EVENT = "near-wallet-injected";

/** Option ids are "near:<manifest id>", so a NEAR wallet can't collide with an EVM rdns or a Solana wallet name. */
export const nearOptionId = (manifestId: string): string => `near:${manifestId}`;

const isFn = (x: unknown): boolean => typeof x === "function";

/** Why a `near-wallet-injected` detail is not listed, or null when it can be used. */
export function nearUnsupported(w: unknown): string | null {
  const x = w as Partial<NearInjectedWallet> | null;
  const m = x?.manifest;
  if (!m || typeof m.id !== "string" || !m.id || typeof m.name !== "string" || !m.name.trim()) return "no manifest id or name";
  if (!isFn(x.signIn) || !isFn(x.signOut) || !isFn(x.getAccounts) || !isFn(x.signAndSendTransaction)) return "missing a method";
  const f = m.features ?? {};
  // A feature the wallet says it lacks: sign-in that adds no access key (never asked for here), sending, mainnet.
  if (f.signInWithoutAddKey === false || f.signAndSendTransaction === false || f.mainnet === false) return "a feature it says it lacks";
  return null;
}

export const isUsableNearWallet = (w: unknown): w is NearInjectedWallet => nearUnsupported(w) === null;

/** Menu entries for the usable wallets, in announce order (one per manifest id). */
export function nearOptions(wallets: readonly NearInjectedWallet[]): WalletOption[] {
  const seen = new Set<string>();
  const out: WalletOption[] = [];
  for (const w of wallets) {
    if (seen.has(w.manifest.id) || !isUsableNearWallet(w)) continue;
    seen.add(w.manifest.id);
    const icon = dataIcon(w.manifest.icon);
    out.push({id: nearOptionId(w.manifest.id), family: "near", name: w.manifest.name.trim(), ...(icon ? {icon} : {}), kind: "injected"});
  }
  return out;
}

/** The account ids a wallet answered `signIn` / `getAccounts` with (`[{accountId}]`), in its order. */
export function accountIdsOf(answer: unknown): string[] {
  if (!Array.isArray(answer)) return [];
  return answer.map((a) => (a as {accountId?: unknown} | null)?.accountId).filter((id): id is string => typeof id === "string");
}
