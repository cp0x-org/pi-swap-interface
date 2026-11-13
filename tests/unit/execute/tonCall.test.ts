/**
 * TON contract calls (D35): Symbiosis paid in USDT from a TON wallet. The exact BoC is read at the plan
 * (checkPlanBrowser → checkTonPlan → tonGate.ts checkTonCall) and again on the one TON Connect message (checkTonRequest's
 * jetton-call kind): the app's own decode of the jetton transfer and of the bridge request's head, then Symbiosis'
 * verifier with the request rebuilt from the review. Then the whole flow — the real engine and the real Symbiosis
 * provider over recorded answers (two dry quotes captured on 2026-11-13, direct releases at 6 and 18 decimals; the
 * SDK's fixture, a swap on the destination, which is refused), executeSwap, the gate and a fake TON Connect wallet that
 * records every request. Nothing reaches a network; nothing is signed.
 */
import {Buffer} from "buffer";
import {Address, Cell, beginCell, storeMessage} from "@ton/core";
import {describe, expect, it, vi} from "vitest";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {SYMBIOSIS_REVERTER, SYMBIOSIS_TON_PORTAL_RAW, evmToTron} from "@anywalletkit/protocol-swap2-symbiosis/config";
import {symbiosisProvider} from "@anywalletkit/protocol-swap2-symbiosis/provider";
import {ccAssetByToken, ccChain} from "@anywalletkit/swap2-assets";
import {toFriendlyAddress} from "../../../src/catalog";
import type {SwapToken} from "../../../src/contracts/domain";
import type {ReviewedSwap, TonConnectRequest, TonSourceSigner} from "../../../src/contracts/execution";
import {gateAccount} from "../../../src/execute/accounts/gated";
import {tonEngineAccount} from "../../../src/execute/accounts/ton";
import {swapErrorText} from "../../../src/execute/errors";
import {engineConfig, executeSwap} from "../../../src/execute/execute";
import {SwapGateRefusal, SwapReviewMismatch, TON_BODY_GAS, checkPlanBrowser, createSwapGate, planWrites} from "../../../src/execute/gate";
import {venueRule} from "../../../src/execute/pins";
import {JETTON_TRANSFER_OP, captureTonBody, checkTonCall, checkTonRequest, commentCell, pinnedJettonWallet} from "../../../src/execute/tonGate";
import {TON_CALLS, TON_USDT, checkTonPlan, symbiosisRelease, tonCallOf, tonCallSigned, type TonCallExpected} from "../../../src/execute/tonPlan";
import F from "./symbiosisTon.fixture.json";

/** The Symbiosis module's TON placeholder, the sender both recorded quotes were built for, and its USDT jetton wallet. */
const SELF = "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8";
const SELF_UQ = toFriendlyAddress(SELF)!;
const JW = "0:2f2f33ae6dd9c0b6fee08cef597eb00a9d5925152ff8c46ee2417ceb7f296598";
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const EVIL_TON = `0:${"cd".repeat(32)}`;
const EVIL_EVM = "0x000000000000000000000000000000000000dEaD";
const NOW = Date.now();
/** USDC on Arbitrum and on Base (a token Symbiosis reaches from TON only by a swap on arrival), USDbC on Base, USDT on Tron. */
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_USDBC = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
/** The TON Portal's notification gas in every recording: TON_CALLS.symbiosis.minForwardTon. */
const FORWARD = 50_000_000n;

type Fx = (typeof F)["sdk"];
/** The recordings a TON wallet signs: direct releases of a like-asset token (its own decimals). */
const FIXTURES: [string, Fx][] = [
  ["the dry quote captured 2026-11-13 (USDC on Arbitrum, 6 decimals, a direct release)", F.live as Fx],
  ["the dry quote captured 2026-11-13 (USDC on BNB Chain, 18 decimals, a direct release)", F.bnb as Fx],
];
/** The token received's decimals (the catalog's). */
const destDecimals = (f: Fx) => ccAssetByToken(f.params.destChain, f.params.destToken)!.decimals;

const reviewedOf = (f: Fx, over: Partial<ReviewedSwap> = {}): ReviewedSwap => ({
  provider: "symbiosis",
  fromChain: "ton:-239",
  fromContract: USDT,
  amountIn: BigInt(f.params.amountIn),
  destChain: f.params.destChain,
  destToken: f.params.destToken,
  recipient: f.params.destAddress,
  refundAddress: SELF_UQ,
  minOut: BigInt(f.quote.minDestAmount),
  slippageBps: f.params.slippageBps,
  approvalSpender: null,
  nativeFee: 0n,
  ...over,
});
const callOf = (f: Fx, over: Partial<ReviewedSwap> = {}): TonCallExpected => tonCallOf(reviewedOf(f, over))!;
const msgOf = (f: Fx) => ({to: f.quote.tonTo, value: BigInt(f.quote.tonValue), bodyBoc: f.quote.tonBody});

const b64 = (c: Cell) => Buffer.from(c.toBoc()).toString("base64");
const bounceable = (raw: string) => Address.parseRaw(raw).toString({urlSafe: true, bounceable: true});

// ── rewriting one field of a real message ───────────────────────────────────────────────────────────────────────────

/** The outer TEP-74 transfer of a real body, every field as it is. */
function readTransfer(boc: string) {
  const s = Cell.fromBase64(boc).beginParse();
  const t = {
    op: s.loadUint(32),
    queryId: s.loadUintBig(64),
    amount: s.loadCoins(),
    destination: s.loadAddress(),
    response: s.loadAddress(),
    custom: s.loadMaybeRef(),
    forwardTon: s.loadCoins(),
  };
  s.loadBit();
  return {...t, forward: s.loadRef()};
}
type Transfer = ReturnType<typeof readTransfer>;

/** The body again with `over` applied; `inline` puts the forward payload in the body, `tail` adds a byte after it. */
function transferBoc(boc: string, over: Partial<Transfer> = {}, o: {inline?: boolean; tail?: boolean} = {}): string {
  const t = {...readTransfer(boc), ...over};
  const b = beginCell()
    .storeUint(t.op, 32)
    .storeUint(t.queryId, 64)
    .storeCoins(t.amount)
    .storeAddress(t.destination)
    .storeAddress(t.response)
    .storeMaybeRef(t.custom)
    .storeCoins(t.forwardTon);
  if (o.inline) b.storeBit(0).storeSlice(beginCell().storeUint(0x5e7d9020, 32).endCell().beginParse());
  else b.storeBit(1).storeRef(t.forward);
  if (o.tail) b.storeUint(1, 8);
  return b64(b.endCell());
}

/** The bridge request's head as recorded: the relayers' fee, the jetton, the amount, the host-chain recipient. */
function readHead(boc: string) {
  const h = readTransfer(boc).forward.beginParse().loadRef().beginParse();
  return {fee: h.loadCoins(), master: h.loadAddress(), amount: h.loadCoins(), chain2: h.loadUintBig(160)};
}

/**
 * The bridge request (forward payload) with fields replaced: its op, its head's fee / jetton / amount /
 * `chain2address` (`headTail`: a byte after them), its tail's `revertableAddress`, or a fourth cell (`extraRef`).
 */
function bridgeBoc(
  boc: string,
  o: {op?: number; fee?: bigint; master?: Address; amount?: bigint; chain2address?: string; headTail?: boolean; revertable?: string; extraRef?: boolean},
): string {
  const t = readTransfer(boc);
  const f = t.forward.beginParse();
  const op = f.loadUint(32);
  const [, sides, tail] = [f.loadRef(), f.loadRef(), f.loadRef()];
  const h = readHead(boc);
  const nh = beginCell()
    .storeCoins(o.fee ?? h.fee)
    .storeAddress(o.master ?? h.master)
    .storeCoins(o.amount ?? h.amount)
    .storeUint(o.chain2address ? BigInt(o.chain2address) : h.chain2, 160);
  if (o.headTail) nh.storeUint(1, 8);
  const newHead = nh.endCell();
  const tl = tail.beginParse();
  const finalOffset = tl.loadUintBig(256);
  const revertable = tl.loadUintBig(160);
  const rest = tl.loadBits(tl.remainingBits);
  const refs = [tl.loadRef(), tl.loadRef(), tl.loadRef()];
  const nb = beginCell()
    .storeUint(finalOffset, 256)
    .storeUint(o.revertable ? BigInt(o.revertable) : revertable, 160)
    .storeBits(rest);
  for (const r of refs) nb.storeRef(r);
  const fw = beginCell().storeUint(o.op ?? op, 32).storeRef(newHead).storeRef(sides).storeRef(nb.endCell());
  if (o.extraRef) fw.storeRef(commentCell("x"));
  return transferBoc(boc, {forward: fw.endCell()});
}

// ── the call itself ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("which TON contract calls are signed (TON_CALLS)", () => {
  it("Symbiosis paid in USDT only: not native TON, not another jetton, not Omniston", () => {
    expect(tonCallSigned("symbiosis", USDT, "eip155:42161", ARB_USDC)).toBe(true);
    expect(tonCallSigned("symbiosis", TON_USDT, "eip155:42161", ARB_USDC)).toBe(true);
    expect(tonCallSigned("symbiosis", null, "eip155:42161", ARB_USDC)).toBe(false);
    expect(tonCallSigned("symbiosis", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f", "eip155:42161", ARB_USDC)).toBe(false);
    expect(tonCallSigned("omniston", USDT, "eip155:42161", ARB_USDC)).toBe(false);
    expect(tonCallOf(reviewedOf(F.live as Fx, {fromContract: null}))).toBeUndefined();
    expect(tonCallOf(reviewedOf(F.live as Fx, {provider: "omniston"}))).toBeUndefined();
    expect(tonCallOf(reviewedOf(F.live as Fx))).toMatchObject({
      provider: "symbiosis",
      jetton: USDT,
      amount: 50_000_000n,
      destinations: [SYMBIOSIS_TON_PORTAL_RAW],
      minForwardTon: FORWARD,
    });
  });

  it("only for a token the Portal's pools release directly on an EVM network: not Tron, not a swap on arrival", () => {
    // The like-asset tokens a pinned pool trades against TON's USDT synthetic, at their own decimals.
    expect(symbiosisRelease(USDT, "eip155:42161", ARB_USDC)?.decimals).toBe(6);
    expect(symbiosisRelease(USDT, "eip155:56", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d")?.decimals).toBe(18);
    expect(tonCallSigned("symbiosis", USDT, "eip155:8453", BASE_USDBC)).toBe(true);
    // USDC on Base is reached only by a swap after the release (the SDK's recording); Tron needs an EVM address of the
    // payer's that a TON wallet doesn't have; a native coin only through an unwrap; WETH sits in another pool.
    expect(tonCallSigned("symbiosis", USDT, "eip155:8453", BASE_USDC)).toBe(false);
    expect(tonCallSigned("symbiosis", USDT, "tron:728126428", TRON_USDT)).toBe(false);
    expect(tonCallSigned("symbiosis", USDT, "eip155:42161", null)).toBe(false);
    expect(tonCallSigned("symbiosis", USDT, "eip155:42161", "0x82af49447d8a07e3bd95bd0d56f35241523fbab1")).toBe(false);
    expect(tonCallSigned("symbiosis", USDT, "eip155:1", "0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe(false);
    expect(tonCallOf(reviewedOf(F.sdk))).toBeUndefined();
  });

  it("every jetton a call may be paid in has pinned wallet code, so its wallet is computed, never asked", () => {
    for (const rule of Object.values(TON_CALLS)) for (const j of rule.jettons) expect(pinnedJettonWallet(j, SELF), j).not.toBeNull();
    expect(pinnedJettonWallet(USDT, SELF)).toBe(JW);
  });
});

describe.each(FIXTURES)("checkTonCall on %s", (_name, f) => {
  const call = callOf(f);
  const msg = msgOf(f);
  const check = (m: Partial<typeof msg>, c: TonCallExpected = call) => checkTonCall({...msg, ...m}, c, SELF);

  it("passes the exact message the venue built: the payer's USDT wallet, 0.2 TON, the bridge request to the Portal", () => {
    expect(Address.parse(msg.to).toRawString()).toBe(JW);
    expect(msg.value).toBe(200_000_000n);
    expect(readTransfer(msg.bodyBoc).destination.toRawString()).toBe(SYMBIOSIS_TON_PORTAL_RAW);
    expect(check({})).toBeNull();
    // A raw target is sent bounceable: the same message.
    expect(check({to: JW})).toBeNull();
  });

  it("refuses every field of the message the review fixed, read by the app itself", () => {
    const body = msg.bodyBoc;
    const t = readTransfer(body);
    const cases: [Partial<typeof msg>, RegExp][] = [
      [{to: bounceable(EVIL_TON)}, /isn't sent to your own jetton wallet/],
      [{to: Address.parseRaw(JW).toString({urlSafe: true, bounceable: false})}, /isn't sent bounceable/],
      [{to: Address.parseRaw(JW).toString({urlSafe: true, bounceable: true, testOnly: true})}, /isn't sent bounceable/],
      [{value: TON_BODY_GAS + 1n}, /more than its gas allowance/],
      [{value: 0n}, /attaches no TON/],
      [{bodyBoc: transferBoc(body, {op: 0x178d4519})}, /not a jetton transfer/],
      [{bodyBoc: transferBoc(body, {amount: t.amount + 1n})}, /jetton amount isn't the reviewed one/],
      [{bodyBoc: transferBoc(body, {destination: Address.parseRaw(EVIL_TON)})}, /contract the app doesn't pin/],
      [{bodyBoc: transferBoc(body, {response: Address.parseRaw(EVIL_TON)})}, /excess goes to another wallet/],
      [{bodyBoc: transferBoc(body, {custom: commentCell("x")})}, /custom payload/],
      [{bodyBoc: transferBoc(body, {forwardTon: msg.value})}, /forwards as much TON/],
      // Nothing forwarded: the Portal gets no transfer_notification and never runs the bridge request.
      [{bodyBoc: transferBoc(body, {forwardTon: 0n})}, /forwards too little TON/],
      [{bodyBoc: transferBoc(body, {forwardTon: 1n})}, /forwards too little TON/],
      [{bodyBoc: transferBoc(body, {forwardTon: FORWARD - 1n})}, /forwards too little TON/],
      [{bodyBoc: transferBoc(body, {}, {inline: true})}, /isn't carried in a reference/],
      [{bodyBoc: transferBoc(body, {}, {tail: true})}, /trailing data/],
      [{bodyBoc: "not-a-boc"}, /can't be read/],
      [{bodyBoc: b64(beginCell().storeUint(JETTON_TRANSFER_OP, 32).endCell())}, /can't be read/],
    ];
    for (const [m, why] of cases) expect(check(m), String(why)).toMatch(why);
    expect(t.forwardTon).toBe(FORWARD);
    expect(check({bodyBoc: transferBoc(body, {forwardTon: FORWARD + 1n})})).toBeNull();
  });

  it("reads the bridge request's head itself: the relayers' fee leaves at least the reviewed minimum, unit for unit", () => {
    const body = msg.bodyBoc;
    const amountIn = BigInt(f.params.amountIn);
    const h = readHead(body);
    expect(h.fee).toBe(250_000n);
    // The least the bridged amount may be (6 decimals, rounded up) to cover the reviewed minimum unit for unit.
    const minOut = BigInt(f.quote.minDestAmount);
    const unit = 10n ** 12n;
    const need = (minOut * 10n ** BigInt(18 - destDecimals(f)) + unit - 1n) / unit;
    const maxFee = amountIn - need;
    expect(maxFee).toBeGreaterThan(h.fee);
    // A fee taking all but one unit of the input (the package only asks for "less than the amount"), or a unit too much.
    expect(check({bodyBoc: bridgeBoc(body, {fee: amountIn - 1n})})).toMatch(/^symbiosis: the relayers' fee leaves less than the reviewed minimum/);
    expect(check({bodyBoc: bridgeBoc(body, {fee: maxFee + 1n})})).toMatch(/relayers' fee leaves less/);
    expect(check({bodyBoc: bridgeBoc(body, {fee: maxFee})})).toBeNull();
    // A smaller minimum reviewed allows a larger fee: the review's own minimum is the bound.
    expect(check({bodyBoc: bridgeBoc(body, {fee: maxFee + 1n})}, callOf(f, {minOut: minOut / 2n}))).toBeNull();
    // The head's jetton and amount are the review's, nothing follows them; the request is its op and three cells.
    expect(check({bodyBoc: bridgeBoc(body, {master: Address.parseRaw(EVIL_TON)})})).toMatch(/another jetton/);
    expect(check({bodyBoc: bridgeBoc(body, {amount: amountIn - 1n})})).toMatch(/another amount/);
    expect(check({bodyBoc: bridgeBoc(body, {headTail: true})})).toMatch(/head carries trailing data/);
    expect(check({bodyBoc: bridgeBoc(body, {op: 0x5e7d9021})})).toMatch(/isn't a bridge request/);
    expect(check({bodyBoc: bridgeBoc(body, {extraRef: true})})).toMatch(/three cells/);
    expect(check({bodyBoc: transferBoc(body, {forward: commentCell("x")})})).toMatch(/isn't a bridge request/);
  });

  it("then Symbiosis' own verifier, with the request from the review: recipient, revert address, minimum", () => {
    // The bridge request credits another address than the reviewed recipient.
    expect(check({bodyBoc: bridgeBoc(msg.bodyBoc, {chain2address: EVIL_EVM})})).toMatch(/^symbiosis: .*not one of the user's addresses/);
    // Its revert (refund) address is neither the payer's nor Symbiosis' pinned revert service.
    expect(check({bodyBoc: bridgeBoc(msg.bodyBoc, {revertable: EVIL_EVM})})).toMatch(/^symbiosis: .*neither the user nor Symbiosis' revert service/);
    expect(check({bodyBoc: bridgeBoc(msg.bodyBoc, {revertable: SYMBIOSIS_REVERTER})})).toBeNull();
    // The review was for another recipient, or promised more than the route guarantees.
    expect(check({}, callOf(f, {recipient: EVIL_EVM}))).toMatch(/^symbiosis: /);
    expect(check({}, callOf(f, {minOut: BigInt(f.quote.minDestAmount) + 1n}))).toMatch(/^symbiosis: .*below the quoted minimum/);
    expect(check({}, callOf(f, {minOut: BigInt(f.quote.minDestAmount) - 1n}))).toBeNull();
    // Another amount in the review: the app's decode refuses first.
    expect(check({}, callOf(f, {amountIn: 50_000_001n}))).toMatch(/jetton amount/);
  });
});

describe("the SDK's recording: USDC on Base, a swap on arrival, is never signed from TON", () => {
  const f = F.sdk;

  it("its bytes pass the package's verifier — the burn's own relayers' fee is bound by nothing there — and are refused here", () => {
    // The direct-release rule refuses it first (tonCallOf, the route list); the venue rule's verify, run on its own,
    // reads the package's answer: a swap on the destination, which this app doesn't sign from TON.
    expect(tonCallOf(reviewedOf(f))).toBeUndefined();
    expect(TON_CALLS.symbiosis!.verify(reviewedOf(f), msgOf(f))).toMatch(/^symbiosis: the route swaps again on the destination/);
    expect(planCheck(f)).toMatch(/for a token this venue's call isn't checked for/);
  });

  it("executeSwap with the real engine and provider refuses it before the wallet is asked", async () => {
    const {run, sent} = rig(f);
    const e = await run().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(swapErrorText(e, "TON")).not.toMatch(/may still/);
    expect(sent).toHaveLength(0);
  });
});

// ── at the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

const planOf = (f: Fx, source: Partial<Extract<Swap2ExecutionPlan["source"], {kind: "call"}>> = {}, over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan =>
  ({
    provider: "symbiosis",
    fromChain: "ton:-239",
    destChain: f.params.destChain,
    destToken: f.params.destToken,
    recipient: f.params.destAddress,
    refundAddress: SELF_UQ,
    sourceAmount: BigInt(f.params.amountIn),
    destAmount: BigInt(f.quote.destAmount),
    minDestAmount: BigInt(f.quote.minDestAmount),
    feeUsd: 0.5,
    etaSeconds: 30,
    validUntilMs: NOW + 55_000,
    approvals: [],
    source: {kind: "call", to: f.quote.tonTo, value: BigInt(f.quote.tonValue), cellBody: true, ...source},
    ...over,
  }) as Swap2ExecutionPlan;

/** checkPlanBrowser as executeSwap calls it, the engine having decoded `boc` (undefined: none decoded). */
function planCheck(f: Fx, o: {boc?: string | null; plan?: Swap2ExecutionPlan; r?: ReviewedSwap} = {}) {
  const body = captureTonBody();
  const boc = o.boc === undefined ? f.quote.tonBody : o.boc;
  if (boc !== null) body.decodeTonBody(boc);
  return checkPlanBrowser(o.plan ?? planOf(f), o.r ?? reviewedOf(f), venueRule("symbiosis"), undefined, body);
}

describe.each(FIXTURES)("checkPlanBrowser on %s", (_name, f) => {
  it("passes the reviewed call, and arms exactly its BoC", () => {
    expect(planCheck(f)).toBeNull();
    const {writes} = planWrites(planOf(f), f.quote.tonBody);
    expect(writes).toEqual([{kind: "call", to: f.quote.tonTo, value: BigInt(f.quote.tonValue), bodyBoc: f.quote.tonBody}]);
  });

  it("refuses a native TON or other-jetton source, another venue, a body it can't see, or another payload", () => {
    const usde = "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f";
    expect(planCheck(f, {r: reviewedOf(f, {fromContract: null})})).toMatch(/paid in TON/);
    expect(planCheck(f, {r: reviewedOf(f, {fromContract: usde})})).toMatch(/paid in a jetton/);
    expect(planCheck(f, {plan: planOf(f, {}, {provider: "omniston"}), r: reviewedOf(f, {provider: "omniston"})})).toMatch(/contract payload this app doesn't sign/);
    expect(planCheck(f, {boc: null})).toMatch(/body is missing/);
    expect(checkPlanBrowser(planOf(f), reviewedOf(f), venueRule("symbiosis"))).toMatch(/body is missing/);
    expect(planCheck(f, {plan: planOf(f, {memo: "x"})})).toMatch(/payload this network doesn't carry/);
    expect(planCheck(f, {plan: planOf(f, {data: "0x00"})})).toMatch(/calldata/);
    // To Tron (the destination needs an EVM address of the payer's): never this venue's checked call.
    const tron = {destChain: "tron:728126428", destToken: TRON_USDT, recipient: evmToTron(f.params.destAddress)};
    expect(planCheck(f, {plan: planOf(f, {}, tron), r: reviewedOf(f, tron)})).toMatch(/for a token this venue's call isn't checked for/);
  });

  it("refuses a plain deposit for the venue: from TON it is paid by its contract call only", () => {
    // The whole input as a USDT transfer to an address the API named: checkPlan alone passes it (the reviewed token
    // and amount), and a TON account built for the call would sign it as a deposit.
    const amount = BigInt(f.params.amountIn);
    for (const recipient of [EVIL_TON, SYMBIOSIS_TON_PORTAL_RAW]) {
      const plan = planOf(f, {}, {source: {kind: "token-transfer", token: USDT, recipient, amount}});
      expect(planCheck(f, {plan})).toMatch(/a plain transfer this venue never makes/);
    }
    // TON to an address, with or without a comment (checkPlan's ceiling refuses it for a jetton route too).
    for (const source of [{kind: "call", to: bounceable(EVIL_TON), value: 1n}, {kind: "call", to: bounceable(EVIL_TON), value: 1n, memo: "x"}] as const)
      expect(checkTonPlan(planOf(f, {}, {source}), reviewedOf(f))).toMatch(/a plain transfer this venue never makes/);
  });

  it("refuses what the engine decoded when it isn't the reviewed call — the BoC itself is read, not the engine's summary", () => {
    expect(planCheck(f, {boc: transferBoc(f.quote.tonBody, {destination: Address.parseRaw(EVIL_TON)})})).toMatch(/doesn't pin/);
    expect(planCheck(f, {boc: transferBoc(f.quote.tonBody, {custom: commentCell("x")})})).toMatch(/custom payload/);
    expect(planCheck(f, {boc: transferBoc(f.quote.tonBody, {forwardTon: 0n})})).toMatch(/forwards too little TON/);
    expect(planCheck(f, {boc: bridgeBoc(f.quote.tonBody, {fee: BigInt(f.params.amountIn) - 1n})})).toMatch(/relayers' fee leaves less/);
    expect(planCheck(f, {plan: planOf(f, {to: bounceable(EVIL_TON)})})).toMatch(/your own jetton wallet/);
    // checkPlan's own ceiling (gas only for a jetton source) comes first; checkTonCall's is the same 0.5 TON.
    expect(planCheck(f, {plan: planOf(f, {value: TON_BODY_GAS + 1n})})).toMatch(/sends more than you reviewed/);
    expect(planCheck(f, {r: reviewedOf(f, {minOut: BigInt(f.quote.minDestAmount) + 1n})})).toMatch(/guaranteed output dropped/);
    expect(() => captureTonBody().decodeTonBody("not-a-boc")).toThrow(SwapReviewMismatch);
  });
});

// ── on the TON Connect message ──────────────────────────────────────────────────────────────────────────────────────

describe("checkTonRequest: the jetton-call kind", () => {
  const f = F.live as Fx;
  const call = callOf(f);
  const value = BigInt(f.quote.tonValue);
  const exp = {kind: "jetton-call", jettonWallet: JW, value, bodyBoc: f.quote.tonBody, call} as const;
  const req = (msg: Partial<TonConnectRequest["messages"][number]> = {}, over: Partial<TonConnectRequest> = {}): TonConnectRequest => ({
    validUntil: Math.floor(NOW / 1000) + 300,
    network: "-239",
    from: SELF,
    messages: [{address: f.quote.tonTo, amount: f.quote.tonValue, payload: f.quote.tonBody, ...msg}],
    ...over,
  });
  const ctx = {self: SELF, now: NOW};

  it("passes exactly the armed message", () => {
    expect(checkTonRequest(req(), exp, ctx)).toBeNull();
  });

  it("refuses another target, TON amount, body (or another encoding of it), a second message, a state init", () => {
    const sameCellOtherBytes = Buffer.from(Cell.fromBase64(f.quote.tonBody).toBoc({crc32: false})).toString("base64");
    expect(sameCellOtherBytes).not.toBe(f.quote.tonBody);
    const cases: [TonConnectRequest, RegExp][] = [
      [req({address: bounceable(EVIL_TON)}), /your own jetton wallet/],
      [req({address: Address.parseRaw(JW).toString({urlSafe: true, bounceable: false})}), /your own jetton wallet/],
      [req({amount: (value + 1n).toString()}), /another TON amount/],
      [req({payload: F.bnb.quote.tonBody}), /body isn't the reviewed one/],
      [req({payload: sameCellOtherBytes}), /body isn't the reviewed one/],
      [req({payload: undefined}), /body is missing/],
      [req({}, {messages: [req().messages[0]!, req().messages[0]!]}), /more than the one/],
      [req({stateInit: b64(commentCell("x"))}), /state init/],
      [req({}, {from: EVIL_TON}), /another wallet/],
    ];
    for (const [r, why] of cases) expect(checkTonRequest(r, exp, ctx), String(why)).toMatch(why);
    // The armed message itself, held to the review again: over the gas allowance, or a body the review didn't fix.
    const big = TON_BODY_GAS + 1n;
    expect(checkTonRequest(req({amount: big.toString()}), {...exp, value: big}, ctx)).toMatch(/gas allowance/);
    const evil = transferBoc(f.quote.tonBody, {destination: Address.parseRaw(EVIL_TON)});
    expect(checkTonRequest(req({payload: evil}), {...exp, bodyBoc: evil}, ctx)).toMatch(/doesn't pin/);
    const stranded = transferBoc(f.quote.tonBody, {forwardTon: 0n});
    expect(checkTonRequest(req({payload: stranded}), {...exp, bodyBoc: stranded}, ctx)).toMatch(/forwards too little TON/);
    const fee = bridgeBoc(f.quote.tonBody, {fee: BigInt(f.params.amountIn) - 1n});
    expect(checkTonRequest(req({payload: fee}), {...exp, bodyBoc: fee}, ctx)).toMatch(/relayers' fee leaves less/);
  });
});

// ── the whole flow ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Symbiosis' API from a recording: its limits, then its quote answer (`patch` rewrites the message it carries). */
function symbiosisApi(f: Fx, patch: (m: {address: string; amount: string; payload: string}) => void = () => undefined) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.pathname.endsWith("/v1/swap-limits")) return Response.json(f.limits);
    if (u.pathname.endsWith("/v2/quote")) {
      const answer = structuredClone(f.response) as typeof f.response;
      // The recording's message expires; the answer is otherwise served as recorded.
      answer.tx.validUntil = Math.floor(Date.now() / 1000) + 600;
      patch(answer.tx.messages[0]!);
      return Response.json(answer);
    }
    return new Response("{}", {status: 404});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

/** TonAPI: the payer's USDT wallet and its state. */
const tonApi = (balance = "100000000") =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/methods/get_wallet_address")) return Response.json({success: true, decoded: {jetton_wallet_address: JW}});
    if (u.includes("/methods/get_wallet_data")) return Response.json({success: true, decoded: {balance, owner: SELF, jetton: TON_USDT}});
    return new Response("", {status: 500});
  });

/** A TON Connect wallet for SELF that records every request and never broadcasts. */
function fakeWallet() {
  const sent: TonConnectRequest[] = [];
  const signed = b64(beginCell().store(storeMessage({info: {type: "external-in", dest: Address.parseRaw(SELF), importFee: 0n}, init: null, body: beginCell().storeUint(1, 32).endCell()})).endCell());
  const signer: TonSourceSigner = {
    family: "ton",
    address: SELF_UQ,
    rawAddress: SELF,
    walletName: "Tonkeeper",
    tonApiUrl: "https://tonapi.invalid",
    sender: {
      account: {address: SELF, chain: "-239"},
      wallet: {provider: "injected"},
      async sendTransaction(tx, options) {
        sent.push(tx);
        options?.onRequestSent?.();
        return {boc: signed};
      },
    },
  };
  return {signer, sent};
}

const usdtOnTon: SwapToken = {
  key: `ton:${USDT.toLowerCase()}`,
  chain: "ton",
  caip2: "ton:-239",
  chainName: "TON",
  family: "ton",
  symbol: "USDT",
  catalogSymbol: "USDT",
  decimals: 6,
  contract: USDT,
  gasToken: false,
  amount: "50000000",
  balance: "loaded",
  usd: 1,
  owner: SELF_UQ,
  payMode: "wallet",
};
const CHAIN_NAMES: Readonly<Record<string, string>> = {"eip155:8453": "Base", "eip155:42161": "Arbitrum", "eip155:56": "BNB Chain"};
const destOf = (f: Fx): SwapToken => ({
  ...usdtOnTon,
  key: `${ccChain(f.params.destChain)!.key}:${f.params.destToken}`,
  chain: ccChain(f.params.destChain)!.key,
  caip2: f.params.destChain,
  chainName: CHAIN_NAMES[f.params.destChain]!,
  family: "evm",
  symbol: "USDC",
  catalogSymbol: "USDC",
  decimals: destDecimals(f),
  contract: f.params.destToken,
  owner: null,
});

function rig(f: Fx, patch?: Parameters<typeof symbiosisApi>[1]) {
  const api = symbiosisApi(f, patch);
  const w = fakeWallet();
  const fetchImpl = tonApi();
  const router = new CrossChainRouter([symbiosisProvider({fetchImpl: api.fetchImpl, tronSource: false, btcSource: false})]);
  const run = () =>
    executeSwap(
      {from: usdtOnTon, to: destOf(f), reviewed: reviewedOf(f), signer: w.signer},
      {router: () => router, tonAccount: {fetch: fetchImpl as unknown as typeof fetch}},
    );
  return {run, sent: w.sent, api, tonapi: fetchImpl};
}

describe.each(FIXTURES)("executeSwap from a TON wallet through Symbiosis — %s", (_name, f) => {
  it("sends ONE TON Connect message: the payer's USDT jetton wallet, the TON it attaches, the exact BoC the venue built", async () => {
    const {run, sent, api, tonapi} = rig(f);
    const res = await run();
    expect(api.calls.filter((p) => p.endsWith("/v2/quote"))).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({network: "-239", from: SELF});
    expect(sent[0]!.messages).toEqual([{address: f.quote.tonTo, amount: f.quote.tonValue, payload: f.quote.tonBody}]);
    expect(Address.parse(sent[0]!.messages[0]!.address).toRawString()).toBe(JW);
    expect(Address.parseFriendly(sent[0]!.messages[0]!.address).isBounceable).toBe(true);
    // The wallet proven twice (when the engine names it, and again right before the request): never named by TonAPI alone.
    expect(tonapi.mock.calls.map(([u]) => String(u).replace(/^.*\/methods\//, "").replace(/\?.*$/, ""))).toEqual([
      "get_wallet_address",
      "get_wallet_data",
      "get_wallet_address",
      "get_wallet_data",
    ]);
    expect(res.id).toMatch(/^awk1\.symbiosis\./);
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a tampered answer before the wallet is asked: another target, a non-bounceable one, more gas, a stranded transfer, a fee eating the input", async () => {
    const cases: [(m: {address: string; amount: string; payload: string}) => void, RegExp][] = [
      // Not the payer's own jetton wallet: the engine compares it with the account's (getJettonWalletAddress).
      [(m) => void (m.address = bounceable(EVIL_TON)), /jetton wallet/],
      // Its own wallet, but non-bounceable: Symbiosis' check reads the raw address; the app's refuses it.
      [(m) => void (m.address = Address.parseRaw(JW).toString({urlSafe: true, bounceable: false})), /bounceable/],
      // 0.6 TON: inside the package's 1 TON, above the app's 0.5 TON (the engine's tonGasCeiling here).
      [(m) => void (m.amount = "600000000"), /more than the 500000000 gas ceiling/],
      // Nothing forwarded to the Portal (the package and the engine check only "less than attached"): stranded there.
      [(m) => void (m.payload = transferBoc(m.payload, {forwardTon: 0n})), /forwards too little TON/],
      // The relayers' fee at all but one unit of the input (the package checks only "less than the amount").
      [(m) => void (m.payload = bridgeBoc(m.payload, {fee: BigInt(f.params.amountIn) - 1n})), /relayers' fee leaves less/],
    ];
    for (const [patch, why] of cases) {
      const {run, sent} = rig(f, patch);
      const e = await run().catch((x: unknown) => x);
      expect((e as Error).message, String(why)).toMatch(why);
      expect(swapErrorText(e, "TON")).not.toMatch(/may still/);
      expect(sent).toHaveLength(0);
    }
  });
});

// ── the engine's cell body through the gate ─────────────────────────────────────────────────────────────────────────

describe("gated.ts: the engine's cell body becomes its exact BoC before the gate copies it", () => {
  const f = F.live as Fx;
  const reviewed = reviewedOf(f);
  const armed = () => {
    const gate = createSwapGate("ton:-239");
    gate.arm(planWrites(planOf(f), f.quote.tonBody).writes);
    return gate;
  };
  const account = (w = fakeWallet()) => tonEngineAccount(w.signer, {fetch: tonApi() as unknown as typeof fetch}, tonCallOf(reviewed));
  const decoded = (boc: string) => captureTonBody().decodeTonBody(boc);

  it("the decoded body (a Cell structuredClone can't copy) reaches the wallet as the armed BoC, once", async () => {
    const w = fakeWallet();
    const gated = gateAccount(account(w), armed());
    const write = {to: f.quote.tonTo, value: BigInt(f.quote.tonValue), body: decoded(f.quote.tonBody)};
    expect(() => structuredClone(write)).toThrow();
    await gated.sendTransaction(write as never);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.messages[0]!.payload).toBe(f.quote.tonBody);
    await expect(gated.sendTransaction(write as never)).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(w.sent).toHaveLength(1);
  });

  it("refuses a body that isn't the armed BoC, one that carries none, a text comment, and both forms at once", async () => {
    const other = transferBoc(f.quote.tonBody, {queryId: 7n});
    const writes = [
      {to: f.quote.tonTo, value: BigInt(f.quote.tonValue), body: decoded(other)},
      {to: f.quote.tonTo, value: BigInt(f.quote.tonValue), body: {beginParse: () => Cell.fromBase64(f.quote.tonBody).beginParse()}},
      {to: f.quote.tonTo, value: BigInt(f.quote.tonValue), body: f.quote.tonBody},
      {to: f.quote.tonTo, value: BigInt(f.quote.tonValue), body: decoded(f.quote.tonBody), bodyBoc: f.quote.tonBody},
    ];
    for (const write of writes) {
      const w = fakeWallet();
      await expect(gateAccount(account(w), armed()).sendTransaction(write as never)).rejects.toBeInstanceOf(SwapGateRefusal);
      expect(w.sent).toHaveLength(0);
    }
  });

  it("a TON account without the reviewed call signs no cell body and names no jetton wallet", async () => {
    const w = fakeWallet();
    const bare = tonEngineAccount(w.signer, {fetch: tonApi() as unknown as typeof fetch});
    await expect(bare.sendTransaction({to: f.quote.tonTo, value: 1n, bodyBoc: f.quote.tonBody})).rejects.toThrow(/contract payload/);
    await expect(bare.getJettonWalletAddress(USDT)).rejects.toThrow(/contract payload/);
    // With the call: only its jetton, proven.
    const acct = account(w);
    await expect(acct.getJettonWalletAddress("EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f")).rejects.toThrow(/contract payload/);
    expect(await acct.getJettonWalletAddress(USDT)).toBe(JW);
    expect(w.sent).toHaveLength(0);
  });

  it("an account built for the call signs nothing else: no plain jetton or TON transfer, with or without a comment", async () => {
    const w = fakeWallet();
    const acct = account(w);
    await expect(acct.transfer({token: USDT, recipient: EVIL_TON, amount: 50_000_000n})).rejects.toThrow(/contract call only/);
    await expect(acct.sendTransaction({to: bounceable(EVIL_TON), value: 1n})).rejects.toThrow(/contract call only/);
    await expect(acct.sendTransaction({to: bounceable(EVIL_TON), value: 1n, body: "x"})).rejects.toThrow(/contract call only/);
    expect(w.sent).toHaveLength(0);
  });

  it("only a TON payer's engine decodes cell bodies, with the 0.5 TON gas ceiling", () => {
    const router = new CrossChainRouter([]);
    const ton = engineConfig({fromChain: "ton:-239", router, reviewExecution: () => {}, decodeTonBody: captureTonBody().decodeTonBody});
    expect(Object.keys(ton).sort()).toEqual(["decodeTonBody", "fromChain", "nativeFeeCeiling", "onExecutionPhase", "reviewExecution", "router", "tonGasCeiling"]);
    expect(ton.tonGasCeiling).toBe(TON_BODY_GAS);
    expect(engineConfig({fromChain: "eip155:1", router, reviewExecution: () => {}})).not.toHaveProperty("decodeTonBody");
  });
});
