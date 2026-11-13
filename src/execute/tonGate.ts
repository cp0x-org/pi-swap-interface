/**
 * The gate's TON checks (D10, in gate.ts's style). gate.ts already holds every write to the reviewed plan at the
 * engine-account boundary; a TON source then becomes a TON Connect request the account builds itself, and the
 * wallet signs whatever that request says. So the request is checked too, decoded back from its own BoCs:
 *
 *   - `checkTonPlan` (tonPlan.ts, from checkPlanBrowser): the plan is a deposit with at most a text comment, or a
 *     venue's contract call (TON_CALLS) whose exact BoC passes `checkTonCall`.
 *   - `checkTonRequest` (in the account, right before `sendTransaction`): one message, mainnet, from the reviewed
 *     wallet, valid for at most 5 minutes, no state init; native: the deposit address (its bounce flag too), the
 *     exact amount, the comment or nothing; jetton: the payer's own jetton wallet for the reviewed jetton master,
 *     the fixed gas, and a transfer body whose amount, recipient, excess address (the payer), forward amount and
 *     comment are exactly the reviewed ones — no custom payload, no trailing data; jetton-call (D35): the payer's own
 *     jetton wallet, bounceable, exactly the TON the write attaches, the armed BoC itself as the payload, and that BoC
 *     through `checkTonCall` again.
 *   - `checkTonCall` (D35): a venue's contract call, read here from its exact BoC — the payer's own jetton wallet,
 *     at most TON_BODY_GAS attached, a TEP-74 transfer of exactly the reviewed amount to one of the venue's pinned
 *     contracts, excess to the payer, no custom payload, less TON forwarded than attached, the venue's instruction in
 *     a reference and nothing after it — then the venue package's own verifier on the same message.
 *   - `pinnedJettonWallet`: the payer's USDT jetton wallet computed here from the jetton's pinned wallet code, so a
 *     public API's answer for it is checked, not trusted.
 *   - `captureTonBody`: the engine's `decodeTonBody` for one TON execution, which keeps the BoC it is handed.
 *
 * Pure (@ton/core's cell codec, and the venues' own verifiers through tonPlan.ts), and loaded with the TON account
 * only (a lazy chunk, beside Omniston's) — unit-tested in tests/unit/execute/ton.test.ts.
 */
import {Buffer} from "buffer";
import {Address, Cell, beginCell, contractAddress, loadMessage, storeMessage, type Slice} from "@ton/core";
import type {TonConnectRequest} from "../contracts/execution";
import {SwapReviewMismatch, TON_BODY_GAS} from "./gate";
import type {TonBodyCheck, TonCallExpected, TonCallMessage} from "./tonPlan";

/** TON Connect's mainnet network id. */
export const TON_NETWORK = "-239";
/** TEP-74 jetton `transfer` op. */
export const JETTON_TRANSFER_OP = 0x0f8a7ea5;
/** nanoTON forwarded to the recipient with the jetton (so its wallet is notified) — mobile's wallet-ton default. */
export const TON_JETTON_FORWARD = 1n;
/** nanoTON a jetton transfer carries for gas (0.05 TON) plus the forward; the excess comes back to the payer. */
export const TON_JETTON_ATTACHED = 50_000_000n + TON_JETTON_FORWARD;
/** A request is valid this long (TON Connect's advisory maximum): an unanswered prompt can't be signed later. */
export const TON_VALID_SECONDS = 300;

const RAW = /^(-1|0):[0-9a-fA-F]{64}$/;

/** A TON address in a strict form: raw `wc:hex`, or friendly with a valid checksum. Workchain 0 / -1 only. */
export interface TonAddress {
  raw: string;
  /** The friendly form's flags; null for a raw address. */
  bounceable: boolean | null;
  testOnly: boolean;
}

/** Parse a TON address strictly (no `+0:…` or other spellings @ton/core would also read), or null. */
export function parseTonAddress(a: unknown): TonAddress | null {
  if (typeof a !== "string") return null;
  try {
    if (RAW.test(a)) return {raw: Address.parseRaw(a).toRawString(), bounceable: null, testOnly: false};
    if (!Address.isFriendly(a)) return null;
    const f = Address.parseFriendly(a);
    if (f.address.workChain !== 0 && f.address.workChain !== -1) return null;
    return {raw: f.address.toRawString(), bounceable: f.isBounceable, testOnly: f.isTestOnly};
  } catch {
    return null;
  }
}

/** A mainnet address's raw form, or null (malformed or test-only). */
export function mainnetRaw(a: unknown): string | null {
  const p = parseTonAddress(a);
  return p && !p.testOnly ? p.raw : null;
}

/** The form a message is sent to: a friendly address as given (its bounce flag decides), a raw one bounceable. */
export function messageAddress(a: string): string | null {
  const p = parseTonAddress(a);
  if (!p || p.testOnly) return null;
  return p.bounceable === null ? Address.parseRaw(a).toString({urlSafe: true, bounceable: true}) : a;
}

/** A TON text comment: op 0, then the UTF-8 text (snake cells). */
export const commentCell = (text: string): Cell => beginCell().storeUint(0, 32).storeStringTail(text).endCell();

/**
 * USDT's jetton wallet code (a library cell; the wallet's state is status:uint4 balance:Coins owner master),
 * pinned by the jetton master that deploys it. Read from mainnet (TonAPI get_wallet_data, 2026-11-12) and checked
 * against Tether's treasury jetton wallet in tests/unit/execute/ton.test.ts.
 */
const PINNED_JETTON_CODE: Readonly<Record<string, string>> = {
  "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe":
    "b5ee9c72010101010023000842028f452d7a4dfd74066b682365177259ed05734435be76b5fd4bd5d8af2b7c3d68",
};

/** The jetton wallet `owner` has for `master`, computed from the pinned wallet code; null for a jetton without one. */
export function pinnedJettonWallet(master: string, owner: string): string | null {
  const m = mainnetRaw(master);
  const o = mainnetRaw(owner);
  const hex = m ? PINNED_JETTON_CODE[m] : undefined;
  if (!m || !o || !hex) return null;
  const code = Cell.fromBoc(hexBytes(hex))[0]!;
  const data = beginCell().storeUint(0, 4).storeCoins(0).storeAddress(Address.parseRaw(o)).storeAddress(Address.parseRaw(m)).endCell();
  return contractAddress(0, {code, data}).toRawString();
}

const hexBytes = (hex: string) => Buffer.from(hex, "hex");

/** What one TON Connect message must be: the write the gate consumed, in TON terms. */
export type TonExpected =
  | {kind: "native"; to: string; value: bigint; comment?: string}
  /** `jettonWallet`: the payer's own wallet for the reviewed jetton master (resolved and proven by the account). */
  | {kind: "jetton"; jettonWallet: string; recipient: string; amount: bigint; comment?: string}
  /**
   * A venue's contract call (D35): `jettonWallet` as above, `value` the TON the write attaches, `bodyBoc` the armed BoC
   * the write carries, `call` what the reviewed route fixes about the transfer.
   */
  | {kind: "jetton-call"; jettonWallet: string; value: bigint; bodyBoc: string; call: TonCallExpected};

/** One BoC with one ordinary root cell, or null. */
function oneCell(boc: unknown): Cell | null {
  if (typeof boc !== "string" || !boc) return null;
  try {
    const cells = Cell.fromBoc(Buffer.from(boc, "base64"));
    return cells.length === 1 && !cells[0]!.isExotic ? cells[0]! : null;
  } catch {
    return null;
  }
}

/** The cell is exactly the text comment `text` (op 0 + its UTF-8 snake), nothing more. */
const isComment = (cell: Cell, text: string): boolean => cell.equals(commentCell(text));

const addressOf = (s: Slice): string | null => {
  const a = s.loadMaybeAddress();
  return a ? a.toRawString() : null;
};

/** Why the jetton transfer body is not the expected one, or null. */
function checkJettonBody(body: Cell, exp: Extract<TonExpected, {kind: "jetton"}>, self: string): string | null {
  try {
    const s = body.beginParse();
    if (s.loadUint(32) !== JETTON_TRANSFER_OP) return "the message is not a jetton transfer";
    s.loadUintBig(64); // query id: any
    if (s.loadCoins() !== exp.amount) return "the jetton amount isn't the reviewed one";
    if (addressOf(s) !== mainnetRaw(exp.recipient)) return "the jettons go to another address than the deposit address";
    if (addressOf(s) !== self) return "the transfer's excess goes to another wallet";
    if (s.loadMaybeRef() !== null) return "the transfer carries a custom payload";
    if (s.loadCoins() !== TON_JETTON_FORWARD) return "the transfer forwards another TON amount";
    const forward = s.loadBit() ? s.loadRef() : null;
    if (s.remainingBits !== 0 || s.remainingRefs !== 0) return "the transfer carries trailing data";
    if (exp.comment === undefined) return forward === null ? null : "the transfer carries a payload the review didn't show";
    return forward !== null && isComment(forward, exp.comment) ? null : "the transfer's comment isn't the reviewed one";
  } catch {
    return "the jetton transfer can't be read";
  }
}

/**
 * Why the TON Connect request is not exactly the expected message from `self` (raw), or null. `now` in ms.
 */
export function checkTonRequest(req: TonConnectRequest, exp: TonExpected, ctx: {self: string; now: number}): string | null {
  const keys = Object.keys(req).sort().join(",");
  if (keys !== "from,messages,network,validUntil") return "the request carries fields the swap never sends";
  if (req.network !== TON_NETWORK) return "the request is not for TON mainnet";
  if (req.from !== ctx.self || mainnetRaw(req.from) !== ctx.self) return "the request is from another wallet";
  const nowSec = Math.floor(ctx.now / 1000);
  if (!Number.isSafeInteger(req.validUntil) || req.validUntil <= nowSec || req.validUntil > nowSec + TON_VALID_SECONDS) return "the request's validity is out of range";
  if (!Array.isArray(req.messages) || req.messages.length !== 1) return "the request holds more than the one reviewed message";
  const m = req.messages[0]!;
  const mkeys = Object.keys(m).filter((k) => (m as Record<string, unknown>)[k] !== undefined);
  if (mkeys.some((k) => k !== "address" && k !== "amount" && k !== "payload")) return "the message carries a state init or extra currency";
  if (typeof m.amount !== "string" || !/^[0-9]{1,30}$/.test(m.amount)) return "the message amount is malformed";
  const amount = BigInt(m.amount);
  const to = parseTonAddress(m.address);
  if (!to || to.testOnly || to.bounceable === null) return "the message address isn't a TON mainnet address";
  const payload = m.payload === undefined ? null : oneCell(m.payload);
  if (m.payload !== undefined && !payload) return "the message payload can't be read";

  if (exp.kind === "jetton-call") {
    if (to.raw !== mainnetRaw(exp.jettonWallet) || !to.bounceable) return "the message isn't sent to your own jetton wallet";
    if (amount !== exp.value) return "the message attaches another TON amount than the reviewed one";
    if (!payload || m.payload === undefined) return "the contract call's body is missing";
    // The armed BoC itself: the same bytes, so the same cell (its hash) — what the plan check read is what is signed.
    const armed = oneCell(exp.bodyBoc);
    if (m.payload !== exp.bodyBoc || !armed || !payload.hash().equals(armed.hash())) return "the message body isn't the reviewed one";
    return checkTonCall({to: m.address, value: amount, bodyBoc: m.payload}, exp.call, ctx.self);
  }
  if (exp.kind === "native") {
    if (m.address !== messageAddress(exp.to)) return "the message goes to another address than the deposit address";
    if (amount !== exp.value) return "the message sends another amount than the reviewed one";
    if (exp.comment === undefined) return payload === null ? null : "the message carries a payload the review didn't show";
    return payload !== null && isComment(payload, exp.comment) ? null : "the message's comment isn't the reviewed one";
  }
  if (to.raw !== mainnetRaw(exp.jettonWallet) || !to.bounceable) return "the message isn't sent to your own jetton wallet";
  if (amount !== TON_JETTON_ATTACHED) return "the message attaches another TON amount than the jetton transfer's gas";
  if (!payload) return "the jetton transfer is missing";
  return checkJettonBody(payload, exp, ctx.self);
}

/** Why the cell body is not a TEP-74 transfer of the reviewed call (amount, destination, excess, forward), or null. */
function checkCallBody(body: Cell, call: TonCallExpected, value: bigint, self: string): string | null {
  try {
    const s = body.beginParse();
    if (s.loadUint(32) !== JETTON_TRANSFER_OP) return "the contract call is not a jetton transfer";
    s.loadUintBig(64); // query id: any
    if (s.loadCoins() !== call.amount) return "the jetton amount isn't the reviewed one";
    const destination = addressOf(s);
    if (destination === null || !call.destinations.includes(destination)) return "the jettons go to a contract the app doesn't pin for this venue";
    if (addressOf(s) !== self) return "the transfer's excess goes to another wallet";
    // Refused, not skipped: a custom payload is acted on by the payer's own jetton wallet.
    if (s.loadBit()) return "the transfer carries a custom payload";
    if (s.loadCoins() >= value) return "the transfer forwards as much TON as the message attaches, or more";
    if (!s.loadBit()) return "the venue's instruction isn't carried in a reference";
    s.loadRef();
    if (s.remainingBits !== 0 || s.remainingRefs !== 0) return "the transfer carries trailing data";
    return null;
  } catch {
    return "the jetton transfer can't be read";
  }
}

/**
 * Why a TON contract call is not the reviewed one from `self` (raw), or null (D35) — at the plan (checkTonPlan) and
 * again on the TON Connect message. Every expectation is the reviewed route's (`call`, tonPlan.ts tonCallOf) or the
 * app's own: never the quote's.
 */
export function checkTonCall(msg: TonCallMessage, call: TonCallExpected, self: string): string | null {
  const to = parseTonAddress(msg.to);
  if (!to || to.testOnly || to.bounceable === false) return "the contract call isn't sent bounceable to a TON mainnet address";
  const jw = pinnedJettonWallet(call.jetton, self);
  if (jw === null || to.raw !== jw) return "the contract call isn't sent to your own jetton wallet";
  if (msg.value <= 0n || msg.value > TON_BODY_GAS) return "the contract call attaches no TON, or more than its gas allowance (0.5 TON)";
  const body = oneCell(msg.bodyBoc);
  if (!body) return "the contract call's body can't be read";
  return checkCallBody(body, call, msg.value, self) ?? call.verify(msg);
}

/** A TON cell body as the engine holds it: a parsed cell (it reads the transfer before the review) and its exact BoC. */
export interface TonBody {
  /** The BoC the engine was handed — what is checked, armed and signed (gated.ts sends this on, never a re-encoding). */
  readonly __bocBase64: string;
  beginParse(): Slice;
}

/**
 * One TON execution's cell body (D35, mobile execute.ts decodeTonBody): the engine's `decodeTonBody` keeps the BoC it
 * is handed and returns a TonBody over its one ordinary root cell (anything else is refused before the review); `boc`
 * and `check` are checkTonPlan's view of that very BoC. The last body the engine decoded is the one its plan carries.
 */
export function captureTonBody(): TonBodyCheck & {decodeTonBody(boc: string): TonBody} {
  let kept: string | undefined;
  return {
    decodeTonBody(boc) {
      const cell = oneCell(boc);
      if (!cell) throw new SwapReviewMismatch("the TON contract call's body can't be read");
      kept = boc;
      return Object.freeze({__bocBase64: boc, beginParse: () => cell.beginParse()});
    },
    boc: () => kept,
    check: checkTonCall,
  };
}

/**
 * The hash a TON source is tracked by: TEP-467's normalized hash of the signed external message the wallet
 * returned (explorers and TON APIs look a message up by it). Null when the BoC isn't an external message to `self`.
 */
export function tonMessageHash(boc: unknown, self: string): string | null {
  const cell = oneCell(boc);
  if (!cell) return null;
  try {
    const msg = loadMessage(cell.beginParse());
    if (msg.info.type !== "external-in" || msg.info.dest.toRawString() !== self) return null;
    const normalized = beginCell()
      .store(storeMessage({info: {type: "external-in", dest: msg.info.dest, importFee: 0n}, init: null, body: msg.body}, {forceRef: true}))
      .endCell();
    return normalized.hash().toString("hex");
  } catch {
    return null;
  }
}
