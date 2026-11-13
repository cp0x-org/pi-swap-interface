/**
 * Tron balances over the runtime config's full-node HTTP API (`tronApi`): `getaccount` for TRX and one
 * `triggerconstantcontract` `balanceOf(owner)` per catalog TRC-20 (the catalog lists USDT only). Read only while a Tron
 * wallet is connected. An account the chain has never seen answers `{}`: 0 TRX.
 */
import type {Token} from "../../contracts/domain";
import {bytesToHex} from "../bytes";
import {tronAddressBytes, tronPost} from "../tron";
import type {BalanceRead} from "./evm";

const isHex64 = (s: unknown): s is string => typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);

/** balanceOf(owner) calldata arguments: the 20 address bytes, left-padded to 32. */
const addressArg = (bytes21: Uint8Array): string => bytesToHex(bytes21.slice(1), false).padStart(64, "0");

/** TRX and catalog TRC-20 balances of `owner`; a token whose read failed is null. Throws when `owner` isn't a Tron address. */
export async function readTronBalances(owner: string, tokens: readonly Token[], urls?: readonly string[]): Promise<BalanceRead> {
  const me = tronAddressBytes(owner);
  if (!me) throw new Error("Not a Tron address.");
  const native = tokens.find((t) => !t.contract);
  const trc20 = tokens.filter((t) => t.contract && tronAddressBytes(t.contract));
  const out: BalanceRead = {};
  const reads: Promise<void>[] = [];
  if (native)
    reads.push(
      tronPost<{balance?: unknown}>("/wallet/getaccount", {address: owner, visible: true}, urls).then(
        (a) => {
          const sun = a.balance ?? 0;
          out[native.key] = typeof sun === "number" && Number.isSafeInteger(sun) && sun >= 0 ? BigInt(sun) : null;
        },
        () => {
          out[native.key] = null;
        },
      ),
    );
  for (const t of trc20)
    reads.push(
      tronPost<{result?: {result?: unknown}; constant_result?: unknown[]; transaction?: {ret?: {ret?: unknown}[]}}>(
        "/wallet/triggerconstantcontract",
        {owner_address: owner, contract_address: t.contract, function_selector: "balanceOf(address)", parameter: addressArg(me), visible: true},
        urls,
      ).then(
        (r) => {
          const word = r.constant_result?.[0];
          const ok = r.result?.result === true && r.transaction?.ret?.[0]?.ret !== "FAILED" && isHex64(word);
          out[t.key] = ok ? BigInt(`0x${word}`) : null;
        },
        () => {
          out[t.key] = null;
        },
      ),
    );
  await Promise.all(reads);
  if (tokens.length && Object.values(out).every((v) => v === null)) throw new Error("Tron balances: every read failed.");
  return out;
}
