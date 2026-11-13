/**
 * Minimal toasts ("Address copied"): a module-level queue any code can push
 * to with `showToast`, drawn by one `<Toaster/>` the app mounts once. Polite
 * live region, auto-dismiss; nothing important lives only in a toast.
 */
import {useSyncExternalStore} from "react";
import {cx} from "./cx";
import s from "./Toast.module.css";

/** Colour of the toast's dot. */
export type ToastTone = "accent" | "green" | "amber" | "red";

/** One queued toast. */
export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: readonly ToastItem[]) {
  items = next;
  for (const l of listeners) l();
}

/** Show `text` for `ms` (default 2.4 s); at most three at once, the oldest goes first. */
export function showToast(text: string, opts: {tone?: ToastTone; ms?: number} = {}): number {
  const id = nextId++;
  emit([...items, {id, text, tone: opts.tone ?? "accent"}].slice(-3));
  setTimeout(() => dismissToast(id), opts.ms ?? 2400);
  return id;
}

/** Remove one toast early. */
export function dismissToast(id: number): void {
  if (items.some((t) => t.id === id)) emit(items.filter((t) => t.id !== id));
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => items;

/** The toasts on screen; mount once near the root (the integrator does, next to the sheets). */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className={s.region} role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={s.toast}>
          <span className={cx(s.dot, t.tone !== "accent" && s[t.tone])} aria-hidden="true" />
          {t.text}
        </div>
      ))}
    </div>
  );
}
