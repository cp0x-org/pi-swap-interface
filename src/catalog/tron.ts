/**
 * Tron in the browser (D11): base58check addresses ↔ the 21-byte form (0x41 ‖ 20 bytes) the node API and TRC-20
 * calldata use, and POSTs to the runtime config's full-node HTTP API (`tronApi`, `/wallet/*`). Nothing calls it
 * before a Tron wallet is connected: balances then, and execute's reference block, broadcast and receipt.
 */
import {sha256} from "viem";
import {base58ToBytes, bytesToBase58} from "./bytes";
import {tronApiUrls} from "./rpc";

/** The 0x41 version byte every mainnet Tron address starts with. */
const TRON_PREFIX = 0x41;
const TIMEOUT_MS = 10_000;

const checksum = (payload: Uint8Array): Uint8Array => sha256(sha256(payload, "bytes"), "bytes").slice(0, 4);

/** The 21 bytes (0x41 ‖ 20) of a base58check Tron address, checksum verified; null when it isn't one. */
export function tronAddressBytes(address: string): Uint8Array | null {
  if (typeof address !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null;
  let raw: Uint8Array;
  try {
    raw = base58ToBytes(address);
  } catch {
    return null;
  }
  if (raw.length !== 25 || raw[0] !== TRON_PREFIX) return null;
  const body = raw.slice(0, 21);
  const sum = checksum(body);
  for (let i = 0; i < 4; i++) if (raw[21 + i] !== sum[i]) return null;
  return body;
}

/** The base58check address of 21 address bytes (0x41 ‖ 20), or null for anything else. */
export function tronAddressFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length !== 21 || bytes[0] !== TRON_PREFIX) return null;
  const out = new Uint8Array(25);
  out.set(bytes);
  out.set(checksum(bytes), 21);
  return bytesToBase58(out);
}

/** A Tron API answer that isn't 2xx JSON. `status` 0 = no answer at all (network, CORS, timeout). */
export class TronApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TronApiError";
  }
}

/** One POST to one host: the JSON body of a 2xx answer, else a TronApiError. */
export async function tronPostTo<T>(base: string, path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new TronApiError(`${path}: ${String((e as Error | null)?.message ?? e).slice(0, 120)}`, 0);
  }
  const j = (await res.json().catch(() => undefined)) as T | undefined;
  if (!res.ok || j === undefined || j === null || typeof j !== "object") throw new TronApiError(`${path} HTTP ${res.status}`, res.status);
  return j;
}

/** POST `path` to each Tron API host in order (`urls`, default the runtime config's) until one answers 2xx JSON. */
export async function tronPost<T>(path: string, body: unknown, urls: readonly string[] = tronApiUrls()): Promise<T> {
  let last: unknown = new TronApiError("No Tron API is configured.", 0);
  for (const base of urls) {
    try {
      return await tronPostTo<T>(base, path, body);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
