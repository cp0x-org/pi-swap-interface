/**
 * localStorage for per-viewer conveniences only (D16): wagmi's reconnect
 * store, the remembered Solana, Tron and NEAR wallets, the WalletConnect flag,
 * the TON Connect session. Every access is in try/catch: a private window or
 * blocked site data must leave wallets working, just without the silent
 * reconnect. TON Connect UI alone writes keys of its own, unguarded
 * (TONCONNECT_UI_KEYS); the runtime builds it inside a try/catch. It also
 * writes the one sessionStorage key (TONCONNECT_UI_SESSION_KEY), which the
 * runtime removes at once.
 */
import {createStorage, type Storage} from "wagmi";

/** A string key-value store; tests pass a Map-backed one. */
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The browser's localStorage, every call guarded (even reading `localStorage` can throw a SecurityError). */
export const localKeyValue: KeyValue = {
  get(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Quota or blocked storage: the convenience is lost, nothing else.
    }
  },
  remove(key) {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // As above.
    }
  },
};

/** An in-memory KeyValue (tests, and anywhere persistence must not happen). */
export function memoryKeyValue(seed: Readonly<Record<string, string>> = {}): KeyValue {
  const m = new Map(Object.entries(seed));
  return {get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k)};
}

/** wagmi's persisted store over a guarded KeyValue, under our own prefix (keys read `cp0x.wagmi.*`). */
export function wagmiStorage(kv: KeyValue = localKeyValue): Storage {
  return createStorage({
    key: "cp0x.wagmi",
    storage: {getItem: (k) => kv.get(k), setItem: (k, v) => kv.set(k, v), removeItem: (k) => kv.remove(k)},
  });
}

/** The Solana wallet to reconnect silently on the next visit (Wallet Standard name). */
export const SOLANA_WALLET_KEY = "cp0x.solanaWallet.v1";
/** The Tron wallet to reconnect silently on the next visit (its option id), read from its TronWeb without a prompt. */
export const TRON_WALLET_KEY = "cp0x.tronWallet.v1";
/** The NEAR wallet to reconnect silently on the next visit (its NEAR Connect manifest id). */
export const NEAR_WALLET_KEY = "cp0x.nearWallet.v1";
/** Set while the EVM connection is WalletConnect: only then may a reload contact WalletConnect's relay (D11). */
export const WALLETCONNECT_KEY = "cp0x.walletconnect.v1";
/** Set while a TON wallet is connected (its option id): only then may a reload load TON Connect and reach its bridge (D11). */
export const TON_WALLET_KEY = "cp0x.tonWallet.v1";
/** Prefix of TON Connect's own session store (its bridge session keys, the last event id). */
export const TONCONNECT_STORE_PREFIX = "cp0x.tonconnect.";
/**
 * TON Connect UI's own keys, outside our namespace and written without a guard (the wallet picked in its modal, for
 * its "Recent" mark): they exist only once its modal was used, and a TON disconnect removes them.
 */
export const TONCONNECT_UI_KEYS: readonly string[] = ["ton-connect-ui_wallet-info", "ton-connect-ui_preferred-wallet", "ton-connect-ui_last-selected-wallet-info"];
/**
 * TON Connect UI's sessionStorage key: when its chunk loads, it copies the page's hash query (the swap's pay, receive
 * and amount) there as Telegram Mini App launch params, which this app never is. The runtime removes it right after
 * that load, the only time it is written; nothing reads it after.
 */
export const TONCONNECT_UI_SESSION_KEY = "ton-connect-session_storage_launchParams";

/** Removes a sessionStorage key, guarded like localKeyValue. */
export function removeSessionItem(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // Blocked storage: then nothing was written either.
  }
}
