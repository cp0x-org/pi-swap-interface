/**
 * Omniston's swap between TON and USDT from a TON wallet, read by the app itself (D35 part C): tonPlan.ts's Omniston
 * swap rule's `instruction`, run by tonGate.ts's checkTonCall on the exact BoC — at the plan and again on the TON
 * Connect message — once the envelope passed (a USDT source: the payer's own jetton wallet, ≤ 0.5 TON, a TEP-74
 * transfer of the reviewed amount to a pinned DEX contract, excess to the payer, no custom payload, at least that
 * contract's recorded forward, the swap in a reference; a TON source: bounceable to a pinned DEX contract, the
 * reviewed input plus at least its recorded gas and at most 0.5 TON).
 *
 * The contract the message pays decides the layout, never Omniston's label (tonDexPins.ts):
 *
 *   STON.fi v1   USDT: the router, forward swap#25938561. TON: the router's pTON v1 wallet, a transfer of the input to
 *                that router (its excess to the payer, forwarding at least 0.1 TON and no more than the gas), carrying
 *                the same swap. swap: the router's wallet of the reviewed output, the minimum, the recipient, no
 *                referral (v1 has no deadline; a refund goes back to the transfer's sender, the payer).
 *   STON.fi v2   USDT: the router, forward swap#6664de2a. TON: the router's pTON v2 wallet, ton_transfer#01f3835d of
 *                the input refunding the payer, the swap in a reference. swap: the router's wallet of the reviewed
 *                output, refund and excess to the payer, the deadline, then the minimum, the recipient, no chained
 *                swap (forward gas 0, no custom payload), no refund payload or its gas, no referral.
 *   DeDust v1    USDT: its USDT vault, forward swap#e3a0d482. TON: its native vault, swap#ea06185d of the input. step:
 *                the pinned TON/USDT pool, a given input, the minimum, no next step; params: the deadline, the
 *                recipient, no referral, nothing for the recipient, and back to the payer on a refund either nothing
 *                or what every build carries (op 0x3c37d7e9, the payer twice).
 *
 * Every cell read to its end; the recipient named explicitly (never addr_none, "the sender"). A deadline: Omniston
 * sets none (STON.fi v2: 2^32 − 1, DeDust: 0, v1 has no field), and that is all it can send — its build request has
 * no deadline. What bounds the time instead is the TON Connect request's validity (at most 5 minutes, tonGate.ts;
 * the wallet signs it as the message's own expiry), with the on-chain minimum at least the reviewed one whenever it
 * runs. A body that does carry a deadline passes only one in the next 20 minutes.
 *
 * Strings and a `Slice` only (the main bundle, like tonPlan.ts): the TON chunk hands the slice over.
 */
import type {Slice} from "@ton/core";
import {isAddressFor, toRawAddress, ZERO_ADDRESS} from "../catalog";
import type {ReviewedSwap} from "../contracts/execution";
import {DEDUST_V1, STONFI_V1, STONFI_V2, TON_USDT, tonDexAt, type StonfiPin} from "./tonDexPins";

const TON_CHAIN = "ton:-239";
const JETTON_TRANSFER = 0x0f8a7ea5;
const PTON_V2_TON_TRANSFER = 0x01f3835d;
const STONFI_V1_SWAP = 0x25938561;
const STONFI_V2_SWAP = 0x6664de2a;
const DEDUST_NATIVE_SWAP = 0xea06185d;
const DEDUST_JETTON_SWAP = 0xe3a0d482;
/** What every Omniston DeDust v1 build hands back to the payer with a refund: this op, then the payer twice. */
const DEDUST_REJECT = 0x3c37d7e9;
/** The least TON the pTON v1 wallet's transfer forwards to the router (every recording: 0.1 TON, all of the gas). */
const STONFI_V1_PTON_FORWARD = 100_000_000n;
/** "No deadline" as Omniston sends it: STON.fi v2's tx_deadline 2^32 − 1, DeDust's 0. */
const STONFI_V2_NO_DEADLINE = 0xffffffffn;
const DEDUST_NO_DEADLINE = 0n;
/** A deadline a body does carry must fall within this many seconds from now (the request itself lives 300). */
export const OMNISTON_SWAP_DEADLINE_S = 20 * 60;

/** A TON mainnet address in a strict form (tonPlan.ts's rule), raw; else null. */
const mainnetRaw = (a: string): string | null =>
  isAddressFor("ton", a) && (!a.includes(":") || /^(-1|0):/.test(a)) ? toRawAddress(a) : null;

/** Whether an Omniston swap paid in `source` (raw jetton master; null = TON) for `destToken` on `destChain` is one checked here. */
export function omnistonSwapServes(source: string | null, destChain: string, destToken: string | null): boolean {
  if (destChain !== TON_CHAIN) return false;
  const tonOut = destToken === null || destToken === ZERO_ADDRESS;
  const usdtOut = destToken !== null && toRawAddress(destToken) === TON_USDT;
  return source === TON_USDT ? tonOut : source === null && usdtOut;
}

/** Omniston's names for the DEXes pinned here: a quote naming any other may be refused before it is reviewed. */
export const OMNISTON_SWAP_PROTOCOLS: ReadonlySet<string> = new Set([STONFI_V1.protocol, STONFI_V2.protocol, DEDUST_V1.protocol]);

/** What the reviewed route fixes about the swap. */
interface Expect {
  self: string;
  recipient: string;
  amountIn: bigint;
  minOut: bigint;
  /** The output is USDT (a TON source) or TON (a USDT source). */
  usdtOut: boolean;
}

const addressOf = (s: Slice): string | null => s.loadMaybeAddress()?.toRawString() ?? null;
const ended = (s: Slice): boolean => s.remainingBits === 0 && s.remainingRefs === 0;

function deadlineOk(deadline: bigint, none: bigint): boolean {
  if (deadline === none) return true;
  const now = BigInt(Math.floor(Date.now() / 1000));
  return deadline > now && deadline <= now + BigInt(OMNISTON_SWAP_DEADLINE_S);
}

/** The router's wallet of the reviewed output: what a STON.fi swap must ask for. */
const askWallet = (pin: StonfiPin, x: Expect): string => (x.usdtOut ? pin.usdtWallet : pin.ptonWallet);

function stonfiV1Swap(s: Slice, x: Expect): string | null {
  if (s.loadUint(32) !== STONFI_V1_SWAP) return "omniston: the swap isn't STON.fi v1's";
  if (addressOf(s) !== askWallet(STONFI_V1, x)) return "omniston: the swap asks the router for another token than the reviewed one";
  if (s.loadCoins() < x.minOut) return "omniston: the swap's on-chain minimum is below the reviewed one";
  if (addressOf(s) !== x.recipient) return "omniston: the swap pays another recipient than the reviewed one";
  if (s.loadBit()) return "omniston: the swap names a referral";
  return ended(s) ? null : "omniston: the swap carries trailing data";
}

function stonfiV2Swap(s: Slice, x: Expect): string | null {
  if (s.loadUint(32) !== STONFI_V2_SWAP) return "omniston: the swap isn't STON.fi v2's";
  if (addressOf(s) !== askWallet(STONFI_V2, x)) return "omniston: the swap asks the router for another token than the reviewed one";
  if (addressOf(s) !== x.self) return "omniston: the swap refunds another wallet than yours";
  if (addressOf(s) !== x.self) return "omniston: the swap's excess goes to another wallet than yours";
  if (!deadlineOk(s.loadUintBig(64), STONFI_V2_NO_DEADLINE)) return "omniston: the swap's deadline is out of range";
  if (s.remainingBits !== 0 || s.remainingRefs !== 1) return "omniston: the swap carries trailing data";
  const b = s.loadRef().beginParse();
  if (b.loadCoins() < x.minOut) return "omniston: the swap's on-chain minimum is below the reviewed one";
  if (addressOf(b) !== x.recipient) return "omniston: the swap pays another recipient than the reviewed one";
  // Forward gas and a custom payload: a chained (cross) swap after this one, which a single hop never has.
  if (b.loadCoins() !== 0n || b.loadMaybeRef() !== null) return "omniston: the swap chains another swap after it";
  if (b.loadCoins() !== 0n || b.loadMaybeRef() !== null) return "omniston: the swap carries a refund payload";
  if (b.loadUint(16) !== 0 || addressOf(b) !== null) return "omniston: the swap names a referral";
  return ended(b) ? null : "omniston: the swap carries trailing data";
}

/** DeDust v1's SwapStep and ^SwapParams, the op read. */
function dedustSwap(s: Slice, x: Expect): string | null {
  if (addressOf(s) !== DEDUST_V1.pool) return "omniston: the swap trades in another DeDust pool than the pinned TON/USDT one";
  if (s.loadUint(1) !== 0) return "omniston: the swap isn't one of a given input";
  if (s.loadCoins() < x.minOut) return "omniston: the swap's on-chain minimum is below the reviewed one";
  if (s.loadMaybeRef() !== null) return "omniston: the swap chains another swap after it";
  if (s.remainingBits !== 0 || s.remainingRefs !== 1) return "omniston: the swap carries trailing data";
  const p = s.loadRef().beginParse();
  if (!deadlineOk(BigInt(p.loadUint(32)), DEDUST_NO_DEADLINE)) return "omniston: the swap's deadline is out of range";
  if (addressOf(p) !== x.recipient) return "omniston: the swap pays another recipient than the reviewed one";
  if (addressOf(p) !== null) return "omniston: the swap names a referral";
  if (p.loadMaybeRef() !== null) return "omniston: the swap hands the recipient a payload";
  const reject = p.loadMaybeRef();
  if (!ended(p)) return "omniston: the swap carries trailing data";
  if (reject) {
    const r = reject.beginParse();
    if (r.loadUint(32) !== DEDUST_REJECT || addressOf(r) !== x.self || addressOf(r) !== x.self || !ended(r))
      return "omniston: the swap's refund carries a payload other than every build's";
  }
  return null;
}

/** STON.fi v1's native input: the router's pTON v1 wallet is sent a transfer of the input to its router. */
function ptonV1(s: Slice, x: Expect, gas: bigint): string | null {
  if (s.loadUint(32) !== JETTON_TRANSFER) return "omniston: the message to STON.fi's pTON wallet isn't a transfer";
  s.loadUintBig(64); // query id: any
  if (s.loadCoins() !== x.amountIn) return "omniston: the swap moves another amount than the reviewed one";
  if (addressOf(s) !== STONFI_V1.router) return "omniston: the TON goes to another router than the pTON wallet's own";
  if (addressOf(s) !== x.self) return "omniston: the transfer's excess goes to another wallet";
  if (s.loadBit()) return "omniston: the transfer carries a custom payload";
  const forward = s.loadCoins();
  if (forward > gas) return "omniston: the transfer forwards more TON than the gas the message attaches";
  if (forward < STONFI_V1_PTON_FORWARD) return "omniston: the transfer forwards too little TON for the router to swap";
  if (!s.loadBit()) return "omniston: the swap isn't carried in a reference";
  const swap = s.loadRef();
  return ended(s) ? stonfiV1Swap(swap.beginParse(), x) : "omniston: the transfer carries trailing data";
}

/** STON.fi v2's native input: ton_transfer of the input to the router's pTON v2 wallet, refunding the payer. */
function ptonV2(s: Slice, x: Expect): string | null {
  if (s.loadUint(32) !== PTON_V2_TON_TRANSFER) return "omniston: the message to STON.fi's pTON wallet isn't a TON transfer";
  s.loadUintBig(64); // query id: any
  if (s.loadCoins() !== x.amountIn) return "omniston: the swap moves another amount than the reviewed one";
  if (addressOf(s) !== x.self) return "omniston: the swap refunds another wallet than yours";
  if (!s.loadBit()) return "omniston: the swap isn't carried in a reference";
  const swap = s.loadRef();
  return ended(s) ? stonfiV2Swap(swap.beginParse(), x) : "omniston: the transfer carries trailing data";
}

/**
 * The app's own read of an Omniston swap between TON and USDT (tonGate.ts checkTonCall hands it over): `s` is the
 * jetton transfer's forward payload (a USDT source) or the whole body (a TON source), `ton` what the transfer forwards
 * or what the message attaches beyond the input, `contract` (raw) the pinned contract it pays — the DEX it picks.
 */
export function omnistonSwapInstruction(r: ReviewedSwap, s: Slice, ton: bigint, contract: string): string | null {
  const source = r.fromContract === null ? null : toRawAddress(r.fromContract);
  const self = mainnetRaw(r.refundAddress);
  const recipient = mainnetRaw(r.recipient);
  if (!self || !recipient || r.fromChain !== TON_CHAIN || !omnistonSwapServes(source, r.destChain, r.destToken))
    return "omniston: the route isn't a swap between TON and USDT this app checks";
  const x: Expect = {self, recipient, amountIn: r.amountIn, minOut: r.minOut, usdtOut: source === null};
  const dex = tonDexAt(contract, source === null);
  if (!dex) return "omniston: the swap pays a contract the app doesn't pin";
  try {
    if (source === null) {
      if (dex === DEDUST_V1) {
        if (s.loadUint(32) !== DEDUST_NATIVE_SWAP) return "omniston: the message to DeDust's native vault isn't a swap";
        s.loadUintBig(64); // query id: any
        if (s.loadCoins() !== x.amountIn) return "omniston: the swap moves another amount than the reviewed one";
        return dedustSwap(s, x);
      }
      return dex === STONFI_V1 ? ptonV1(s, x, ton) : ptonV2(s, x);
    }
    if (dex === DEDUST_V1) {
      if (s.loadUint(32) !== DEDUST_JETTON_SWAP) return "omniston: the forward payload isn't a DeDust swap";
      return dedustSwap(s, x);
    }
    return dex === STONFI_V1 ? stonfiV1Swap(s, x) : stonfiV2Swap(s, x);
  } catch {
    return "omniston: the swap can't be read";
  }
}
