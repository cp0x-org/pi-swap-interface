/**
 * TON as a signing family (D10, D11): the gate's TON checks on their own, then the real SDK engine over an
 * in-process NEAR-Intents-shaped venue, the production executeSwap and a fake TON Connect wallet that records every
 * request — TON to a deposit address (with and without a memo) and a USDT jetton deposit. Nothing reaches a
 * network: TonAPI is a stub, the wallet never broadcasts.
 */
import {Buffer} from "buffer";
import {Address, Cell, beginCell, storeMessage} from "@ton/core";
import {describe, expect, it, vi} from "vitest";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import type {CrossChainProvider, Quote, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {toFriendlyAddress} from "../../../src/catalog";
import type {SwapToken} from "../../../src/contracts/domain";
import type {ReviewedSwap, TonConnectRequest, TonSourceSigner} from "../../../src/contracts/execution";
import {tonEngineAccount} from "../../../src/execute/accounts/ton";
import {WALLET_DECLINED_TEXT, swapErrorText} from "../../../src/execute/errors";
import {executeSwap} from "../../../src/execute/execute";
import {SwapGateRefusal, SwapReviewMismatch, checkPlanBrowser} from "../../../src/execute/gate";
import {
  JETTON_TRANSFER_OP,
  TON_JETTON_ATTACHED,
  TON_JETTON_FORWARD,
  checkTonRequest,
  commentCell,
  messageAddress,
  pinnedJettonWallet,
  tonMessageHash,
  type TonExpected,
} from "../../../src/execute/tonGate";
import {checkTonPlan} from "../../../src/execute/tonPlan";

/** Tether's treasury and its USDT jetton wallet on mainnet (TonAPI, 2026-11-12). */
const SELF = "0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3";
const SELF_UQ = toFriendlyAddress(SELF)!;
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const USDT_RAW = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
const JW = "0:2626cf30b702bdded845efc883efa45029ff59defdacc4ce7b8b0a5966d75002";
/** A deposit address (a valid non-bounceable mainnet address that is nobody's in these tests). */
const DEPOSIT = Address.parseRaw(`0:${"ab".repeat(32)}`).toString({urlSafe: true, bounceable: false});
const EVIL = Address.parseRaw(`0:${"cd".repeat(32)}`).toString({urlSafe: true, bounceable: false});
const ME_EVM = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = 1_800_000_000_000;

const boc = (c: Cell) => Buffer.from(c.toBoc()).toString("base64");

const nativeReq = (over: Partial<TonConnectRequest> = {}, msg: Partial<TonConnectRequest["messages"][number]> = {}): TonConnectRequest => ({
  validUntil: NOW / 1000 + 300,
  network: "-239",
  from: SELF,
  messages: [{address: DEPOSIT, amount: "5000000000", ...msg}],
  ...over,
});

function jettonBody(o: Partial<{op: number; amount: bigint; to: string; response: string; custom: Cell | null; forward: bigint; payload: Cell | null; tail: boolean}> = {}): Cell {
  const b = beginCell()
    .storeUint(o.op ?? JETTON_TRANSFER_OP, 32)
    .storeUint(7n, 64)
    .storeCoins(o.amount ?? 25_000_000n)
    .storeAddress(Address.parse(o.to ?? DEPOSIT))
    .storeAddress(Address.parseRaw(o.response ?? SELF))
    .storeMaybeRef(o.custom ?? null)
    .storeCoins(o.forward ?? TON_JETTON_FORWARD)
    .storeMaybeRef(o.payload === undefined ? null : o.payload);
  if (o.tail) b.storeUint(1, 8);
  return b.endCell();
}

const jettonReq = (body: Cell, msg: Partial<TonConnectRequest["messages"][number]> = {}): TonConnectRequest => ({
  validUntil: NOW / 1000 + 300,
  network: "-239",
  from: SELF,
  messages: [{address: Address.parseRaw(JW).toString({urlSafe: true, bounceable: true}), amount: TON_JETTON_ATTACHED.toString(), payload: boc(body), ...msg}],
});

const NATIVE: TonExpected = {kind: "native", to: DEPOSIT, value: 5_000_000_000n};
const JETTON: TonExpected = {kind: "jetton", jettonWallet: JW, recipient: DEPOSIT, amount: 25_000_000n};
const ctx = {self: SELF, now: NOW};

describe("checkTonRequest", () => {
  it("passes exactly the expected native message, with or without its comment", () => {
    expect(checkTonRequest(nativeReq(), NATIVE, ctx)).toBeNull();
    expect(checkTonRequest(nativeReq({}, {payload: boc(commentCell("memo-42"))}), {...NATIVE, comment: "memo-42"}, ctx)).toBeNull();
  });

  it("refuses any other native message", () => {
    const bounceable = Address.parse(DEPOSIT).toString({urlSafe: true, bounceable: true});
    const cases: [TonConnectRequest, TonExpected, RegExp][] = [
      [nativeReq({}, {address: EVIL}), NATIVE, /another address/],
      [nativeReq({}, {address: bounceable}), NATIVE, /another address/],
      [nativeReq({}, {amount: "5000000001"}), NATIVE, /another amount/],
      [nativeReq({}, {payload: boc(commentCell("x"))}), NATIVE, /payload the review didn't show/],
      [nativeReq({}, {payload: boc(commentCell("memo-43"))}), {...NATIVE, comment: "memo-42"}, /comment isn't the reviewed one/],
      [nativeReq(), {...NATIVE, comment: "memo-42"}, /comment isn't the reviewed one/],
      [nativeReq({}, {stateInit: boc(commentCell("x"))}), NATIVE, /state init/],
      [nativeReq({network: "-3"}), NATIVE, /mainnet/],
      [nativeReq({from: `0:${"11".repeat(32)}`}), NATIVE, /another wallet/],
      [nativeReq({validUntil: NOW / 1000 + 301}), NATIVE, /validity/],
      [nativeReq({validUntil: NOW / 1000}), NATIVE, /validity/],
      [{...nativeReq(), messages: [nativeReq().messages[0]!, nativeReq().messages[0]!]}, NATIVE, /more than the one/],
      [{...nativeReq(), extra: 1} as unknown as TonConnectRequest, NATIVE, /fields the swap never sends/],
      [nativeReq({}, {address: `0:${"ab".repeat(32)}`}), NATIVE, /isn't a TON mainnet address/],
      [nativeReq({}, {payload: "not-a-boc"}), NATIVE, /payload can't be read/],
    ];
    for (const [req, exp, why] of cases) expect(checkTonRequest(req, exp, ctx)).toMatch(why);
  });

  it("passes exactly the expected jetton transfer, comment in its forward payload", () => {
    expect(checkTonRequest(jettonReq(jettonBody()), JETTON, ctx)).toBeNull();
    expect(checkTonRequest(jettonReq(jettonBody({payload: commentCell("memo-42")})), {...JETTON, comment: "memo-42"}, ctx)).toBeNull();
  });

  it("refuses a jetton transfer that differs in anything the review fixed", () => {
    const cases: [TonConnectRequest, TonExpected, RegExp][] = [
      [jettonReq(jettonBody(), {address: EVIL}), JETTON, /your own jetton wallet/],
      [jettonReq(jettonBody(), {amount: "1000000000"}), JETTON, /another TON amount/],
      [jettonReq(jettonBody({op: 0x178d4519})), JETTON, /not a jetton transfer/],
      [jettonReq(jettonBody({amount: 25_000_001n})), JETTON, /jetton amount/],
      [jettonReq(jettonBody({to: EVIL})), JETTON, /another address than the deposit/],
      [jettonReq(jettonBody({response: `0:${"cd".repeat(32)}`})), JETTON, /excess goes to another wallet/],
      [jettonReq(jettonBody({custom: commentCell("x")})), JETTON, /custom payload/],
      [jettonReq(jettonBody({forward: 100_000_000n})), JETTON, /forwards another TON amount/],
      [jettonReq(jettonBody({payload: commentCell("memo-42")})), JETTON, /payload the review didn't show/],
      [jettonReq(jettonBody({payload: commentCell("memo-43")})), {...JETTON, comment: "memo-42"}, /comment isn't the reviewed one/],
      [jettonReq(jettonBody({tail: true})), JETTON, /trailing data/],
      [{...jettonReq(jettonBody()), messages: [{...jettonReq(jettonBody()).messages[0]!, payload: undefined}]} as TonConnectRequest, JETTON, /jetton transfer is missing/],
    ];
    for (const [req, exp, why] of cases) expect(checkTonRequest(req, exp, ctx)).toMatch(why);
  });

  it("sends a raw deposit address bounceable and keeps a friendly one's flag", () => {
    expect(messageAddress(DEPOSIT)).toBe(DEPOSIT);
    expect(messageAddress(`0:${"ab".repeat(32)}`)).toBe(Address.parse(DEPOSIT).toString({urlSafe: true, bounceable: true}));
    expect(messageAddress(Address.parse(DEPOSIT).toString({urlSafe: true, bounceable: false, testOnly: true}))).toBeNull();
  });
});

describe("the payer's USDT jetton wallet and the source hash", () => {
  it("computes the treasury's USDT jetton wallet from the pinned code, and nothing for an unpinned jetton", () => {
    expect(pinnedJettonWallet(USDT, SELF)).toBe(JW);
    expect(pinnedJettonWallet(USDT_RAW, SELF_UQ)).toBe(JW);
    expect(pinnedJettonWallet("EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f", SELF)).toBeNull();
  });

  it("hashes the signed external message the wallet returns (normalized), only when it is this wallet's", () => {
    const ext = (dest: string, src: boolean) =>
      boc(
        beginCell()
          .store(storeMessage({info: {type: "external-in", dest: Address.parseRaw(dest), importFee: src ? 5n : 0n}, init: null, body: beginCell().storeUint(42, 32).endCell()}))
          .endCell(),
      );
    const h = tonMessageHash(ext(SELF, false), SELF);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(tonMessageHash(ext(SELF, true), SELF)).toBe(h); // import fee normalized away
    expect(tonMessageHash(ext(`0:${"11".repeat(32)}`, false), SELF)).toBeNull();
    expect(tonMessageHash("", SELF)).toBeNull();
  });
});

// ── the plan rule and the engine flow ────────────────────────────────────────────────────────────────────────────

const plan = (source: Swap2ExecutionPlan["source"], over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan =>
  ({
    provider: "near_intents",
    fromChain: "ton:-239",
    destChain: "eip155:8453",
    destToken: USDC_BASE,
    recipient: ME_EVM,
    refundAddress: SELF_UQ,
    sourceAmount: 5_000_000_000n,
    destAmount: 15_000_000n,
    minDestAmount: 14_900_000n,
    feeUsd: 0,
    etaSeconds: 60,
    validUntilMs: NOW + 55_000,
    approvals: [],
    source,
    ...over,
  }) as Swap2ExecutionPlan;

describe("checkTonPlan", () => {
  it("passes a TON or jetton deposit, and refuses approvals, cell bodies and non-mainnet addresses", () => {
    const r = reviewedFor(tonToken({}), 5n);
    expect(checkTonPlan(plan({kind: "call", to: DEPOSIT, value: 5n, memo: "m"}), r)).toBeNull();
    expect(checkTonPlan(plan({kind: "token-transfer", token: USDT, recipient: DEPOSIT, amount: 5n}), r)).toBeNull();
    expect(checkTonPlan(plan({kind: "call", to: DEPOSIT, value: 5n, cellBody: true}), r)).toMatch(/contract payload/);
    expect(checkTonPlan(plan({kind: "call", to: `5:${"ab".repeat(32)}`, value: 5n}), r)).toMatch(/mainnet/);
    expect(checkTonPlan(plan({kind: "call", to: "kQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6CG", value: 5n}), r)).toMatch(/mainnet/);
    expect(checkTonPlan(plan({kind: "token-transfer", token: USDT, recipient: "nope", amount: 5n}), r)).toMatch(/mainnet/);
    expect(checkTonPlan(plan({kind: "call", to: DEPOSIT, value: 5n}, {approvals: [{token: USDT, spender: DEPOSIT, amount: 5n}]}), r)).toMatch(/approval/);
  });
});

const tonToken = (over: Partial<SwapToken>): SwapToken => ({
  key: "ton:native",
  chain: "ton",
  caip2: "ton:-239",
  chainName: "TON",
  family: "ton",
  symbol: "TON",
  catalogSymbol: "GRAM",
  decimals: 9,
  contract: null,
  gasToken: true,
  amount: "9000000000",
  balance: "loaded",
  usd: 30,
  owner: SELF_UQ,
  payMode: "wallet",
  ...over,
});
const USDT_TON = tonToken({key: `ton:${USDT.toLowerCase()}`, symbol: "USDT", catalogSymbol: "USDT", decimals: 6, contract: USDT, gasToken: false});
const TO: SwapToken = {
  ...tonToken({}),
  key: `base:${USDC_BASE.toLowerCase()}`,
  chain: "base",
  caip2: "eip155:8453",
  chainName: "Base",
  family: "evm",
  symbol: "USDC",
  catalogSymbol: "USDC",
  decimals: 6,
  contract: USDC_BASE,
  gasToken: false,
  owner: ME_EVM,
};

const reviewedFor = (from: SwapToken, amountIn: bigint): ReviewedSwap => ({
  provider: "near_intents",
  fromChain: "ton:-239",
  fromContract: from.contract,
  amountIn,
  destChain: "eip155:8453",
  destToken: USDC_BASE,
  recipient: ME_EVM,
  refundAddress: SELF_UQ,
  minOut: 14_800_000n,
  slippageBps: 50,
  approvalSpender: null,
  nativeFee: 0n,
});

/** An in-process NEAR-Intents-shaped venue: a one-time deposit address, an optional memo, no transaction. */
function depositVenue(o: {amount: bigint; memo?: string; to?: string}): CrossChainProvider {
  return {
    name: "near_intents",
    supportsSameChain: false,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async (): Promise<Quote> => ({
      provider: "near_intents",
      intentId: `near1click:${encodeURIComponent(o.to ?? DEPOSIT)}|${encodeURIComponent(o.memo ?? "")}`,
      depositAddress: o.to ?? DEPOSIT,
      depositMemo: o.memo ?? null,
      sourceAmount: o.amount.toString(),
      destAmount: "15000000",
      minDestAmount: "14950000",
      feeUsd: 0.1,
      etaSeconds: 60,
      reliability: 0.95,
      validUntilMs: Date.now() + 55_000,
    }),
    buildDeposit: async (q: Quote): Promise<UnsignedTx> => ({chain: "", to: q.depositAddress, value: q.sourceAmount, ...(q.depositMemo ? {memo: q.depositMemo} : {})}),
    trackIntent: async () => ({state: "pending" as const}),
  };
}

/**
 * A TON Connect wallet that records every request and answers with a signed external message from SELF. `provider`
 * is how it is reached (JS or HTTP bridge); `unconfirmed` fails (with that error, or never settles) before the SDK
 * confirms the request was handed over.
 */
function fakeSender(o: {reject?: boolean; lose?: boolean; account?: string; provider?: "http" | "injected"; unconfirmed?: Error | "silent"} = {}) {
  const sent: TonConnectRequest[] = [];
  const signedBoc = boc(beginCell().store(storeMessage({info: {type: "external-in", dest: Address.parseRaw(SELF), importFee: 0n}, init: null, body: beginCell().storeUint(1, 32).endCell()})).endCell());
  const sender: TonSourceSigner["sender"] = {
    account: {address: o.account ?? SELF, chain: "-239"},
    wallet: {provider: o.provider ?? "injected"},
    async sendTransaction(tx, options) {
      sent.push(tx);
      if (o.reject) throw new Error("[TON_CONNECT_SDK_ERROR] UserRejectsError: User rejects the action in the wallet.\nRejected");
      if (o.unconfirmed === "silent") return new Promise<never>(() => undefined);
      if (o.unconfirmed) throw o.unconfirmed;
      options?.onRequestSent?.();
      if (o.lose) throw new TypeError("Failed to fetch");
      return {boc: signedBoc};
    },
  };
  return {sender, sent, signedBoc};
}

/** TonAPI: the payer's USDT wallet and its state. */
function tonApi(o: {jw?: string; owner?: string; balance?: string; deployed?: boolean} = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/methods/get_wallet_address")) return Response.json({success: true, decoded: {jetton_wallet_address: o.jw ?? JW}});
    if (u.includes("/methods/get_wallet_data")) {
      if (o.deployed === false) return Response.json({error: "entity not found"}, {status: 404});
      return Response.json({success: true, decoded: {balance: o.balance ?? "100000000", owner: o.owner ?? SELF, jetton: USDT_RAW}});
    }
    return new Response("", {status: 500});
  });
}

function rig(from: SwapToken, amount: bigint, o: {memo?: string; to?: string; sender?: ReturnType<typeof fakeSender>; fetch?: ReturnType<typeof tonApi>; r?: Partial<ReviewedSwap>} = {}) {
  const w = o.sender ?? fakeSender();
  const signer: TonSourceSigner = {family: "ton", address: SELF_UQ, rawAddress: SELF, walletName: "Tonkeeper", sender: w.sender, tonApiUrl: "https://tonapi.invalid"};
  const router = new CrossChainRouter([depositVenue({amount, ...(o.memo ? {memo: o.memo} : {}), ...(o.to ? {to: o.to} : {})})]);
  const fetchImpl = o.fetch ?? tonApi();
  const run = () =>
    executeSwap(
      {from, to: TO, reviewed: {...reviewedFor(from, amount), ...o.r}, signer},
      {router: () => router, tonAccount: {fetch: fetchImpl as unknown as typeof fetch, queryId: () => 9n}},
    );
  return {run, sent: w.sent, fetchImpl};
}

const payloadCell = (req: TonConnectRequest) => Cell.fromBase64(req.messages[0]!.payload!);

describe("executeSwap from TON (real engine, fake TON Connect wallet)", () => {
  it("sends exactly the reviewed TON to the deposit address, tracked by the signed message's hash", async () => {
    const {run, sent} = rig(tonToken({}), 5_000_000_000n);
    const res = await run();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.messages).toEqual([{address: DEPOSIT, amount: "5000000000"}]);
    expect(sent[0]).toMatchObject({network: "-239", from: SELF});
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.id).toMatch(/^awk1\.near_intents\./);
    expect(res.depositTo).toBe(DEPOSIT);
  });

  it("carries the venue's memo as the message comment", async () => {
    const {run, sent} = rig(tonToken({}), 5_000_000_000n, {memo: "1click-77"});
    await run();
    const s = payloadCell(sent[0]!).beginParse();
    expect(s.loadUint(32)).toBe(0);
    expect(s.loadStringTail()).toBe("1click-77");
  });

  it("sends USDT as a jetton transfer from the payer's own jetton wallet, excess back to the payer", async () => {
    const {run, sent, fetchImpl} = rig(USDT_TON, 25_000_000n);
    await run();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`https://tonapi.invalid/v2/blockchain/accounts/${encodeURIComponent(USDT_RAW)}/methods/get_wallet_address?args=${encodeURIComponent(SELF)}`);
    const m = sent[0]!.messages[0]!;
    expect(Address.parse(m.address).toRawString()).toBe(JW);
    expect(m.amount).toBe(TON_JETTON_ATTACHED.toString());
    const s = payloadCell(sent[0]!).beginParse();
    expect(s.loadUint(32)).toBe(JETTON_TRANSFER_OP);
    expect(s.loadUintBig(64)).toBe(9n);
    expect(s.loadCoins()).toBe(25_000_000n);
    expect(s.loadAddress().toRawString()).toBe(Address.parse(DEPOSIT).toRawString());
    expect(s.loadAddress().toRawString()).toBe(SELF);
  });

  it("refuses a jetton wallet TonAPI names wrongly, one that isn't the payer's, or a short balance — the wallet is never called", async () => {
    const cases: [ReturnType<typeof tonApi>, RegExp][] = [
      [tonApi({jw: `0:${"cd".repeat(32)}`}), /isn't yours/],
      [tonApi({owner: `0:${"cd".repeat(32)}`}), /isn't yours for this token/],
      [tonApi({balance: "24999999"}), /holds less/],
      [tonApi({deployed: false}), /holds none/],
    ];
    for (const [fetchImpl, why] of cases) {
      const {run, sent} = rig(USDT_TON, 25_000_000n, {fetch: fetchImpl});
      const e = await run().catch((x: unknown) => x);
      expect((e as Error).message).toMatch(why);
      expect(swapErrorText(e, "TON")).toMatch(/nothing was sent/);
      expect(sent).toHaveLength(0);
    }
  });

  it("refuses a deposit to an address the plan can't hold, and a wallet that isn't the reviewed one — nothing reaches the wallet", async () => {
    const testnet = Address.parse(DEPOSIT).toString({urlSafe: true, bounceable: false, testOnly: true});
    const a = rig(tonToken({}), 5_000_000_000n, {to: testnet});
    await expect(a.run()).rejects.toBeInstanceOf(SwapReviewMismatch);
    expect(a.sent).toHaveLength(0);
    const b = rig(tonToken({}), 5_000_000_000n, {r: {refundAddress: EVIL}});
    await expect(b.run()).rejects.toThrow(/isn't the reviewed one/);
    expect(b.sent).toHaveLength(0);
    const c = rig(tonToken({}), 5_000_000_000n, {sender: fakeSender({account: `0:${"cd".repeat(32)}`})});
    await expect(c.run()).rejects.toThrow(/switched accounts/);
    expect(c.sent).toHaveLength(0);
  });

  it("a declined prompt is answered (nothing sent); a lost answer after the wallet got the request is maybe-sent", async () => {
    const declined = rig(tonToken({}), 5_000_000_000n, {sender: fakeSender({reject: true})});
    const e = await declined.run().catch((x: unknown) => x);
    expect(swapErrorText(e, "TON")).toBe(WALLET_DECLINED_TEXT);
    const lost = rig(tonToken({}), 5_000_000_000n, {sender: fakeSender({lose: true})});
    const l = await lost.run().catch((x: unknown) => x);
    expect(swapErrorText(l, "TON")).toMatch(/may still go through/);
  });
});

describe("the TON account on its own (what the gate lets through)", () => {
  const signer = (w = fakeSender()): TonSourceSigner => ({family: "ton", address: SELF_UQ, rawAddress: SELF, walletName: "Tonkeeper", sender: w.sender, tonApiUrl: "https://tonapi.invalid"});

  it("refuses a jetton without pinned wallet code before TonAPI is asked: its answer alone can't prove the wallet", async () => {
    const w = fakeSender();
    const fetchImpl = tonApi();
    const acct = tonEngineAccount(signer(w), {fetch: fetchImpl as unknown as typeof fetch});
    const USDE = "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f";
    const e = await acct.transfer({token: USDE, recipient: DEPOSIT, amount: 1n}).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/can't be sent from a wallet here yet/);
    expect(swapErrorText(e, "TON")).toMatch(/nothing was sent/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(w.sent).toHaveLength(0);
  });

  it("on the HTTP bridge, a failure or silence before the SDK confirmed the request is maybe-sent; on the JS bridge, nothing sent", async () => {
    const outcome = async (o: Parameters<typeof fakeSender>[0]) => {
      const e = await tonEngineAccount(signer(fakeSender(o)))
        .sendTransaction({to: DEPOSIT, value: 1n})
        .catch((x: unknown) => x);
      return {maybeSent: (e as {maybeSent?: unknown}).maybeSent === true, text: swapErrorText(e, "TON")};
    };
    // The bridge may have taken the POST whose answer was lost: the wallet can still sign it.
    expect(await outcome({provider: "http", unconfirmed: new TypeError("Failed to fetch")})).toMatchObject({maybeSent: true, text: expect.stringMatching(/may still go through/)});
    // The SDK's own refusal comes before any transport: nothing was sent, on either bridge.
    const wrongNet = new Error("[TON_CONNECT_SDK_ERROR] WalletWrongNetworkError\nWallet connected to a wrong network");
    expect(await outcome({provider: "http", unconfirmed: wrongNet})).toMatchObject({maybeSent: false, text: expect.stringMatching(/nothing was sent/)});
    expect(await outcome({provider: "injected", unconfirmed: new TypeError("Failed to fetch")})).toMatchObject({maybeSent: false, text: expect.stringMatching(/nothing was sent/)});

    vi.useFakeTimers();
    try {
      for (const [provider, maybeSent] of [["http", true], ["injected", false]] as const) {
        const p = tonEngineAccount(signer(fakeSender({provider, unconfirmed: "silent"})))
          .sendTransaction({to: DEPOSIT, value: 1n})
          .catch((x: unknown) => x);
        await vi.advanceTimersByTimeAsync(361_000);
        expect(((await p) as {maybeSent?: unknown}).maybeSent === true).toBe(maybeSent);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses fields the engine never sends and a contract payload", async () => {
    const acct = tonEngineAccount(signer());
    await expect(acct.sendTransaction({to: DEPOSIT, value: 1n, data: "0x00"} as never)).rejects.toThrow(/carries a field \(data\)/);
    await expect(acct.sendTransaction({to: DEPOSIT, value: 1n, body: beginCell().endCell()} as never)).rejects.toThrow(/contract payload/);
    await expect(acct.sendTransaction({to: DEPOSIT, value: 0n})).rejects.toThrow(/malformed/);
    await expect(acct.transfer({token: USDT, recipient: DEPOSIT, amount: 1n, memoEncoding: "hex"} as never)).rejects.toThrow(/carries a field/);
  });

  it("is reached only through the gate in executeSwap: an unarmed write is a SwapGateRefusal", async () => {
    const w = fakeSender();
    const {gateAccount} = await import("../../../src/execute/accounts/gated");
    const {createSwapGate} = await import("../../../src/execute/gate");
    const gated = gateAccount(tonEngineAccount(signer(w)), createSwapGate("ton:-239"));
    await expect(gated.sendTransaction({to: DEPOSIT, value: 1n})).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(w.sent).toHaveLength(0);
  });

  it("checkPlanBrowser holds a TON plan to the TON rule", () => {
    const r = reviewedFor(tonToken({}), 5_000_000_000n);
    expect(checkPlanBrowser(plan({kind: "call", to: DEPOSIT, value: 5_000_000_000n}), r)).toBeNull();
    expect(checkPlanBrowser(plan({kind: "call", to: DEPOSIT, value: 5_000_000_000n, cellBody: true}), r)).toMatch(/contract payload/);
  });
});
