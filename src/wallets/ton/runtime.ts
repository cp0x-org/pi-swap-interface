/**
 * The TON half of the wallets (D11): TON Connect through @tonconnect/sdk, which loads as a lazy chunk only when the
 * viewer picks TON, or on a reload after a TON wallet was connected (TON_WALLET_KEY) — never at boot otherwise. The
 * SDK is built with its analytics off (it would send every connect and transaction event to analytics.ton.org), a
 * silent event dispatcher, its session in our localStorage namespace, and its wallets list pointed at
 * `tonconnect-wallets.json` beside index.html (the self-hosted snapshot of TON Connect's official list), so it never
 * fetches TON's remote list. A wallet installed here connects through its JS bridge; the menu's "TON Connect" entry
 * opens TON Connect UI's own modal (owner, 2026-11-13) — a second lazy chunk, built once on that pick as a wallet
 * picker over the same connector, never on a restore. Only mainnet accounts are kept. Nothing here signs: getSigner
 * hands the connector itself (never TON Connect UI) to execute, whose gated account calls `sendTransaction`.
 */
import type {ConnectAdditionalRequest, ITonConnect, TonConnect} from "@tonconnect/sdk";
import type {TonSender} from "../../contracts/execution";
import type {TonConnection} from "../../contracts/wallets";
import {toFriendlyAddress, toRawAddress} from "../../catalog";
import {answered, isAnswered} from "../errors";
import {TON_MAINNET_NETWORK} from "../family";
import type {WalletsStore} from "../state";
import {TON_WALLET_KEY, TONCONNECT_STORE_PREFIX, TONCONNECT_UI_KEYS, TONCONNECT_UI_SESSION_KEY, removeSessionItem, type KeyValue} from "../storage";
import {CP0X_TON_UI_WALLET, CP0X_TON_WALLET, TONCONNECT_ID, isBundledTonIcon, isTonInjected, tonOptions, tonWalletByApp, tonWalletOf, type TonUiWallet} from "./wallets";

/** A connected TON Connect wallet as the SDK reports it (`Wallet`, the fields read here). */
export interface TonWalletLike {
  device: {appName: string};
  /** "injected" (JS bridge) or "http" (TON Connect bridge): execute reads it to tell a sent request from an unsent one. */
  provider: "http" | "injected";
  account: {address: string; chain: string};
}

/** The SDK's TonConnect, as far as the runtime and the signer use it. */
export interface TonConnector extends TonSender {
  readonly wallet: TonWalletLike | null;
  /** The wallets list it holds: ours, or the SDK's own bundled one when ours couldn't be read (kept for its life). */
  getWallets(): Promise<readonly {imageUrl: string}[]>;
  onStatusChange(callback: (wallet: TonWalletLike | null) => void, errorsHandler?: (e: unknown) => void): () => void;
  /** An installed wallet's JS bridge (TON Connect UI's modal connects every other wallet itself). */
  connect(source: {jsBridgeKey: string}, options?: {signal?: AbortSignal}): void;
  restoreConnection(options?: {signal?: AbortSignal}): Promise<void>;
  disconnect(): Promise<void>;
}

/** TON Connect's async key-value store (IStorage). */
export interface TonStorage {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

/** Builds the page's one TON Connect (a dynamic import of the SDK); tests pass a fake. */
export type LoadTonConnect = (o: {manifestUrl: string; walletsListSource: string; storage: TonStorage}) => Promise<TonConnector>;

/** TON Connect UI's modal state (`WalletsModalState`, the fields read here). */
export interface TonModalState {
  status: "opened" | "closed";
  /** Once closed: "action-cancelled" (the viewer closed it) or "wallet-selected". */
  closeReason?: string | null;
}

/** TON Connect UI as the runtime uses it: a wallet picker and nothing else (never its sendTransaction or signData). */
export interface TonPicker {
  /** Resolves once the modal is open (inside a listed wallet's in-app browser: once that wallet was asked instead). */
  openModal(): Promise<void>;
  closeModal(): void;
  onModalStateChange(callback: (state: TonModalState) => void): () => void;
}

/** Builds TON Connect UI over the page's connector (a dynamic import of @tonconnect/ui); tests pass a fake. */
export type LoadTonConnectUI = (o: {
  connector: TonConnector;
  /** The connect attempt in progress: every connect the modal starts ends on its signal. */
  signal(): AbortSignal | undefined;
  /** Wallets the modal lists beside the official ones (cp0x's, inside its in-app browser). */
  includeWallets: readonly TonUiWallet[];
}) => Promise<TonPicker>;

/** TON Connect's events (connect, transaction, modal) go nowhere. */
const SILENT = {dispatchEvent: async () => {}, addEventListener: async () => () => {}};

/** The SDK chunk, built with nothing reporting anywhere and only mainnet asked for. */
export const loadTonConnect: LoadTonConnect = async (o) => {
  const {TonConnect, CHAIN} = await import("@tonconnect/sdk");
  const connector = new TonConnect({
    manifestUrl: o.manifestUrl,
    storage: o.storage,
    walletsListSource: o.walletsListSource,
    analytics: {mode: "off"},
    eventDispatcher: SILENT,
  });
  connector.setConnectionNetwork(CHAIN.MAINNET);
  // The SDK's generic, overloaded connect() doesn't assign structurally; every member used here exists as typed.
  return connector as unknown as TonConnector;
};

/**
 * TON Connect UI's view of the connector: reads pass through, and every connect its modal starts carries the attempt's
 * signal — closing the modal alone doesn't end that connect (its universal QR keeps listening on every bridge in the
 * list), ending the attempt does. It has no write: the modal only picks a wallet. A class, not an object literal: the
 * UI deep-merges the plain objects in its options and would copy the getters' values.
 */
class PickerConnector {
  constructor(
    private readonly c: TonConnect,
    private readonly signal: () => AbortSignal | undefined,
  ) {}
  get connected() {
    return this.c.connected;
  }
  get account() {
    return this.c.account;
  }
  get wallet() {
    return this.c.wallet;
  }
  getWallets() {
    return this.c.getWallets();
  }
  getSessionId() {
    return this.c.getSessionId();
  }
  onStatusChange(...a: Parameters<TonConnect["onStatusChange"]>) {
    return this.c.onStatusChange(...a);
  }
  /** The modal's own call shape: (source, its connect request — none here, options). */
  connect(source: Parameters<TonConnect["connect"]>[0], request?: ConnectAdditionalRequest, options?: {traceId?: string; openingDeadlineMS?: number}) {
    const signal = this.signal();
    return this.c.connect(source, request, {...options, ...(signal && !signal.aborted ? {signal} : {})});
  }
  disconnect() {
    return this.c.disconnect();
  }
}

/**
 * The UI chunk, built over the connector as a picker: no restore of its own (ours is capped), nothing reported, no
 * button, English, the app's dark theme (src/theme/tokens.css), and cp0x's wallet when its in-app browser runs the page.
 */
export const loadTonConnectUI: LoadTonConnectUI = async (o) => {
  const {TonConnectUI, THEME} = await import("@tonconnect/ui");
  // Loading it copied the page's hash query into sessionStorage, as Telegram launch params (storage.ts).
  removeSessionItem(TONCONNECT_UI_SESSION_KEY);
  try {
    return new TonConnectUI({
      connector: new PickerConnector(o.connector as unknown as TonConnect, o.signal) as unknown as ITonConnect,
      restoreConnection: false,
      eventDispatcher: SILENT,
      buttonRootId: null,
      language: "en",
      uiPreferences: {theme: THEME.DARK},
      walletsListConfiguration: {includeWallets: o.includeWallets.map((w) => ({...w, platforms: [...w.platforms]}))},
    });
  } catch (e) {
    // It keeps its own keys (ton-connect-ui_*) in localStorage without a guard: blocked storage is an answer, not a crash.
    throw answered("TON Connect couldn't open in this browser — allow this site to store data, then try again.", e);
  }
};

/** The connected wallet getSigner hands to execute. */
export interface TonCurrent {
  connector: TonConnector;
  /** UQ… (non-bounceable, mainnet). */
  address: string;
  /** 0:<hex>. */
  rawAddress: string;
  walletName: string;
}

export interface TonRuntime {
  /** Fill the menu (installed wallets, then TON Connect) and restore a remembered session. Idempotent. */
  start(): void;
  /** Resolves once a reload's restore ended (capped), so a remembered wallet is live for getSigner. */
  ready(): Promise<void>;
  /**
   * Connect by option id: an installed wallet through its JS bridge, "tonconnect" through TON Connect UI's modal.
   * Resolves once connected, or quietly when the viewer closes the modal. `signal` cancels the attempt (the modal
   * closes), and it gives up after TON_CONNECT_WAIT_MS. Throws wallet errors.
   */
  connect(optionId: string, signal: AbortSignal): Promise<void>;
  /** Forget the session and tell the wallet (best effort). Never throws. */
  disconnect(): Promise<void>;
  current(): TonCurrent | null;
}

/** What the TON runtime reads from the page (the controller passes the browser's; tests pass fakes). */
export interface TonRuntimeDeps {
  store: WalletsStore;
  kv: KeyValue;
  /** Absolute URL of tonconnect-manifest.json beside index.html (the wallet fetches it). */
  manifestUrl(): string;
  /** Absolute URL of tonconnect-wallets.json beside index.html. */
  walletsListUrl(): string;
  load?: LoadTonConnect;
  loadUi?: LoadTonConnectUI;
  /** TON Connect JS bridge test; default `window[key].tonconnect`. */
  injected?: (key: string) => boolean;
}

/** Longest a reload's getSigner waits for the session restore, and a disconnect for the wallet. */
export const TON_RESTORE_WAIT_MS = 10_000;
export const TON_DISCONNECT_WAIT_MS = 5_000;
/** Longest a connect waits for the wallet: the SDK retries a bridge every 2 s with no deadline of its own. */
export const TON_CONNECT_WAIT_MS = 5 * 60_000;

const capped = <T>(p: Promise<T>, ms: number): Promise<T | void> => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

/** localStorage under our prefix, every call guarded (TON Connect keeps its bridge session keys here). */
export function tonStorage(kv: KeyValue): TonStorage {
  return {
    setItem: async (k, v) => kv.set(`${TONCONNECT_STORE_PREFIX}${k}`, v),
    getItem: async (k) => kv.get(`${TONCONNECT_STORE_PREFIX}${k}`),
    removeItem: async (k) => kv.remove(`${TONCONNECT_STORE_PREFIX}${k}`),
  };
}

const text = (e: unknown): string => String((e as {message?: unknown} | null)?.message ?? e);

/**
 * A TON Connect failure in the user's words (the SDK's class names don't survive minification; its info texts do).
 * `name` opens a sentence, `inSentence` sits inside one.
 */
function connectError(e: unknown, name: string, inSentence = name): unknown {
  const t = text(e);
  if (/User rejects the action/i.test(t)) return answered("You declined in your wallet.", e);
  if (/manifest/i.test(t)) return answered(`${name} couldn't read this page's TON Connect manifest (tonconnect-manifest.json).`, e);
  if (/wrong network/i.test(t)) return answered(`Switch ${inSentence} to TON mainnet, then connect again.`, e);
  if (/not exists in the webpage|not injected/i.test(t)) return answered(`${name} isn't available in this browser.`, e);
  return e;
}

/** The page's TON connection; the SDK loads on the first connect, or on a reload's restore of a remembered wallet. */
export function createTonRuntime(d: TonRuntimeDeps): TonRuntime {
  const load = d.load ?? loadTonConnect;
  const loadUi = d.loadUi ?? loadTonConnectUI;
  const injected = d.injected ?? ((key: string) => isTonInjected(key));
  let sdk: Promise<TonConnector> | null = null;
  let ui: Promise<TonPicker> | null = null;
  let cur: TonCurrent | null = null;
  let started = false;
  let restored: Promise<void> = Promise.resolve();
  /** A reload's restore is still running on the connector (it may yet bring a session back on it). */
  let restoring = false;
  /** The option a connect in progress was picked with: it names the connection until the wallet's own name is known. */
  let picking: string | null = null;
  /** The signal of the modal attempt in progress, which the picker puts on every connect the modal starts. */
  let live: AbortSignal | undefined;

  const refreshOptions = () => d.store.patch({tonOptions: tonOptions(injected)});

  function publish(): void {
    const prev = d.store.fields().ton;
    if (!cur) return d.store.patch({ton: null});
    const next: TonConnection = {family: "ton", address: cur.address, walletName: cur.walletName};
    d.store.patch({ton: prev && prev.address === next.address && prev.walletName === next.walletName ? prev : next});
  }

  /** The wallet the SDK reports → the connection, or null for none / a testnet account / an unreadable address. */
  function onWallet(connector: TonConnector, w: TonWalletLike | null): void {
    const raw = w && w.account.chain === TON_MAINNET_NETWORK ? toRawAddress(w.account.address) : null;
    const friendly = raw ? toFriendlyAddress(raw) : null;
    if (!w || !raw || !friendly) {
      if (cur && !w) d.kv.remove(TON_WALLET_KEY); // the wallet ended the session itself
      cur = null;
      return publish();
    }
    const picked = tonWalletOf(picking ?? d.kv.get(TON_WALLET_KEY) ?? "");
    const walletName = tonWalletByApp(w.device.appName)?.name ?? picked?.name ?? "TON wallet";
    cur = {connector, address: friendly, rawAddress: raw, walletName};
    publish();
  }

  function connector(): Promise<TonConnector> {
    sdk ??= load({manifestUrl: d.manifestUrl(), walletsListSource: d.walletsListUrl(), storage: tonStorage(d.kv)}).then(
      (c) => {
        c.onStatusChange((w) => onWallet(c, w));
        return c;
      },
      (e: unknown) => {
        sdk = null;
        throw answered("TON Connect didn't load — check your connection and try again.", e);
      },
    );
    return sdk;
  }

  /**
   * The connector holds our list. When `tonconnect-wallets.json` can't be read the SDK falls back to its own bundled
   * list — remote icons the CSP blocks, bridges ours doesn't name — and keeps it for the connector's life, so TON
   * Connect UI is never built over that: the pick is answered instead, and the connector dropped, so the next pick
   * fetches ours again (unless a session lives on it, or a reload's restore still runs on it).
   */
  async function ourList(c: TonConnector): Promise<void> {
    const list = await c.getWallets();
    if (list.length && list.every((w) => isBundledTonIcon(w.imageUrl))) return;
    if (!cur && !restoring) sdk = null;
    throw answered("TON Connect's wallet list didn't load — check your connection and try again.");
  }

  /**
   * TON Connect UI, built once, on the first pick of its entry, over a connector that holds our list (the UI reads it
   * from there, and preloads every icon). That list never changes after: the SDK fetches it once per connector.
   */
  function picker(c: TonConnector): Promise<TonPicker> {
    const includeWallets = injected(CP0X_TON_WALLET.jsBridgeKey) ? [CP0X_TON_UI_WALLET] : [];
    ui ??= ourList(c)
      .then(() => loadUi({connector: c, signal: () => live, includeWallets}))
      .catch((e: unknown) => {
        ui = null;
        throw isAnswered(e) ? e : answered("TON Connect didn't load — check your connection and try again.", e);
      });
    return ui;
  }

  /** An installed wallet's JS bridge, until it answers (true) or the attempt is aborted (throws). */
  function viaBridge(c: TonConnector, jsBridgeKey: string, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const off = c.onStatusChange(
        (wallet) => {
          if (!wallet) return;
          off();
          resolve(true);
        },
        (e) => {
          off();
          reject(e);
        },
      );
      const stop = () => {
        off();
        reject(signal.reason);
      };
      if (signal.aborted) return stop();
      signal.addEventListener("abort", stop, {once: true});
      try {
        c.connect({jsBridgeKey}, {signal});
      } catch (e) {
        off();
        reject(e);
      }
    });
  }

  /**
   * TON Connect UI's modal, until a wallet connects (true), the viewer closes it (false) or the attempt is aborted
   * (throws; the modal closes). A wallet's error while it is open is the modal's: 2.4.4 shows a decline (with a
   * retry) only on its desktop screen for one wallet, and a wrong network on that screen and the phone's — a decline
   * on its universal QR or a phone's screen changes nothing on the page, and the viewer closes it (a quiet cancel).
   * Only a wallet the page runs inside, which it connects without opening, reports to us.
   */
  async function viaModal(c: TonConnector, signal: AbortSignal): Promise<boolean> {
    const p = await picker(c);
    if (signal.aborted) throw signal.reason;
    live = signal;
    try {
      return await new Promise<boolean>((resolve, reject) => {
        let opened = false;
        const offs: (() => void)[] = [];
        const end = () => {
          for (const off of offs) off();
          signal.removeEventListener("abort", stop);
        };
        const stop = () => {
          end();
          p.closeModal();
          reject(signal.reason);
        };
        offs.push(
          c.onStatusChange(
            (wallet) => {
              if (!wallet) return;
              end();
              resolve(true);
            },
            (e) => {
              if (opened) return;
              end();
              reject(e);
            },
          ),
          p.onModalStateChange((s) => {
            if (s.status === "opened") opened = true;
            else {
              end();
              resolve(!!c.wallet);
            }
          }),
        );
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, {once: true});
        p.openModal().catch((e: unknown) => {
          end();
          reject(e);
        });
      });
    } finally {
      live = undefined;
    }
  }

  async function restore(): Promise<void> {
    restoring = true;
    try {
      const c = await connector();
      await c.restoreConnection();
      if (!c.wallet) d.kv.remove(TON_WALLET_KEY);
    } catch {
      // The session can't come back (the extension is gone, the bridge forgot it): the viewer connects again.
      d.kv.remove(TON_WALLET_KEY);
    } finally {
      restoring = false;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      refreshOptions();
      // Most extensions inject their bridge at document start, some in-app browsers a moment later.
      setTimeout(refreshOptions, 1_000);
      if (d.kv.get(TON_WALLET_KEY)) restored = restore();
    },
    ready: () => capped(restored, TON_RESTORE_WAIT_MS).then(() => undefined),
    async connect(optionId, signal) {
      const w = optionId === TONCONNECT_ID ? null : tonWalletOf(optionId);
      if (w === undefined || (w && !w.jsBridgeKey)) throw answered("That wallet isn't available any more — reload the page and try again.");
      const c = await connector();
      if (cur) throw answered("A TON wallet is already connected — disconnect it first.");
      picking = optionId;
      // The attempt ends on this signal: the viewer's cancel, or our deadline.
      const ctl = new AbortController();
      const cancel = () => ctl.abort(answered("The connection was cancelled."));
      signal.addEventListener("abort", cancel, {once: true});
      if (signal.aborted) cancel();
      const late = w ? `${w.name} didn't answer in time — try connecting again.` : "No TON wallet answered in time — try connecting again.";
      const deadline = setTimeout(() => ctl.abort(answered(late)), TON_CONNECT_WAIT_MS);
      let connected = false;
      try {
        connected = w?.jsBridgeKey ? await viaBridge(c, w.jsBridgeKey, ctl.signal) : await viaModal(c, ctl.signal);
      } catch (e) {
        throw w ? connectError(e, w.name) : connectError(e, "Your TON wallet", "your TON wallet");
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", cancel);
        picking = null;
        // Ended without a wallet: the connect the SDK still holds ends too (the modal's bridges close). Never after a
        // connection — the SDK would close it.
        if (!connected) ctl.abort();
      }
      // The viewer closed the modal: nothing to say.
      if (!connected) return;
      if (!cur) {
        const name = tonWalletByApp(c.wallet?.device.appName ?? "")?.name ?? w?.name ?? "Your TON wallet";
        await capped(c.disconnect().catch(() => undefined), TON_DISCONNECT_WAIT_MS);
        throw answered(`${name} didn't share a TON mainnet account — switch it to mainnet and try again.`);
      }
      // Only a finished connection is remembered: a reload restores it (and nothing else loads TON Connect at boot).
      d.kv.set(TON_WALLET_KEY, optionId);
    },
    async disconnect() {
      d.kv.remove(TON_WALLET_KEY);
      // TON Connect UI's own keys (the last wallet picked in its modal) go with the session.
      for (const k of TONCONNECT_UI_KEYS) d.kv.remove(k);
      const prev = cur;
      cur = null;
      publish();
      if (prev) await capped(prev.connector.disconnect().catch(() => undefined), TON_DISCONNECT_WAIT_MS);
    },
    current: () => cur,
  };
}
