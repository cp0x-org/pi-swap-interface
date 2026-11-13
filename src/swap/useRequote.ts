/**
 * The review's re-quote of the one picked route (mobile app/swap/review.tsx
 * L69-111, D19): every 30 s while the tab is visible, retry once, never
 * cached across reviews. The fresh route replaces the drafted one when it
 * lands; a venue that no longer routes the swap sets `gone`, which blocks
 * Confirm; a failed re-quote (network) keeps the drafted route — the engine
 * re-quotes live before anything is signed anyway.
 */
import {useQuery} from "@tanstack/react-query";
import {useCallback, useMemo} from "react";
import type {PriceMap} from "../contracts/domain";
import type {SwapDraft} from "../contracts/execution";
import type {QuoteRequest, RequoteState, WebRoute} from "../contracts/routes";
import {providerName} from "./providerMeta";
import {REFRESH_MS, routesKey} from "./useRoutes";

/** What useRequote calls: engine.requoteRoute (injected so the hook is testable without venues). */
export type RequoteRouteFn = (req: QuoteRequest, provider: string, prices?: PriceMap) => Promise<{route: WebRoute | null; reason: string | null}>;

/** A useRequote hook over `requote`. Needs a QueryClientProvider (App has one). */
export function createUseRequote(requote: RequoteRouteFn) {
  return function useRequote(draft: SwapDraft | null, prices: PriceMap): RequoteState & {refetch(): void} {
    const provider = draft?.route.provider ?? "";
    const q = useQuery({
      // Strings only: the key is hashed with JSON.stringify, which throws on a bigint.
      queryKey: ["swap-requote", provider, draft ? routesKey({mode: "live", req: draft.req}) : ""],
      enabled: !!draft,
      queryFn: () => requote(draft!.req, provider, prices),
      refetchInterval: REFRESH_MS,
      retry: 1,
      staleTime: 0,
      gcTime: 0,
    });
    const {data, isError, refetch} = q;
    const again = useCallback(() => void refetch(), [refetch]);
    return useMemo(() => {
      if (!draft) return {route: null, gone: null, failed: false, loading: false, refetch: again};
      const gone = data && !data.route ? `${providerName(provider)} no longer routes this swap: ${data.reason ?? "no route right now"}` : null;
      return {
        route: data ? data.route : draft.route,
        gone,
        failed: isError,
        loading: data === undefined && !isError,
        refetch: again,
      };
    }, [draft, data, isError, provider, again]);
  };
}
