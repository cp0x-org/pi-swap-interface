/**
 * The swap counter (ARCHITECTURE D36, owner 2026-11-13): one anonymous POST to cp0x's swap-web proxy
 * (`<API>/api/v2/swap-web/sent`) per swap this browser sends, holding exactly `{venue, from, to, mode}` — the venue's
 * id, the two networks' CAIP-2 ids and wallet | deposit. No address, amount, hash, swap id or time: cp0x keeps counts
 * per UTC day (venue × direction × mode) and posts a daily summary to its ops chat.
 * - Only on a Standard page: a build with VITE_CP0X_API, the Standard mode, not demo (pageConnection's plan). Public,
 *   Custom, demo and every build without the API never send it.
 * - Once per swap: the activity store notes the moment a record first reads as sent (inflight readsSent: the wallet
 *   broadcast it, or a QR deposit was seen) in the tab whose write made it so, and sets `counted` on the record in that
 *   same write; a reload, another tab or the tracker never counts it again (store.ts).
 * - Fire-and-forget: a simple `text/plain` POST (no preflight, so `keepalive` carries it even when the tab closes right
 *   after the broadcast), no credentials, no referrer, a 5 s timeout. The answer is never read; every error is
 *   swallowed.
 */
import type {SwapRecord} from "../contracts/activity";
import {chainByCaip2Web} from "../catalog";
import {DEFAULT_RUNTIME_CONFIG, isDemo, pageConnection, type PageConnection} from "../config";

/** The whole body: nothing else is ever sent. */
export interface SentEvent {
  venue: string;
  from: string;
  to: string;
  mode: "wallet" | "deposit";
}

export const SENT_TIMEOUT_MS = 5_000;

/** What is sent for `r`: null for a venue or network this app doesn't list (cp0x's allowlist would refuse it anyway). */
export function sentEvent(r: SwapRecord): SentEvent | null {
  const from = chainByCaip2Web(r.fromChain);
  const to = chainByCaip2Web(r.toChain);
  if (!Object.hasOwn(DEFAULT_RUNTIME_CONFIG.providers, r.provider) || !from || !to) return null;
  return {venue: r.provider, from: from.caip2, to: to.caip2, mode: r.mode ?? "wallet"};
}

export interface CountDeps {
  /** Default: this page's connection. */
  page?: PageConnection;
  /** Default: isDemo(). */
  demo?: boolean;
  /** Default: the page's fetch. */
  fetch?: typeof fetch;
}

/** Count `r` once it reads as sent (store.ts calls it once per record). Never throws, never waits. */
export function countSent(r: SwapRecord, d: CountDeps = {}): void {
  try {
    const page = d.page ?? pageConnection();
    if (page.mode !== "standard" || !page.plan || (d.demo ?? isDemo())) return;
    const event = sentEvent(r);
    if (!event) return;
    const init: RequestInit = {
      method: "POST",
      headers: {"content-type": "text/plain;charset=UTF-8"},
      body: JSON.stringify(event),
      keepalive: true,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(SENT_TIMEOUT_MS),
    };
    const url = `${page.plan.base}/sent`;
    void (d.fetch ? d.fetch(url, init) : globalThis.fetch(url, init)).catch(() => {});
  } catch {
    // A count is never worth an error.
  }
}
