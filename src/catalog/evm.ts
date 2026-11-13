/**
 * viem chain definitions and read clients for the 31 EVM catalog chains (catalog.md §2.4). Built from the
 * catalog, never from `viem/chains`: viem has no Elysium (99901), and the multicall address and RPCs must be
 * ours. RPCs are the runtime config's (D8); config is loaded before this module evaluates (D9).
 */
import {
  createPublicClient,
  custom,
  defineChain,
  fallback,
  http,
  isAddress,
  type Address,
  type Chain as ViemChain,
  type PublicClient,
  type Transport,
} from "viem";
import {catalogChainId} from "@anywalletkit/swap2-assets";
import {isProxyUrl} from "../config";
import {EVM_CHAINS, chainByCaip2, type ChainInfo} from "../shared";
import {evmRpcUrls} from "./rpc";

/** Multicall3: canonical everywhere except zkSync Era (matter-labs deployment). eth_getCode checked on all 31 chains 2026-11-11. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_BY_SLUG: Partial<Record<string, Address>> = {zksync: "0xF9cda624FBC7e059355ce98a31693d299FACd963"};

/** The Multicall3 a balance read targets on this chain slug. */
export const multicallAddress = (slug: string): Address => MULTICALL3_BY_SLUG[slug] ?? MULTICALL3;

/**
 * One catalog chain as a viem/wagmi chain. `rpcUrls` = the runtime list minus cp0x's proxy (D30): this definition
 * reaches wallets (wagmi's switchChain → wallet_addEthereumChain, WalletConnect's rpcMap), and a wallet extension
 * calling the proxy has no allowed Origin, gets 403 and would be left with a broken network. When an operator
 * emptied the list, the catalog's list stays in the definition only, so a wallet can still add the chain
 * (wallet_addEthereumChain needs one URL) — our own reads still go through `readTransport`, which then refuses.
 */
export function toViemChain(c: ChainInfo): ViemChain {
  const id = c.chainId!;
  const urls = evmRpcUrls(id).filter((u) => !isProxyUrl(u));
  return defineChain({
    id,
    name: c.name,
    // All 31 are 18 at the EVM level (Arc's USDC gas token included) — wallet_addEthereumChain requires 18.
    nativeCurrency: {name: c.native.symbol, symbol: c.native.symbol, decimals: c.native.decimals},
    rpcUrls: {default: {http: [...(urls.length ? urls : c.rpc)]}},
    ...(c.explorer ? {blockExplorers: {default: {name: c.name, url: c.explorer}}} : {}),
    contracts: {multicall3: {address: multicallAddress(c.slug)}},
  });
}

/** viem chain definitions for all EVM catalog chains, catalog order (wagmi's `chains`; it adds unknown ones such as Elysium on switch). */
export const VIEM_CHAINS = EVM_CHAINS.map(toViemChain) as [ViemChain, ...ViemChain[]] as readonly [ViemChain, ...ViemChain[]];

const VIEM_BY_ID = new Map(VIEM_CHAINS.map((c) => [c.id, c]));

/**
 * Read transport over the runtime RPC list, in order, with no ranking pings (they would hit every RPC on a timer).
 * An emptied list yields a transport that refuses with a readable error instead of reaching a removed endpoint.
 */
export function readTransport(chainId: number): Transport {
  const urls = evmRpcUrls(chainId);
  if (!urls.length) {
    return custom(
      {
        request: async () => {
          throw new Error(`No RPC is configured for EVM chain ${chainId}.`);
        },
      },
      {retryCount: 0},
    );
  }
  return fallback(
    urls.map((u) => http(u, {timeout: 10_000, retryCount: 0})),
    {rank: false, retryCount: 1},
  );
}

const clients = new Map<number, PublicClient>();

/**
 * Cached public client per chain id (config is fixed per page). Ours, never the wallet's EIP-1193 provider: that
 * one serves only the wallet's current chain and may prompt. Throws for a chain id outside the catalog.
 */
export function publicClient(chainId: number): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const chain = VIEM_BY_ID.get(chainId);
  if (!chain) throw new Error(`catalog: unknown EVM chain ${chainId}`);
  const client: PublicClient = createPublicClient({chain, transport: readTransport(chainId)});
  clients.set(chainId, client);
  return client;
}

/** Tests only: forget cached clients after a runtime-config change. */
export function resetPublicClients(): void {
  clients.clear();
}

/** EIP-7702 delegation designator: an EOA that delegated its code is still a key-held account. */
const DELEGATION = /^0xef0100[0-9a-fA-F]{40}$/;

/**
 * Whether an EVM address holds contract code (eth_getCode ≠ "0x"), for the recipient warning. An EIP-7702
 * delegated EOA counts as an account, not a contract. false off EVM or for a non-address. Rejects when every RPC
 * fails — the caller decides whether a missing warning matters.
 */
export async function isContractAddress(caip2: string, address: string): Promise<boolean> {
  const chain = chainByCaip2(catalogChainId(caip2));
  const a = address.trim();
  if (chain?.family !== "evm" || chain.chainId === undefined || !isAddress(a, {strict: false})) return false;
  const code = await publicClient(chain.chainId).getCode({address: a});
  return !!code && code !== "0x" && !DELEGATION.test(code);
}
