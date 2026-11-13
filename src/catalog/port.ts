/**
 * The catalog's port (D15): the hooks screens reach through `usePorts().catalog`. Chains and tokens are static;
 * balances and prices are react-query reads, so every caller shares one request per key.
 */
import {useQuery} from "@tanstack/react-query";
import {useMemo} from "react";
import type {Owners, PriceMap} from "../contracts/domain";
import type {CatalogPort, SwapTokensState} from "../contracts/ports";
import {useBalances} from "./balances";
import {isContractAddress} from "./evm";
import {CHAIN_LIST} from "./network";
import {lastKnownPrices, loadPrices} from "./prices";
import {TOKENS, swapTokens} from "./tokens";

/** `{}` until the first prices arrive: one shared object, so memoized consumers do not churn. */
const NO_PRICES: PriceMap = Object.freeze({});

/** Module-level so react-query keeps the same placeholder object between renders. */
const warmStart = (): PriceMap | undefined => lastKnownPrices();

/**
 * Symbol → USD, refreshed every 60 s while the tab is visible. react-query's structural sharing keeps the same
 * object when a refresh brings identical numbers; a failed refresh keeps the last good map (loadPrices throws).
 */
export function usePrices(): PriceMap {
  const {data} = useQuery<PriceMap>({
    queryKey: ["prices"],
    queryFn: ({signal}) => loadPrices(signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
    placeholderData: warmStart,
  });
  return data ?? NO_PRICES;
}

/** Owners by value: a caller that rebuilds the object each render must not rebuild the token list. */
function useStableOwners(owners: Owners): Owners {
  const key = JSON.stringify(Object.entries(owners).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "").sort());
  return useMemo(() => Object.fromEntries(JSON.parse(key) as [string, string][]) as Owners, [key]);
}

/** The token universe with the viewer's balances and prices: held first, pay side = payMode !== "none". */
export function useSwapTokens(owners: Owners): SwapTokensState {
  const stable = useStableOwners(owners);
  const balances = useBalances(stable);
  const prices = usePrices();
  const all = useMemo(() => swapTokens(TOKENS, balances.byKey, prices, stable), [balances.byKey, prices, stable]);
  const pay = useMemo(() => all.filter((t) => t.payMode !== "none"), [all]);
  const byKey = useMemo(() => new Map(all.map((t) => [t.key, t])), [all]);
  return useMemo(
    () => ({all, pay, receive: all, byKey, prices, loading: balances.loading, refresh: balances.refresh}),
    [all, pay, byKey, prices, balances.loading, balances.refresh],
  );
}

/** EVM contract check for the recipient warning: cached 5 min per (chain, address); null while unknown or not EVM. */
export function useIsContract(caip2: string, address: string | null): boolean | null {
  const {data} = useQuery({
    queryKey: ["is-contract", caip2, address],
    enabled: !!address && caip2.startsWith("eip155:"),
    queryFn: () => isContractAddress(caip2, address!),
    staleTime: 300_000,
    retry: 1,
  });
  return data ?? null;
}

/** The real catalog port (App.tsx's realPorts). */
export const catalogPort: CatalogPort = {
  useChains: () => CHAIN_LIST,
  useTokens: () => TOKENS,
  useBalances,
  usePrices,
  useSwapTokens,
  useIsContract,
};
