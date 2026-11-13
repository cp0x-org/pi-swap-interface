/**
 * TON balances over TonAPI (runtime config `tonApiUrl`, D11), asked only for a connected TON wallet: the account's
 * TON and its jettons, one call each (one after the other: TonAPI's keyless limit is about one request a second),
 * the catalog's jettons matched by master address. TonAPI writes the TON balance as a JSON number of nanoTON, so it
 * is read from the text, where a large wallet keeps its precision.
 */
import type {Token} from "../../contracts/domain";
import {getRuntimeConfig} from "../../config";
import {toRawAddress} from "../address";
import type {BalanceRead} from "./evm";

const TIMEOUT_MS = 10_000;

async function getText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {headers: {accept: "application/json"}, signal: ctl.signal});
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** The owner's catalog TON balances; null for a token whose read failed. Throws when nothing could be read. */
export async function readTonBalances(owner: string, tokens: readonly Token[], o: {base?: string; fetch?: typeof fetch} = {}): Promise<BalanceRead> {
  const fetchImpl = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = (o.base ?? getRuntimeConfig().tonApiUrl).replace(/\/+$/, "");
  const id = encodeURIComponent(toRawAddress(owner) ?? owner);
  const account = await getText(`${base}/v2/accounts/${id}`, fetchImpl);
  const jettons = tokens.some((t) => t.contract !== null) ? await getText(`${base}/v2/accounts/${id}/jettons`, fetchImpl) : null;
  if (account === null && jettons === null) throw new Error("TonAPI didn't answer");
  // The account object's first "balance" key is its own (the address before it is a plain string).
  const native = account === null ? undefined : /"balance"\s*:\s*(\d{1,30})\b/.exec(account)?.[1];
  let held: Map<string, string> | null = null;
  try {
    const list = (JSON.parse(jettons ?? "null") as {balances?: {balance?: unknown; jetton?: {address?: unknown}}[]} | null)?.balances;
    if (Array.isArray(list)) {
      held = new Map();
      for (const b of list) {
        const master = typeof b.jetton?.address === "string" ? toRawAddress(b.jetton.address) : null;
        if (master && typeof b.balance === "string" && /^\d{1,40}$/.test(b.balance)) held.set(master, b.balance);
      }
    }
  } catch {
    held = null;
  }
  const out: BalanceRead = {};
  for (const t of tokens) {
    if (t.contract === null) out[t.key] = native === undefined ? null : BigInt(native);
    else if (!held) out[t.key] = null;
    else out[t.key] = BigInt(held.get(toRawAddress(t.contract) ?? "") ?? "0");
  }
  return out;
}
