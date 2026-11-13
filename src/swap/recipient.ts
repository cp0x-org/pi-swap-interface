// Ported from cp0x-elysium apps/mobile/lib/swap/recipient.ts @756b115. Web patch: `owner` may be null (no wallet on
// that family — the field then holds the only address, so the "own address" refusal does not apply), and the address
// check is the catalog's checkRecipient (mobile lib/send/recipient.ts) over every web family.
/**
 * The swap screen's "send to another address": the pasted address checked for
 * the destination chain's network (shape, and the EIP-55 checksum on EVM).
 * Addresses only: a name would be one more lookup between review and signing.
 */
import type {Family, SwapRecipient} from "../contracts/domain";
import {checkRecipient} from "../catalog";

export function swapRecipient(input: string, to: {family: Family; chainName: string; owner: string | null}): SwapRecipient {
  const c = checkRecipient(input, to.family);
  if (c.kind === "empty") return c;
  if (c.kind === "invalid") return c;
  if (c.kind === "name") return {kind: "invalid", reason: `Paste the ${to.chainName} address — names aren't used for swaps.`};
  if (to.owner !== null) {
    const same = to.family === "evm" ? c.address.toLowerCase() === to.owner.toLowerCase() : c.address === to.owner;
    if (same) return {kind: "invalid", reason: "That's this wallet's own address — turn this off to receive here."};
  }
  return {kind: "ok", address: c.address};
}
