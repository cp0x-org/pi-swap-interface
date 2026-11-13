/**
 * EVM balances with one eth_call per chain (catalog.md §5.1): Multicall3 `getEthBalance` for the native entry,
 * ERC-20 `balanceOf` for every contract entry, over our own public client (runtime RPCs), never the wallet's
 * provider. Celo and Arc have no native entry, so their gas token is read with `balanceOf` at the catalog's
 * decimals — never also with eth_getBalance (that would count it twice).
 */
import {erc20Abi, multicall3Abi, type Address, type PublicClient} from "viem";
import type {Token} from "../../contracts/domain";
import {multicallAddress} from "../evm";

/** Base units per token key; null = that one read failed (shown as "—", never 0). */
export type BalanceRead = Record<string, bigint | null>;

/** The multicall surface we use — a fake one in tests. */
export type MulticallClient = Pick<PublicClient, "multicall">;

/**
 * One chain's balances for `owner`. Per-token failures (a contract that reverts or is not deployed) come back
 * null; the call throws when the whole read fails (every RPC of the fallback transport refused, or every token
 * failed — the native `getEthBalance` cannot fail on its own).
 */
export async function readEvmBalances(
  client: MulticallClient,
  slug: string,
  tokens: readonly Token[],
  owner: Address,
): Promise<BalanceRead> {
  if (!tokens.length) return {};
  const mc = multicallAddress(slug);
  const contracts = tokens.map((t) =>
    t.contract
      ? ({address: t.contract as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner]} as const)
      : ({address: mc, abi: multicall3Abi, functionName: "getEthBalance", args: [owner]} as const),
  );
  // 4 096 bytes keeps the largest chain (Ethereum, 26 reads ≈ 1 KB of calldata) in a single eth_call.
  const res = await client.multicall({contracts, allowFailure: true, multicallAddress: mc, batchSize: 4_096});
  // With allowFailure viem reports a failed eth_call (every RPC down) as one failure per token. Throw instead, so
  // react-query retries and keeps the last good read rather than caching a page of "unknown".
  const failed = res.filter((r) => r.status === "failure");
  if (failed.length === tokens.length) throw failed[0]?.error ?? new Error(`Balance read failed on ${slug}.`);
  const out: BalanceRead = {};
  tokens.forEach((t, i) => {
    const r = res[i];
    out[t.key] = r?.status === "success" && typeof r.result === "bigint" ? r.result : null;
  });
  return out;
}
