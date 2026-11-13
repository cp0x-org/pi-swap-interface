/**
 * One shared 1 s clock for "updated 5 s ago" style labels: every subscriber
 * re-renders on the same tick, and the timer stops when nobody listens.
 */
import {useSyncExternalStore} from "react";

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(onChange);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => now;

/** Epoch ms, refreshed every second while mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
