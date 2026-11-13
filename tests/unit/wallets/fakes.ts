// Fakes for the wallets tests: an EIP-1193 provider, Wallet Standard wallets and registry, a TON Connect, controller
// deps. No network.
import type {Wallets} from "@wallet-standard/app";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import {numberToHex, type Address, type Chain as ViemChain, type PublicClient} from "viem";
import {vi} from "vitest";
import {injected, type CreateConnectorFn, type Storage} from "wagmi";
import type {ControllerDeps} from "../../../src/wallets/controller";
import {createWagmiConfig, wagmiParameters, type EvmChains} from "../../../src/wallets/evm/config";
import type {LoadWalletConnect} from "../../../src/wallets/evm/walletConnect";
import {memoryKeyValue, type KeyValue} from "../../../src/wallets/storage";
import {createTronDiscovery, type TronDiscovery, type TronWindow} from "../../../src/wallets/tron/injected";
import type {LoadTonConnect, LoadTonConnectUI, TonConnector, TonModalState, TonPicker, TonWalletLike} from "../../../src/wallets/ton/runtime";
import type {TonConnectRequest} from "../../../src/contracts/execution";

export const OWNER = "0x1111111111111111111111111111111111111111" as Address;
export const OWNER_CHECKSUM = "0x1111111111111111111111111111111111111111";

const chain = (id: number, name: string): ViemChain => ({
  id,
  name,
  nativeCurrency: {name: "ETH", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [`https://rpc-${id}.invalid`]}},
});
export const CHAINS: EvmChains = [chain(1, "Ethereum"), chain(42161, "Arbitrum"), chain(99901, "Elysium")];

type Listener = (x: unknown) => void;

/** An injected EIP-1193 wallet: answers accounts / chain / switch / permissions in memory. */
export function fakeEip1193(o: {accounts?: Address[]; chainId?: number; rejectConnect?: boolean; rejectSwitch?: boolean; authorized?: boolean} = {}) {
  const accounts = o.accounts ?? [OWNER];
  let chainId = o.chainId ?? 1;
  // Like a real wallet: eth_accounts is empty until this site is authorized.
  let authorized = o.authorized ?? false;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (ev: string, v: unknown) => listeners.get(ev)?.forEach((l) => l(v));
  const rejected = () => Object.assign(new Error("User rejected the request."), {code: 4001});
  const provider = {
    requests: [] as string[],
    async request({method, params}: {method: string; params?: unknown}): Promise<unknown> {
      provider.requests.push(method);
      switch (method) {
        case "eth_requestAccounts":
          if (o.rejectConnect) throw rejected();
          authorized = true;
          return accounts;
        case "eth_accounts":
          return authorized ? accounts : [];
        case "eth_chainId":
          return numberToHex(chainId);
        case "wallet_requestPermissions":
          if (o.rejectConnect) throw rejected();
          authorized = true;
          return [{parentCapability: "eth_accounts", caveats: [{type: "restrictReturnedAccounts", value: accounts}]}];
        case "wallet_revokePermissions":
          authorized = false;
          return null;
        case "wallet_switchEthereumChain": {
          if (o.rejectSwitch) throw rejected();
          chainId = Number((params as [{chainId: string}])[0].chainId);
          emit("chainChanged", numberToHex(chainId));
          return null;
        }
        default:
          throw Object.assign(new Error(`unsupported ${method}`), {code: 4200});
      }
    },
    on(ev: string, l: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(l);
    },
    removeListener(ev: string, l: Listener) {
      listeners.get(ev)?.delete(l);
    },
    chainId: () => chainId,
    emit,
  };
  return provider;
}

export const ICON = "data:image/svg+xml;base64,PHN2Zy8+";

/** An EIP-6963-style injected connector (id = rdns) over a fake provider. */
export const testWallet = (provider: ReturnType<typeof fakeEip1193>, rdns = "io.test.wallet", name = "Test Wallet"): CreateConnectorFn =>
  injected({target: {id: rdns, name, icon: ICON, provider: provider as never}});

/** A public client whose getCode answers `code` (or throws). */
export const fakePub = (code: string | undefined | Error): PublicClient =>
  ({
    getCode: vi.fn(async () => {
      if (code instanceof Error) throw code;
      return code;
    }),
  }) as unknown as PublicClient;

/** An in-memory Wallet Standard registry (the real one is a page singleton). */
export function fakeRegistry(initial: Wallet[] = []): Wallets & {list: Wallet[]} {
  const list = [...initial];
  const on = {register: new Set<(...w: Wallet[]) => void>(), unregister: new Set<(...w: Wallet[]) => void>()};
  return {
    list,
    get: () => list,
    on(event, listener) {
      on[event].add(listener as (...w: Wallet[]) => void);
      return () => void on[event].delete(listener as (...w: Wallet[]) => void);
    },
    register(...ws) {
      list.push(...ws);
      on.register.forEach((l) => l(...ws));
      return () => {
        for (const w of ws) list.splice(list.indexOf(w), 1);
        on.unregister.forEach((l) => l(...ws));
      };
    },
  };
}

export const solAccount = (address: string, chains: string[] = ["solana:mainnet", "solana:devnet"]): WalletAccount => ({
  address,
  publicKey: new Uint8Array(32),
  chains: chains as WalletAccount["chains"],
  features: ["solana:signTransaction", "solana:signAndSendTransaction"],
});

/** A Wallet Standard Solana wallet. `trusted`: a silent connect returns the accounts. */
export function fakeSolanaWallet(o: {
  name?: string;
  accounts?: WalletAccount[];
  versions?: readonly ("legacy" | 0)[];
  signTransaction?: boolean;
  chains?: string[];
  trusted?: boolean;
  reject?: boolean;
  icon?: string;
} = {}) {
  let accounts: readonly WalletAccount[] = [];
  const listeners = new Set<(p: {accounts?: readonly WalletAccount[]}) => void>();
  const granted = o.accounts ?? [solAccount("So1anaAddress1111111111111111111111111111111")];
  const emit = (p: {accounts?: readonly WalletAccount[]}) => listeners.forEach((l) => l(p));
  const connect = vi.fn(async (input?: {silent?: boolean}) => {
    if (input?.silent && !o.trusted) return {accounts: []};
    if (o.reject) throw Object.assign(new Error("User rejected the request."), {code: 4001});
    accounts = granted;
    return {accounts};
  });
  const disconnect = vi.fn(async () => {
    accounts = [];
  });
  const features: Record<string, unknown> = {
    "standard:connect": {version: "1.0.0", connect},
    "standard:disconnect": {version: "1.0.0", disconnect},
    "standard:events": {
      version: "1.0.0",
      on: (_ev: "change", l: (p: {accounts?: readonly WalletAccount[]}) => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
    },
  };
  if (o.signTransaction !== false)
    features["solana:signTransaction"] = {
      version: "1.0.0",
      supportedTransactionVersions: o.versions ?? ["legacy", 0],
      signTransaction: vi.fn(async () => {
        throw new Error("the wallets module never signs");
      }),
    };
  const wallet = {
    version: "1.0.0" as const,
    name: o.name ?? "Phantom",
    icon: (o.icon ?? ICON) as Wallet["icon"],
    chains: (o.chains ?? ["solana:mainnet", "solana:devnet"]) as Wallet["chains"],
    features: features as Wallet["features"],
    get accounts() {
      return accounts;
    },
  };
  return {
    wallet: wallet as Wallet,
    connect,
    disconnect,
    /** The wallet switched to `next` (or [] = disconnected inside the wallet). */
    change(next: readonly WalletAccount[]) {
      accounts = next;
      emit({accounts: next});
    },
  };
}

/**
 * A fake WalletConnect connector factory: emits a pairing URI, then waits for `approve()`. `relay: false` is a relay
 * that refuses this site: connect emits no URI and never settles; `lateUri(i)` makes the i-th connector set up (the
 * newest by default) emit one anyway (its relay answered after all).
 */
export function fakeWalletConnect(o: {relay?: boolean} = {}) {
  let approve: (() => void) | null = null;
  const params: unknown[] = [];
  const emitters: {emit(ev: string, data: unknown): void}[] = [];
  const load = vi.fn<LoadWalletConnect>(async () => (p) => {
    params.push(p);
    return ((config: {emitter: {emit(ev: string, data: unknown): void}}) => ({
      id: "walletConnect",
      name: "WalletConnect",
      type: "walletConnect",
      async setup() {
        emitters.push(config.emitter);
      },
      async connect() {
        if (o.relay === false) return new Promise<never>(() => {});
        config.emitter.emit("message", {type: "display_uri", data: "wc:test@2?relay-protocol=irn&symKey=00"});
        await new Promise<void>((r) => (approve = r));
        return {accounts: [OWNER], chainId: 1};
      },
      async disconnect() {},
      async getAccounts() {
        return [OWNER];
      },
      async getChainId() {
        return 1;
      },
      async getProvider() {
        return {session: {peer: {metadata: {name: "Rainbow"}}}};
      },
      async isAuthorized() {
        return false;
      },
      onAccountsChanged() {},
      onChainChanged() {},
      onDisconnect() {},
    })) as unknown as CreateConnectorFn;
  });
  return {
    load,
    params,
    approve: () => approve?.(),
    lateUri: (index = emitters.length - 1) => emitters[index]?.emit("message", {type: "display_uri", data: "wc:late@2?relay-protocol=irn&symKey=00"}),
  };
}

/** The connectors the app ships at startup (the targetless injected one). */
export const appConnectors = (): CreateConnectorFn[] => [...(wagmiParameters({chains: CHAINS, rpcUrls: () => [], storage: null}).connectors ?? [])];

/** Controller deps over a wagmi config with the given connectors (no discovery, no storage) and a fake registry. */
export function controllerDeps(o: {
  connectors?: CreateConnectorFn[];
  standard?: Wallets;
  projectId?: string;
  kv?: KeyValue;
  pub?: PublicClient;
  loadWalletConnect?: LoadWalletConnect;
  legacyInjected?: boolean;
  /** wagmi's persisted store (null = none); share one between two controllers to simulate a reload. */
  storage?: Storage | null;
  discovery?: boolean;
  tron?: TronDiscovery;
  loadTonConnect?: LoadTonConnect;
  loadTonConnectUI?: LoadTonConnectUI;
  tonInjected?: (key: string) => boolean;
} = {}): ControllerDeps {
  const params = wagmiParameters({
    chains: CHAINS,
    rpcUrls: (id) => [`https://rpc-${id}.invalid`],
    storage: o.storage ?? null,
    discovery: o.discovery ?? false,
  });
  return {
    wagmi: createWagmiConfig({...params, connectors: o.connectors ?? []}),
    standard: o.standard ?? fakeRegistry(),
    projectId: o.projectId ?? "",
    kv: o.kv ?? memoryKeyValue(),
    legacyInjected: () => o.legacyInjected ?? false,
    origin: () => "https://swap.example",
    chainName: (caip2) => ({"eip155:1": "Ethereum", "eip155:42161": "Arbitrum", "eip155:99901": "Elysium", "solana:mainnet": "Solana", "bitcoin:mainnet": "Bitcoin"})[caip2] ?? caip2,
    viemChain: (id) => CHAINS.find((c) => c.id === id),
    publicClient: () => o.pub ?? fakePub(undefined),
    evmRpcUrls: (id) => [`https://rpc-${id}.invalid`],
    solanaRpcUrls: () => ["https://solana.invalid"],
    tron: o.tron ?? createTronDiscovery(fakeTronWindow()),
    tronApiUrls: () => ["https://tron.invalid"],
    ...(o.loadWalletConnect ? {loadWalletConnect: o.loadWalletConnect} : {}),
    ton: {
      manifestUrl: () => "https://swap.example/tonconnect-manifest.json",
      walletsListUrl: () => "https://swap.example/tonconnect-wallets.json",
      tonApiUrl: () => "https://tonapi.invalid",
      load:
        o.loadTonConnect ??
        (async () => {
          throw new Error("this test loads no TON Connect");
        }),
      loadUi:
        o.loadTonConnectUI ??
        (async () => {
          throw new Error("this test loads no TON Connect UI");
        }),
      injected: o.tonInjected ?? (() => false),
    },
  };
}

/** A TON wallet's raw address (Tether's treasury: the USDT jetton wallet it owns is known on mainnet). */
export const TON_RAW = "0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3";

/** The wallets list the SDK holds when ours didn't load: its own bundled one, every icon remote (and its own bridges). */
export const TON_FALLBACK_LIST: readonly {imageUrl: string}[] = [
  {imageUrl: "https://wallet.tg/images/logo-288.png"},
  {imageUrl: "https://tonkeeper.com/assets/tonconnect-icon.png"},
];

/**
 * A TON Connect stand-in (the SDK surface the runtime uses): a JS-bridge connect answers at once; `approve()` is a
 * wallet picked in TON Connect UI's modal answering (over its HTTP bridge), `fail()` one refusing there;
 * `sendTransaction` records the request; `getWallets` answers our list (bundled icons) unless `list` says otherwise.
 * No network.
 */
export function fakeTonConnect(
  o: {address?: string; chain?: string; appName?: string; reject?: boolean; restorable?: boolean; boc?: string; list?: readonly {imageUrl: string}[]} = {},
) {
  type Listener = {cb: (w: TonWalletLike | null) => void; err?: (e: unknown) => void};
  const listeners = new Set<Listener>();
  let wallet: TonWalletLike | null = null;
  const sources: unknown[] = [];
  const sent: TonConnectRequest[] = [];
  const signals: AbortSignal[] = [];
  let provider: TonWalletLike["provider"] = "injected";
  const connected = (): TonWalletLike => ({device: {appName: o.appName ?? "Tonkeeper"}, provider, account: {address: o.address ?? TON_RAW, chain: o.chain ?? "-239"}});
  const emit = () => {
    for (const l of [...listeners]) l.cb(wallet);
  };
  const refuse = (e: unknown) => {
    for (const l of [...listeners]) l.err?.(e);
  };
  const finish = () => {
    if (o.reject) return refuse(new Error("[TON_CONNECT_SDK_ERROR] UserRejectsError: User rejects the action in the wallet."));
    wallet = connected();
    emit();
  };
  const disconnect = vi.fn(async () => {
    wallet = null;
    emit();
  });
  const restoreConnection = vi.fn(async () => {
    if (!o.restorable) return;
    wallet = connected();
    emit();
  });
  const connector: TonConnector = {
    get wallet() {
      return wallet;
    },
    get account() {
      return wallet ? wallet.account : null;
    },
    getWallets: async () => o.list ?? [{imageUrl: "logos/ton-wallets/tonkeeper.png"}, {imageUrl: "logos/ton-wallets/mytonwallet.png"}],
    onStatusChange(cb, err) {
      const l: Listener = {cb, ...(err ? {err} : {})};
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    connect(source, options) {
      sources.push(source);
      if (options?.signal) signals.push(options.signal);
      provider = "injected";
      queueMicrotask(finish);
    },
    restoreConnection,
    disconnect,
    async sendTransaction(tx, options) {
      sent.push(tx);
      options?.onRequestSent?.();
      return {boc: o.boc ?? ""};
    },
  };
  const load = vi.fn<LoadTonConnect>(async () => connector);
  return {
    connector,
    load,
    sources,
    sent,
    signals,
    disconnect,
    restoreConnection,
    approve: () => {
      provider = "http";
      finish();
    },
    fail: refuse,
  };
}

/**
 * A TON Connect UI stand-in (the picker surface the runtime uses): `openModal` opens it and records the signal the real
 * modal's connects would carry (its view of the connector reads it then); `close()` is the viewer closing it. The real
 * one changes state a task later; this one at once.
 */
export function fakeTonConnectUI() {
  const listeners = new Set<(s: TonModalState) => void>();
  let state: TonModalState = {status: "closed", closeReason: null};
  const set = (next: TonModalState) => {
    state = next;
    for (const l of [...listeners]) l(next);
  };
  const built: Parameters<LoadTonConnectUI>[0][] = [];
  /** Per openModal: the attempt's signal, as the modal's connect would get it. */
  const modalSignals: (AbortSignal | undefined)[] = [];
  const picker: TonPicker = {
    openModal: vi.fn(async () => {
      modalSignals.push(built.at(-1)?.signal());
      set({status: "opened", closeReason: null});
    }),
    closeModal: vi.fn(() => set({status: "closed", closeReason: "action-cancelled"})),
    onModalStateChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
  const load = vi.fn<LoadTonConnectUI>(async (o) => {
    built.push(o);
    return picker;
  });
  return {load, picker, built, modalSignals, state: () => state, close: () => set({status: "closed", closeReason: "action-cancelled"})};
}

/** Let promise chains (wagmi's async storage, connector setup) settle. */
export const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// ── Tron ──

/** Valid mainnet Tron addresses (base58check), used as plain strings: nothing is ever sent. */
export const TRON_OWNER = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi";
export const TRON_OTHER = "TEcDijvKSXcfWT7S6rd44H5vNgufm7Y4XC";

/** A window for Tron discovery: an EventTarget with the globals given (`window.tron`, `window.tronLink`, `window.tronWeb`). */
export function fakeTronWindow(globals: {tron?: unknown; tronLink?: unknown; tronWeb?: unknown} = {}): TronWindow & {tron?: unknown; tronLink?: unknown; tronWeb?: unknown} {
  return Object.assign(new EventTarget(), globals);
}

/**
 * TronLink's TIP-1193 provider: `eth_requestAccounts` (a prompt; `reject` declines it), `accountsChanged` /
 * `chainChanged`, and a TronWeb that exists once this origin is authorized. Its `trx.sign` throws: the wallets
 * module never signs.
 */
export function fakeTronLink(o: {address?: string; authorized?: boolean; reject?: boolean; host?: string} = {}) {
  let address = o.address ?? TRON_OWNER;
  let authorized = o.authorized ?? false;
  let locked = false;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (ev: string, v: unknown) => listeners.get(ev)?.forEach((l) => l(v));
  const tronWeb = {
    defaultAddress: {
      get base58() {
        return authorized && !locked ? address : false;
      },
    },
    fullNode: {host: o.host ?? "https://api.trongrid.io"},
    trx: {
      sign: vi.fn(async () => {
        throw new Error("the wallets module never signs");
      }),
    },
  };
  const provider = {
    requests: [] as string[],
    request: vi.fn(async ({method}: {method: string}) => {
      provider.requests.push(method);
      if (method !== "eth_requestAccounts") throw Object.assign(new Error(`unsupported ${method}`), {code: 4200});
      if (o.reject) throw Object.assign(new Error("User rejected the request."), {code: 4001});
      authorized = true;
      return [address];
    }),
    on(ev: string, l: Listener) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(l);
    },
    removeListener(ev: string, l: Listener) {
      listeners.get(ev)?.delete(l);
    },
    get tronWeb() {
      return authorized ? tronWeb : false;
    },
    /** The user picked another account in the wallet. */
    switchTo(next: string) {
      address = next;
      emit("accountsChanged", [next]);
    },
    lock() {
      locked = true;
      emit("accountsChanged", []);
    },
    unlock() {
      locked = false;
      emit("accountsChanged", [address]);
    },
    chain(chainId: string) {
      emit("chainChanged", {chainId});
    },
    listenerCount: (ev: string) => listeners.get(ev)?.size ?? 0,
    tronWebObject: tronWeb,
  };
  return provider;
}
