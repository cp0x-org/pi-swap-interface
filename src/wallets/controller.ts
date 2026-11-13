/**
 * One object per page that owns every family: the store the screens read,
 * connect / disconnect with the connect-menu state (`connecting`,
 * `pairingUri`, `error`), and getSigner. Built from explicit dependencies so
 * tests run it over a mock wagmi connector, fake Wallet Standard wallets, a
 * fake injected Tron wallet, a fake TON Connect with a fake TON Connect UI, and
 * fake injected NEAR wallets.
 */
import type {Wallets} from "@wallet-standard/app";
import type {Chain as ViemChain, PublicClient} from "viem";
import type {SourceSigner} from "../contracts/execution";
import type {WalletFamily, WalletsState} from "../contracts/wallets";
import {connectErrorText} from "./errors";
import type {WagmiConfig} from "./evm/config";
import {createEvmRuntime, type EvmRuntime} from "./evm/runtime";
import type {LoadWalletConnect} from "./evm/walletConnect";
import {createNearRuntime, type NearEvents, type NearRuntime} from "./near/runtime";
import {createGetSigner} from "./signer";
import {createSolanaRuntime, type SolanaRuntime} from "./solana/runtime";
import {createWalletsStore} from "./state";
import type {KeyValue} from "./storage";
import type {TronDiscovery} from "./tron/injected";
import {createTronRuntime, type TronRuntime} from "./tron/runtime";
import {createTonRuntime, type LoadTonConnect, type LoadTonConnectUI, type TonRuntime} from "./ton/runtime";

export interface ControllerDeps {
  wagmi: WagmiConfig;
  /** @wallet-standard/app getWallets() (or a fake). */
  standard: Wallets;
  /** runtime config walletConnect.projectId; "" hides WalletConnect. */
  projectId: string;
  kv: KeyValue;
  legacyInjected(): boolean;
  origin(): string;
  chainName(caip2: string): string;
  viemChain(chainId: number): ViemChain | undefined;
  publicClient(chainId: number): PublicClient;
  evmRpcUrls(chainId: number): readonly string[];
  solanaRpcUrls(): readonly string[];
  /** Injected Tron wallets (TIP-6963, window.tron, the legacy globals). */
  tron: TronDiscovery;
  tronApiUrls(): readonly string[];
  /** Where NEAR wallets announce themselves (`window`); without it no NEAR wallet is ever listed. */
  nearEvents?: NearEvents;
  nearRpcUrls?(): readonly string[];
  loadWalletConnect?: LoadWalletConnect;
  ton: {
    /** tonconnect-manifest.json and tonconnect-wallets.json beside index.html, absolute. */
    manifestUrl(): string;
    walletsListUrl(): string;
    /** Runtime config `tonApiUrl` (execute's jetton wallet lookup). */
    tonApiUrl(): string;
    load?: LoadTonConnect;
    /** TON Connect UI (its wallet-picker modal); tests pass a fake. */
    loadUi?: LoadTonConnectUI;
    injected?: (key: string) => boolean;
  };
}

export interface WalletsController {
  readonly wagmi: WagmiConfig;
  getState(): WalletsState;
  /** useSyncExternalStore subscribe; the first subscriber starts discovery and the silent reconnect. */
  subscribe(listener: () => void): () => void;
  /** Start discovery and the silent reconnects (idempotent). */
  start(): void;
  /** Never throws: a failure lands in `error`. */
  connect(optionId: string): Promise<void>;
  /**
   * Never throws. While a connect of that family is pending it only cancels it
   * (the QR sheet closed; TON Connect's modal closes) and keeps the existing
   * connection; otherwise it disconnects the family.
   */
  disconnect(family: WalletFamily): Promise<void>;
  getSigner(caip2: string): Promise<SourceSigner>;
  readonly evm: EvmRuntime;
  readonly solana: SolanaRuntime;
  readonly tron: TronRuntime;
  readonly ton: TonRuntime;
  readonly near: NearRuntime;
}

export function createWalletsController(d: ControllerDeps): WalletsController {
  const store = createWalletsStore({walletConnect: d.projectId !== ""});
  const evm = createEvmRuntime({
    config: d.wagmi,
    store,
    projectId: d.projectId,
    kv: d.kv,
    legacyInjected: d.legacyInjected,
    origin: d.origin,
    ...(d.loadWalletConnect ? {loadWalletConnect: d.loadWalletConnect} : {}),
  });
  const solana = createSolanaRuntime({wallets: d.standard, store, kv: d.kv});
  const tron = createTronRuntime({discovery: d.tron, store, kv: d.kv});
  const ton = createTonRuntime({
    store,
    kv: d.kv,
    manifestUrl: d.ton.manifestUrl,
    walletsListUrl: d.ton.walletsListUrl,
    ...(d.ton.load ? {load: d.ton.load} : {}),
    ...(d.ton.loadUi ? {loadUi: d.ton.loadUi} : {}),
    ...(d.ton.injected ? {injected: d.ton.injected} : {}),
  });
  const near = createNearRuntime({events: d.nearEvents ?? new EventTarget(), store, kv: d.kv});
  let started = false;
  /** Bumped by every connect and every cancel: only the latest attempt writes the menu state. */
  let attempt = 0;
  /** Aborts a pending TON Connect attempt (its modal closes, its bridges stop being listened to). */
  let tonPending: AbortController | null = null;

  const start = () => {
    if (started) return;
    started = true;
    solana.start();
    tron.start();
    ton.start();
    near.start();
    void evm.start();
  };

  const getSigner = createGetSigner({
    ready: () => evm.ready(),
    evm,
    solana,
    tron,
    ton,
    tonApiUrl: d.ton.tonApiUrl,
    near,
    chainName: d.chainName,
    viemChain: d.viemChain,
    publicClient: d.publicClient,
    evmRpcUrls: d.evmRpcUrls,
    solanaRpcUrls: d.solanaRpcUrls,
    tronApiUrls: d.tronApiUrls,
    nearRpcUrls: () => d.nearRpcUrls?.() ?? [],
  });

  return {
    wagmi: d.wagmi,
    evm,
    solana,
    tron,
    ton,
    near,
    getState: store.get,
    subscribe(listener) {
      start();
      return store.subscribe(listener);
    },
    start,
    async connect(optionId) {
      start();
      const option = store.get().options.find((o) => o.id === optionId);
      const mine = ++attempt;
      if (!option) {
        store.patch({connecting: null, pairingUri: null, error: "That wallet isn't available any more — reload the page and try again."});
        return;
      }
      store.patch({connecting: option.id, pairingUri: null, error: null});
      try {
        if (option.family === "evm") await evm.connect(option.id);
        else if (option.family === "solana") await solana.connect(option.id);
        else if (option.family === "tron") await tron.connect(option.id);
        else if (option.family === "near") await near.connect(option.id);
        else {
          tonPending?.abort();
          await ton.connect(option.id, (tonPending = new AbortController()).signal);
        }
        if (mine === attempt) store.patch({connecting: null, pairingUri: null});
      } catch (e) {
        if (mine === attempt) store.patch({connecting: null, pairingUri: null, error: connectErrorText(e, option.name)});
      }
    },
    async disconnect(family) {
      start();
      const s = store.get();
      const pending = s.connecting ? s.options.find((o) => o.id === s.connecting) : undefined;
      if (pending?.family === family) {
        // WalletConnect can't abort a pairing; the stale QR just stops being shown. A TON Connect attempt can (its modal closes).
        attempt++;
        if (family === "ton") tonPending?.abort();
        store.patch({connecting: null, pairingUri: null, error: null});
        return;
      }
      store.patch({error: null});
      try {
        if (family === "evm") await evm.disconnect();
        else if (family === "solana") await solana.disconnect();
        else if (family === "tron") await tron.disconnect();
        else if (family === "near") await near.disconnect();
        else await ton.disconnect();
      } catch {
        // Every runtime forgets the connection locally even when the wallet fails to answer.
      }
    },
    getSigner,
  };
}
