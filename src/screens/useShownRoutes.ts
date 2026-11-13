/**
 * The route list as the screen shows it (D32): the port's state folded render
 * by render (foldShownList), so re-quoting the same pair and amount — a new
 * slippage, recipient or refund address, the 30 s refresh — keeps every row in
 * place and lists the routes still quoted for other terms as `held`. A new
 * pair, amount or mode shows the port's state as it is.
 */
import {useMemo, useState} from "react";
import type {RoutesRequest, RoutesState} from "../contracts/routes";
import {routesKey} from "../swap";
import {foldShownList, heldRoutes, type ShownList} from "./form/model";

/** The port's state with the shown list's snapshot and freshness, plus the held routes. */
export type ShownRoutes = RoutesState & {refresh(): void; held: string[]};

export function useShownRoutes(r: RoutesRequest | null, state: RoutesState & {refresh(): void}): ShownRoutes {
  const [shown, setShown] = useState<ShownList | null>(null);
  // State from the previous render, adjusted during render (React's "storing information from previous renders"):
  // the fold returns `shown` itself for the same input, so this settles in one extra pass.
  const next = r ? foldShownList(shown, r, state) : null;
  if (next !== shown) setShown(next);
  const key = r ? routesKey(r) : null;
  return useMemo((): ShownRoutes => {
    if (!next) return {...state, held: []};
    return {...state, snapshot: next.snapshot, updatedAt: next.updatedAt, held: heldRoutes(next, key)};
  }, [next, state, key]);
}
