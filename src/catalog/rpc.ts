/**
 * RPC lists come from the runtime config only (D8): the operator's runtime-config.json can replace or empty a
 * chain's list, and nothing in the app may reach a URL they removed. Read per call, never cached at import, so a
 * test's setRuntimeConfig() takes effect.
 */
import {getRuntimeConfig} from "../config";

/** Runtime-config RPC list for an EVM chain id, tried in order ([] when none: that chain has no reads). */
export const evmRpcUrls = (chainId: number): readonly string[] => getRuntimeConfig().evmRpc[chainId] ?? [];

/** Runtime-config Solana RPCs, tried in order (browser-usable endpoints only; mainnet-beta 403s browser origins). */
export const solanaRpcUrls = (): readonly string[] => getRuntimeConfig().solanaRpc;

/** Runtime-config Tron HTTP API hosts (`/wallet/*`), tried in order. */
export const tronApiUrls = (): readonly string[] => getRuntimeConfig().tronApi;

/** Runtime-config NEAR RPCs, tried in order ([] when the operator emptied it: no NEAR reads). */
export const nearRpcUrls = (): readonly string[] => getRuntimeConfig().nearRpc;
