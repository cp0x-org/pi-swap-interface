/**
 * Venue back-off (D29): after a venue answers with a rate limit (RATE_LIMITED, the predicate the route list's "busy"
 * rows use), the engine's rounds — live and preview — stop asking it until the wait it named is over ("retry in 2
 * hours", read with the list's own RETRY_WAIT), else 60 s doubling per repeat up to 15 min; a quote from it clears
 * the back-off. While it backs off the venue gets a refusal in the list's words and nothing is sent, so a lockout
 * isn't extended by our own retries. The review's re-quote (requoteRoute) doesn't go through it. Pure, with an
 * injectable clock.
 */
import {retryAfterMs} from "./providerWrappers";

const FIRST_MS = 60_000;
const FALLBACK_MAX_MS = 15 * 60_000;
/** A venue's own wait is believed up to this (LI.FI says 2 h): a bad answer can't switch a venue off for the session. */
const NAMED_MAX_MS = 3 * 3_600_000;

export interface VenueBackoff {
  /** The refusal for a venue still backing off ("lifi: rate limit exceeded, retry in ~3 min"), or null to ask it. */
  refusal(provider: string): string | null;
  /** A rate-limit answer from `provider` (its text, to read a named wait from). */
  limited(provider: string, reason: string): void;
  /** `provider` quoted: back to normal. */
  quoted(provider: string): void;
}

export function createVenueBackoff(now: () => number = Date.now): VenueBackoff {
  const state = new Map<string, {until: number; strikes: number}>();
  return {
    refusal(provider) {
      const s = state.get(provider);
      const left = s ? s.until - now() : 0;
      return left > 0 ? `${provider}: rate limit exceeded, retry in ~${Math.ceil(left / 60_000)} min` : null;
    },
    limited(provider, reason) {
      const strikes = (state.get(provider)?.strikes ?? 0) + 1;
      const named = retryAfterMs(reason);
      const wait = named !== null ? Math.min(named, NAMED_MAX_MS) : Math.min(FIRST_MS * 2 ** (strikes - 1), FALLBACK_MAX_MS);
      state.set(provider, {until: now() + wait, strikes});
    },
    quoted(provider) {
      state.delete(provider);
    },
  };
}
