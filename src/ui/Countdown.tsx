/**
 * Time left until a deadline (deposit address expiry, quote validity): one
 * shared 1 s clock for the whole page, so many countdowns tick together and
 * none keeps a timer alive after it unmounts.
 */
import {useEffect, useRef, useSyncExternalStore} from "react";
import {Text} from "./Text";

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function tick() {
  now = Date.now();
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    timer = setInterval(tick, 1000);
    // the clock slept while nobody listened: catch up before the first second passes
    queueMicrotask(tick);
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

/** While nobody listens the clock does not tick: a first render must read the real time, not the last tick's. */
function wakeClock() {
  if (!timer) now = Date.now();
}

/** Milliseconds left until `until` (epoch ms), never below 0; re-renders every second. */
export function useCountdown(until: number): number {
  wakeClock();
  const t = useSyncExternalStore(subscribe, snapshot, snapshot);
  return Math.max(0, until - t);
}

/** "m:ss" (or "h:mm:ss" from an hour up), rounded up so "0:00" means really expired. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The countdown's colour: amber under `warnBelowMs`, red at zero (DepositPanel rule: amber under 2:00). */
export function countdownTone(ms: number, warnBelowMs = 120_000): "ink" | "amber" | "red" {
  if (ms <= 0) return "red";
  return ms < warnBelowMs ? "amber" : "ink";
}

/** Props of the countdown text. */
export interface CountdownProps {
  /** Deadline, epoch ms. */
  until: number;
  /** Default 2 minutes. */
  warnBelowMs?: number;
  /** Called once when the time runs out. */
  onExpire?: () => void;
  "data-testid"?: string;
}

const COLOR = {ink: undefined, amber: "var(--amber)", red: "var(--red)"} as const;

/** "Expires in" style mm:ss in tabular digits; amber near the end, red at 0:00. */
export function Countdown({until, warnBelowMs, onExpire, ...rest}: CountdownProps) {
  const left = useCountdown(until);
  const expired = left === 0;
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });
  useEffect(() => {
    if (expired) expire.current?.();
  }, [expired]);
  return (
    <Text {...rest} role="timer" tabular weight={600} color={COLOR[countdownTone(left, warnBelowMs)]}>
      {formatCountdown(left)}
    </Text>
  );
}
