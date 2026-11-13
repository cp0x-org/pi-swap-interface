/**
 * Smart-contract accounts are refused in v1 (D10, engine.md §6.1): a Safe
 * returns a safeTxHash from eth_sendTransaction, so waiting for the receipt
 * never ends, and the same address on the destination chain may not be the
 * user's. An EIP-7702 delegation (`0xef0100` + 20-byte address) is still a
 * key-controlled EOA and is allowed.
 */
import type {Address, PublicClient} from "viem";
import {answered} from "../errors";

/** What eth_getCode says about an account. */
export type AccountCodeKind = "eoa" | "delegated" | "contract";

const DELEGATION = /^0xef0100[0-9a-f]{40}$/i;

/** Classify eth_getCode's answer: empty → EOA, a 7702 delegation designator → delegated EOA, anything else → contract. */
export function accountCodeKind(code: string | undefined | null): AccountCodeKind {
  if (!code || code === "0x") return "eoa";
  return DELEGATION.test(code) ? "delegated" : "contract";
}

export const SMART_ACCOUNT_TEXT =
  "Smart-contract wallets (Safe, ERC-4337) can't swap here yet — connect a regular account. Nothing was sent.";

/**
 * Throw an answered Error unless `address` is an EOA on that chain. A failed
 * read fails closed (we cannot tell): the user retries, nothing was sent.
 */
export async function assertNotContract(pub: Pick<PublicClient, "getCode">, address: Address, chainName: string): Promise<void> {
  let code: string | undefined;
  try {
    code = await pub.getCode({address});
  } catch (e) {
    throw answered(`Couldn't check your account on ${chainName} right now — try again.`, e);
  }
  if (accountCodeKind(code) === "contract") throw answered(SMART_ACCOUNT_TEXT);
}
