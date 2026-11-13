/**
 * Injected Tron wallets, read from what the page already has — nothing is fetched, no list of wallets is loaded:
 * - TIP-6963: every wallet that answers `TIP6963:requestProvider` (TronLink: rdns `org.tronlink.www`), with its
 *   TIP-1193 provider (`request({method: "eth_requestAccounts"})`, `on("accountsChanged" | "chainChanged" | …)`);
 * - `window.tron`, TronLink's TIP-1193 provider, when nothing announced it;
 * - legacy `window.tronLink` (`tron_requestAccounts` → `{code}`) or a bare `window.tronWeb`, when neither exists.
 * Each becomes one TronInjected. The account comes from the wallet's answer or its TronWeb's `defaultAddress`; the
 * network from `chainChanged` / `connect`, else the TronWeb's node host. Nothing here signs (D10): getSigner hands
 * the TronWeb to execute, whose Tron account asks for the one signature (src/execute/accounts/tron.ts).
 */
import type {TronWebLike} from "../../contracts/execution";
import type {WalletOption} from "../../contracts/wallets";
import {isAddressFor} from "../../catalog";
import {answered} from "../errors";
import {dataIcon} from "../options";

/** Tron mainnet's TIP-1193 chain id (TronLink: Shasta `0x94a9059e`, Nile `0xcd8690dc`). */
export const TRON_MAINNET_CHAIN_ID = "0x2b6653dc";
/** TronLink's TIP-6963 rdns (`window.tron` is listed under it when nothing announced it). */
export const TRONLINK_RDNS = "org.tronlink.www";
/**
 * A Tron option's id: `tron:` + the TIP-6963 rdns. The prefix keeps it apart from the same wallet's EIP-6963 entry
 * (one rdns can announce both an EVM and a Tron provider; the menu finds options by id).
 */
export const tronOptionId = (rdns: string): string => `tron:${rdns}`;
/** The option id of a legacy injection (`window.tronLink` / `window.tronWeb`). */
export const LEGACY_TRON_ID = "tron:injected";

type Listener = (...args: unknown[]) => void;

/** A TIP-1193 provider as TronLink injects it. Only `eth_requestAccounts` is ever requested (ESLint, D10). */
export interface Tip1193Provider {
  request(args: {method: string; params?: unknown}): Promise<unknown>;
  on?(event: string, listener: Listener): void;
  removeListener?(event: string, listener: Listener): void;
  /** TronLink: `false` until this origin is authorized. */
  tronWeb?: unknown;
}

/** Legacy TronLink 3.x: `request({method: "tron_requestAccounts"})` answers `{code: 200}` (4000 pending, 4001 rejected, "" locked). */
export interface LegacyTronLink {
  request?(args: {method: string}): Promise<unknown>;
  tronWeb?: unknown;
  ready?: unknown;
}

/** What the page can see of the window (tests pass a fake). */
export interface TronWindow {
  tron?: unknown;
  tronLink?: unknown;
  tronWeb?: unknown;
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
  dispatchEvent(e: Event): boolean;
}

/** "mainnet", a TronLink test network, or nothing said yet. */
export type TronNetwork = "mainnet" | "test" | "unknown";

/** One injected Tron wallet, normalized. */
export interface TronInjected {
  /** tronOptionId(TIP-6963 rdns), tronOptionId(TRONLINK_RDNS) for `window.tron`, or LEGACY_TRON_ID. */
  id: string;
  name: string;
  icon?: string;
  /** The wallet's connect prompt; resolves with the account it shared. Throws wallet errors. */
  requestAccount(): Promise<string>;
  /** The account the wallet shows this origin right now, without a prompt; null when locked or not authorized. */
  account(): string | null;
  /** The TronWeb the wallet injected for this origin (signing happens only in src/execute/accounts). */
  tronWeb(): TronWebLike | null;
  network(): TronNetwork;
  /** Account or network changes: `accounts` when the wallet named them (`[]` = locked / disconnected). */
  onChange(listener: (accounts?: readonly string[]) => void): () => void;
  /** The object this wallet was found at (dedupe: `window.tron` is the provider TronLink announces). */
  readonly source: object;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && (typeof v === "object" || typeof v === "function");
const isTron = (a: unknown): a is string => typeof a === "string" && isAddressFor("tron", a);

/** A TronWeb object, or null (TronLink's `tronWeb` is `false` until this origin is authorized). */
function tronWebOf(v: unknown): TronWebLike | null {
  return isObj(v) && isObj(v.defaultAddress) ? (v as TronWebLike) : null;
}

/** The base58 account a TronWeb shows (`defaultAddress.base58`; `false` while locked). */
const accountOf = (tw: TronWebLike | null): string | null => (tw && isTron(tw.defaultAddress?.base58) ? tw.defaultAddress.base58 : null);

/** TronWeb's node host names the network when no chain id was heard: Shasta and Nile are TronLink's test networks. */
function networkOfTronWeb(tw: TronWebLike | null): TronNetwork {
  const host = isObj(tw) && isObj((tw as Record<string, unknown>).fullNode) ? ((tw as Record<string, unknown>).fullNode as {host?: unknown}).host : undefined;
  if (typeof host !== "string") return "unknown";
  return /shasta|nile/i.test(host) ? "test" : "unknown";
}

const chainIdOf = (v: unknown): string | null => {
  const id = isObj(v) ? v.chainId : v;
  return typeof id === "string" ? id : null;
};

/** A TIP-1193 provider (TIP-6963 announced, or `window.tron`) as a TronInjected. */
export function tip1193Wallet(provider: Tip1193Provider, info: {id: string; name: string; icon?: unknown}): TronInjected {
  let chainId: string | null = null;
  const icon = dataIcon(info.icon);
  const tronWeb = () => tronWebOf(provider.tronWeb);
  return {
    id: info.id,
    name: info.name,
    ...(icon ? {icon} : {}),
    source: provider,
    async requestAccount() {
      const out = await provider.request({method: "eth_requestAccounts"});
      const first = Array.isArray(out) ? out.find(isTron) : undefined;
      const account = first ?? accountOf(tronWeb());
      if (!account) throw answered(`${info.name} didn't share a Tron account — unlock it and try again.`);
      return account;
    },
    account: () => accountOf(tronWeb()),
    tronWeb,
    network() {
      if (chainId) return chainId === TRON_MAINNET_CHAIN_ID ? "mainnet" : "test";
      return networkOfTronWeb(tronWeb());
    },
    onChange(listener) {
      if (typeof provider.on !== "function") return () => {};
      const accounts: Listener = (a) => listener(Array.isArray(a) ? a.filter(isTron) : undefined);
      const chain: Listener = (v) => {
        chainId = chainIdOf(v) ?? chainId;
        listener();
      };
      provider.on("accountsChanged", accounts);
      provider.on("chainChanged", chain);
      provider.on("connect", chain);
      return () => {
        provider.removeListener?.("accountsChanged", accounts);
        provider.removeListener?.("chainChanged", chain);
        provider.removeListener?.("connect", chain);
      };
    },
  };
}

/** Legacy TronLink's window messages that mean "read the account again" (its payload is never trusted). */
const LEGACY_ACTIONS = new Set(["setAccount", "accountsChanged", "setNode", "disconnectWeb", "connectWeb", "acceptWeb", "tabReply"]);

/** Legacy `window.tronLink` / bare `window.tronWeb` as a TronInjected. */
export function legacyWallet(win: TronWindow): TronInjected | null {
  const link = isObj(win.tronLink) ? (win.tronLink as LegacyTronLink) : null;
  if (!link && !tronWebOf(win.tronWeb)) return null;
  const tronWeb = () => tronWebOf(link?.tronWeb) ?? tronWebOf(win.tronWeb);
  const name = link ? "TronLink" : "Tron browser wallet";
  return {
    id: LEGACY_TRON_ID,
    name,
    source: link ?? (win.tronWeb as object),
    async requestAccount() {
      if (typeof link?.request === "function") {
        const res = await link.request({method: "tron_requestAccounts"});
        const code = isObj(res) ? res.code : undefined;
        if (code === 4001) throw Object.assign(new Error("User rejected the request."), {code: 4001});
        if (code === 4000) throw Object.assign(new Error("Request already pending."), {code: -32002});
        if (code !== 200) throw answered(`Unlock ${name} and try again.`);
      }
      const account = accountOf(tronWeb());
      if (!account) throw answered(`Unlock ${name} and try again.`);
      return account;
    },
    account: () => accountOf(tronWeb()),
    tronWeb,
    network: () => networkOfTronWeb(tronWeb()),
    onChange(listener) {
      const onMessage = (e: Event) => {
        const m = e as MessageEvent<{message?: {action?: unknown}} | null>;
        if (m.source !== (win as unknown) || !LEGACY_ACTIONS.has(String(m.data?.message?.action))) return;
        listener();
      };
      win.addEventListener("message", onMessage);
      return () => win.removeEventListener("message", onMessage);
    },
  };
}

/** The TIP-6963 announcement's detail (TronLink's shape). */
interface Announce {
  info?: {uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown};
  provider?: unknown;
}

const isTip1193 = (v: unknown): v is Tip1193Provider => isObj(v) && typeof v.request === "function";

/**
 * Live discovery: TIP-6963 announcements (asked for once at start, then whenever a wallet announces itself),
 * `window.tron` and the legacy globals. `list()` is the current set, announced wallets first.
 */
export function createTronDiscovery(win: TronWindow) {
  const announced = new Map<string, TronInjected>();
  const listeners = new Set<() => void>();
  let tron: TronInjected | null = null;
  let legacy: TronInjected | null = null;
  let started = false;

  const changed = () => listeners.forEach((l) => l());

  const onAnnounce = (e: Event) => {
    const d = (e as CustomEvent<Announce>).detail;
    const rdns = d?.info?.rdns;
    const name = d?.info?.name;
    if (!isTip1193(d?.provider) || typeof rdns !== "string" || !rdns || typeof name !== "string" || !name) return;
    const prev = announced.get(rdns);
    if (prev?.source === d.provider) return;
    announced.set(rdns, tip1193Wallet(d.provider, {id: tronOptionId(rdns), name: name.slice(0, 64), icon: d.info?.icon}));
    changed();
  };

  /** Re-read the globals (extensions may inject after this script ran). */
  const scan = () => {
    const nextTron = isTip1193(win.tron) ? (tron?.source === win.tron ? tron : tip1193Wallet(win.tron, {id: tronOptionId(TRONLINK_RDNS), name: "TronLink"})) : null;
    const nextLegacy = nextTron ? null : (legacy && (legacy.source === win.tronLink || legacy.source === win.tronWeb) ? legacy : legacyWallet(win));
    if (nextTron === tron && nextLegacy === legacy) return;
    tron = nextTron;
    legacy = nextLegacy;
    changed();
  };

  return {
    start() {
      if (started) return;
      started = true;
      win.addEventListener("TIP6963:announceProvider", onAnnounce);
      // TronLink's own "ready" signal, and the page load: a late injection is picked up then.
      win.addEventListener("tronLink#initialized", scan);
      win.addEventListener("load", scan);
      scan();
      win.dispatchEvent(new Event("TIP6963:requestProvider"));
    },
    /** Announced wallets, then `window.tron` unless announced, then the legacy globals. */
    list(): TronInjected[] {
      const out = [...announced.values()];
      if (tron && !out.some((w) => w.source === tron!.source || w.id === tron!.id)) out.push(tron);
      if (legacy && !out.some((w) => w.source === legacy!.source)) out.push(legacy);
      return out;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** One page's discovery. */
export type TronDiscovery = ReturnType<typeof createTronDiscovery>;

/** The connect menu's Tron entries. */
export function tronOptions(wallets: readonly TronInjected[]): WalletOption[] {
  return wallets.map((w) => ({id: w.id, family: "tron", name: w.name, ...(w.icon ? {icon: w.icon} : {}), kind: "injected"}));
}
