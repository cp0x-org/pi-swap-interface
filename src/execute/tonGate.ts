/**
 * The gate's TON checks (D10, in gate.ts's style). gate.ts already holds every write to the reviewed plan at the
 * engine-account boundary; a TON source then becomes a TON Connect request the account builds itself, and the
 * wallet signs whatever that request says. So the request is checked too, decoded back from its own BoCs:
 *
 *   - `checkTonPlan` (tonPlan.ts, from checkPlanBrowser): the plan is a deposit with at most a text comment.
 *   - `checkTonRequest` (in the account, right before `sendTransaction`): one message, mainnet, from the reviewed
 *     wallet, valid for at most 5 minutes, no state init; native: the deposit address (its bounce flag too), the
 *     exact amount, the comment or nothing; jetton: the payer's own jetton wallet for the reviewed jetton master,
 *     the fixed gas, and a transfer body whose amount, recipient, excess address (the payer), forward amount and
 *     comment are exactly the reviewed ones — no custom payload, no trailing data.
 *   - `pinnedJettonWallet`: the payer's USDT jetton wallet computed here from the jetton's pinned wallet code, so a
 *     public API's answer for it is checked, not trusted.
 *
 * Pure (@ton/core's cell codec only), and loaded with the TON account only (a lazy chunk, beside Omniston's) —
 * unit-tested in tests/unit/execute/ton.test.ts.
 */
import {Buffer} from "buffer";
import {Address, Cell, beginCell, contractAddress, loadMessage, storeMessage, type Slice} from "@ton/core";
import type {TonConnectRequest} from "../contracts/execution";

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
  | {kind: "jetton"; jettonWallet: string; recipient: string; amount: bigint; comment?: string};

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
