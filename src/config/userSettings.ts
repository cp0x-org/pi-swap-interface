/**
 * The viewer's own overrides of the runtime config (API bases, venues on/off,
 * previews off, a WalletConnect project id), kept in this browser's
 * localStorage as a RuntimeConfigInput. The boot merges them after
 * runtime-config.json and before the hash demo flag (D8); they apply on the
 * next load because providers and RPC lists are built once per page (D9).
 * Every access is guarded: a private window or blocked storage just means no
 * overrides.
 */
import type {RuntimeConfigInput} from "../contracts/config";

/** localStorage key of the overrides (JSON RuntimeConfigInput). */
export const USER_SETTINGS_KEY = "cp0x.swap.settings.v1";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Sections this layer never applies: demo is the URL's job, and NEAR Intents suspensions are the operator's lever to
 * pause a corridor fast (risk 10), so a stale saved value must not undo one. RPCs moved to the connection settings
 * (Custom mode, D30); connection.ts reads an older browser's `evmRpc` / `solanaRpc` from here once, as Custom
 * endpoints with "only my RPCs" on, so they still replace each list. `nearRpc` is the operator's only.
 */
const NOT_APPLIED = new Set<string>(["demo", "nearIntents", "evmRpc", "solanaRpc", "nearRpc"]);

/** The saved overrides minus the sections this layer never applies, or null when none / unreadable. Unvalidated: pass through parseRuntimeConfig. */
export function readUserSettings(): RuntimeConfigInput | null {
  try {
    const raw = globalThis.localStorage?.getItem(USER_SETTINGS_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!isObj(v)) return null;
    const kept = Object.fromEntries(Object.entries(v).filter(([k]) => !NOT_APPLIED.has(k)));
    return Object.keys(kept).length ? (kept as RuntimeConfigInput) : null;
  } catch {
    return null;
  }
}

/** Save (or clear, with null / an empty object). False when the browser refuses storage. */
export function writeUserSettings(next: RuntimeConfigInput | null): boolean {
  try {
    if (!globalThis.localStorage) return false;
    if (next === null || Object.keys(next).length === 0) globalThis.localStorage.removeItem(USER_SETTINGS_KEY);
    else globalThis.localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
