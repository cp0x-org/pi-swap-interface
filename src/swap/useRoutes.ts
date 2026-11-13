/**
 * The route list's quotes (mobile lib/swap/useRoutes.ts semantics): a dry
 * round across every venue that serves the pair 400 ms after the pair, amount
 * or addresses settle, re-run every 30 s while the tab is visible. Routes
 * stream in as venues answer; a refresh keeps the previous list on screen until
 * the first new price lands. A round the user typed past is aborted (its
 * requests too) and its answers dropped; typing back to a request whose round
 * had finished, before the wait is over, shows that list again without asking.
 *
 * Web changes: the key includes both addresses (a typed refund / recipient
 * changes the quote) and starts with the mode, so a preview list clears the
 * moment the request becomes live; state is only set from timer and promise
 * callbacks (react-hooks set-state-in-effect), the "loading" of a pending round
 * is derived; a tab coming back after more than 30 s refreshes at once.
 *
 * Preview rounds (D7, D29: prices before the user's addresses exist) are paced
 * harder: an 800 ms debounce, no timed refresh (one re-ask when the tab comes
 * back after 2 min), and every round — a manual refresh too — spends a token of
 * the tab's preview bucket. With none left the round waits for the next token,
 * and `limitedUntil` says until when.
 */
import {useCallback, useEffect, useEffectEvent, useMemo, useState} from "react";
import type {PriceMap} from "../contracts/domain";
import type {RouteSnapshot, RoutesRequest, RoutesState} from "../contracts/routes";
import {appActive, createTokenBucket, getRuntimeConfig, type TokenBucket} from "../config";
import {NO_QUOTE, classifyRefusal, redactRaw} from "./refusals";

/** How long the form must sit still before a new pair / amount is quoted. */
export const DEBOUNCE_MS = 400;
/** The live route list refreshes this often while the tab is visible. */
export const REFRESH_MS = 30_000;
/** Preview rounds wait longer for the form to settle: each one spends a token of the tab's preview budget. */
export const PREVIEW_DEBOUNCE_MS = 800;
/** A preview older than this is asked again once when the tab comes back; previews never refresh on a timer. */
export const PREVIEW_STALE_MS = 120_000;

/** What useRoutes calls: engine.quoteRoutes (injected so the hook is testable without venues). */
export type QuoteRoutesFn = (
  r: RoutesRequest,
  onUpdate: (s: RouteSnapshot) => void,
  prices?: PriceMap,
  signal?: AbortSignal,
) => Promise<RouteSnapshot | null>;

const IDLE: RoutesState = {snapshot: null, loading: false, error: null, updatedAt: 0, limitedUntil: 0};

/** Everything about a request that changes its quotes, mode first. */
export function routesKey(r: RoutesRequest): string {
  const {from, to, amountIn, slippageBps} = r.req;
  const head = [r.mode, from.key, to.key, amountIn.toString(), slippageBps];
  if (r.mode === "live") return [...head, r.req.recipient, r.req.refundAddress].join("|");
  return [...head, r.req.recipient ?? "", r.req.refundAddress ?? "", r.req.toOther ? "other" : "own"].join("|");
}

/** State as of one round of one key; anything else on screen is derived from it. */
interface Slot {
  key: string | null;
  round: number;
  state: RoutesState;
  /** This round's quote finished (answered or failed); false while it runs or waits for a preview token. */
  settled: boolean;
}

/**
 * A round failure in the user's words (the status line prefixes "Couldn't quote: "). A whole round fails on our side
 * (a request the venues can't be asked with, a bad /config.json), not a venue's log text, and there is no "Technical
 * reason" to fall back on: a text no rule knows shows itself, URLs out and cut to 120 chars, never "No quote right now".
 */
function roundError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const r = classifyRefusal("", msg);
  if (r.category !== "other" || r.reason !== NO_QUOTE) return r.reason;
  const shown = redactRaw(msg);
  return shown.length > 120 ? `${shown.slice(0, 119)}…` : shown || NO_QUOTE;
}

export interface UseRoutesOptions {
  /** The tab's preview bucket (tests); default one per factory, sized by runtime config `preview` on first use. */
  previewBucket?: TokenBucket;
}

/** A useRoutes hook over `quote`; hooks from one factory share its preview bucket (the swap port: one per tab). */
export function createUseRoutes(quote: QuoteRoutesFn, opts: UseRoutesOptions = {}) {
  let bucket = opts.previewBucket ?? null;
  const previewBucket = (): TokenBucket => {
    const {roundsBurst, roundRefillMs} = getRuntimeConfig().preview;
    return (bucket ??= createTokenBucket(roundsBurst, roundRefillMs));
  };

  return function useRoutes(r: RoutesRequest | null, prices: PriceMap): RoutesState & {refresh(): void} {
    const key = r ? routesKey(r) : null;
    const mode = r?.mode ?? null;
    const [round, setRound] = useState(0);
    const [slot, setSlot] = useState<Slot>({key: null, round: -1, state: IDLE, settled: false});

    // Reads the latest request, prices and slot without making them effect dependencies (the key captures r).
    const begin = useEffectEvent((k: string, rnd: number, signal: AbortSignal, limitedUntil: number) => {
      if (!r || routesKey(r) !== k) return;
      const fresh = slot.key !== k;
      const same = (s: Slot) => s.key === k && s.round === rnd;
      setSlot({key: k, round: rnd, settled: false, state: fresh ? {...IDLE, loading: true, limitedUntil} : {...slot.state, loading: true, error: null, limitedUntil}});
      quote(
        r,
        (snap) => {
          if (signal.aborted) return;
          setSlot((s) => {
            if (!same(s)) return s;
            const prev = s.state.snapshot;
            // A refresh keeps the old list until the first new price lands.
            const snapshot = snap.routes.length || fresh || !prev ? snap : {...prev, pending: snap.pending};
            return {...s, state: {...s.state, snapshot}};
          });
        },
        prices,
        signal,
      )
        .then((final) => {
          if (signal.aborted || final === null) return;
          setSlot((s) => (same(s) ? {...s, settled: true, state: {...s.state, snapshot: final, loading: false, error: null, updatedAt: Date.now()}} : s));
        })
        .catch((e: unknown) => {
          if (signal.aborted) return;
          setSlot((s) => (same(s) ? {...s, settled: true, state: {...s.state, loading: false, error: roundError(e), updatedAt: Date.now()}} : s));
        });
    });
    /** May this round start now? A preview spends a token; without one, how long until the next. */
    const admit = useEffectEvent((): {wait: number; limitedUntil: number} => {
      if (r?.mode !== "preview") return {wait: 0, limitedUntil: 0};
      const b = previewBucket();
      if (b.take()) return {wait: 0, limitedUntil: b.nextAt()};
      const at = b.nextAt();
      return {wait: Math.max(1, at - Date.now()), limitedUntil: at};
    });
    /** Out of preview tokens: say until when (a new key's list is cleared; a refresh keeps the list it had). */
    const hold = useEffectEvent((k: string, rnd: number, until: number) =>
      setSlot((s) => ({key: k, round: rnd, settled: false, state: s.key === k ? {...s.state, loading: false, limitedUntil: until} : {...IDLE, limitedUntil: until}})),
    );
    const delayFor = useEffectEvent((k: string) => (slot.key === k ? 0 : r?.mode === "preview" ? PREVIEW_DEBOUNCE_MS : DEBOUNCE_MS));
    /**
     * This key's round already finished and is on screen: the amount was typed away and back within the wait. Only a
     * new round (refresh, timer, tab back) or a new key asks again; a round cut off mid-flight never settled.
     */
    const onScreen = useEffectEvent((k: string, rnd: number) => slot.key === k && slot.round === rnd && slot.settled);
    const staleOnReturn = useEffectEvent(
      () => slot.state.updatedAt > 0 && Date.now() - slot.state.updatedAt > (r?.mode === "preview" ? PREVIEW_STALE_MS : REFRESH_MS),
    );

    useEffect(() => {
      if (!key || onScreen(key, round)) return;
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const go = () => {
        const {wait, limitedUntil} = admit();
        if (wait > 0) {
          hold(key, round, limitedUntil);
          timer = setTimeout(go, wait);
          return;
        }
        begin(key, round, ctl.signal, limitedUntil);
      };
      timer = setTimeout(go, delayFor(key));
      return () => {
        clearTimeout(timer);
        ctl.abort();
      };
    }, [key, round]);

    useEffect(() => {
      if (!key) return;
      const bump = () => setRound((x) => x + 1);
      // Previews never poll: only a live list refreshes on a timer.
      const every =
        mode === "live"
          ? setInterval(() => {
              if (appActive()) bump();
            }, REFRESH_MS)
          : undefined;
      const onVisible = () => {
        if (appActive() && staleOnReturn()) bump();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        clearInterval(every);
        document.removeEventListener("visibilitychange", onVisible);
      };
    }, [key, mode]);

    const refresh = useCallback(() => setRound((x) => x + 1), []);
    const view = useMemo((): RoutesState => {
      if (key === null) return IDLE;
      // A new pair / amount / mode: the list clears while the debounce runs.
      if (slot.key !== key) return {...IDLE, loading: true};
      // A refresh is due: keep the list, show it loading.
      if (slot.round !== round) return {...slot.state, loading: true, error: null};
      return slot.state;
    }, [key, round, slot]);
    return useMemo(() => ({...view, refresh}), [view, refresh]);
  };
}
