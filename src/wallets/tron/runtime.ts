/**
 * The Tron third of the wallets (D11): injected wallets from TIP-6963 / `window.tron` / the legacy globals,
 * connect (the wallet's own prompt), account and network changes, and a silent reconnect on the next visit to the
 * wallet remembered in localStorage — read from the wallet's TronWeb, never a prompt. Nothing here signs: getSigner
 * hands the TronWeb to execute (src/execute/accounts/tron.ts), and nothing here contacts a network.
 */
import type {TronConnection} from "../../contracts/wallets";
import {answered} from "../errors";
import type {WalletsStore} from "../state";
import {TRON_WALLET_KEY, type KeyValue} from "../storage";
import {tronOptions, type TronDiscovery, type TronInjected, type TronNetwork} from "./injected";

/** The connected wallet, its account, the network it says it is on. */
export interface TronCurrent {
  wallet: TronInjected;
  address: string;
  network: TronNetwork;
}

export interface TronRuntime {
  /** Start discovery and reconnect the remembered wallet silently. Idempotent. */
  start(): void;
  /** Connect by option id (the wallet's prompt). Throws wallet errors. */
  connect(id: string): Promise<void>;
  /** Forget the connection (an injected Tron wallet has no site disconnect to call). Never throws. */
  disconnect(): Promise<void>;
  current(): TronCurrent | null;
}

export function createTronRuntime(d: {discovery: TronDiscovery; store: WalletsStore; kv: KeyValue}): TronRuntime {
  let cur: {wallet: TronInjected; address: string} | null = null;
  let offChange: (() => void) | null = null;
  let started = false;

  function publish(): void {
    const prev = d.store.fields().tron;
    if (!cur) return d.store.patch({tron: null});
    const next: TronConnection = {family: "tron", address: cur.address, walletName: cur.wallet.name, ...(cur.wallet.icon ? {walletIcon: cur.wallet.icon} : {})};
    const same = prev && prev.address === next.address && prev.walletName === next.walletName && prev.walletIcon === next.walletIcon;
    d.store.patch({tron: same ? prev : next});
  }

  function setCurrent(next: {wallet: TronInjected; address: string} | null): void {
    if (next?.wallet !== cur?.wallet) {
      offChange?.();
      offChange = next ? next.wallet.onChange((accounts) => changed(next.wallet, accounts)) : null;
    }
    cur = next;
    publish();
  }

  /** The wallet moved: the account it names (or shows), none when locked; a remembered wallet may come back. */
  function changed(wallet: TronInjected, accounts?: readonly string[]): void {
    if (!cur || cur.wallet !== wallet) return;
    const address = accounts ? (accounts[0] ?? null) : wallet.account();
    if (!address) return setCurrent(null);
    if (address !== cur.address) setCurrent({wallet, address});
    else publish();
  }

  function refreshOptions(): void {
    const list = d.discovery.list();
    d.store.patch({tronOptions: tronOptions(list)});
    if (cur && !list.includes(cur.wallet)) setCurrent(null);
    trySilent(list);
  }

  /** The remembered wallet, once it shows (or, unlocking, names) an account to this origin without being asked. */
  function trySilent(list: readonly TronInjected[], named?: readonly string[]): void {
    const id = d.kv.get(TRON_WALLET_KEY);
    if (!id || cur) return;
    const wallet = list.find((w) => w.id === id);
    const address = wallet ? (named?.[0] ?? wallet.account()) : null;
    if (wallet && address) setCurrent({wallet, address});
  }

  /** Listens to every listed wallet while disconnected, so an unlock reconnects the remembered one. */
  let offSilent: (() => void)[] = [];
  function watchSilent(): void {
    offSilent.forEach((f) => f());
    offSilent = d.discovery.list().map((w) => w.onChange((accounts) => trySilent([w], accounts)));
  }

  return {
    start() {
      if (started) return;
      started = true;
      d.discovery.subscribe(() => {
        refreshOptions();
        watchSilent();
      });
      d.discovery.start();
      refreshOptions();
      watchSilent();
    },
    async connect(id) {
      const wallet = d.discovery.list().find((w) => w.id === id);
      if (!wallet) throw answered("That wallet isn't available any more — reload the page and try again.");
      const address = await wallet.requestAccount();
      setCurrent({wallet, address});
      d.kv.set(TRON_WALLET_KEY, wallet.id);
    },
    async disconnect() {
      d.kv.remove(TRON_WALLET_KEY);
      setCurrent(null);
    },
    current() {
      if (!cur) return null;
      return {wallet: cur.wallet, address: cur.address, network: cur.wallet.network()};
    },
  };
}
