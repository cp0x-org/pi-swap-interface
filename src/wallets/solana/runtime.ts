/**
 * The Solana half of the wallets (D11, D18): Wallet Standard discovery
 * (wallets register at any time), connect / disconnect, account changes from
 * `standard:events`, and a silent reconnect on the next visit to the wallet
 * remembered in localStorage. Nothing here signs: getSigner hands the wallet
 * and account to execute, whose SDK account calls `solana:signTransaction`.
 */
import type {Wallets} from "@wallet-standard/app";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import type {SolanaConnection} from "../../contracts/wallets";
import {answered} from "../errors";
import {dataIcon} from "../options";
import type {WalletsStore} from "../state";
import {SOLANA_WALLET_KEY, type KeyValue} from "../storage";
import {
  connectFeature,
  disconnectFeature,
  eventsFeature,
  findSolanaWallet,
  isUsableSolanaWallet,
  pickSolanaAccount,
  solanaOptions,
} from "./standard";

/** The connected wallet and the account it signs with. */
export interface SolanaCurrent {
  wallet: Wallet;
  account: WalletAccount;
}

export interface SolanaRuntime {
  /** Start listening for wallets and reconnect the remembered one silently. Idempotent. */
  start(): void;
  /** Connect by Wallet Standard name (the option id). Throws wallet errors. */
  connect(name: string): Promise<void>;
  /** Forget the connection and ask the wallet to disconnect (best effort). Never throws. */
  disconnect(): Promise<void>;
  /** The connection, with the wallet's live account object (wallets match accounts by identity). */
  current(): SolanaCurrent | null;
}

export function createSolanaRuntime(d: {wallets: Wallets; store: WalletsStore; kv: KeyValue}): SolanaRuntime {
  let cur: SolanaCurrent | null = null;
  let offEvents: (() => void) | null = null;
  let started = false;
  let silentPending = false;

  const refreshOptions = () => d.store.patch({solanaOptions: solanaOptions(d.wallets.get())});

  function publish(): void {
    const prev = d.store.fields().solana;
    if (!cur) return d.store.patch({solana: null});
    const icon = dataIcon(cur.wallet.icon);
    const next: SolanaConnection = {family: "solana", address: cur.account.address, walletName: cur.wallet.name, ...(icon ? {walletIcon: icon} : {})};
    const same = prev && prev.address === next.address && prev.walletName === next.walletName && prev.walletIcon === next.walletIcon;
    d.store.patch({solana: same ? prev : next});
  }

  function listen(wallet: Wallet): () => void {
    const events = eventsFeature(wallet);
    if (typeof events?.on !== "function") return () => {};
    return events.on("change", ({accounts, chains, features}) => {
      if (chains || features) refreshOptions();
      if (!cur || cur.wallet !== wallet) return;
      if (!isUsableSolanaWallet(wallet)) return setCurrent(null);
      if (!accounts) return;
      const account = pickSolanaAccount(accounts, cur.account.address);
      if (!account) {
        // The user disconnected from inside the wallet: don't reconnect it silently next time either.
        d.kv.remove(SOLANA_WALLET_KEY);
        return setCurrent(null);
      }
      if (account !== cur.account) setCurrent({wallet, account});
    });
  }

  function setCurrent(next: SolanaCurrent | null): void {
    if (next?.wallet !== cur?.wallet) {
      offEvents?.();
      offEvents = next ? listen(next.wallet) : null;
    }
    cur = next;
    publish();
  }

  async function standardDisconnect(wallet: Wallet): Promise<void> {
    try {
      await disconnectFeature(wallet)?.disconnect();
    } catch {
      // The wallet keeps its own permission; we have already forgotten the connection.
    }
  }

  async function connect(name: string, silent = false): Promise<void> {
    const wallet = findSolanaWallet(d.wallets.get(), name);
    if (!wallet) throw answered(`${name} isn't available any more — reload the page and try again.`);
    const feature = connectFeature(wallet)!;
    const out = silent ? await feature.connect({silent: true}) : await feature.connect();
    const account = pickSolanaAccount(out?.accounts?.length ? out.accounts : wallet.accounts);
    if (!account) {
      if (silent) return;
      throw answered(`${wallet.name} didn't share a Solana mainnet account.`);
    }
    if (silent && cur) return; // the user connected something in the meantime
    const prev = cur;
    setCurrent({wallet, account});
    d.kv.set(SOLANA_WALLET_KEY, wallet.name);
    if (prev && prev.wallet !== wallet) await standardDisconnect(prev.wallet);
  }

  function trySilent(candidates: readonly Wallet[]): void {
    const name = d.kv.get(SOLANA_WALLET_KEY);
    if (!name || cur || silentPending || !candidates.some((w) => w.name === name && isUsableSolanaWallet(w))) return;
    silentPending = true;
    void connect(name, true)
      .catch(() => undefined)
      .finally(() => {
        silentPending = false;
      });
  }

  return {
    start() {
      if (started) return;
      started = true;
      refreshOptions();
      d.wallets.on("register", (...added) => {
        refreshOptions();
        trySilent(added);
      });
      d.wallets.on("unregister", (...removed) => {
        refreshOptions();
        if (cur && removed.includes(cur.wallet)) setCurrent(null);
      });
      trySilent(d.wallets.get());
    },
    connect: (name) => connect(name),
    async disconnect() {
      const prev = cur;
      d.kv.remove(SOLANA_WALLET_KEY);
      setCurrent(null);
      if (prev) await standardDisconnect(prev.wallet);
    },
    current() {
      if (!cur) return null;
      const address = cur.account.address;
      return {wallet: cur.wallet, account: cur.wallet.accounts.find((a) => a.address === address) ?? cur.account};
    },
  };
}
