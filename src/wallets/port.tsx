/**
 * The real wallets port (D11, D15). The controller — wagmi config, Wallet
 * Standard, Tron and NEAR discovery, TON Connect, storage — is created on first
 * use, never at import: App.tsx imports this module in demo mode too, and demo
 * mode must not touch a wallet, the network or storage.
 */
import {getWallets} from "@wallet-standard/app";
import {useEffect, useMemo, useState, useSyncExternalStore, type ReactNode} from "react";
import {WagmiContext} from "wagmi";
import {VIEM_CHAINS, chainByCaip2Web, evmRpcUrls, nearRpcUrls, publicClient, tronApiUrls} from "../catalog";
import {getRuntimeConfig} from "../config/runtime";
import type {WalletsPort} from "../contracts/ports";
import type {WalletsApi} from "../contracts/wallets";
import {createWalletsController, type ControllerDeps, type WalletsController} from "./controller";
import {createWagmiConfig, wagmiParameters} from "./evm/config";
import {evmChainIdOf} from "./family";
import {localKeyValue, wagmiStorage} from "./storage";
import {createTronDiscovery} from "./tron/injected";

const viemChain = (chainId: number) => VIEM_CHAINS.find((c) => c.id === chainId);

/** "Arbitrum" for "eip155:42161": the catalog's name, then viem's, then the caip2 itself. */
function chainName(caip2: string): string {
  const id = evmChainIdOf(caip2);
  return chainByCaip2Web(caip2)?.name ?? (id === null ? undefined : viemChain(id)?.name) ?? caip2;
}

/** A file beside index.html, absolute (resolved against document.baseURI, so an IPFS sub-path works). */
const besideIndex = (file: string): string => new URL(file, document.baseURI).href;

/** The browser's dependencies, read from the runtime config once (fixed per page, D9). */
function browserDeps(): ControllerDeps {
  return {
    wagmi: createWagmiConfig(wagmiParameters({chains: VIEM_CHAINS, rpcUrls: evmRpcUrls, storage: wagmiStorage(localKeyValue)})),
    standard: getWallets(),
    projectId: getRuntimeConfig().walletConnect.projectId,
    kv: localKeyValue,
    legacyInjected: () => typeof window !== "undefined" && !!(window as Window & {ethereum?: unknown}).ethereum,
    origin: () => (typeof location === "undefined" ? "" : location.origin),
    chainName,
    viemChain,
    publicClient,
    evmRpcUrls,
    solanaRpcUrls: () => getRuntimeConfig().solanaRpc,
    tron: createTronDiscovery(window),
    tronApiUrls,
    ton: {
      manifestUrl: () => besideIndex("tonconnect-manifest.json"),
      walletsListUrl: () => besideIndex("tonconnect-wallets.json"),
      tonApiUrl: () => getRuntimeConfig().tonApiUrl,
    },
    ...(typeof window !== "undefined" ? {nearEvents: window} : {}),
    nearRpcUrls,
  };
}

let controller: WalletsController | null = null;

/** The page's wallets controller, created on first use. */
export function walletsController(): WalletsController {
  controller ??= createWalletsController(browserDeps());
  return controller;
}

/** Wraps the app: wagmi's context (for any wagmi hook) and the start of discovery + silent reconnect. */
export function WalletsProvider({children}: {children: ReactNode}) {
  const [wagmi] = useState(() => walletsController().wagmi);
  useEffect(() => {
    walletsController().start();
  }, []);
  return <WagmiContext.Provider value={wagmi}>{children}</WagmiContext.Provider>;
}

function useWallets(): WalletsApi {
  const c = walletsController();
  const s = useSyncExternalStore(c.subscribe, c.getState, c.getState);
  return useMemo(() => ({...s, connect: c.connect, disconnect: c.disconnect}), [s, c]);
}

export const walletsPort: WalletsPort = {
  Provider: WalletsProvider,
  useWallets,
  getSigner: (caip2) => walletsController().getSigner(caip2),
};
