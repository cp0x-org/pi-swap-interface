/**
 * TON contract calls (D35 part B): Omniston's escrow paid in USDT from a TON wallet, over the live rev2 capture of
 * 2026-11-11 (USDT on TON → USDC on Base; omnistonEscrowRev2.fixture.json, the phone's). The exact BoC is read at the
 * plan (checkPlanBrowser → checkTonPlan → tonGate.ts checkTonCall: the app's own decode of the transfer and of the
 * escrow order) and bound (checkTonCallBinding → omnistonEscrow.ts: the build this page's provider checked, the secret
 * IndexedDB holds for its hashlock, the package's payload check and build verifier with the review's values), then
 * again on the one TON Connect message. The package's build verifier as the phone runs it (mobile pins.test.ts:68-105).
 * Then the whole flow — the real engine and the real Omniston provider (buildOmniston behind its lazy stand-in, its
 * WebSocket client replaced by a recording one) through executeSwap to a fake TON Connect wallet — and the HTLC secret's
 * life: on disk before the wallet is asked, disclosed only once validateEvmOutputPosition passes, through the activity
 * tracker's poll, after a reload too. Nothing reaches a network; nothing is signed.
 *
 * Node's own Buffer here (not the page's polyfill): @ton/core writes into its own, and the escrow is rebuilt below.
 */
import "fake-indexeddb/auto";
import {Address, Cell, beginCell, storeMessage} from "@ton/core";
import {hexToBytes, keccak256} from "viem";
import {afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import type {OmnistonClientLike, OmnistonQuote, OrderSnapshot} from "@anywalletkit/protocol-swap2-omniston/provider";
import {AUDITED_OMNISTON_SETTLEMENT_CONTRACTS} from "@anywalletkit/protocol-swap2-omniston/validators";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {getSwaps, loadSwaps, newRecord, pollRecord, saveSwap} from "../../../src/activity";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import type {SwapToken} from "../../../src/contracts/domain";
import type {ReviewedSwap, TonConnectRequest, TonSourceSigner} from "../../../src/contracts/execution";
import {tonEngineAccount} from "../../../src/execute/accounts/ton";
import {swapErrorText} from "../../../src/execute/errors";
import {executeSwap} from "../../../src/execute/execute";
import {SwapReviewMismatch, TON_BODY_GAS, checkPlanBrowser} from "../../../src/execute/gate";
import {checkOmnistonEscrow, omnistonEscrowVerifier} from "../../../src/execute/omnistonEscrow";
import {venueRule} from "../../../src/execute/pins";
import {JETTON_TRANSFER_OP, captureTonBody, checkTonCall, checkTonRequest, commentCell, pinnedJettonWallet} from "../../../src/execute/tonGate";
import {OMNISTON_TON_MINTER, TON_CALLS, TON_USDT, checkTonCallBinding, tonCallOf, tonCallSigned, type TonCallExpected} from "../../../src/execute/tonPlan";
import {createQuoteEngine} from "../../../src/swap/engine";
import {omnistonEscrowBuild, recordOmnistonEscrow, type OmnistonEscrowCheck} from "../../../src/swap/omnistonBuilds";
import {lazyLoads, lazyOmniston} from "../../../src/swap/omnistonLazy";
import {createProviderStores} from "../../../src/swap/stores";
import E from "./omnistonEscrow.fixture.json";
import X from "./omnistonEscrowRev2.fixture.json";

// The provider's WebSocket client (an RFQ stream, the escrow builder, the order feed) and the EVM delivery checks are
// the only things replaced: every other check, the package's TON validators included, is the real one.
const mocks = vi.hoisted(() => ({
  client: null as unknown,
  evmOutput: vi.fn(async (_input: unknown) => false),
  locate: vi.fn(async (_input: unknown) => null as string | null),
}));
vi.mock("@anywalletkit/protocol-swap2-omniston/provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anywalletkit/protocol-swap2-omniston/provider")>();
  return {...real, omnistonProvider: (o: Parameters<typeof real.omnistonProvider>[0]) => real.omnistonProvider({...o, client: mocks.client as OmnistonClientLike})};
});
vi.mock("@anywalletkit/protocol-swap2-omniston/validators", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anywalletkit/protocol-swap2-omniston/validators")>();
  return {...real, createOmnistonEvmOutputValidator: () => mocks.evmOutput, createOmnistonEvmDeliveryLocator: () => mocks.locate};
});

const ORDER = X.quoteUpdated.settlementData.value;
/** The rev2 minter the capture pays, and rev1, which the package's table dropped on 2026-11-12. */
const MINTER = ORDER.srcProtocolContractAddress.chain.value;
const REV1_MINTER = "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ";
const MESSAGE = X.escrowResponse.messages[0]!;
/** The trader the capture was built for, its USDT jetton wallet (the message's target), the recipient on Base. */
const SELF_UQ = X.params.refundAddress;
const SELF = Address.parse(SELF_UQ).toRawString();
const JW = Address.parse(MESSAGE.targetAddress).toRawString();
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const BASE_USDC = X.params.destToken;
const RECIPIENT = X.params.destAddress;
const RESOLVER = ORDER.srcInitialResolverAddress.chain.value;
const AMOUNT = BigInt(X.params.amountIn);
/** What the quote guarantees (minDestAmount = outputUnits) and what the escrow binds the resolver to send (+ the protocol fee). */
const OUTPUT = BigInt(X.quoteUpdated.outputUnits);
const RESOLVER_SENDS = BigInt(ORDER.resolverSendsUnits);
const EVIL_TON = `0:${"cd".repeat(32)}`;
const EVIL_EVM = "0x000000000000000000000000000000000000dEaD";
const BNB_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
/** TON_CALLS.omniston.minForwardTon: the minter's notification in every recording. */
const FORWARD = 300_000_000n;
/** What the minter forwards to the escrow it deploys in every recording: the least the app's decode lets through. */
const ESCROW_GAS = 120_000_000n;
const KECCAK = "HASHING_FUNCTION_KECCAK256";

const b64 = (c: Cell) => Buffer.from(c.toBoc()).toString("base64");
const hexOf = (boc: string) => Buffer.from(boc, "base64").toString("hex");
const bounceable = (raw: string) => Address.parseRaw(raw).toString({urlSafe: true, bounceable: true});
const lockOf = (secretHex: string) => keccak256(hexToBytes(`0x${secretHex}`)).slice(2);
const randomHex = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");

const reviewedOf = (over: Partial<ReviewedSwap> = {}): ReviewedSwap => ({
  provider: "omniston",
  fromChain: "ton:-239",
  fromContract: USDT,
  amountIn: AMOUNT,
  destChain: "eip155:8453",
  destToken: BASE_USDC,
  recipient: RECIPIENT,
  refundAddress: SELF_UQ,
  minOut: OUTPUT,
  slippageBps: X.params.slippageBps,
  approvalSpender: null,
  nativeFee: 0n,
  ...over,
});
const callOf = (over: Partial<ReviewedSwap> = {}): TonCallExpected => tonCallOf(reviewedOf(over))!;

// ── rewriting one field of the real escrow ──────────────────────────────────────────────────────────────────────────

/** The capture's body (base64). */
const CAPTURED = Buffer.from(MESSAGE.payload, "hex").toString("base64");

/** The escrow transfer of a real body, every field as it is: the TEP-74 transfer, the escrow order, its cells. */
function readEscrow(boc: string) {
  const s = Cell.fromBase64(boc).beginParse();
  const transfer = {
    op: s.loadUint(32),
    queryId: s.loadUintBig(64),
    amount: s.loadCoins(),
    destination: s.loadAddress(),
    response: s.loadAddress(),
    custom: s.loadMaybeRef(),
    forwardTon: s.loadCoins(),
  };
  s.loadBit();
  const f = s.loadRef().beginParse();
  const order = {orderOp: f.loadUint(32), quoteId: f.loadBuffer(32), flag1: f.loadBit(), owner: f.loadAddress(), escrowForward: f.loadCoins(), flag2: f.loadBit()};
  const [config, code, aux, flags] = [f.loadRef(), f.loadRef(), f.loadRef(), f.loadRef()];
  const c = config.beginParse();
  const cfg = {configOp: c.loadUint(32), resolver: c.loadAddress(), authority: c.loadBit() ? c.loadBuffer(32) : null, exclusivity: c.loadUintBig(64), auction: c.loadUintBig(64)};
  const state = c.loadRef();
  c.loadBit();
  const dest = c.loadRef().beginParse();
  const parts = c.loadUint(16);
  const x = state.refs[1]!.beginParse();
  const execution = {
    execOp: x.loadUint(32),
    hashlock: x.loadBuffer(32),
    execResolver: x.loadAddress(),
    timelocks: [x.loadUintBig(64), x.loadUintBig(64), x.loadUintBig(64), x.loadUintBig(64)],
  };
  const od = x.loadRef().beginParse();
  const owner = {ownerDataOwner: od.loadAddress(), ownerFlag: od.loadBit(), deposit: od.loadCoins()};
  const destination = {chainId: dest.loadUintBig(64), token: dest.loadBuffer(20), receiver: dest.loadBuffer(20), resolverSends: dest.loadCoins()};
  return {...transfer, ...order, ...cfg, parts, ...execution, ...owner, ...destination, code, aux, flags, execCode: state.refs[0]!};
}
type Escrow = ReturnType<typeof readEscrow>;

/** The body again with `over` applied; `inline` puts the order in the body, `tail` adds a byte after it. */
function escrowBoc(boc: string, over: Partial<Escrow> = {}, o: {inline?: boolean; tail?: boolean} = {}): string {
  const e = {...readEscrow(boc), ...over};
  const ownerData = beginCell().storeAddress(e.ownerDataOwner).storeBit(e.ownerFlag).storeCoins(e.deposit).endCell();
  const x = beginCell().storeUint(e.execOp, 32).storeBuffer(e.hashlock).storeAddress(e.execResolver);
  for (const t of e.timelocks) x.storeUint(t, 64);
  const state = beginCell().storeRef(e.execCode).storeRef(x.storeRef(ownerData).endCell()).endCell();
  const dest = beginCell().storeUint(e.chainId, 64).storeBuffer(e.token).storeBuffer(e.receiver).storeCoins(e.resolverSends).endCell();
  const c = beginCell().storeUint(e.configOp, 32).storeAddress(e.resolver);
  if (e.authority) c.storeBit(1).storeBuffer(e.authority);
  else c.storeBit(0);
  c.storeUint(e.exclusivity, 64).storeUint(e.auction, 64).storeRef(state).storeBit(1).storeRef(dest).storeUint(e.parts, 16);
  const order = beginCell()
    .storeUint(e.orderOp, 32)
    .storeBuffer(e.quoteId)
    .storeBit(e.flag1)
    .storeAddress(e.owner)
    .storeCoins(e.escrowForward)
    .storeBit(e.flag2)
    .storeRef(c.endCell())
    .storeRef(e.code)
    .storeRef(e.aux)
    .storeRef(e.flags)
    .endCell();
  const b = beginCell()
    .storeUint(e.op, 32)
    .storeUint(e.queryId, 64)
    .storeCoins(e.amount)
    .storeAddress(e.destination)
    .storeAddress(e.response)
    .storeMaybeRef(e.custom)
    .storeCoins(e.forwardTon);
  if (o.inline) b.storeBit(0).storeSlice(beginCell().storeUint(e.orderOp, 32).endCell().beginParse());
  else b.storeBit(1).storeRef(order);
  if (o.tail) b.storeUint(1, 8);
  return b64(b.endCell());
}

/**
 * The capture's auxiliary cell (the order's 3rd reference) with `over` applied: its zero address, the address a failed
 * creation refunds to (the payer), its 3 trailing bits, its one cell; `tail` adds a bit after them, `ref` a 2nd cell.
 */
function auxCell(over: {zero?: Address; refund?: Address; bits?: number; cell?: Cell; tail?: boolean; ref?: boolean} = {}): Cell {
  const a = readEscrow(CAPTURED).aux.beginParse();
  const [zero, refund, bits, cell] = [a.loadAddress(), a.loadAddress(), a.loadUint(3), a.loadRef()];
  const b = beginCell().storeAddress(over.zero ?? zero).storeAddress(over.refund ?? refund).storeUint(over.bits ?? bits, 3);
  if (over.tail) b.storeBit(0);
  b.storeRef(over.cell ?? cell);
  if (over.ref) b.storeRef(commentCell("x"));
  return b.endCell();
}

/** This browser's test secret, and the capture rebuilt with its hashlock: the body every case below starts from. */
const SECRET = "5e".repeat(32);
const LOCK = lockOf(SECRET);
const BODY = escrowBoc(CAPTURED, {hashlock: Buffer.from(LOCK, "hex")});
const msgOf = (over: Partial<{to: string; value: bigint; bodyBoc: string}> = {}) => ({to: MESSAGE.targetAddress, value: BigInt(MESSAGE.sendAmount), bodyBoc: BODY, ...over});

/** What buildDeposit hands its payload check for `boc` (provider.ts, the TON source) — what omniston.ts keeps when it passes. */
function providerCheck(boc: string, over: Partial<OmnistonEscrowCheck> = {}): OmnistonEscrowCheck {
  const forward = Cell.fromBase64(boc).refs[0]!;
  return {
    payloadBocHex: hexOf(boc),
    forwardPayloadBocHex: Buffer.from(forward.toBoc()).toString("hex"),
    quoteId: X.quoteUpdated.quoteId,
    inputUnits: X.quoteUpdated.inputUnits,
    resolverSendsUnits: ORDER.resolverSendsUnits,
    srcHtlcSecurityDepositUnits: ORDER.srcHtlcSecurityDepositUnits,
    protocolAddress: MINTER,
    ownerAddress: SELF_UQ,
    destinationChain: X.quoteUpdated.outputAsset.chain.$case,
    destinationAddress: RECIPIENT,
    outputTokenAddress: BASE_USDC,
    initialResolverAddress: RESOLVER,
    secretHashes: [hexToBytes(`0x${lockOf(SECRET)}`)],
    hashingFunction: KECCAK,
    exclusivityTimeout: ORDER.exclusivityTimeout,
    ...over,
  };
}

/** The provider built and checked `boc` (its payload check passed, so omniston.ts kept it). */
const built = (boc: string, over: Partial<OmnistonEscrowCheck> = {}) => recordOmnistonEscrow(providerCheck(boc, over));

const stores = createProviderStores();
beforeAll(async () => {
  // The secret the provider saved for the capture's quote before it asked for the escrow (stores.ts, IndexedDB).
  await stores.omnistonSecrets.save(X.quoteUpdated.quoteId, [SECRET]);
  built(BODY);
});

describe("the escrow rewriter", () => {
  it("re-encodes the capture cell for cell", () => {
    expect(Cell.fromBase64(escrowBoc(CAPTURED)).hash().equals(Cell.fromBase64(CAPTURED).hash())).toBe(true);
    expect(readEscrow(CAPTURED).hashlock.toString("hex")).toBe(X.escrowRequest.secretHashHex);
    expect(auxCell().equals(readEscrow(CAPTURED).aux)).toBe(true);
  });

  it("reads the auxiliary cell as the app does: a zero address, the payer (a failed creation's refund), 000, one cell", () => {
    // Both live escrows (2026-10-10 on rev1, 2026-11-11 on rev2) carry the same auxiliary cell, the payer aside, and flags.
    const old = readEscrow(Buffer.from(E.payloadHex, "hex").toString("base64"));
    for (const e of [readEscrow(CAPTURED), old]) {
      const a = e.aux.beginParse();
      expect(a.loadAddress().toRawString()).toBe(`0:${"0".repeat(64)}`);
      expect(a.loadAddress().toRawString()).toBe(Address.parse(E.owner).toRawString());
      expect([a.loadUint(3), a.remainingBits, a.remainingRefs]).toEqual([0, 0, 1]);
    }
    expect(SELF).toBe(Address.parse(E.owner).toRawString());
    expect(old.aux.refs[0]!.equals(readEscrow(CAPTURED).aux.refs[0]!)).toBe(true);
    expect(old.flags.equals(readEscrow(CAPTURED).flags)).toBe(true);
    // The flags: 75 in 64 bits, then 34 zero bits.
    expect(beginCell().storeUint(75, 64).storeUint(0, 34).endCell().equals(readEscrow(CAPTURED).flags)).toBe(true);
  });
});

// ── which calls are signed ──────────────────────────────────────────────────────────────────────────────────────────

describe("which TON contract calls are signed: Omniston's escrow paid in USDT, to a token on an EVM network", () => {
  it("USDT only, to an ERC-20 on an EVM network Omniston settles on: not native TON, another jetton, TON → TON or Tron", () => {
    expect(tonCallSigned("omniston", USDT, "eip155:8453", BASE_USDC)).toBe(true);
    expect(tonCallSigned("omniston", TON_USDT, "eip155:56", BNB_USDC)).toBe(true);
    expect(tonCallSigned("omniston", null, "eip155:8453", BASE_USDC)).toBe(false);
    expect(tonCallSigned("omniston", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f", "eip155:8453", BASE_USDC)).toBe(false);
    // A TON → TON swap: a DEX router TonAPI's label names, no deadline checked — no call here.
    expect(tonCallSigned("omniston", USDT, "ton:-239", null)).toBe(false);
    expect(tonCallSigned("omniston", USDT, "ton:-239", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f")).toBe(false);
    // A native coin on arrival (Omniston's orders move tokens only), Tron, a network it doesn't settle on.
    expect(tonCallSigned("omniston", USDT, "eip155:8453", null)).toBe(false);
    expect(tonCallSigned("omniston", USDT, "tron:728126428", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(false);
    expect(tonCallSigned("omniston", USDT, "eip155:10", "0x0b2c639c533813f4aa9d7837caf62653d097ff85")).toBe(false);
    expect(tonCallOf(reviewedOf({fromContract: null}))).toBeUndefined();
    expect(tonCallOf(reviewedOf())).toMatchObject({provider: "omniston", jetton: USDT, amount: AMOUNT, destinations: [OMNISTON_TON_MINTER], minForwardTon: FORWARD});
  });

  it("pays only the package's audited rev2 minter, pinned here: never rev1", () => {
    const audited = (AUDITED_OMNISTON_SETTLEMENT_CONTRACTS["ton:-239"] ?? []).map((a) => Address.parse(a).toRawString());
    expect(audited).toEqual([OMNISTON_TON_MINTER]);
    expect(Address.parse(MINTER).toRawString()).toBe(OMNISTON_TON_MINTER);
    expect(TON_CALLS.omniston!.destinations).not.toContain(Address.parse(REV1_MINTER).toRawString());
  });

  it("every EVM network it may deliver on has an audited Omniston settlement contract", () => {
    for (const id of [1, 56, 137, 4663, 8453, 42161, 43114, 196, 999, 9745]) {
      expect(AUDITED_OMNISTON_SETTLEMENT_CONTRACTS[`eip155:${id}`], String(id)).toBeDefined();
      expect(tonCallSigned("omniston", USDT, `eip155:${id}`, BASE_USDC), String(id)).toBe(true);
    }
  });

  it("every rule is checked by its package: a verifier, a binding or both; the payer's wallet is computed, never asked", () => {
    for (const [name, rule] of Object.entries(TON_CALLS)) expect(!!rule.verify || !!rule.bind, name).toBe(true);
    expect(pinnedJettonWallet(USDT, SELF)).toBe(JW);
  });
});

// ── the app's own decode ────────────────────────────────────────────────────────────────────────────────────────────

describe("checkTonCall on the rev2 escrow: the app's own decode of the transfer and the escrow order", () => {
  const call = callOf();
  const check = (m: Partial<ReturnType<typeof msgOf>>, c: TonCallExpected = call) => checkTonCall(msgOf(m), c, SELF);

  it("passes the exact message the venue built: the payer's USDT wallet, 0.4 TON, the escrow order to the rev2 minter", () => {
    expect(BigInt(MESSAGE.sendAmount)).toBe(400_000_000n);
    expect(readEscrow(BODY).destination.toRawString()).toBe(OMNISTON_TON_MINTER);
    expect(readEscrow(BODY).forwardTon).toBe(FORWARD);
    expect(check({})).toBeNull();
    expect(check({bodyBoc: CAPTURED})).toBeNull();
    expect(check({to: JW})).toBeNull();
  });

  it("refuses every field of the transfer the review fixed", () => {
    const t = readEscrow(BODY);
    const cases: [Partial<ReturnType<typeof msgOf>>, RegExp][] = [
      [{to: bounceable(EVIL_TON)}, /isn't sent to your own jetton wallet/],
      [{to: Address.parseRaw(JW).toString({urlSafe: true, bounceable: false})}, /isn't sent bounceable/],
      [{value: TON_BODY_GAS + 1n}, /more than its gas allowance/],
      [{value: 0n}, /attaches no TON/],
      [{bodyBoc: escrowBoc(BODY, {op: 0x178d4519})}, /not a jetton transfer/],
      [{bodyBoc: escrowBoc(BODY, {amount: t.amount + 1n})}, /jetton amount isn't the reviewed one/],
      [{bodyBoc: escrowBoc(BODY, {amount: t.amount - 1n})}, /jetton amount isn't the reviewed one/],
      // rev1's minter (still in old captures), or any other contract.
      [{bodyBoc: escrowBoc(BODY, {destination: Address.parse(REV1_MINTER)})}, /contract the app doesn't pin/],
      [{bodyBoc: escrowBoc(BODY, {destination: Address.parseRaw(EVIL_TON)})}, /contract the app doesn't pin/],
      [{bodyBoc: escrowBoc(BODY, {response: Address.parseRaw(EVIL_TON)})}, /excess goes to another wallet/],
      [{bodyBoc: escrowBoc(BODY, {custom: commentCell("x")})}, /custom payload/],
      [{bodyBoc: escrowBoc(BODY, {forwardTon: BigInt(MESSAGE.sendAmount)})}, /forwards as much TON/],
      // Nothing (or too little) forwarded: the minter is never notified, or can't deploy the escrow.
      [{bodyBoc: escrowBoc(BODY, {forwardTon: 0n})}, /forwards too little TON/],
      [{bodyBoc: escrowBoc(BODY, {forwardTon: 1n})}, /forwards too little TON/],
      [{bodyBoc: escrowBoc(BODY, {forwardTon: FORWARD - 1n})}, /forwards too little TON/],
      [{bodyBoc: escrowBoc(BODY, {}, {inline: true})}, /isn't carried in a reference/],
      [{bodyBoc: escrowBoc(BODY, {}, {tail: true})}, /trailing data/],
      [{bodyBoc: b64(beginCell().storeUint(JETTON_TRANSFER_OP, 32).endCell())}, /can't be read/],
    ];
    for (const [m, why] of cases) expect(check(m), String(why)).toMatch(why);
  });

  it("refuses every field of the escrow order where the money goes: owner, a failed creation's refund, the escrow's gas, network, token, recipient, the minimum, one lock", () => {
    const evm = (a: string) => Buffer.from(a.slice(2), "hex");
    const cases: [Partial<Escrow>, RegExp][] = [
      [{orderOp: 0xc0a5f0da}, /isn't an escrow order/],
      [{owner: Address.parseRaw(EVIL_TON)}, /escrow's owner \(where it refunds\) isn't you/],
      [{ownerDataOwner: Address.parseRaw(EVIL_TON)}, /refunds another wallet/],
      // The escrow's own gas: at least every recording's 0.12 TON (with less its creation fails, and the input takes the
      // failed-creation refund), and less than what the transfer forwards to the minter (0.3 TON recorded).
      [{escrowForward: FORWARD}, /asks the minter to forward more TON than the transfer brings it/],
      [{escrowForward: 0n}, /forwards the escrow too little TON to deploy it/],
      [{escrowForward: 1n}, /forwards the escrow too little TON to deploy it/],
      [{escrowForward: ESCROW_GAS - 1n}, /forwards the escrow too little TON to deploy it/],
      // A failed creation's refund (the auxiliary cell's 2nd address) to anyone but the payer; the rest of that cell and
      // the flags cell, whose meaning the package doesn't read, as every recording has them.
      [{aux: auxCell({refund: Address.parseRaw(EVIL_TON)})}, /refunds a failed creation to another wallet than yours/],
      [{aux: auxCell({refund: Address.parseRaw(JW)})}, /refunds a failed creation to another wallet/],
      [{aux: auxCell({zero: Address.parseRaw(EVIL_TON)})}, /auxiliary cell isn't the one every build carries/],
      [{aux: auxCell({bits: 4})}, /auxiliary cell isn't the one/],
      [{aux: auxCell({cell: beginCell().storeUint(0, 2).storeAddress(Address.parseRaw(EVIL_TON)).endCell()})}, /auxiliary cell isn't the one/],
      [{aux: auxCell({cell: commentCell("x")})}, /auxiliary cell isn't the one/],
      [{aux: auxCell({tail: true})}, /auxiliary cell isn't the one/],
      [{aux: auxCell({ref: true})}, /auxiliary cell isn't the one/],
      // No refund address at all (addr_none where the payer goes).
      [{aux: beginCell().storeAddress(readEscrow(BODY).aux.beginParse().loadAddress()).storeUint(0, 2).storeUint(0, 3).storeRef(readEscrow(BODY).aux.refs[0]!).endCell()}, /can't be read/],
      [{flags: beginCell().storeUint(76, 64).storeUint(0, 34).endCell()}, /flags aren't the ones every build carries/],
      [{flags: beginCell().storeUint(75, 64).storeUint(1, 34).endCell()}, /flags aren't the ones/],
      [{flags: beginCell().storeUint(75, 64).storeUint(0, 34).storeRef(commentCell("x")).endCell()}, /flags aren't the ones/],
      [{flag1: true}, /layout its package reads/],
      [{flag2: true}, /layout its package reads/],
      [{configOp: 0xf2c6fa64}, /config can't be read/],
      [{auction: 60n}, /Dutch auction/],
      [{parts: 2}, /one full fill/],
      // A sha256 execution, or a second resolver in it: one keccak lock naming the config's resolver.
      [{execOp: 0xc8d4b429}, /one keccak hash/],
      [{execResolver: Address.parseRaw(EVIL_TON)}, /two resolvers/],
      [{chainId: 56n}, /another network/],
      [{token: evm(BNB_USDC)}, /another token/],
      [{receiver: evm(EVIL_EVM)}, /another recipient/],
      [{resolverSends: OUTPUT - 1n}, /less than the reviewed minimum/],
    ];
    for (const [over, why] of cases) expect(check({bodyBoc: escrowBoc(BODY, over)}), String(why)).toMatch(why);
    expect(readEscrow(BODY).escrowForward).toBe(ESCROW_GAS);
    expect(check({bodyBoc: escrowBoc(BODY, {escrowForward: ESCROW_GAS})})).toBeNull();
    expect(check({bodyBoc: escrowBoc(BODY, {escrowForward: FORWARD - 1n})})).toBeNull();
    expect(check({bodyBoc: escrowBoc(BODY, {aux: auxCell()})})).toBeNull();
    expect(check({bodyBoc: escrowBoc(BODY, {resolverSends: OUTPUT})})).toBeNull();
  });

  it("holds the order to the review: another recipient, network, token, payer or a higher minimum is refused", () => {
    expect(check({}, callOf({recipient: EVIL_EVM}))).toMatch(/another recipient/);
    expect(check({}, callOf({destChain: "eip155:56", destToken: BASE_USDC}))).toMatch(/another network/);
    expect(check({}, callOf({destToken: BNB_USDC}))).toMatch(/another token/);
    expect(check({}, callOf({minOut: RESOLVER_SENDS + 1n}))).toMatch(/less than the reviewed minimum/);
    expect(check({}, callOf({minOut: RESOLVER_SENDS}))).toBeNull();
    // The payer: its own jetton wallet is another one, so the message's target is refused first.
    expect(checkTonCall(msgOf(), call, EVIL_TON)).toMatch(/your own jetton wallet/);
  });
});

// ── bound beyond its bytes ──────────────────────────────────────────────────────────────────────────────────────────

describe("the escrow's binding (omnistonEscrow.ts): the provider's build, this browser's secret, the package's checks", () => {
  const bind = (m: Partial<ReturnType<typeof msgOf>> = {}, r: ReviewedSwap = reviewedOf()) => checkOmnistonEscrow(r, msgOf(m));

  it("passes the escrow its provider built and checked, locked to the secret IndexedDB holds", async () => {
    expect(await bind()).toBeNull();
    expect(await TON_CALLS.omniston!.bind!(reviewedOf(), msgOf())).toBeNull();
    expect(await callOf().bind(msgOf())).toBeNull();
  });

  it("refuses bytes its provider didn't build and check — any field changed — and a quote id that isn't the build's", async () => {
    // One more nanoTON forwarded, another query id: valid escrows, but not the bytes the provider's check passed.
    expect(await bind({bodyBoc: escrowBoc(BODY, {forwardTon: FORWARD + 1n})})).toMatch(/wasn't built and checked by this page's Omniston provider/);
    expect(await bind({bodyBoc: escrowBoc(BODY, {queryId: 7n})})).toMatch(/wasn't built and checked/);
    expect(await bind({bodyBoc: CAPTURED})).toMatch(/wasn't built and checked/);
    // Kept under the capture's quote, but naming another one.
    const otherQuote = escrowBoc(BODY, {quoteId: Buffer.from(randomHex(32), "hex")});
    built(otherQuote);
    expect(await bind({bodyBoc: otherQuote})).toMatch(/names another quote than the one its provider checked/);
  });

  it("refuses a hashlock that isn't this browser's secret, and an escrow whose secret isn't on disk", async () => {
    // Someone else's hashlock (the capture's own: its preimage was never in this browser), checked by the provider.
    built(CAPTURED);
    expect(await bind({bodyBoc: CAPTURED})).toMatch(/hashlock isn't the secret this browser holds/);
    // Another quote's escrow with no secret saved for it — storage lost or never written: it could never complete.
    const q = randomHex(32);
    const orphan = escrowBoc(BODY, {quoteId: Buffer.from(q, "hex")});
    built(orphan, {quoteId: q});
    expect(await bind({bodyBoc: orphan})).toMatch(/holds no secret for the escrow/);
    // The secret saved for it is another one; then two secrets (the package's one execution commits one hash).
    await stores.omnistonSecrets.save(q, ["77".repeat(32)]);
    expect(await bind({bodyBoc: orphan})).toMatch(/hashlock isn't the secret this browser holds/);
    await stores.omnistonSecrets.save(q, [SECRET, SECRET]);
    expect(await bind({bodyBoc: orphan})).toMatch(/holds no secret/);
    await stores.omnistonSecrets.save(q, [SECRET]);
    expect(await bind({bodyBoc: orphan})).toBeNull();
    // A build kept with another hash than its body's, or another hashing function.
    built(orphan, {quoteId: q, secretHashes: [hexToBytes(`0x${lockOf("78".repeat(32))}`)]});
    expect(await bind({bodyBoc: orphan})).toMatch(/hashlock isn't the secret/);
    built(orphan, {quoteId: q, hashingFunction: "HASHING_FUNCTION_SHA256"});
    expect(await bind({bodyBoc: orphan})).toMatch(/hashlock isn't the secret/);
  });

  it("runs the package's payload check again on these bytes: the resolver, its deposit, the window, the pins, the review", async () => {
    // Bodies the app's own decode passes (their fields where the money goes are the review's), each kept as built.
    const evil = Address.parseRaw(EVIL_TON);
    const cases: [Partial<Escrow>, Partial<OmnistonEscrowCheck>][] = [
      // Another resolver than the quote's, in both its slots (consistent: the app's decode passes it).
      [{resolver: evil, execResolver: evil}, {}],
      // Another security deposit, exclusivity window or timelocks than the quote's / the audited ones.
      [{deposit: 1n}, {}],
      [{exclusivity: 3_600n}, {}],
      [{timelocks: [1n, 120n, 240n, 3_000n]}, {}],
      // Another escrow code or authority key than the pinned ones.
      [{code: commentCell("code")}, {}],
      [{authority: Buffer.alloc(32, 7)}, {}],
      // The resolver bound to send another amount than the quote's (more is still not the quote).
      [{resolverSends: RESOLVER_SENDS + 1n}, {}],
    ];
    for (const [over, check] of cases) {
      const boc = escrowBoc(BODY, over);
      built(boc, check);
      expect(checkTonCall(msgOf({bodyBoc: boc}), callOf(), SELF), JSON.stringify(Object.keys(over))).toBeNull();
      expect(await bind({bodyBoc: boc}), JSON.stringify(Object.keys(over))).toMatch(/isn't the one its provider checked for this swap/);
    }
    // The review's side is the review's, never the build's: another recipient, network, token, owner or amount.
    for (const r of [
      reviewedOf({recipient: EVIL_EVM}),
      reviewedOf({destChain: "eip155:56"}),
      reviewedOf({destToken: BNB_USDC}),
      reviewedOf({refundAddress: Address.parseRaw(EVIL_TON).toString({urlSafe: true, bounceable: false})}),
      reviewedOf({amountIn: AMOUNT + 1n}),
    ])
      expect(await bind({}, r)).toMatch(/isn't the one its provider checked/);
  });

  it("holds neither the auxiliary and flags cells (shape only) nor the escrow's gas (more than none): the app's own decode does", async () => {
    // Bodies the provider's check passes and kept, each a field of the order only the app's decode holds. When the
    // package binds them (hardening for its owner), `bind` refuses them too and this flips.
    const cases: [Partial<Escrow>, RegExp][] = [
      [{aux: auxCell({refund: Address.parseRaw(EVIL_TON)})}, /refunds a failed creation to another wallet/],
      [{aux: auxCell({zero: Address.parseRaw(EVIL_TON)})}, /auxiliary cell isn't the one/],
      [{flags: beginCell().storeUint(76, 64).storeUint(0, 34).endCell()}, /flags aren't the ones/],
      [{escrowForward: 1n}, /too little TON to deploy it/],
    ];
    for (const [over, why] of cases) {
      const boc = escrowBoc(BODY, over);
      built(boc);
      expect(await bind({bodyBoc: boc}), String(why)).toBeNull();
      expect(checkTonCall(msgOf({bodyBoc: boc}), callOf(), SELF), String(why)).toMatch(why);
      expect(await armCheck({boc}), String(why)).toMatch(why);
    }
  });

  it("then the package's build verifier with a quote rebuilt from the review: what the resolver sends covers the reviewed minimum", async () => {
    expect(await bind({}, reviewedOf({minOut: RESOLVER_SENDS}))).toBeNull();
    expect(await bind({}, reviewedOf({minOut: RESOLVER_SENDS + 1n}))).toBe(`omniston: the resolver is bound to deliver ${RESOLVER_SENDS}, under the quote's minimum ${RESOLVER_SENDS + 1n}`);
    // Native TON or another jetton: refused before anything is read.
    expect(await bind({}, reviewedOf({fromContract: null}))).toMatch(/needs a jetton source/);
  });
});

// ── the package's build verifier, as the phone runs it (mobile pins.test.ts:68-105) ────────────────────────────────

describe("Omniston TON → EVM escrow, the package's verifier as the phone runs it (live escrow of 2026-11-11 on the rev2 minter)", () => {
  const verify = omnistonEscrowVerifier("https://tonapi.example");
  const quote = (minDestAmount = "9900000") =>
    ({provider: "omniston", intentId: "q1", sourceAmount: X.quoteUpdated.inputUnits, minDestAmount, providerData: {settlement: "escrow"}}) as unknown as Quote;
  const tx: UnsignedTx = {chain: "ton:-239", to: MESSAGE.targetAddress, value: MESSAGE.sendAmount, bodyBoc: CAPTURED};
  const params = (over: Partial<QuoteParams> = {}) => ({...X.params, ...over}) as QuoteParams;

  it("passes the escrow that is this swap's", async () => {
    expect(await verify(quote(), tx, params())).toBeNull();
  });
  it("refuses another destination, owner, token or amount, a short delivery and a body that isn't an escrow", async () => {
    expect(await verify(quote(), tx, params({destAddress: "0x" + "99".repeat(20)}))).toMatch(/not this swap's/);
    expect(await verify(quote(), tx, params({destChain: "eip155:56"}))).toMatch(/not this swap's/);
    expect(await verify(quote(), tx, params({destToken: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"}))).toMatch(/not this swap's/);
    expect(await verify(quote(), tx, params({refundAddress: RESOLVER}))).toMatch(/not this swap's/);
    expect(await verify({...quote(), sourceAmount: "10000001"}, tx, params())).toMatch(/not the 10000001 this swap sells/);
    expect(await verify(quote(String(RESOLVER_SENDS + 1n)), tx, params())).toMatch(/under the quote's minimum/);
    expect(await verify(quote(), {...tx, bodyBoc: "te6cckEBAQEAAgAAAEysuc0="}, params())).toMatch(/not an Omniston escrow transfer/);
  });
  it("refuses an escrow funded by native TON: only a jetton source binds where the message goes", async () => {
    expect(await verify(quote(), {...tx, to: MINTER, value: X.quoteUpdated.inputUnits}, params({sourceToken: "GRAM"}))).toMatch(/jetton source/);
  });
  it("refuses a body without the request it answered, and an order for a TON source", async () => {
    expect(await verify(quote(), tx)).toMatch(/request this quote answered is unknown/);
    expect(await verify(quote(), {chain: "eip155:8453", to: "0x0000000000000000000000000000000000000001", value: "0", typedData: "{}"}, params())).toMatch(/typed order needs an EVM source/);
  });
  it("refuses the rev1 minter's escrow (live 2026-10-10) by default, naming the minter; this capture is on rev2", async () => {
    expect(MINTER).toBe("EQDybO88l2lrrAmALRUqpmgEE_tuxk510F4Yd4xjbQZxC9IA");
    const old = {...quote("4900000"), sourceAmount: E.inputUnits} as Quote;
    const oldTx: UnsignedTx = {chain: "ton:-239", to: E.jettonWallet, value: E.sendAmount, bodyBoc: Buffer.from(E.payloadHex, "hex").toString("base64")};
    const oldParams = params({amountIn: E.inputUnits, destAddress: E.destAddress, destToken: E.destToken, refundAddress: E.owner});
    expect(await verify(old, oldTx, oldParams)).toBe(`the escrow transfer pays ${REV1_MINTER}, not an Omniston protocol contract this app trusts`);
    // And the app's own decode refuses it before: rev1 isn't the pinned minter.
    const r = reviewedOf({amountIn: BigInt(E.inputUnits), minOut: 4_900_000n, refundAddress: E.owner, recipient: E.destAddress, destToken: E.destToken});
    expect(checkTonCall({to: E.jettonWallet, value: BigInt(E.sendAmount), bodyBoc: oldTx.bodyBoc!}, tonCallOf(r)!, Address.parse(E.owner).toRawString())).toMatch(/doesn't pin/);
  });
});

// ── at the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

const planOf = (source: Partial<Extract<Swap2ExecutionPlan["source"], {kind: "call"}>> = {}, over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan =>
  ({
    provider: "omniston",
    fromChain: "ton:-239",
    destChain: "eip155:8453",
    destToken: BASE_USDC,
    recipient: RECIPIENT,
    refundAddress: SELF_UQ,
    sourceAmount: AMOUNT,
    destAmount: OUTPUT,
    minDestAmount: OUTPUT,
    feeUsd: 0.003,
    etaSeconds: 240,
    validUntilMs: Date.now() + 45_000,
    approvals: [],
    source: {kind: "call", to: MESSAGE.targetAddress, value: BigInt(MESSAGE.sendAmount), cellBody: true, ...source},
    ...over,
  }) as Swap2ExecutionPlan;

/** execute.ts's arm, its checks only: checkPlanBrowser, then the venue's binding on the same BoC. */
async function armCheck(o: {boc?: string; plan?: Swap2ExecutionPlan; r?: ReviewedSwap} = {}) {
  const body = captureTonBody();
  body.decodeTonBody(o.boc ?? BODY);
  const plan = o.plan ?? planOf();
  const r = o.r ?? reviewedOf();
  return checkPlanBrowser(plan, r, venueRule("omniston"), undefined, body) ?? (await checkTonCallBinding(plan, r, body.boc()));
}

describe("checkPlanBrowser and the binding, as execute.ts arms an escrow", () => {
  it("passes the reviewed escrow", async () => {
    expect(await armCheck()).toBeNull();
  });

  it("refuses the decoded bytes when they aren't the reviewed call, and a plain deposit for the venue", async () => {
    expect(await armCheck({boc: escrowBoc(BODY, {destination: Address.parse(REV1_MINTER)})})).toMatch(/doesn't pin/);
    expect(await armCheck({boc: escrowBoc(BODY, {receiver: Buffer.from(EVIL_EVM.slice(2), "hex")})})).toMatch(/another recipient/);
    expect(await armCheck({boc: escrowBoc(BODY, {forwardTon: 1n})})).toMatch(/forwards too little TON/);
    expect(await armCheck({boc: escrowBoc(BODY, {queryId: 9n})})).toMatch(/wasn't built and checked/);
    expect(await armCheck({plan: planOf({to: bounceable(EVIL_TON)})})).toMatch(/your own jetton wallet/);
    expect(await armCheck({plan: planOf({value: TON_BODY_GAS + 1n})})).toMatch(/sends more than you reviewed/);
    expect(await armCheck({r: reviewedOf({fromContract: null})})).toMatch(/paid in TON/);
    // The whole input as a USDT transfer to an address an API named: from TON the venue is paid by its escrow only.
    expect(await armCheck({plan: planOf({}, {source: {kind: "token-transfer", token: USDT, recipient: OMNISTON_TON_MINTER, amount: AMOUNT}})})).toMatch(/plain transfer this venue never makes/);
    // To a TON token (a TON → TON swap): not this venue's checked call.
    const tonTon = {destChain: "ton:-239", destToken: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f", recipient: SELF_UQ};
    expect(await armCheck({plan: planOf({}, tonTon), r: reviewedOf(tonTon)})).toMatch(/for a token this venue's call isn't checked for/);
  });

  it("the binding names nothing for anything but a TON cell body, and refuses a cell body it can't see", async () => {
    expect(await checkTonCallBinding(planOf({}, {fromChain: "eip155:1"}), reviewedOf(), BODY)).toBeNull();
    expect(await checkTonCallBinding(planOf({cellBody: false}), reviewedOf(), BODY)).toBeNull();
    expect(await checkTonCallBinding(planOf(), reviewedOf(), undefined)).toMatch(/body is missing/);
    expect(await checkTonCallBinding(planOf(), reviewedOf({provider: "lifi"}), BODY)).toMatch(/body is missing/);
  });
});

// ── on the TON Connect message ──────────────────────────────────────────────────────────────────────────────────────

describe("checkTonRequest's jetton-call kind and the account's binding on the escrow", () => {
  const value = BigInt(MESSAGE.sendAmount);
  const exp = {kind: "jetton-call", jettonWallet: JW, value, bodyBoc: BODY, call: callOf()} as const;
  const req = (msg: Partial<TonConnectRequest["messages"][number]> = {}): TonConnectRequest => ({
    validUntil: Math.floor(Date.now() / 1000) + 300,
    network: "-239",
    from: SELF,
    messages: [{address: MESSAGE.targetAddress, amount: MESSAGE.sendAmount, payload: BODY, ...msg}],
  });
  const ctx = () => ({self: SELF, now: Date.now()});

  it("passes exactly the armed escrow, refuses another body, amount or target", () => {
    expect(checkTonRequest(req(), exp, ctx())).toBeNull();
    expect(checkTonRequest(req({payload: CAPTURED}), exp, ctx())).toMatch(/body isn't the reviewed one/);
    expect(checkTonRequest(req({amount: (value + 1n).toString()}), exp, ctx())).toMatch(/another TON amount/);
    expect(checkTonRequest(req({address: bounceable(EVIL_TON)}), exp, ctx())).toMatch(/your own jetton wallet/);
    const short = escrowBoc(BODY, {resolverSends: OUTPUT - 1n});
    expect(checkTonRequest(req({payload: short}), {...exp, bodyBoc: short}, ctx())).toMatch(/less than the reviewed minimum/);
    // Armed so, an escrow refunding a failed creation elsewhere, or too poor to deploy, is still read and refused here.
    const elsewhere = escrowBoc(BODY, {aux: auxCell({refund: Address.parseRaw(EVIL_TON)})});
    expect(checkTonRequest(req({payload: elsewhere}), {...exp, bodyBoc: elsewhere}, ctx())).toMatch(/refunds a failed creation to another wallet/);
    const poor = escrowBoc(BODY, {escrowForward: 1n});
    expect(checkTonRequest(req({payload: poor}), {...exp, bodyBoc: poor}, ctx())).toMatch(/too little TON to deploy it/);
  });

  it("the account binds it again right before the wallet: a secret gone from storage by then is refused, nothing sent", async () => {
    const q = randomHex(32);
    const boc = escrowBoc(BODY, {quoteId: Buffer.from(q, "hex")});
    built(boc, {quoteId: q});
    await stores.omnistonSecrets.save(q, [SECRET]);
    const w = fakeWallet();
    const account = tonEngineAccount(w.signer, {fetch: tonApi() as unknown as typeof fetch}, callOf());
    await expect(account.sendTransaction({to: MESSAGE.targetAddress, value, bodyBoc: boc})).resolves.toMatchObject({hash: expect.stringMatching(/^[0-9a-f]{64}$/)});
    expect(w.sent).toHaveLength(1);
    // The same escrow once its secret is gone (evicted, cleared by another tab): refused before the wallet is asked.
    await stores.omnistonSecrets.clear(q);
    await expect(account.sendTransaction({to: MESSAGE.targetAddress, value, bodyBoc: boc})).rejects.toThrow(/holds no secret for the escrow/);
    expect(w.sent).toHaveLength(1);
  });
});

// ── the whole flow ──────────────────────────────────────────────────────────────────────────────────────────────────

/** TonAPI for the payer: its USDT wallet (the account's proof, and the package's jetton-wallet check) and that wallet's state. */
const tonApi = (balance = "100000000") =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("/methods/get_wallet_address")) return Response.json({success: true, decoded: {jetton_wallet_address: JW}});
    if (u.includes("/methods/get_wallet_data")) return Response.json({success: true, decoded: {balance, owner: SELF, jetton: TON_USDT}});
    if (u.includes(`/jettons/`)) return Response.json({balance, wallet_address: {address: JW}, jetton: {address: TON_USDT}});
    return new Response("", {status: 500});
  });

/** A TON Connect wallet for the trader that records every request (and what IndexedDB held then) and never broadcasts. */
function fakeWallet(onSend?: (tx: TonConnectRequest) => Promise<void>) {
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
        await onSend?.(tx);
        options?.onRequestSent?.();
        return {boc: signed};
      },
    },
  };
  return {signer, sent};
}

const stream = <T>(events: readonly T[]) => ({
  subscribe(o: {next?: (v: T) => void; complete?: () => void}) {
    for (const e of events) o.next?.(e);
    o.complete?.();
    return {unsubscribe() {}};
  },
});

/**
 * Omniston's WebSocket API from the capture: a fresh quote (new id, the capture's terms) for every RFQ, the escrow built
 * from the capture with the quote id and the hashlock the provider asked for (`patch` rewrites the message), and an order
 * feed answering `order` (null: no snapshot yet). Disclosures are recorded.
 */
function fakeOmniston(patch: (m: {targetAddress: string; sendAmount: string; payload: string}) => void = () => undefined) {
  const quotes: OmnistonQuote[] = [];
  const builds: {quoteId: string; hashes: Uint8Array[]; owner: string; dest: string}[] = [];
  const disclosed: {quoteId: string; executionIndex: number; secret: string}[] = [];
  const state: {order: ((quoteId: string) => OrderSnapshot) | null; afterBuild?: (quoteId: string) => Promise<void>} = {order: null};
  const client: OmnistonClientLike = {
    requestForQuote: () => {
      const now = Math.floor(Date.now() / 1000);
      const rfqId = randomHex(32);
      const q = {
        ...X.quoteUpdated,
        rfqId,
        quoteId: randomHex(32),
        quoteTimestamp: now,
        settlementData: {$case: "order", value: {...ORDER, tradeStartDeadline: now + 300}},
      } as unknown as OmnistonQuote;
      quotes.push(q);
      return stream([{$case: "ack", value: {rfqId}}, {$case: "quoteUpdated", rfqId, value: q}]);
    },
    async tonBuildEscrowTransfer(req) {
      const hashes = req.htlcSecrets.secretMode.value.hashes;
      builds.push({quoteId: req.quoteId, hashes, owner: req.ownerSrcAddress.chain.value, dest: req.traderDstAddress.chain.value});
      const boc = escrowBoc(CAPTURED, {quoteId: Buffer.from(req.quoteId.padStart(64, "0"), "hex"), hashlock: Buffer.from(hashes[0]!)});
      const m = {targetAddress: MESSAGE.targetAddress, sendAmount: MESSAGE.sendAmount, payload: hexOf(boc)};
      patch(m);
      await state.afterBuild?.(req.quoteId);
      return {messages: [m]};
    },
    evmBuildOrderPayload: () => Promise.reject(new Error("not an EVM source")),
    orderRegisterSignedOrder: () => Promise.reject(new Error("not an EVM source")),
    orderTrack: (req) => stream(state.order ? [{$case: "order", value: state.order(req.quoteId)}] : []),
    async orderDiscloseHtlcSecret(req) {
      disclosed.push({quoteId: req.quoteId, executionIndex: req.executionIndex, secret: Buffer.from(req.secret).toString("hex")});
    },
  };
  return {client, quotes, builds, disclosed, state};
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
  amount: "10000000",
  balance: "loaded",
  usd: 1,
  owner: SELF_UQ,
  payMode: "wallet",
};
const usdcOnBase: SwapToken = {
  ...usdtOnTon,
  key: `base:${BASE_USDC.toLowerCase()}`,
  chain: "base",
  caip2: "eip155:8453",
  chainName: "Base",
  family: "evm",
  symbol: "USDC",
  catalogSymbol: "USDC",
  contract: BASE_USDC,
  owner: null,
};

/** The page's Omniston as production builds it (lazyOmniston → buildOmniston over IndexedDB), on `api`'s client. */
async function pageOmniston(api: ReturnType<typeof fakeOmniston>) {
  mocks.client = api.client;
  // The package's jetton-wallet check reads TonAPI through the global fetch it finds when its validators are built.
  vi.stubGlobal("fetch", tonApi());
  const s = createProviderStores();
  const provider = lazyOmniston(DEFAULT_RUNTIME_CONFIG, s, {});
  await lazyLoads([provider]);
  return {provider, stores: s};
}

async function rig(patch?: Parameters<typeof fakeOmniston>[0], o: {onSend?: (tx: TonConnectRequest) => Promise<void>} = {}) {
  const api = fakeOmniston(patch);
  const page = await pageOmniston(api);
  const w = fakeWallet(o.onSend);
  const fetchImpl = tonApi();
  const router = new CrossChainRouter([page.provider]);
  const run = () => executeSwap({from: usdtOnTon, to: usdcOnBase, reviewed: reviewedOf(), signer: w.signer}, {router: () => router, tonAccount: {fetch: fetchImpl as unknown as typeof fetch}});
  return {run, sent: w.sent, api, page, router};
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.evmOutput.mockReset();
  mocks.evmOutput.mockResolvedValue(false);
  mocks.locate.mockReset();
  mocks.locate.mockResolvedValue(null);
});

describe("executeSwap from a TON wallet through Omniston: the real engine and provider, a recorded API", () => {
  it("sends ONE TON Connect message — the payer's USDT jetton wallet, the TON it attaches, the exact escrow — once its secret is on disk", async () => {
    let onDisk: string[] | undefined;
    const {run, sent, api} = await rig(undefined, {
      onSend: async () => {
        // What IndexedDB holds while the wallet is asked (a fresh connection: what a reloaded tab would read).
        onDisk = await createProviderStores().omnistonSecrets.load(api.builds[0]!.quoteId);
      },
    });
    const res = await run();
    expect(api.builds).toHaveLength(1);
    expect(api.builds[0]).toMatchObject({owner: SELF_UQ, dest: RECIPIENT});
    expect(sent).toHaveLength(1);
    const m = sent[0]!.messages;
    expect(m).toHaveLength(1);
    expect(m[0]!.address).toBe(MESSAGE.targetAddress);
    expect(Address.parse(m[0]!.address).toRawString()).toBe(JW);
    expect(Address.parseFriendly(m[0]!.address).isBounceable).toBe(true);
    expect(m[0]!.amount).toBe("400000000");
    const e = readEscrow(m[0]!.payload!);
    expect(e.quoteId.toString("hex")).toBe(api.builds[0]!.quoteId.padStart(64, "0"));
    expect(e.hashlock.toString("hex")).toBe(Buffer.from(api.builds[0]!.hashes[0]!).toString("hex"));
    // The one secret for that quote was on disk before the wallet saw anything, and it is the escrow's preimage.
    expect(onDisk).toHaveLength(1);
    expect(lockOf(onDisk![0]!)).toBe(e.hashlock.toString("hex"));
    // The provider's payload check passed on exactly these bytes, and the gate found it.
    expect(omnistonEscrowBuild(hexOf(m[0]!.payload!))).toMatchObject({quoteId: api.builds[0]!.quoteId, ownerAddress: SELF_UQ});
    expect(res.id).toMatch(/^awk1\.omniston\./);
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(api.disclosed).toEqual([]);
  });

  it("refuses a tampered build before the wallet is asked: more gas, a non-bounceable target, a stranded escrow, a failed creation refunded elsewhere, a lost secret", async () => {
    // `atPlan`: refused by the review hook itself (SwapReviewMismatch) — nothing was armed, the wallet never reachable.
    const rewrite = (m: {payload: string}, over: Partial<Escrow>) => void (m.payload = hexOf(escrowBoc(Buffer.from(m.payload, "hex").toString("base64"), over)));
    const cases: [Parameters<typeof fakeOmniston>[0], RegExp, boolean, ((api: ReturnType<typeof fakeOmniston>) => void)?][] = [
      // 0.6 TON: inside the provider's 2 TON cap, above the app's 0.5 TON (the engine's tonGasCeiling here).
      [(m) => void (m.sendAmount = "600000000"), /more than the 500000000 gas ceiling/, false],
      // The payer's own jetton wallet, non-bounceable: the package's jetton-wallet check and the engine read the raw address.
      [(m) => void (m.targetAddress = Address.parseRaw(JW).toString({urlSafe: true, bounceable: false})), /bounceable/, true],
      // 1 nanoTON forwarded to the minter (the package asks only for more than 0): the escrow is never deployed.
      [(m) => rewrite(m, {forwardTon: 1n}), /forwards too little TON/, true],
      // The minter told to forward the escrow 1 nanoTON (the package asks only for more than 0): its creation fails...
      [(m) => rewrite(m, {escrowForward: 1n}), /forwards the escrow too little TON to deploy it/, true],
      // ...and a failed creation refunds the auxiliary cell's 2nd address, which the package reads for shape only.
      [(m) => rewrite(m, {aux: auxCell({refund: Address.parseRaw(EVIL_TON)})}), /refunds a failed creation to another wallet than yours/, true],
      // The secret gone from IndexedDB once the escrow was built (evicted, cleared): the escrow could never complete.
      [
        undefined,
        /holds no secret for the escrow/,
        true,
        (api) => {
          api.state.afterBuild = (q) => createProviderStores().omnistonSecrets.clear(q) as Promise<void>;
        },
      ],
    ];
    for (const [patch, why, atPlan, setup] of cases) {
      const {run, sent, api} = await rig(patch);
      setup?.(api);
      const e = await run().catch((x: unknown) => x);
      expect((e as Error).message, String(why)).toMatch(why);
      expect(e instanceof SwapReviewMismatch, String(why)).toBe(atPlan);
      expect(swapErrorText(e, "TON")).not.toMatch(/may still/);
      expect(sent).toHaveLength(0);
    }
  });
});

// ── the HTLC secret's life ──────────────────────────────────────────────────────────────────────────────────────────

describe("the escrow's secret: disclosed only once validateEvmOutputPosition proves the delivery, after a reload too", () => {
  /** The order feed's snapshot for an escrow the resolver matched on Base: one execution, our hashlock, ready to complete. */
  const snapshotFor = (api: ReturnType<typeof fakeOmniston>, status = "TRADE_STATUS_UNSPECIFIED") => (quoteId: string): OrderSnapshot => {
    const q = api.quotes.find((x) => x.quoteId === quoteId)!;
    const b = api.builds.find((x) => x.quoteId === quoteId)!;
    return {
      status,
      executions: [
        {
          index: 0,
          inputUnits: q.inputUnits,
          outputUnits: q.outputUnits,
          resolverSendsUnits: ORDER.resolverSendsUnits,
          secretHash: b.hashes[0]!,
          outputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
          outputPositionAddress: {chain: {$case: "base", value: `0x${"e5".repeat(20)}`}},
        },
      ],
    };
  };

  it("through the activity tracker's poll: never while the EVM position isn't proven; after a reload, once it is", async () => {
    const {run, api, page} = await rig();
    const res = await run();
    const quoteId = api.builds[0]!.quoteId;
    const secret = (await page.stores.omnistonSecrets.load(quoteId))![0]!;
    api.state.order = snapshotFor(api);

    // The record execute's runner keeps for the swap, polled by the tracker through the router's status read.
    await loadSwaps();
    saveSwap(
      newRecord({
        id: res.id,
        accountId: `ton:${SELF}`,
        provider: "omniston",
        from: {caip2: "ton:-239", chain: "ton", symbol: "USDT", decimals: 6},
        to: {caip2: "eip155:8453", chain: "base", symbol: "USDC", decimals: 6},
        amountIn: AMOUNT,
        expectedOut: OUTPUT,
        minOut: OUTPUT,
        recipient: RECIPIENT,
        ...(res.hash ? {hash: res.hash} : {}),
      }),
    );
    const record = () => getSwaps().find((r) => r.id === res.id)!;
    const statusOf = (provider: typeof page.provider) => createQuoteEngine({providers: () => [provider]}).swapStatus;

    // The position isn't proven (or its check fails): the secret stays on disk, undisclosed.
    mocks.evmOutput.mockResolvedValue(false);
    expect(await pollRecord(record(), statusOf(page.provider))).toMatchObject({status: "pending"});
    mocks.evmOutput.mockRejectedValue(new Error("rpc down"));
    await pollRecord(record(), statusOf(page.provider));
    expect(api.disclosed).toEqual([]);
    expect(mocks.evmOutput).toHaveBeenCalled();
    expect(await page.stores.omnistonSecrets.load(quoteId)).toEqual([secret]);

    // A reload: a new page's provider and stores over the same IndexedDB, the same record.
    const reloaded = await pageOmniston(api);
    mocks.evmOutput.mockReset();
    mocks.evmOutput.mockResolvedValue(true);
    await pollRecord(record(), statusOf(reloaded.provider));
    expect(api.disclosed).toEqual([{quoteId, executionIndex: 0, secret}]);
    // Checked against the review's recipient and the escrow's own hashlock before the secret went out.
    expect(mocks.evmOutput).toHaveBeenCalledWith(
      expect.objectContaining({chain: "eip155:8453", recipientAddress: RECIPIENT, outputTokenAddress: BASE_USDC, secretHash: api.builds[0]!.hashes[0]}),
    );

    // Filled: the swap completes and its secret leaves storage.
    api.state.order = snapshotFor(api, "TRADE_STATUS_FULLY_FILLED");
    expect(await pollRecord(record(), statusOf(reloaded.provider))).toMatchObject({status: "completed"});
    expect(await reloaded.stores.omnistonSecrets.load(quoteId)).toBeUndefined();
  });
});
