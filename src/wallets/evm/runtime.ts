/**
 * The EVM half of the wallets: wagmi state → the store, connect / disconnect
 * (one EVM wallet at a time), the boot reconnect, WalletConnect added lazily,
 * and the chain switch + wallet client getSigner needs. No wallet write is
 * called here (D10): the wallet client is handed to execute.
 */
import {getAddress, type Address, type WalletClient} from "viem";
import type {Connector} from "wagmi";
import {connect as wagmiConnect, disconnect as wagmiDisconnect, getWalletClient, reconnect, switchChain} from "wagmi/actions";
import type {EvmTransport} from "../../contracts/execution";
import {answered, isUserRejection} from "../errors";
import {WALLETCONNECT_ID, evmOptions} from "../options";
import type {WalletsStore} from "../state";
import {WALLETCONNECT_KEY, type KeyValue} from "../storage";
import type {WagmiConfig} from "./config";
import {WALLETCONNECT_TYPE, evmConnectionOf, sameEvmConnection, transportOf} from "./connection";
import {loadWalletConnect as defaultLoadWalletConnect, walletConnectParameters, type LoadWalletConnect} from "./walletConnect";

/** A chain-switch prompt left unanswered this long counts as refused (a switch never sends anything). */
export const SWITCH_TIMEOUT_MS = 120_000;
/** Longest a disconnect waits for the wallet before the connection is just forgotten. */
export const DISCONNECT_TIMEOUT_MS = 5_000;
/**
 * Longest a WalletConnect connect may go without a pairing QR before it counts as failed to start. A relay that
 * refuses this site closes every socket (3000 "Unauthorized: origin not allowed" when the project doesn't list the
 * domain), the provider reconnects forever and connect never settles. Once a QR is shown there is no limit.
 */
export const WC_START_MS = 15_000;
/** Longest a connect or getSigner waits for the boot reconnect. */
export const BOOT_WAIT_MS = 10_000;

/** The live EVM connection getSigner works with. */
export interface EvmCurrent {
  address: Address;
  chainId: number;
  transport: EvmTransport;
}

export interface EvmRuntime {
  /** Subscribe to wagmi, wait for its persisted state, reconnect silently. Idempotent; resolves when the reconnect ended. */
  start(): Promise<void>;
  /** start(), capped at BOOT_WAIT_MS. */
  ready(): Promise<void>;
  /** Connect an injected wallet (EIP-6963 rdns / "injected") or "walletconnect". Throws wallet errors. */
  connect(optionId: string): Promise<void>;
  /** Disconnect every EVM connection. Never throws. */
  disconnect(): Promise<void>;
  current(): EvmCurrent | null;
  /** Ask the wallet to switch (wagmi adds an unknown chain such as Elysium from the config first). */
  switchTo(chainId: number): Promise<void>;
  /** The wallet client bound to that chain and account (asserts the wallet really is on it). */
  walletClient(chainId: number, account: Address): Promise<WalletClient>;
}

export interface EvmRuntimeDeps {
  config: WagmiConfig;
  store: WalletsStore;
  /** WalletConnect project id; "" = no WalletConnect. */
  projectId: string;
  kv: KeyValue;
  /** Something is injected at window.ethereum (for the legacy option). */
  legacyInjected(): boolean;
  /** This page's origin (WalletConnect metadata). */
  origin(): string;
  loadWalletConnect?: LoadWalletConnect;
}

const capped = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
  Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

function timeout<T>(p: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(error()), ms)))]).finally(() => clearTimeout(t));
}

/**
 * Run a WalletConnect `connect`, failed with an answered error when the connector shows no pairing QR (display_uri)
 * within WC_START_MS; a QR in time lifts the limit, the user may take long to scan. `shown` says whether a URI really
 * reached the screen: one the store suppresses (a dropped connector's, a cancelled attempt's) lifts nothing. Listens
 * before connecting: a connector may emit the URI at once.
 */
function untilPairing<T>(connector: Connector, shown: (uri: unknown) => boolean, connect: () => Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const onMessage = ({type, data}: {type: string; data?: unknown}) => {
    if (type === "display_uri" && shown(data)) clearTimeout(t);
  };
  connector.emitter.on("message", onMessage);
  const stalled = new Promise<never>((_, reject) => {
    t = setTimeout(
      () => reject(answered("WalletConnect didn't start — its relay refused this site or isn't answering. Try a browser wallet or try again later.")),
      WC_START_MS,
    );
  });
  return Promise.race([connect(), stalled]).finally(() => {
    clearTimeout(t);
    connector.emitter.off("message", onMessage);
  });
}

/** zustand persist with async storage hydrates a few ticks after createConfig; reconnecting before it would race it. */
function hydrated(config: WagmiConfig): Promise<void> {
  const persist = (config._internal.store as {persist?: {hasHydrated(): boolean; onFinishHydration(cb: () => void): () => void}}).persist;
  if (!persist || persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = persist.onFinishHydration(() => {
      off();
      resolve();
    });
    setTimeout(resolve, 2_000);
  });
}

export function createEvmRuntime(d: EvmRuntimeDeps): EvmRuntime {
  const {config, store} = d;
  const load = d.loadWalletConnect ?? defaultLoadWalletConnect;
  const peerNames = new Map<string, string>();
  let booted: Promise<void> | null = null;
  let wc: Promise<Connector> | null = null;
  /** Bumped by every WalletConnect connect: only the latest may drop the connector (a cancelled one's retry reuses it). */
  let wcAttempt = 0;

  const sync = () => {
    const next = evmConnectionOf(config.state, peerNames);
    const prev = store.fields().evm;
    store.patch({evm: sameEvmConnection(prev, next) ? prev : next});
  };
  const syncOptions = () => store.patch({evmOptions: evmOptions(config.connectors, {legacyInjected: d.legacyInjected()})});

  /** The current connection with a live connector (null while only the persisted shell exists). */
  function live(): {connector: Connector; current: EvmCurrent} | null {
    const s = config.state;
    const c = s.current ? s.connections.get(s.current) : undefined;
    const first = c?.accounts[0];
    if (!c || !first || typeof c.connector.getChainId !== "function") return null;
    return {connector: c.connector, current: {address: getAddress(first), chainId: c.chainId, transport: transportOf(c.connector.type)}};
  }

  /** Remember the phone wallet's name for the header (session metadata; display only). */
  async function notePeer(connector: Connector): Promise<void> {
    if (connector.type !== WALLETCONNECT_TYPE) return;
    const provider = (await connector.getProvider().catch(() => null)) as {session?: {peer?: {metadata?: {name?: unknown}}}} | null;
    const name = provider?.session?.peer?.metadata?.name;
    if (typeof name === "string" && name.trim()) peerNames.set(connector.uid, name.trim().slice(0, 40));
    sync();
  }

  /** Still among wagmi's connectors (not dropped). */
  const listed = (connector: Connector) => config.connectors.some((c) => c.uid === connector.uid);

  /**
   * A pairing URI from this connector goes on screen: someone waits for a WalletConnect QR. A dropped connector's late
   * one (its relay answered after all) would pair nothing anyone waits for.
   */
  const showable = (connector: Connector, uri: unknown): uri is string =>
    typeof uri === "string" && store.fields().connecting === WALLETCONNECT_ID && listed(connector);

  /** Add the WalletConnect connector once (its setup() inits the provider, i.e. contacts the relay). */
  function walletConnectConnector(): Promise<Connector> {
    if (!d.projectId) return Promise.reject(answered("WalletConnect isn't set up on this site."));
    wc ??= (async () => {
      const walletConnect = await load();
      const connector = config._internal.connectors.setup(walletConnect(walletConnectParameters(d.projectId, d.origin())));
      connector.emitter.on("message", ({type, data}) => {
        if (type === "display_uri" && showable(connector, data)) store.patch({pairingUri: data});
      });
      config._internal.connectors.setState((list) => [...list, connector]);
      return connector;
    })().catch((e: unknown) => {
      wc = null;
      throw e;
    });
    return wc;
  }

  /** A failed WalletConnect init is cached inside the connector forever: drop it so the next try starts fresh. */
  function dropWalletConnect(connector: Connector): void {
    // Already dropped (an earlier attempt on it failed too): `wc` may hold its fresh successor by now.
    if (!listed(connector)) return;
    config._internal.connectors.setState((list) => list.filter((c) => c.uid !== connector.uid));
    wc = null;
  }

  /** Take a connection out of wagmi's state without asking the wallet (it shares the provider we keep). */
  function forget(connector: Connector): void {
    // A connection restored from storage holds only {id, name, type, uid} until the reconnect replaces it: no emitter.
    const emitter = (connector as Partial<Connector>).emitter;
    if (emitter) {
      emitter.off("change", config._internal.events.change);
      emitter.off("disconnect", config._internal.events.disconnect);
      if (!emitter.listenerCount("connect")) emitter.on("connect", config._internal.events.connect);
    }
    config.setState((x) => {
      const connections = new Map(x.connections);
      connections.delete(connector.uid);
      const next = x.current === connector.uid ? (connections.values().next().value?.connector.uid ?? null) : x.current;
      return {...x, connections, current: next, status: connections.size ? x.status : "disconnected"};
    });
  }

  async function drop(connector: Connector, keep?: Connector): Promise<void> {
    // wagmi's injected disconnect revokes the provider's permissions: never do that to a provider the new wallet uses.
    const shared = keep && (await Promise.all([connector.getProvider(), keep.getProvider()]).then(([a, b]) => !!a && a === b).catch(() => false));
    if (shared) return forget(connector);
    // A WalletConnect disconnect talks to the relay: don't let a dead network keep the wallet "connected".
    await timeout(wagmiDisconnect(config, {connector}), DISCONNECT_TIMEOUT_MS, () => new Error("disconnect timed out")).catch(() =>
      forget(connector),
    );
  }

  function start(): Promise<void> {
    booted ??= (async () => {
      config.subscribe((s) => s, sync);
      config._internal.connectors.subscribe(syncOptions);
      sync();
      syncOptions();
      await hydrated(config);
      // The relay is contacted at boot only when the last session was WalletConnect (the user picked it then).
      if (d.projectId && d.kv.get(WALLETCONNECT_KEY)) await walletConnectConnector().catch(() => d.kv.remove(WALLETCONNECT_KEY));
      await reconnect(config).catch(() => undefined);
      const now = live();
      if (now?.connector.type === WALLETCONNECT_TYPE) await notePeer(now.connector);
      else if (d.kv.get(WALLETCONNECT_KEY)) d.kv.remove(WALLETCONNECT_KEY);
      sync();
    })();
    return booted;
  }

  return {
    start,
    ready: async () => void (await capped(start(), BOOT_WAIT_MS)),
    async connect(optionId) {
      await capped(start(), 3_000);
      const connector =
        optionId === WALLETCONNECT_ID
          ? await walletConnectConnector()
          : config.connectors.find((c) => c.id === optionId && c.type === "injected");
      if (!connector) throw answered("That wallet isn't available any more — reload the page and try again.");
      const previous = live()?.connector;
      if (previous?.uid === connector.uid) return;
      const walletConnect = connector.type === WALLETCONNECT_TYPE;
      const mine = walletConnect ? ++wcAttempt : 0;
      try {
        const connecting = () => wagmiConnect(config, {connector});
        await (walletConnect ? untilPairing(connector, (uri) => showable(connector, uri), connecting) : connecting());
      } catch (e) {
        // A superseded attempt (cancelled, then retried on the same connector) leaves the connector to the retry.
        if (walletConnect && mine === wcAttempt && !isUserRejection(e)) dropWalletConnect(connector);
        throw e;
      }
      if (walletConnect) {
        d.kv.set(WALLETCONNECT_KEY, "1");
        await notePeer(connector);
      } else d.kv.remove(WALLETCONNECT_KEY);
      if (previous) await drop(previous, connector);
      sync();
    },
    async disconnect() {
      d.kv.remove(WALLETCONNECT_KEY);
      for (const {connector} of [...config.state.connections.values()]) {
        if (typeof connector.disconnect === "function") await drop(connector);
        else forget(connector);
      }
      sync();
    },
    current: () => live()?.current ?? null,
    async switchTo(chainId) {
      const l = live();
      if (!l) throw answered("Connect an EVM wallet first.");
      const now = await l.connector.getChainId().catch(() => l.current.chainId);
      if (now === chainId) return;
      // A plain Error on timeout: getSigner turns any failed switch into "Switch your wallet to {Chain} to swap."
      await timeout(switchChain(config, {chainId, connector: l.connector}), SWITCH_TIMEOUT_MS, () => new Error("chain switch timed out"));
    },
    async walletClient(chainId, account) {
      const l = live();
      if (!l) throw answered("Connect an EVM wallet first.");
      return getWalletClient(config, {chainId, connector: l.connector, account});
    },
  };
}
