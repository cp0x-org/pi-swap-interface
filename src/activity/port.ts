/**
 * The activity port (contracts/ports.ts ActivityPort): the drawer's ranked list, one record by id, the tracker, and
 * "refresh status". Ranking is mobile lib/txDock.ts restricted to swaps — a claim to make (or a deposit to send),
 * then failures, then what is still moving, then what just finished; a finished swap stays in the header badge
 * 8 s after it last changed (DONE_VISIBLE_MS).
 */
import {useMemo, useSyncExternalStore} from "react";
import type {ActivityItem, ActivityState, ActivityUrgency, SwapRecord} from "../contracts/activity";
import type {ActivityPort} from "../contracts/ports";
import {chainByCaip2Web} from "../catalog";
import {findSwap, isFinal, statusView, visibleSwaps} from "./inflight";
import {markSwapNotSent, useSwaps, useSwapsLoaded} from "./store";
import {pollSwap, useSwapTracker} from "./tracker";

/** A finished swap stays in the header badge this long after its last change. */
export const DONE_VISIBLE_MS = 8_000;

const RANK: Record<ActivityUrgency, number> = {action: 0, failed: 1, pending: 2, done: 3};

/** Where a record belongs in the drawer. Refunded / partly filled: the funds are back or delivered — finished. */
export function urgencyOf(r: SwapRecord, now = Date.now()): ActivityUrgency {
  if (r.status === "action-required") return "action";
  if (r.status === "pending" && r.mode === "deposit" && !r.sourceHash && (r.deposit?.validUntilMs ?? 0) > now) return "action";
  if (!isFinal(r.status)) return "pending";
  return r.status === "failed" || r.status === "expired" || r.status === "cancelled" || r.status === "not-sent" ? "failed" : "done";
}

const chainName = (caip2: string) => chainByCaip2Web(caip2)?.name ?? caip2;

/** The drawer's state from the list at `now` (pure; the hook below feeds it). */
export function activityState(list: readonly SwapRecord[], loaded: boolean, now = Date.now()): ActivityState {
  const items: ActivityItem[] = list
    .map((record) => {
      const toChainName = chainName(record.toChain);
      return {record, view: statusView(record, toChainName, now), urgency: urgencyOf(record, now), fromChainName: chainName(record.fromChain), toChainName};
    })
    .sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || b.record.createdAt - a.record.createdAt);
  // Unfinished, or finished (done or failed) within the last 8 s — mobile's dock rule.
  const badge = items.find((i) => !isFinal(i.record.status) || now - i.record.updatedAt < DONE_VISIBLE_MS) ?? null;
  return {items, badge, visibleCount: visibleSwaps(list, now).length, loaded};
}

// A one-second clock, ticking only while something renders it: done items leave the badge and deposit countdowns move.
let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
function subscribeClock(l: () => void): () => void {
  clockListeners.add(l);
  clockTimer ??= setInterval(() => {
    clockNow = Date.now();
    for (const x of clockListeners) x();
  }, 1_000);
  return () => {
    clockListeners.delete(l);
    if (!clockListeners.size && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}
const readClock = () => clockNow;

function useActivity(): ActivityState {
  const list = useSwaps();
  const loaded = useSwapsLoaded();
  const at = Math.floor(useSyncExternalStore(subscribeClock, readClock, readClock) / 1_000) * 1_000;
  return useMemo(() => activityState(list, loaded, at), [list, loaded, at]);
}

function useSwap(id: string | null): SwapRecord | undefined {
  const list = useSwaps();
  return useMemo(() => (id ? findSwap(list, id) : undefined), [list, id]);
}

/** The real activity port (App picks it unless demo mode is on). */
export const activityPort: ActivityPort = {
  useActivity,
  useSwap,
  useSwapTracker,
  pollSwap,
  markNotSent: (id) => void markSwapNotSent(id),
};
