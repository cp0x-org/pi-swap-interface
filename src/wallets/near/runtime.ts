/**
 * The NEAR half of the wallets (D11): NEAR Connect's injection protocol (injected.ts) over `window`, connect
 * (`signIn` for mainnet, never with an access key), disconnect, and a silent reconnect on the next visit to the
 * wallet remembered in localStorage (`getAccounts`, never `signIn`). The injected API has no account events: execute
 * reads the wallet's accounts again before it prompts. Nothing here signs: getSigner hands the wallet to execute.
 */
import type {NearInjectedWallet} from "../../contracts/execution";
import type {NearConnection} from "../../contracts/wallets";
import {isAddressFor, shortAddress} from "../../catalog";
import {answered} from "../errors";
import {dataIcon} from "../options";
import type {WalletsStore} from "../state";
import {NEAR_WALLET_KEY, type KeyValue} from "../storage";
import {accountIdsOf, isUsableNearWallet, NEAR_INJECTED_EVENT, NEAR_READY_EVENT, nearOptionId, nearOptions} from "./injected";

/** Where the wallets announce themselves: `window` in the browser, an EventTarget in tests. */
export type NearEvents = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;

/** The connected wallet and the account it signs for. */
export interface NearCurrent {
  wallet: NearInjectedWallet;
  accountId: string;
}

export interface NearRuntime {
  /** Listen for wallets, ask them to announce, reconnect the remembered one silently. Idempotent. */
  start(): void;
  /** Connect by option id ("near:<manifest id>"). Throws wallet errors. */
  connect(optionId: string): Promise<void>;
  /** Forget the connection and ask the wallet to sign out (best effort). Never throws. */
  disconnect(): Promise<void>;
  current(): NearCurrent | null;
}

const NETWORK = {network: "mainnet"} as const;

export function createNearRuntime(d: {events: NearEvents; store: WalletsStore; kv: KeyValue}): NearRuntime {
  /** By manifest id; the first announcement wins (wallets announce again on every ready event). */
  const wallets = new Map<string, NearInjectedWallet>();
  let cur: NearCurrent | null = null;
  let started = false;
  let silentPending = false;

  const refreshOptions = () => d.store.patch({nearOptions: nearOptions([...wallets.values()])});

  function setCurrent(next: NearCurrent | null): void {
    cur = next;
    const prev = d.store.fields().near;
    if (!cur) return d.store.patch({near: null});
    const icon = dataIcon(cur.wallet.manifest.icon);
    const conn: NearConnection = {family: "near", address: cur.accountId, walletName: cur.wallet.manifest.name.trim(), ...(icon ? {walletIcon: icon} : {})};
    const same = prev && prev.address === conn.address && prev.walletName === conn.walletName && prev.walletIcon === conn.walletIcon;
    d.store.patch({near: same ? prev : conn});
  }

  async function signOut(wallet: NearInjectedWallet): Promise<void> {
    try {
      await wallet.signOut(NETWORK);
    } catch {
      // The wallet keeps its own session; we have already forgotten the connection.
    }
  }

  async function connect(optionId: string, silent = false): Promise<void> {
    const wallet = [...wallets.values()].find((w) => nearOptionId(w.manifest.id) === optionId);
    if (!wallet) throw answered("That wallet isn't available any more — reload the page and try again.");
    const name = wallet.manifest.name.trim();
    const ids = accountIdsOf(silent ? await wallet.getAccounts(NETWORK) : await wallet.signIn(NETWORK));
    // The account pays and takes refunds: it must be an address the catalog accepts (implicit or `.near`).
    const accountId = ids.find((id) => isAddressFor("near", id));
    if (!accountId) {
      if (silent) return;
      if (ids.length) throw answered(`${name} shared a NEAR account this page can't pay from yet (${shortAddress(ids[0]!, 10, 6)}). Pay NEAR from a deposit address instead.`);
      throw answered(`${name} didn't share a NEAR mainnet account.`);
    }
    if (silent && cur) return; // the user connected something in the meantime
    const prev = cur;
    setCurrent({wallet, accountId});
    d.kv.set(NEAR_WALLET_KEY, wallet.manifest.id);
    if (prev && prev.wallet !== wallet) await signOut(prev.wallet);
  }

  function trySilent(wallet: NearInjectedWallet): void {
    const id = d.kv.get(NEAR_WALLET_KEY);
    if (!id || cur || silentPending || wallet.manifest.id !== id) return;
    silentPending = true;
    void connect(nearOptionId(id), true)
      .catch(() => undefined)
      .finally(() => {
        silentPending = false;
      });
  }

  const onInjected = (e: Event): void => {
    const w = (e as CustomEvent<unknown>).detail;
    if (!isUsableNearWallet(w) || wallets.has(w.manifest.id)) return;
    wallets.set(w.manifest.id, w);
    refreshOptions();
    trySilent(w);
  };

  return {
    start() {
      if (started) return;
      started = true;
      d.events.addEventListener(NEAR_INJECTED_EVENT, onInjected);
      // Wallets that loaded first answer this; wallets that load later announce themselves.
      d.events.dispatchEvent(new Event(NEAR_READY_EVENT));
    },
    connect: (optionId) => connect(optionId),
    async disconnect() {
      const prev = cur;
      d.kv.remove(NEAR_WALLET_KEY);
      setCurrent(null);
      if (prev) await signOut(prev.wallet);
    },
    current: () => cur,
  };
}
