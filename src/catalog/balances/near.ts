/**
 * NEAR balances over the NEAR RPCs (catalog/near.ts): what the account can spend in NEAR (`view_account`: total −
 * locked − storage reserve) and each catalog NEP-141 token's `ft_balance_of`. An account that doesn't exist yet
 * holds 0. A token whose read fails is null, i.e. unknown.
 */
import type {Token} from "../../contracts/domain";
import {nearAccount, nearView} from "../near";
import type {BalanceRead} from "./evm";

const isDigits = (s: unknown): s is string => typeof s === "string" && /^\d{1,40}$/.test(s);

/** NEAR and catalog NEP-141 balances of `owner`. Throws only when the NEAR read itself fails on every RPC. */
export async function readNearBalances(owner: string, tokens: readonly Token[], urls?: readonly string[]): Promise<BalanceRead> {
  const native = tokens.find((t) => !t.contract);
  const fts = tokens.filter((t) => t.contract);
  const [account, ...amounts] = await Promise.all([
    native ? nearAccount(owner, urls) : Promise.resolve(null),
    ...fts.map((t) => nearView<unknown>(t.contract!, "ft_balance_of", {account_id: owner}, urls).catch(() => undefined)),
  ]);
  const out: BalanceRead = {};
  if (native) out[native.key] = account?.available ?? 0n;
  fts.forEach((t, i) => {
    const v = amounts[i];
    out[t.key] = isDigits(v) ? BigInt(v) : null;
  });
  return out;
}
