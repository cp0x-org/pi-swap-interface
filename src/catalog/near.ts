/**
 * NEAR reads over public JSON-RPC (`query`, no near-api-js): an account's balance and a contract's view call. The
 * list is the runtime config's `nearRpc` (FastNear by default, D8), asked straight from the browser in every mode.
 * Only reached once a NEAR wallet is connected: its balances, and at Confirm its NEAR balance and the token's storage
 * registration of the deposit address (D11, D24).
 */
import {bytesToBase64} from "./bytes";
import {nearRpcUrls} from "./rpc";

const TIMEOUT_MS = 10_000;
/** yoctoNEAR locked per byte of account storage (nearcore's storage_amount_per_byte). */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;

/** NEAR account ids (nearcore rules): 2-64 characters, lowercase parts joined by `-`/`_`, dot-separated. */
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A syntactically valid NEAR account id (implicit hex, `.near`, a token contract…). */
export const isNearAccountId = (id: unknown): id is string => typeof id === "string" && ACCOUNT_ID.test(id);

const isDigits = (s: unknown): s is string => typeof s === "string" && /^\d{1,40}$/.test(s);

/** The node's answer that an account does not exist: definitive, not a reason to try the next RPC. */
class UnknownAccount extends Error {}

/** One `query`, each RPC in order until one answers. */
async function nearQuery<T>(params: Record<string, unknown>, urls: readonly string[]): Promise<T> {
  let last: unknown = new Error("No NEAR RPC is configured.");
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "query", params}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const j = (await res.json()) as {result?: T & {error?: unknown}; error?: {message?: string; cause?: {name?: string}}} | null;
      if (j?.error?.cause?.name === "UNKNOWN_ACCOUNT") throw new UnknownAccount(String(params.account_id));
      // Older nodes put a failed view call in `result.error` with HTTP 200.
      if (!res.ok || !j || j.error || j.result === undefined || j.result.error !== undefined)
        throw new Error(j?.error?.message ?? (typeof j?.result?.error === "string" ? j.result.error : `query HTTP ${res.status}`));
      return j.result;
    } catch (e) {
      if (e instanceof UnknownAccount) throw e;
      last = e;
    }
  }
  throw last;
}

/** A contract's view method with JSON args, its JSON answer. Throws when no RPC answers or the call fails. */
export async function nearView<T>(contract: string, method: string, args: Readonly<Record<string, unknown>>, urls = nearRpcUrls()): Promise<T> {
  const r = await nearQuery<{result?: unknown}>(
    {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: bytesToBase64(new TextEncoder().encode(JSON.stringify(args))),
    },
    urls,
  );
  if (!Array.isArray(r.result) || !r.result.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error(`${method}: the node returned no result`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result as number[]))) as T;
}

/** An account's NEAR: total, and what it can spend (total − locked − storage reserve). null = it doesn't exist yet. */
export async function nearAccount(accountId: string, urls = nearRpcUrls()): Promise<{amount: bigint; available: bigint} | null> {
  let v: {amount?: unknown; locked?: unknown; storage_usage?: unknown};
  try {
    v = await nearQuery({request_type: "view_account", finality: "final", account_id: accountId}, urls);
  } catch (e) {
    if (e instanceof UnknownAccount) return null;
    throw e;
  }
  const usage = typeof v.storage_usage === "number" && Number.isSafeInteger(v.storage_usage) && v.storage_usage >= 0 ? BigInt(v.storage_usage) : null;
  if (!isDigits(v.amount) || !isDigits(v.locked) || usage === null) throw new Error("view_account: malformed answer");
  const amount = BigInt(v.amount);
  const available = amount - BigInt(v.locked) - usage * STORAGE_PRICE_PER_BYTE;
  return {amount, available: available > 0n ? available : 0n};
}
