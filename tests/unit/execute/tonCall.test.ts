/**
 * TON contract calls (D35): Symbiosis paid in USDT from a TON wallet. The exact BoC is read at the plan
 * (checkPlanBrowser → checkTonPlan → tonGate.ts checkTonCall) and again on the one TON Connect message (checkTonRequest's
 * jetton-call kind): the app's own decode of the jetton transfer, then Symbiosis' verifier with the request rebuilt from
 * the review. Then the whole flow — the real engine and the real Symbiosis provider over recorded answers (the SDK's
 * fixture, and a dry quote captured on 2026-11-13), executeSwap, the gate and a fake TON Connect wallet that records
 * every request. Nothing reaches a network; nothing is signed.
 */
import {Buffer} from "buffer";
import {Address, Cell, beginCell, storeMessage} from "@ton/core";
import {describe, expect, it, vi} from "vitest";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {SYMBIOSIS_REVERTER, SYMBIOSIS_TON_PORTAL_RAW} from "@anywalletkit/protocol-swap2-symbiosis/config";
import {symbiosisProvider} from "@anywalletkit/protocol-swap2-symbiosis/provider";
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
import {TON_CALLS, TON_USDT, tonCallOf, tonCallSigned, type TonCallExpected} from "../../../src/execute/tonPlan";
import F from "./symbiosisTon.fixture.json";

/** The Symbiosis module's TON placeholder, the sender both recorded quotes were built for, and its USDT jetton wallet. */
const SELF = "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8";
const SELF_UQ = toFriendlyAddress(SELF)!;
const JW = "0:2f2f33ae6dd9c0b6fee08cef597eb00a9d5925152ff8c46ee2417ceb7f296598";
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const EVIL_TON = `0:${"cd".repeat(32)}`;
const EVIL_EVM = "0x000000000000000000000000000000000000dEaD";
const NOW = Date.now();

type Fx = (typeof F)["sdk"];
const FIXTURES: [string, Fx][] = [
  ["the SDK's recorded quote (USDC on Base, a destination swap)", F.sdk],
  ["the dry quote captured 2026-11-13 (USDC on Arbitrum, a direct release)", F.live as Fx],
];

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

/** The bridge request (forward payload) with its head's `chain2address` or its tail's `revertableAddress` replaced. */
function bridgeBoc(boc: string, o: {chain2address?: string; revertable?: string}): string {
  const t = readTransfer(boc);
  const f = t.forward.beginParse();
  const op = f.loadUint(32);
  const [head, sides, tail] = [f.loadRef(), f.loadRef(), f.loadRef()];
  const h = head.beginParse();
  const fee = h.loadCoins();
  const master = h.loadAddress();
  const amount = h.loadCoins();
  const chain2 = h.loadUintBig(160);
  const newHead = beginCell()
    .storeCoins(fee)
    .storeAddress(master)
    .storeCoins(amount)
    .storeUint(o.chain2address ? BigInt(o.chain2address) : chain2, 160)
    .endCell();
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
  const forward = beginCell().storeUint(op, 32).storeRef(newHead).storeRef(sides).storeRef(nb.endCell()).endCell();
  return transferBoc(boc, {forward});
}

// ── the call itself ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("which TON contract calls are signed (TON_CALLS)", () => {
  it("Symbiosis paid in USDT only: not native TON, not another jetton, not Omniston", () => {
    expect(tonCallSigned("symbiosis", USDT)).toBe(true);
    expect(tonCallSigned("symbiosis", TON_USDT)).toBe(true);
    expect(tonCallSigned("symbiosis", null)).toBe(false);
    expect(tonCallSigned("symbiosis", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f")).toBe(false);
    expect(tonCallSigned("omniston", USDT)).toBe(false);
    expect(tonCallOf(reviewedOf(F.sdk, {fromContract: null}))).toBeUndefined();
    expect(tonCallOf(reviewedOf(F.sdk, {provider: "omniston"}))).toBeUndefined();
    expect(tonCallOf(reviewedOf(F.sdk))).toMatchObject({provider: "symbiosis", jetton: USDT, amount: 50_000_000n, destinations: [SYMBIOSIS_TON_PORTAL_RAW]});
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
      [{bodyBoc: transferBoc(body, {}, {inline: true})}, /isn't carried in a reference/],
      [{bodyBoc: transferBoc(body, {}, {tail: true})}, /trailing data/],
      [{bodyBoc: "not-a-boc"}, /can't be read/],
      [{bodyBoc: b64(beginCell().storeUint(JETTON_TRANSFER_OP, 32).endCell())}, /can't be read/],
    ];
    for (const [m, why] of cases) expect(check(m), String(why)).toMatch(why);
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
  });

  it("refuses what the engine decoded when it isn't the reviewed call — the BoC itself is read, not the engine's summary", () => {
    expect(planCheck(f, {boc: transferBoc(f.quote.tonBody, {destination: Address.parseRaw(EVIL_TON)})})).toMatch(/doesn't pin/);
    expect(planCheck(f, {boc: transferBoc(f.quote.tonBody, {custom: commentCell("x")})})).toMatch(/custom payload/);
    expect(planCheck(f, {plan: planOf(f, {to: bounceable(EVIL_TON)})})).toMatch(/your own jetton wallet/);
    // checkPlan's own ceiling (gas only for a jetton source) comes first; checkTonCall's is the same 0.5 TON.
    expect(planCheck(f, {plan: planOf(f, {value: TON_BODY_GAS + 1n})})).toMatch(/sends more than you reviewed/);
    expect(planCheck(f, {r: reviewedOf(f, {minOut: BigInt(f.quote.minDestAmount) + 1n})})).toMatch(/guaranteed output dropped/);
    expect(() => captureTonBody().decodeTonBody("not-a-boc")).toThrow(SwapReviewMismatch);
  });
});

// ── on the TON Connect message ──────────────────────────────────────────────────────────────────────────────────────

describe("checkTonRequest: the jetton-call kind", () => {
  const f = F.sdk;
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
      [req({payload: F.live.quote.tonBody}), /body isn't the reviewed one/],
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
const destOf = (f: Fx): SwapToken => ({
  ...usdtOnTon,
  key: `${f.params.destChain === "eip155:8453" ? "base" : "arbitrum"}:${f.params.destToken}`,
  chain: f.params.destChain === "eip155:8453" ? "base" : "arbitrum",
  caip2: f.params.destChain,
  chainName: f.params.destChain === "eip155:8453" ? "Base" : "Arbitrum",
  family: "evm",
  symbol: "USDC",
  catalogSymbol: "USDC",
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

  it("refuses a tampered answer before the wallet is asked: another target, a non-bounceable one, more gas", async () => {
    const cases: [(m: {address: string; amount: string}) => void, RegExp][] = [
      // Not the payer's own jetton wallet: the engine compares it with the account's (getJettonWalletAddress).
      [(m) => void (m.address = bounceable(EVIL_TON)), /jetton wallet/],
      // Its own wallet, but non-bounceable: Symbiosis' check reads the raw address; the app's refuses it.
      [(m) => void (m.address = Address.parseRaw(JW).toString({urlSafe: true, bounceable: false})), /bounceable/],
      // 0.6 TON: inside the package's 1 TON, above the app's 0.5 TON (the engine's tonGasCeiling here).
      [(m) => void (m.amount = "600000000"), /more than the 500000000 gas ceiling/],
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
  const f = F.sdk;
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

  it("only a TON payer's engine decodes cell bodies, with the 0.5 TON gas ceiling", () => {
    const router = new CrossChainRouter([]);
    const ton = engineConfig({fromChain: "ton:-239", router, reviewExecution: () => {}, decodeTonBody: captureTonBody().decodeTonBody});
    expect(Object.keys(ton).sort()).toEqual(["decodeTonBody", "fromChain", "nativeFeeCeiling", "onExecutionPhase", "reviewExecution", "router", "tonGasCeiling"]);
    expect(ton.tonGasCeiling).toBe(TON_BODY_GAS);
    expect(engineConfig({fromChain: "eip155:1", router, reviewExecution: () => {}})).not.toHaveProperty("decodeTonBody");
  });
});
