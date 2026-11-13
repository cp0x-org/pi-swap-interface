/**
 * The wagmi config (D11): every catalog EVM chain (Elysium included, built
 * by the catalog with defineChain), our own transports over the runtime
 * config's RPC lists, EIP-6963 discovery plus the targetless injected
 * connector for wallets that don't announce. No Coinbase / MetaMask SDKs, and
 * WalletConnect is not a startup connector: it is added only when the user
 * picks it (walletConnect.ts), so its relay is never contacted otherwise.
 */
import type {Chain as ViemChain} from "viem";
import {createConfig, fallback, http, injected, type Config, type CreateConfigParameters, type Storage, type Transport} from "wagmi";
import {isProxyUrl} from "../../config";

export type EvmChains = readonly [ViemChain, ...ViemChain[]];
/** The app's wagmi config type (chains are only known at runtime, so ids are plain numbers). */
export type WagmiConfig = Config<EvmChains, Record<number, Transport>>;

/**
 * Read transport for one chain: the configured RPCs in order, no ranking pings
 * (those would hit every RPC every few seconds). An empty list falls back to
 * the chain definition's own URLs.
 */
export function evmTransport(urls: readonly string[]): Transport {
  if (!urls.length) return http(undefined, {timeout: 10_000, retryCount: 0});
  return fallback(
    urls.map((u) => http(u, {timeout: 10_000, retryCount: 0})),
    {rank: false, retryCount: 1},
  );
}

/**
 * createConfig's input, pure so a test can read it. Deliberately absent:
 * `dataSuffix` (viem appends it to calldata, so the signed data would no longer
 * be the armed data — D10) and any SDK connector. The transports leave out
 * cp0x's proxy (D30): WalletConnect builds the rpcMap of the wallet session
 * from them (@wagmi/connectors walletConnect.js, extractRpcUrls), and a wallet
 * calling the proxy gets 403. The app's own reads use catalog.publicClient.
 */
export function wagmiParameters(o: {
  chains: EvmChains;
  rpcUrls: (chainId: number) => readonly string[];
  storage: Storage | null;
  /** Off in unit tests: EIP-6963 discovery listens on window. */
  discovery?: boolean;
}): CreateConfigParameters<EvmChains, Record<number, Transport>> {
  return {
    chains: o.chains,
    transports: Object.fromEntries(o.chains.map((c) => [c.id, evmTransport(o.rpcUrls(c.id).filter((u) => !isProxyUrl(u)))])),
    multiInjectedProviderDiscovery: o.discovery ?? true,
    // window.ethereum for wallets without EIP-6963 (in-app browsers); the menu hides it when a 6963 wallet is present.
    connectors: [injected({shimDisconnect: true})],
    storage: o.storage,
    ssr: false,
  };
}

/** Build the page's wagmi config (once: chains and transports are fixed per page, D9). */
export function createWagmiConfig(params: CreateConfigParameters<EvmChains, Record<number, Transport>>): WagmiConfig {
  return createConfig(params);
}
