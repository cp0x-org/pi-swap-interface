/**
 * Pacing, pure (no SDK imports: Standard's routing uses it at boot, before the app loads).
 * - A token bucket for preview rounds (D29): `burst` rounds at once, then one more every `refillMs`, with an
 *   injectable clock; the swap port's useRoutes and the demo port each keep one per tab. Advisory only: there is no
 *   backend, so it paces this tab's own requests to the venues (and their per-IP limits), nothing more.
 * - `paced`, a FIFO gap between calls (providers.ts' Symbiosis and Jupiter, standard.ts' direct Symbiosis calls).
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * FIFO pacing: calls start at least `gapMs` apart. Symbiosis' /v2/quote is
 * 1 request/s per IP and the module fires two fetches back to back; Jupiter
 * keyless is 0.5 RPS (providers.md §0.8). Only starts are spaced: a call that
 * itself sends twice (a proxy call, then its direct retry) is one turn here.
 */
export function paced<A extends unknown[], R>(gapMs: number, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  let next = 0;
  return async (...a: A) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await sleep(at - now);
    return fn(...a);
  };
}

export interface TokenBucket {
  /** Spend one token: true when there was one. */
  take(): boolean;
  /** When the next whole token is there (ms), 0 while one is available. */
  nextAt(): number;
}

/** A full bucket of `burst` tokens refilling continuously at one per `refillMs`. */
export function createTokenBucket(burst: number, refillMs: number, now: () => number = Date.now): TokenBucket {
  let tokens = burst;
  let at = now();
  const fill = () => {
    const t = now();
    tokens = Math.min(burst, tokens + Math.max(0, t - at) / refillMs);
    at = t;
    return t;
  };
  return {
    take() {
      fill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    nextAt() {
      const t = fill();
      return tokens >= 1 ? 0 : t + Math.ceil((1 - tokens) * refillMs);
    },
  };
}
