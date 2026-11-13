/**
 * One execution per payer and source chain at a time (engine.md §7.5). The engine's own in-flight guard only
 * catches a repeat on the same account object; this one spans tabs (navigator.locks, secure contexts) and always
 * this tab (an in-memory set, also the fallback where Web Locks are missing).
 */
import {Swap2InFlightError} from "@anywalletkit/protocol-swap2-core/errors";
import {answered} from "./errors";

const held = new Set<string>();

/** The lock name for a payer on a chain: `cp0x-swap:<caip2>:<payer>` (EVM addresses lowercased). */
export const swapLockName = (fromChain: string, payer: string): string =>
  `cp0x-swap:${fromChain}:${payer.startsWith("0x") ? payer.toLowerCase() : payer}`;

const busy = () => answered(new Swap2InFlightError("swap2: this swap is already running in another tab or window — wait for its result"));

/** Run `fn` holding `name`, or throw Swap2InFlightError (answered) when another execution holds it. */
export async function withSwapLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (held.has(name)) throw busy();
  held.add(name);
  try {
    const locks = typeof navigator !== "undefined" ? (navigator as Navigator & {locks?: LockManager}).locks : undefined;
    if (!locks?.request) return await fn();
    return await locks.request(name, {ifAvailable: true}, async (lock) => {
      if (!lock) throw busy();
      return fn();
    });
  } finally {
    held.delete(name);
  }
}
