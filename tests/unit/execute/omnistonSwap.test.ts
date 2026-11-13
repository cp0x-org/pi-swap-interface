/**
 * TON contract calls (D35 part C): Omniston's swaps between TON and USDT from a TON wallet, over every TON ↔ USDT build
 * recorded (omnistonSwaps.fixture.json: the SDK's recording of 2026-10-22 and the read-only dry builds of 2026-11-13) —
 * STON.fi v1, STON.fi v2 and DeDust v1, each from TON and from USDT. The pins (tonDexPins.ts) against their friendly
 * forms, the pinned USDT wallet code and every recording; the exact BoC read at the plan (checkPlanBrowser →
 * checkTonPlan → tonGate.ts checkTonCall: the envelope, then tonSwap.ts's own decode of the DEX call) and bound
 * (checkTonCallBinding → omnistonSwap.ts: the package's build verifier with the review and the pins, never TonAPI),
 * then again on the one TON Connect message; every tampered field, per DEX; what stays refused (DeDust CPMM v2,
 * swap.coffee, another STON.fi v2 router, another jetton). Then the whole flow — the real engine and the real Omniston
 * provider (its WebSocket client replaced, and TonAPI's answers to its own build checks replaced by "yes" to everything)
 * through executeSwap to a fake TON Connect wallet: the gate alone refuses what the provider lets through. Nothing
 * reaches a network; nothing is signed.
 *
 * Node's own Buffer here (not the page's polyfill): @ton/core writes into its own, and the bodies are rebuilt below.
 */
import "fake-indexeddb/auto";
import {Address, Cell, beginCell, storeMessage, type Builder, type Slice} from "@ton/core";
import {afterEach, describe, expect, it, vi} from "vitest";
import {TON_SWAP_PROTOCOL_LAYOUTS, type OmnistonClientLike, type OmnistonQuote} from "@anywalletkit/protocol-swap2-omniston/provider";
import {DEFAULT_OMNISTON_TON_PROXY_TON_MASTERS} from "@anywalletkit/protocol-swap2-omniston/validators";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config/defaults";
import type {SwapToken} from "../../../src/contracts/domain";
import type {ReviewedSwap, TonConnectRequest, TonSourceSigner} from "../../../src/contracts/execution";
import {tonEngineAccount} from "../../../src/execute/accounts/ton";
import {swapErrorText} from "../../../src/execute/errors";
import {executeSwap} from "../../../src/execute/execute";
import {SwapReviewMismatch, TON_BODY_GAS, checkPlanBrowser} from "../../../src/execute/gate";
import {checkOmnistonSwap} from "../../../src/execute/omnistonSwap";
import {venueRule} from "../../../src/execute/pins";
import {DEDUST_V1, STONFI_V1, STONFI_V2, TON_DEXES, TON_DEX_JETTON_IN, TON_DEX_NATIVE_IN, tonDexAt} from "../../../src/execute/tonDexPins";
import {captureTonBody, checkTonCall, checkTonRequest, commentCell, pinnedJettonWallet} from "../../../src/execute/tonGate";
import {TON_CALLS, TON_USDT, checkTonCallBinding, omnistonSwapRouteSigned, tonCallOf, tonCallSigned, type TonCallExpected} from "../../../src/execute/tonPlan";
import {OMNISTON_SWAP_DEADLINE_S} from "../../../src/execute/tonSwap";
import {lazyLoads, lazyOmniston} from "../../../src/swap/omnistonLazy";
import {createProviderStores} from "../../../src/swap/stores";
import F from "./omnistonSwaps.fixture.json";

// The provider's WebSocket client is replaced, and so are TonAPI's answers to its own build checks (jetton wallet,
// swap target, swap legs): "yes" to everything, as a lying index would say. The gate's checks are the real ones.
const mocks = vi.hoisted(() => ({client: null as unknown}));
vi.mock("@anywalletkit/protocol-swap2-omniston/provider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anywalletkit/protocol-swap2-omniston/provider")>();
  return {...real, omnistonProvider: (o: Parameters<typeof real.omnistonProvider>[0]) => real.omnistonProvider({...o, client: mocks.client as OmnistonClientLike})};
});
vi.mock("@anywalletkit/protocol-swap2-omniston/validators", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anywalletkit/protocol-swap2-omniston/validators")>();
  return {
    ...real,
    createOmnistonTonValidators: (o: Parameters<typeof real.createOmnistonTonValidators>[0]) => ({
      ...real.createOmnistonTonValidators(o),
      validateTonJettonWallet: async () => true,
      validateTonSwapTarget: async () => true,
      validateTonSwapLeg: async () => true,
    }),
  };
});

interface Case {
  recorded: string;
  pair: string;
  protocols: string;
  routeSteps: string[];
  trader: string;
  dest: string;
  amountIn: string;
  outputUnits?: string;
  minOut: string;
  quote?: Record<string, unknown>;
  message: {targetAddress: string; sendAmount: string; payload: string};
}
const CASES = F.cases as unknown as Case[];
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const ZERO = "0x0000000000000000000000000000000000000000";
const EVIL = `0:${"cd".repeat(32)}`;
const EVIL_ADDR = Address.parseRaw(EVIL);
/** DeDust CPMM v2's TON/USDT pool (EQAH4MY1…): what Omniston quotes TON → USDT through today, and not pinned here. */
const CPMM_V2_POOL = "0:07e0c63511ba8fec6836c0992866fa021b80583ec106e655415cf667d14a9737";

const tonIn = (c: Case) => c.pair.startsWith("GRAM>");
const isPinnedPair = (c: Case) => c.pair === "GRAM>USDT" || c.pair === "USDT>GRAM";
const PINNED = CASES.filter((c) => isPinnedPair(c) && ["StonFiV1", "StonFiV2", "DeDust"].includes(c.protocols));
const of = (protocol: string, source: "ton" | "usdt") => PINNED.filter((c) => c.protocols === protocol && tonIn(c) === (source === "ton"));
const label = (c: Case) => `${c.recorded} ${c.pair} ${c.amountIn} ${c.protocols}`;

const raw = (a: string) => Address.parse(a).toRawString();
const friendly = (a: string, bounceable = false) => Address.parse(a).toString({urlSafe: true, bounceable});
const b64 = (cell: Cell) => Buffer.from(cell.toBoc()).toString("base64");
const cellOf = (c: Case) => Cell.fromBoc(Buffer.from(c.message.payload, "hex"))[0]!;
const bocOf = (c: Case) => Buffer.from(c.message.payload, "hex").toString("base64");
const nowSec = () => Math.floor(Date.now() / 1000);

const reviewedOf = (c: Case, over: Partial<ReviewedSwap> = {}): ReviewedSwap => ({
  provider: "omniston",
  fromChain: "ton:-239",
  fromContract: tonIn(c) ? null : USDT,
  amountIn: BigInt(c.amountIn),
  destChain: "ton:-239",
  destToken: tonIn(c) ? USDT : ZERO,
  recipient: friendly(c.dest),
  refundAddress: friendly(c.trader),
  minOut: BigInt(c.minOut),
  slippageBps: 100,
  approvalSpender: null,
  nativeFee: 0n,
  ...over,
});
const callOf = (c: Case, over: Partial<ReviewedSwap> = {}): TonCallExpected => tonCallOf(reviewedOf(c, over))!;
const msgOf = (c: Case, over: Partial<{to: string; value: bigint; bodyBoc: string}> = {}) => ({
  to: c.message.targetAddress,
  value: BigInt(c.message.sendAmount),
  bodyBoc: bocOf(c),
  ...over,
});
const check = (c: Case, m: Partial<ReturnType<typeof msgOf>> = {}, r: ReviewedSwap = reviewedOf(c)) => checkTonCall(msgOf(c, m), tonCallOf(r)!, raw(r.refundAddress));

// ── rewriting one field of a recorded body ──────────────────────────────────────────────────────────────────────────

type Addr = Address | null;
/** A TEP-74 transfer: a USDT source's, or the one a TON source sends STON.fi v1's pTON wallet. `inline`/`tail` misshape it. */
interface Transfer {
  op: number;
  queryId: bigint;
  amount: bigint;
  destination: Addr;
  response: Addr;
  custom: Cell | null;
  forwardTon: bigint;
  inline?: boolean;
  tail?: boolean;
}
/** STON.fi v1's swap#25938561; `ref` false = has_ref 0. */
interface V1Swap {
  op: number;
  ask: Addr;
  minOut: bigint;
  to: Addr;
  ref: Addr | false;
  tail?: boolean;
}
/** STON.fi v2's swap#6664de2a and its ^body. */
interface V2Swap {
  op: number;
  ask: Addr;
  refund: Addr;
  excess: Addr;
  deadline: bigint;
  minOut: bigint;
  receiver: Addr;
  fwdGas: bigint;
  custom: Cell | null;
  refundFwdGas: bigint;
  refundPayload: Cell | null;
  refFee: number;
  refAddress: Addr;
  tail?: boolean;
  headTail?: boolean;
}
/** pTON v2's ton_transfer#01f3835d (a TON source's message to STON.fi v2's pTON wallet). */
interface PtonV2 {
  op: number;
  queryId: bigint;
  tonAmount: bigint;
  refund: Addr;
  inline?: boolean;
  tail?: boolean;
}
/** DeDust v1's SwapStep and ^SwapParams; `swapOp` the jetton forward's op, `op`/`queryId`/`amount` the native vault's head. */
interface DedustSwap {
  pool: Addr;
  kind: number;
  limit: bigint;
  next: Cell | null;
  deadline: number;
  recipient: Addr;
  referral: Addr;
  fulfill: Cell | null;
  reject: Cell | null;
  tail?: boolean;
}

function readTransfer(s: Slice): Transfer & {forward: Cell} {
  const t = {op: s.loadUint(32), queryId: s.loadUintBig(64), amount: s.loadCoins(), destination: s.loadMaybeAddress(), response: s.loadMaybeAddress(), custom: s.loadMaybeRef(), forwardTon: s.loadCoins()};
  if (!s.loadBit()) throw new Error("recorded inline");
  return {...t, forward: s.loadRef()};
}
function writeTransfer(t: Transfer, forward: Cell): Cell {
  const b = beginCell().storeUint(t.op, 32).storeUint(t.queryId, 64).storeCoins(t.amount).storeAddress(t.destination).storeAddress(t.response).storeMaybeRef(t.custom).storeCoins(t.forwardTon);
  // Inline: the forward payload's op in the body itself (a whole swap doesn't fit beside the transfer).
  if (t.inline) b.storeBit(0).storeUint(forward.beginParse().preloadUint(32), 32);
  else b.storeBit(1).storeRef(forward);
  if (t.tail) b.storeUint(1, 8);
  return b.endCell();
}
const readV1 = (s: Slice): V1Swap => ({op: s.loadUint(32), ask: s.loadMaybeAddress(), minOut: s.loadCoins(), to: s.loadMaybeAddress(), ref: s.loadBit() ? s.loadMaybeAddress() : false});
function writeV1(x: V1Swap): Cell {
  const b = beginCell().storeUint(x.op, 32).storeAddress(x.ask).storeCoins(x.minOut).storeAddress(x.to);
  if (x.ref === false) b.storeBit(0);
  else b.storeBit(1).storeAddress(x.ref);
  if (x.tail) b.storeBit(1);
  return b.endCell();
}
function readV2(s: Slice): V2Swap {
  const head = {op: s.loadUint(32), ask: s.loadMaybeAddress(), refund: s.loadMaybeAddress(), excess: s.loadMaybeAddress(), deadline: s.loadUintBig(64)};
  const b = s.loadRef().beginParse();
  return {
    ...head,
    minOut: b.loadCoins(),
    receiver: b.loadMaybeAddress(),
    fwdGas: b.loadCoins(),
    custom: b.loadMaybeRef(),
    refundFwdGas: b.loadCoins(),
    refundPayload: b.loadMaybeRef(),
    refFee: b.loadUint(16),
    refAddress: b.loadMaybeAddress(),
  };
}
function writeV2(x: V2Swap): Cell {
  const body = beginCell()
    .storeCoins(x.minOut)
    .storeAddress(x.receiver)
    .storeCoins(x.fwdGas)
    .storeMaybeRef(x.custom)
    .storeCoins(x.refundFwdGas)
    .storeMaybeRef(x.refundPayload)
    .storeUint(x.refFee, 16)
    .storeAddress(x.refAddress);
  if (x.tail) body.storeBit(1);
  const head = beginCell().storeUint(x.op, 32).storeAddress(x.ask).storeAddress(x.refund).storeAddress(x.excess).storeUint(x.deadline, 64).storeRef(body.endCell());
  if (x.headTail) head.storeBit(1);
  return head.endCell();
}
function readDedust(s: Slice): DedustSwap {
  const step = {pool: s.loadMaybeAddress(), kind: s.loadUint(1), limit: s.loadCoins(), next: s.loadMaybeRef()};
  const p = s.loadRef().beginParse();
  return {...step, deadline: p.loadUint(32), recipient: p.loadMaybeAddress(), referral: p.loadMaybeAddress(), fulfill: p.loadMaybeRef(), reject: p.loadMaybeRef()};
}
function storeDedust(b: Builder, x: DedustSwap): Builder {
  const p = beginCell().storeUint(x.deadline, 32).storeAddress(x.recipient).storeAddress(x.referral).storeMaybeRef(x.fulfill).storeMaybeRef(x.reject);
  if (x.tail) p.storeBit(1);
  return b.storeAddress(x.pool).storeUint(x.kind, 1).storeCoins(x.limit).storeMaybeRef(x.next).storeRef(p.endCell());
}

/** A STON.fi v1 case's body with `over` applied to its swap and `outer` to the transfer carrying it (from USDT or pTON v1). */
function v1Body(c: Case, over: Partial<V1Swap> = {}, outer: Partial<Transfer> = {}): string {
  const t = readTransfer(cellOf(c).beginParse());
  return b64(writeTransfer({...t, ...outer}, writeV1({...readV1(t.forward.beginParse()), ...over})));
}
/** A STON.fi v2 case's body with `over` applied to its swap and `outer` to what carries it (a USDT transfer, or pTON v2's ton_transfer). */
function v2Body(c: Case, over: Partial<V2Swap> = {}, outer: Partial<Transfer & PtonV2> = {}): string {
  const s = cellOf(c).beginParse();
  if (!tonIn(c)) {
    const t = readTransfer(s);
    return b64(writeTransfer({...t, ...outer}, writeV2({...readV2(t.forward.beginParse()), ...over})));
  }
  const p: PtonV2 = {op: s.loadUint(32), queryId: s.loadUintBig(64), tonAmount: s.loadCoins(), refund: s.loadMaybeAddress()};
  if (!s.loadBit()) throw new Error("recorded inline");
  const swap = writeV2({...readV2(s.loadRef().beginParse()), ...over});
  const x = {...p, ...outer};
  const b = beginCell().storeUint(x.op, 32).storeUint(x.queryId, 64).storeCoins(x.tonAmount).storeAddress(x.refund);
  if (x.inline) b.storeBit(0).storeUint(swap.beginParse().preloadUint(32), 32);
  else b.storeBit(1).storeRef(swap);
  if (x.tail) b.storeUint(1, 8);
  return b64(b.endCell());
}
/** A DeDust v1 case's body with `over` applied to its step and params, `outer` to the native vault's head or the USDT transfer. */
function dedustBody(c: Case, over: Partial<DedustSwap> = {}, outer: Partial<Transfer> & {swapOp?: number} = {}): string {
  const s = cellOf(c).beginParse();
  if (tonIn(c)) {
    const head = {op: s.loadUint(32), queryId: s.loadUintBig(64), amount: s.loadCoins(), ...outer};
    const swap = {...readDedust(s), ...over};
    return b64(storeDedust(beginCell().storeUint(head.op, 32).storeUint(head.queryId, 64).storeCoins(head.amount), swap).endCell());
  }
  const t = readTransfer(s);
  const f = t.forward.beginParse();
  const op = f.loadUint(32);
  const swap = {...readDedust(f), ...over};
  return b64(writeTransfer({...t, ...outer}, storeDedust(beginCell().storeUint(outer.swapOp ?? op, 32), swap).endCell()));
}
/** The case's body rebuilt with nothing changed, in its own layout. */
const rebuilt = (c: Case) => (c.protocols === "StonFiV1" ? v1Body(c) : c.protocols === "StonFiV2" ? v2Body(c) : dedustBody(c));

/** DeDust's reject payload as every build carries it: op 0x3c37d7e9, then the payer twice. */
const rejectOf = (payer: Addr, other: Addr = payer, op = 0x3c37d7e9) => beginCell().storeUint(op, 32).storeAddress(payer).storeAddress(other).endCell();

describe("the body rewriters", () => {
  it("re-encode every recorded TON ↔ USDT body cell for cell", () => {
    // 10 of the SDK's (the 11th TON ↔ USDT build went to DeDust CPMM v2) and 2 dry builds (the other 2 went there too).
    expect(PINNED).toHaveLength(12);
    for (const [p, source, n] of [["StonFiV1", "ton", 3], ["StonFiV1", "usdt", 2], ["StonFiV2", "ton", 2], ["StonFiV2", "usdt", 3], ["DeDust", "ton", 1], ["DeDust", "usdt", 1]] as const)
      expect(of(p, source), `${p} from ${source}`).toHaveLength(n);
    for (const c of PINNED) expect(Cell.fromBase64(rebuilt(c)).hash().equals(cellOf(c).hash()), label(c)).toBe(true);
  });
});

// ── the pins ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the DEX pins (tonDexPins.ts): canonical addresses, held to their friendly forms, the USDT wallet code and every recording", () => {
  it("every address, in its raw and friendly (bounceable) form", () => {
    const forms: [string, string][] = [
      [STONFI_V1.router, "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt"],
      [STONFI_V1.ptonWallet, "EQARULUYsmJq1RiZ-YiH-IJLcAZUVkVff-KBPwEmmaQGH6aC"],
      [STONFI_V1.usdtWallet, "EQBO7JIbnU1WoNlGdgFtScJrObHXkBp-FT5mAz8UagiG9KQR"],
      [STONFI_V2.router, "EQCS4UEa5UaJLzOyyKieqQOQ2P9M-7kXpkO5HnP3Bv250cN3"],
      [STONFI_V2.ptonWallet, "EQCSIMGBps_qzRG3uPYhON8bucyCtu0mYdL1-u4gSz77IBa3"],
      [STONFI_V2.usdtWallet, "EQCSLWJ9fY7b0A5OI72wxUp27l4fRlc6GvRBeFf6PiPpH4p3"],
      [DEDUST_V1.nativeVault, "EQDa4VOnTYlLvDJ0gZjNYm5PXfSmmtL6Vs6A_CZEtXCNICq_"],
      [DEDUST_V1.usdtVault, "EQAYqo4u7VF0fa4DPAebk4g9lBytj2VFny7pzXR0trjtXQaO"],
      [DEDUST_V1.pool, "EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r"],
      [TON_USDT, USDT],
    ];
    for (const [r, f] of forms) {
      expect(raw(f), f).toBe(r);
      expect(Address.parseRaw(r).toString({urlSafe: true, bounceable: true}), r).toBe(f);
      expect(r, r).toMatch(/^0:[0-9a-f]{64}$/);
    }
    // Nine contracts, no two alike: a pin can't stand in for another role.
    const all = TON_DEXES.flatMap((d) => (d.dex === "stonfi" ? [d.router, d.ptonWallet, d.usdtWallet] : [d.nativeVault, d.usdtVault, d.pool]));
    expect(new Set(all).size).toBe(9);
    expect(all).not.toContain(CPMM_V2_POOL);
  });

  it("each router's USDT wallet is the one USDT's pinned wallet code derives for it", () => {
    expect(pinnedJettonWallet(TON_USDT, STONFI_V1.router)).toBe(STONFI_V1.usdtWallet);
    expect(pinnedJettonWallet(TON_USDT, STONFI_V2.router)).toBe(STONFI_V2.usdtWallet);
  });

  it("every recording through a pinned DEX pays its pins, and names their wallets and pool", () => {
    for (const c of PINNED) {
      const native = tonIn(c);
      const to = raw(c.message.targetAddress);
      const contract = native ? to : readTransfer(cellOf(c).beginParse()).destination!.toRawString();
      const dex = tonDexAt(contract, native);
      expect(dex?.protocol, label(c)).toBe(c.protocols);
      expect((native ? TON_DEX_NATIVE_IN : TON_DEX_JETTON_IN).has(contract), label(c)).toBe(true);
      // A USDT source leaves the payer's own jetton wallet, as the pinned code derives it.
      if (!native) expect(to, label(c)).toBe(pinnedJettonWallet(TON_USDT, raw(c.trader)));
    }
    // The wallets each STON.fi swap asks its router for, and DeDust's pool, as recorded.
    const v1 = readV1(readTransfer(cellOf(of("StonFiV1", "ton")[0]!).beginParse()).forward.beginParse());
    expect(v1.ask!.toRawString()).toBe(STONFI_V1.usdtWallet);
    expect(readV1(readTransfer(cellOf(of("StonFiV1", "usdt")[0]!).beginParse()).forward.beginParse()).ask!.toRawString()).toBe(STONFI_V1.ptonWallet);
    expect(readV2(readTransfer(cellOf(of("StonFiV2", "usdt")[0]!).beginParse()).forward.beginParse()).ask!.toRawString()).toBe(STONFI_V2.ptonWallet);
    const s = cellOf(of("DeDust", "ton")[0]!).beginParse();
    s.skip(32 + 64);
    s.loadCoins();
    expect(readDedust(s).pool!.toRawString()).toBe(DEDUST_V1.pool);
  });

  it("names each DEX as Omniston and the package do, and pTON's masters as the package lists them", () => {
    for (const d of TON_DEXES) expect(TON_SWAP_PROTOCOL_LAYOUTS[d.protocol], d.protocol).toBe(d.dex === "stonfi" ? `stonfi-v${d.version}` : "dedust-v1");
    expect(DEFAULT_OMNISTON_TON_PROXY_TON_MASTERS.map(raw)).toEqual([
      "0:8cdc1d7640ad5ee326527fc1ad0514f468b30dc84b0173f0e155f451b4e11f7c",
      "0:671963027f7f85659ab55b821671688601cdcf1ee674fc7fbbb1a776a18d34a3",
    ]);
  });

  it("each entry contract's floor is what every recording carries there", () => {
    for (const c of PINNED) {
      const native = tonIn(c);
      const value = BigInt(c.message.sendAmount);
      if (native) expect(value - BigInt(c.amountIn), label(c)).toBe(TON_DEX_NATIVE_IN.get(raw(c.message.targetAddress)));
      else {
        const t = readTransfer(cellOf(c).beginParse());
        expect(t.forwardTon, label(c)).toBe(TON_DEX_JETTON_IN.get(t.destination!.toRawString()));
      }
    }
  });
});

// ── which calls are signed ──────────────────────────────────────────────────────────────────────────────────────────

describe("which TON contract calls are signed: Omniston's swap between TON and USDT, both ways", () => {
  it("TON → USDT and USDT → TON only: no other jetton on either side, nothing cross-chain from native TON", () => {
    expect(tonCallSigned("omniston", null, "ton:-239", USDT)).toBe(true);
    expect(tonCallSigned("omniston", null, "ton:-239", TON_USDT)).toBe(true);
    expect(tonCallSigned("omniston", USDT, "ton:-239", null)).toBe(true);
    expect(tonCallSigned("omniston", USDT, "ton:-239", ZERO)).toBe(true);
    expect(tonCallSigned("omniston", USDT, "ton:-239", USDT)).toBe(false);
    expect(tonCallSigned("omniston", null, "ton:-239", null)).toBe(false);
    expect(tonCallSigned("omniston", null, "ton:-239", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f")).toBe(false);
    expect(tonCallSigned("omniston", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f", "ton:-239", null)).toBe(false);
    expect(tonCallSigned("omniston", USDT, "ton:-239", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f")).toBe(false);
    // From native TON to an EVM network: still no call (an escrow needs a jetton source); Symbiosis never from TON.
    expect(tonCallSigned("omniston", null, "eip155:8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe(false);
    expect(tonCallSigned("symbiosis", null, "ton:-239", USDT)).toBe(false);
    expect(tonCallSigned("lifi", null, "ton:-239", USDT)).toBe(false);
  });

  it("names the pins it pays: a USDT transfer to a router or DeDust's USDT vault, TON to a pTON wallet or DeDust's native vault", () => {
    const usdtIn = callOf(of("StonFiV1", "usdt")[0]!);
    expect(usdtIn).toMatchObject({provider: "omniston", jetton: USDT, amount: 50_000_000n});
    expect(usdtIn.destinations).toBe(TON_DEX_JETTON_IN);
    expect([...TON_DEX_JETTON_IN.keys()]).toEqual([STONFI_V1.router, STONFI_V2.router, DEDUST_V1.usdtVault]);
    const tonInCall = callOf(of("DeDust", "ton")[0]!);
    expect(tonInCall).toMatchObject({provider: "omniston", jetton: null, amount: 2_000_000_000n});
    expect(tonInCall.destinations).toBe(TON_DEX_NATIVE_IN);
    expect([...TON_DEX_NATIVE_IN.keys()]).toEqual([STONFI_V1.ptonWallet, STONFI_V2.ptonWallet, DEDUST_V1.nativeVault]);
    // Its rule has the package's verifier as its binding; every jetton it is paid in has pinned wallet code.
    const rule = TON_CALLS.omniston!.find((x) => x.native)!;
    expect(rule.bind).toBeDefined();
    expect(rule.jettons.map((j) => pinnedJettonWallet(j, raw(PINNED[0]!.trader)))).not.toContain(null);
    expect(TON_CALLS.omniston!.filter((x) => x.native)).toHaveLength(1);
  });

  it("the route list's early refusal: one step through StonFiV1, StonFiV2 or DeDust by the quote's label, never more", () => {
    for (const p of ["StonFiV1", "StonFiV2", "DeDust"]) expect(omnistonSwapRouteSigned([p]), p).toBe(true);
    for (const steps of [["DeDustCPMMV2"], ["TonCoV2"], ["SwapCoffee"], ["StonFiV2", "StonFiV2"], ["split(StonFiV2|DeDust)"], ["2-routes"], [], undefined])
      expect(omnistonSwapRouteSigned(steps), String(steps)).toBe(false);
    for (const c of CASES) expect(omnistonSwapRouteSigned(c.routeSteps), label(c)).toBe(PINNED.includes(c) || c.pair === "USDT>USDe");
  });
});

// ── the app's own decode ────────────────────────────────────────────────────────────────────────────────────────────

describe("checkTonCall on every recorded swap: the envelope, then the app's own read of the DEX call", () => {
  it("passes every TON ↔ USDT build through a pinned DEX, as the venue built it", () => {
    for (const c of PINNED) expect(check(c), label(c)).toBeNull();
    // A raw target is sent bounceable.
    for (const c of PINNED) expect(check(c, {to: raw(c.message.targetAddress)}), label(c)).toBeNull();
  });

  it("refuses what isn't pinned: DeDust CPMM v2 (live today), swap.coffee, another STON.fi v2 router, another jetton", async () => {
    for (const c of CASES.filter((x) => x.protocols === "DeDustCPMMV2" || x.protocols === "SwapCoffee")) {
      expect(check(c), label(c)).toMatch(/goes to a contract the app doesn't pin/);
      expect(await checkOmnistonSwap(reviewedOf(c), msgOf(c)), label(c)).toMatch(/doesn't pin/);
    }
    const usde = CASES.find((x) => x.pair === "USDT>USDe")!;
    expect(tonCallOf(reviewedOf(usde, {destToken: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f"}))).toBeUndefined();
    // Its bytes held to a USDT → TON review: the transfer pays another of STON.fi's v2 routers (0:52357ff9…), unpinned.
    expect(readTransfer(cellOf(usde).beginParse()).destination!.toRawString()).not.toBe(STONFI_V2.router);
    expect(check(usde)).toMatch(/jettons go to a contract the app doesn't pin/);
    expect(await checkOmnistonSwap(reviewedOf(usde), msgOf(usde))).toMatch(/doesn't pin/);
  });

  it("holds every swap to the review: the recipient, the minimum, the amount, the payer", () => {
    for (const c of PINNED) {
      const r = reviewedOf(c);
      expect(check(c, {}, {...r, recipient: friendly(EVIL)}), label(c)).toMatch(/another recipient/);
      expect(check(c, {}, {...r, minOut: r.minOut + 1n}), label(c)).toMatch(/on-chain minimum is below the reviewed one/);
      expect(check(c, {}, {...r, amountIn: r.amountIn - 1n}), label(c)).toMatch(tonIn(c) ? /another amount/ : /jetton amount isn't the reviewed one/);
      expect(check(c, {}, {...r, amountIn: r.amountIn + 1n}), label(c)).toMatch(tonIn(c) ? /too little TON|another amount/ : /jetton amount isn't the reviewed one/);
      // Another payer: its jetton wallet is another one, or the TON's refund and excess aren't it.
      // (DeDust's TON input has no refund field — a refund goes back to the sender — but its refund note names the payer.)
      expect(checkTonCall(msgOf(c), callOf(c, {refundAddress: friendly(EVIL)}), EVIL), label(c)).toMatch(tonIn(c) ? /another wallet|refund carries a payload/ : /your own jetton wallet/);
    }
  });

  it("TON source: refuses another target, a non-bounceable one, and TON beyond the input outside its floor and 0.5 TON", () => {
    for (const c of of("StonFiV1", "ton").concat(of("StonFiV2", "ton"), of("DeDust", "ton"))) {
      const input = BigInt(c.amountIn);
      const floor = TON_DEX_NATIVE_IN.get(raw(c.message.targetAddress))!;
      const cases: [Partial<ReturnType<typeof msgOf>>, RegExp][] = [
        [{to: friendly(EVIL, true)}, /doesn't pin/],
        [{to: friendly(CPMM_V2_POOL, true)}, /doesn't pin/],
        // The USDT-source entry of the same DEX, or a router itself: not where TON goes in.
        [{to: friendly(STONFI_V1.router, true)}, /doesn't pin/],
        [{to: friendly(DEDUST_V1.usdtVault, true)}, /doesn't pin/],
        [{to: friendly(c.message.targetAddress)}, /isn't sent bounceable/],
        [{value: input}, /gas allowance/],
        [{value: input - 1n}, /gas allowance/],
        [{value: input + TON_BODY_GAS + 1n}, /gas allowance/],
        [{value: input + floor - 1n}, /too little TON for the venue's contract/],
        [{bodyBoc: b64(commentCell("x"))}, /isn't|can't be read/],
      ];
      for (const [m, why] of cases) expect(check(c, m), `${label(c)} ${String(why)}`).toMatch(why);
      expect(check(c, {value: input + TON_BODY_GAS}), label(c)).toBeNull();
    }
    // Another DEX's pinned entry, carrying this one's body: its layout is read and refused.
    const v1 = of("StonFiV1", "ton")[0]!;
    const dedust = of("DeDust", "ton")[0]!;
    expect(check(v1, {to: friendly(DEDUST_V1.nativeVault, true)})).toMatch(/native vault isn't a swap/);
    expect(check(dedust, {to: friendly(STONFI_V1.ptonWallet, true)})).toMatch(/pTON wallet isn't a transfer/);
    expect(check(dedust, {to: friendly(STONFI_V2.ptonWallet, true), value: BigInt(dedust.amountIn) + 220_000_000n})).toMatch(/isn't a TON transfer/);
  });

  it("USDT source: refuses every field of the transfer — target, gas, op, amount, destination, excess, custom payload, forward, shape", () => {
    for (const c of of("StonFiV1", "usdt").concat(of("StonFiV2", "usdt"), of("DeDust", "usdt"))) {
      const t = readTransfer(cellOf(c).beginParse());
      const value = BigInt(c.message.sendAmount);
      const floor = TON_DEX_JETTON_IN.get(t.destination!.toRawString())!;
      const body = (outer: Partial<Transfer>) => (c.protocols === "StonFiV1" ? v1Body(c, {}, outer) : c.protocols === "StonFiV2" ? v2Body(c, {}, outer) : dedustBody(c, {}, outer));
      const cases: [Partial<ReturnType<typeof msgOf>>, RegExp][] = [
        [{to: friendly(EVIL, true)}, /your own jetton wallet/],
        [{to: friendly(c.message.targetAddress)}, /isn't sent bounceable/],
        [{value: TON_BODY_GAS + 1n}, /gas allowance/],
        [{value: 0n}, /attaches no TON/],
        [{bodyBoc: body({op: 0x178d4519})}, /not a jetton transfer/],
        [{bodyBoc: body({amount: t.amount + 1n})}, /jetton amount isn't the reviewed one/],
        [{bodyBoc: body({amount: t.amount - 1n})}, /jetton amount isn't the reviewed one/],
        [{bodyBoc: body({destination: EVIL_ADDR})}, /contract the app doesn't pin/],
        [{bodyBoc: body({destination: Address.parseRaw(CPMM_V2_POOL)})}, /contract the app doesn't pin/],
        // An entry of TON's, or a router's own wallet: never where USDT goes in.
        [{bodyBoc: body({destination: Address.parseRaw(STONFI_V2.ptonWallet)})}, /contract the app doesn't pin/],
        [{bodyBoc: body({destination: Address.parseRaw(STONFI_V1.usdtWallet)})}, /contract the app doesn't pin/],
        [{bodyBoc: body({response: EVIL_ADDR})}, /excess goes to another wallet/],
        [{bodyBoc: body({response: null})}, /excess goes to another wallet/],
        [{bodyBoc: body({custom: commentCell("x")})}, /custom payload/],
        [{bodyBoc: body({forwardTon: value})}, /forwards as much TON/],
        [{bodyBoc: body({forwardTon: floor - 1n})}, /forwards too little TON/],
        [{bodyBoc: body({forwardTon: 1n})}, /forwards too little TON/],
        [{bodyBoc: body({inline: true})}, /isn't carried in a reference/],
        [{bodyBoc: body({tail: true})}, /trailing data/],
      ];
      for (const [m, why] of cases) expect(check(c, m), `${label(c)} ${String(why)}`).toMatch(why);
    }
    // Another pinned DEX's entry, carrying this one's swap: its layout is read and refused.
    const v1 = of("StonFiV1", "usdt")[0]!;
    expect(check(v1, {value: 260_000_000n, bodyBoc: v1Body(v1, {}, {destination: Address.parseRaw(STONFI_V2.router), forwardTon: 210_000_000n})})).toMatch(/isn't STON.fi v2's/);
    expect(check(v1, {bodyBoc: v1Body(v1, {}, {destination: Address.parseRaw(DEDUST_V1.usdtVault)})})).toMatch(/isn't a DeDust swap/);
  });

  it("STON.fi v1: the router's wallet of the reviewed output, the minimum, the recipient, no referral; pTON v1's transfer", () => {
    for (const c of [...of("StonFiV1", "ton"), ...of("StonFiV1", "usdt")]) {
      const v1 = readV1(readTransfer(cellOf(c).beginParse()).forward.beginParse());
      const other = tonIn(c) ? STONFI_V1.ptonWallet : STONFI_V1.usdtWallet;
      const cases: [Partial<V1Swap>, RegExp][] = [
        [{op: 0x25938562}, /isn't STON.fi v1's/],
        [{ask: EVIL_ADDR}, /asks the router for another token/],
        [{ask: Address.parseRaw(other)}, /asks the router for another token/],
        [{ask: Address.parseRaw(STONFI_V2.usdtWallet)}, /asks the router for another token/],
        [{ask: null}, /asks the router for another token/],
        [{minOut: BigInt(c.minOut) - 1n}, /on-chain minimum is below the reviewed one/],
        [{minOut: 0n}, /on-chain minimum is below/],
        [{to: EVIL_ADDR}, /another recipient/],
        [{to: null}, /another recipient/],
        [{ref: EVIL_ADDR}, /names a referral/],
        [{ref: null}, /names a referral/],
        [{tail: true}, /trailing data/],
      ];
      for (const [over, why] of cases) expect(check(c, {bodyBoc: v1Body(c, over)}), `${label(c)} ${String(why)}`).toMatch(why);
      expect(check(c, {bodyBoc: v1Body(c, {minOut: v1.minOut + 1n})}), label(c)).toBeNull();
    }
    // TON in: the pTON v1 wallet's transfer of the input to its own router.
    for (const c of of("StonFiV1", "ton")) {
      const t = readTransfer(cellOf(c).beginParse());
      const gas = BigInt(c.message.sendAmount) - BigInt(c.amountIn);
      const cases: [Partial<Transfer>, RegExp][] = [
        [{op: 0x0f8a7ea6}, /pTON wallet isn't a transfer/],
        [{amount: t.amount - 1n}, /another amount/],
        [{amount: t.amount + 1n}, /another amount/],
        [{destination: Address.parseRaw(STONFI_V2.router)}, /another router than the pTON wallet's own/],
        [{destination: EVIL_ADDR}, /another router/],
        [{response: EVIL_ADDR}, /excess goes to another wallet/],
        [{custom: commentCell("x")}, /custom payload/],
        [{forwardTon: gas + 1n}, /forwards more TON than the gas/],
        [{forwardTon: 100_000_000n - 1n}, /forwards too little TON for the router/],
        [{forwardTon: 0n}, /forwards too little TON for the router/],
        [{inline: true}, /isn't carried in a reference/],
        [{tail: true}, /trailing data/],
      ];
      for (const [outer, why] of cases) expect(check(c, {bodyBoc: v1Body(c, {}, outer)}), `${label(c)} ${String(why)}`).toMatch(why);
      // More gas attached, the forward within it: still the reviewed swap.
      expect(check(c, {value: BigInt(c.message.sendAmount) + 1n, bodyBoc: v1Body(c, {}, {forwardTon: gas + 1n})}), label(c)).toBeNull();
    }
  });

  it("STON.fi v2: the wallet of the reviewed output, refund and excess to the payer, the deadline, no chained swap, refund payload or referral; pTON v2's transfer", () => {
    for (const c of [...of("StonFiV2", "ton"), ...of("StonFiV2", "usdt")]) {
      const other = tonIn(c) ? STONFI_V2.ptonWallet : STONFI_V2.usdtWallet;
      const cases: [Partial<V2Swap>, RegExp][] = [
        [{op: 0x6664de2b}, /isn't STON.fi v2's/],
        [{ask: EVIL_ADDR}, /asks the router for another token/],
        [{ask: Address.parseRaw(other)}, /asks the router for another token/],
        [{ask: Address.parseRaw(STONFI_V1.usdtWallet)}, /asks the router for another token/],
        [{refund: EVIL_ADDR}, /refunds another wallet than yours/],
        [{refund: null}, /refunds another wallet/],
        [{excess: EVIL_ADDR}, /excess goes to another wallet/],
        [{deadline: BigInt(nowSec() - 60)}, /deadline is out of range/],
        [{deadline: BigInt(nowSec() + OMNISTON_SWAP_DEADLINE_S + 60)}, /deadline is out of range/],
        [{deadline: 0n}, /deadline is out of range/],
        [{deadline: 0xfffffffen}, /deadline is out of range/],
        [{minOut: BigInt(c.minOut) - 1n}, /on-chain minimum is below the reviewed one/],
        [{receiver: EVIL_ADDR}, /another recipient/],
        [{receiver: null}, /another recipient/],
        // A chained (cross) swap after this one: forward gas, a custom payload, or both.
        [{fwdGas: 1n}, /chains another swap/],
        [{custom: commentCell("x")}, /chains another swap/],
        [{fwdGas: 300_000_000n, custom: commentCell("x")}, /chains another swap/],
        [{refundFwdGas: 1n}, /refund payload/],
        [{refundPayload: commentCell("x")}, /refund payload/],
        // A referral: a fee, an address with no fee (the package lets that through), both.
        [{refFee: 10}, /names a referral/],
        [{refAddress: EVIL_ADDR}, /names a referral/],
        [{refFee: 10, refAddress: EVIL_ADDR}, /names a referral/],
        [{tail: true}, /trailing data/],
        [{headTail: true}, /trailing data/],
      ];
      for (const [over, why] of cases) expect(check(c, {bodyBoc: v2Body(c, over)}), `${label(c)} ${String(why)}`).toMatch(why);
      // A deadline it does carry, in the next 20 minutes, is the DEX's own bound: it passes.
      expect(check(c, {bodyBoc: v2Body(c, {deadline: BigInt(nowSec() + 600)})}), label(c)).toBeNull();
    }
    for (const c of of("StonFiV2", "ton")) {
      const cases: [Partial<PtonV2>, RegExp][] = [
        [{op: 0x01f3835e}, /isn't a TON transfer/],
        [{tonAmount: BigInt(c.amountIn) - 1n}, /another amount/],
        [{tonAmount: BigInt(c.amountIn) + 1n}, /another amount/],
        [{refund: EVIL_ADDR}, /refunds another wallet than yours/],
        [{refund: null}, /refunds another wallet/],
        [{inline: true}, /isn't carried in a reference/],
        [{tail: true}, /trailing data/],
      ];
      for (const [outer, why] of cases) expect(check(c, {bodyBoc: v2Body(c, {}, outer)}), `${label(c)} ${String(why)}`).toMatch(why);
    }
  });

  it("DeDust v1: the pinned pool, a given input, the minimum, one step, the deadline, the recipient, no referral or payloads but every build's refund note", () => {
    for (const c of [...of("DeDust", "ton"), ...of("DeDust", "usdt")]) {
      const self = Address.parse(c.trader);
      const cases: [Partial<DedustSwap>, RegExp][] = [
        [{pool: EVIL_ADDR}, /another DeDust pool than the pinned TON\/USDT one/],
        [{pool: Address.parseRaw(CPMM_V2_POOL)}, /another DeDust pool/],
        [{pool: null}, /another DeDust pool/],
        [{kind: 1}, /given input/],
        [{limit: BigInt(c.minOut) - 1n}, /on-chain minimum is below the reviewed one/],
        [{limit: 0n}, /on-chain minimum is below/],
        [{next: commentCell("x")}, /chains another swap/],
        [{deadline: nowSec() - 60}, /deadline is out of range/],
        [{deadline: nowSec() + OMNISTON_SWAP_DEADLINE_S + 60}, /deadline is out of range/],
        [{deadline: 0xffffffff}, /deadline is out of range/],
        [{recipient: EVIL_ADDR}, /another recipient/],
        [{recipient: null}, /another recipient/],
        [{referral: EVIL_ADDR}, /names a referral/],
        [{fulfill: commentCell("x")}, /hands the recipient a payload/],
        // The refund note: every build's is op 0x3c37d7e9 and the payer twice — nothing else.
        [{reject: rejectOf(self, self, 0x3c37d7e8)}, /refund carries a payload other than every build's/],
        [{reject: rejectOf(self, EVIL_ADDR)}, /refund carries a payload other/],
        [{reject: rejectOf(EVIL_ADDR, self)}, /refund carries a payload other/],
        [{reject: beginCell().storeSlice(rejectOf(self).beginParse()).storeBit(0).endCell()}, /refund carries a payload other/],
        [{reject: beginCell().storeSlice(rejectOf(self).beginParse()).storeRef(commentCell("x")).endCell()}, /refund carries a payload other/],
        [{reject: commentCell("x")}, /refund carries a payload other|can't be read/],
        [{tail: true}, /trailing data/],
      ];
      for (const [over, why] of cases) expect(check(c, {bodyBoc: dedustBody(c, over)}), `${label(c)} ${String(why)}`).toMatch(why);
      expect(check(c, {bodyBoc: dedustBody(c, {reject: null})}), label(c)).toBeNull();
      expect(check(c, {bodyBoc: dedustBody(c, {deadline: nowSec() + 600})}), label(c)).toBeNull();
      // The op: the native vault's, or the USDT transfer's forward.
      const op = tonIn(c) ? dedustBody(c, {}, {op: 0xea06185e}) : dedustBody(c, {}, {swapOp: 0xe3a0d483});
      expect(check(c, {bodyBoc: op}), label(c)).toMatch(/isn't a (DeDust )?swap/);
    }
    for (const c of of("DeDust", "ton")) {
      expect(check(c, {bodyBoc: dedustBody(c, {}, {amount: BigInt(c.amountIn) - 1n})})).toMatch(/another amount/);
      expect(check(c, {bodyBoc: dedustBody(c, {}, {amount: BigInt(c.amountIn) + 1n})})).toMatch(/another amount/);
    }
  });
});

// ── bound beyond its bytes: the package's verifier on the pins ──────────────────────────────────────────────────────

describe("the swap's binding (omnistonSwap.ts): the package's build verifier with the review and the pins, never TonAPI", () => {
  it("passes every recorded swap through a pinned DEX, asking no network", async () => {
    const fetch = vi.fn(async () => new Response("", {status: 500}));
    vi.stubGlobal("fetch", fetch);
    for (const c of PINNED) {
      expect(await checkOmnistonSwap(reviewedOf(c), msgOf(c)), label(c)).toBeNull();
      expect(await callOf(c).bind(msgOf(c)), label(c)).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses the review's side changed: recipient, minimum, amount, payer", async () => {
    for (const c of PINNED) {
      const r = reviewedOf(c);
      expect(await checkOmnistonSwap({...r, recipient: friendly(EVIL)}, msgOf(c)), label(c)).toMatch(/receiver-not-destination/);
      expect(await checkOmnistonSwap({...r, minOut: r.minOut + 1n}, msgOf(c)), label(c)).toMatch(/min-out-below-quote/);
      expect(await checkOmnistonSwap({...r, amountIn: r.amountIn + 1n}, msgOf(c)), label(c)).toMatch(/amount-mismatch/);
      // DeDust's TON input names no refund address (a refund goes back to the sender): the package has nothing to read.
      if (c.protocols === "DeDust" && tonIn(c)) expect(await checkOmnistonSwap({...r, refundAddress: friendly(EVIL)}, msgOf(c)), label(c)).toBeNull();
      else expect(await checkOmnistonSwap({...r, refundAddress: friendly(EVIL)}, msgOf(c)), label(c)).toMatch(/not-trader/);
    }
  });

  it("holds the package's legs and target to the pins: another ask wallet, router, pool or target is refused there too", async () => {
    const v1 = of("StonFiV1", "ton")[0]!;
    const v2 = of("StonFiV2", "usdt")[0]!;
    const dd = of("DeDust", "ton")[0]!;
    // Bodies the package's decoder reads as genuine — only the pins tell them apart.
    expect(await checkOmnistonSwap(reviewedOf(v1), msgOf(v1, {bodyBoc: v1Body(v1, {ask: EVIL_ADDR})}))).toMatch(/leg not verified/);
    expect(await checkOmnistonSwap(reviewedOf(v2), msgOf(v2, {bodyBoc: v2Body(v2, {ask: Address.parseRaw(STONFI_V2.usdtWallet)})}))).toMatch(/leg not verified/);
    expect(await checkOmnistonSwap(reviewedOf(dd), msgOf(dd, {bodyBoc: dedustBody(dd, {pool: Address.parseRaw(CPMM_V2_POOL)})}))).toMatch(/leg not verified/);
    // pTON v1's transfer naming another router: the leg's router isn't the pinned one.
    expect(await checkOmnistonSwap(reviewedOf(v1), msgOf(v1, {bodyBoc: v1Body(v1, {}, {destination: EVIL_ADDR})}))).toMatch(/leg not verified/);
    // A USDT transfer to a contract no pin names, and TON sent to one: refused before the package runs.
    expect(await checkOmnistonSwap(reviewedOf(v2), msgOf(v2, {bodyBoc: v2Body(v2, {}, {destination: EVIL_ADDR})}))).toMatch(/doesn't pin/);
    expect(await checkOmnistonSwap(reviewedOf(dd), msgOf(dd, {to: friendly(EVIL, true)}))).toMatch(/doesn't pin/);
    // Another DEX's pinned entry carrying this body: the route the pin names isn't the layout the body has.
    expect(await checkOmnistonSwap(reviewedOf(v1), msgOf(v1, {to: friendly(DEDUST_V1.nativeVault, true)}))).toMatch(/unknown-layout/);
  });

  it("refuses what the package reads too, and lets through what only the app's decode holds (deadlines, payloads, a zero-fee referral)", async () => {
    const v2 = of("StonFiV2", "ton")[0]!;
    const dd = of("DeDust", "usdt")[0]!;
    expect(await checkOmnistonSwap(reviewedOf(v2), msgOf(v2, {bodyBoc: v2Body(v2, {refund: EVIL_ADDR})}))).toMatch(/refund-not-trader/);
    expect(await checkOmnistonSwap(reviewedOf(v2), msgOf(v2, {bodyBoc: v2Body(v2, {refFee: 10, refAddress: EVIL_ADDR})}))).toMatch(/referral/);
    // The package reads and discards these: the app's own decode is what refuses them (above). When the package binds
    // them (hardening for its owner), this flips.
    const cases: [Case, string][] = [
      [v2, v2Body(v2, {deadline: BigInt(nowSec() + 86_400)})],
      [v2, v2Body(v2, {refAddress: EVIL_ADDR})],
      [v2, v2Body(v2, {refundFwdGas: 1n})],
      [dd, dedustBody(dd, {fulfill: commentCell("x")})],
      [dd, dedustBody(dd, {reject: commentCell("x")})],
      [dd, dedustBody(dd, {deadline: nowSec() + 86_400})],
    ];
    for (const [c, boc] of cases) {
      expect(await checkOmnistonSwap(reviewedOf(c), msgOf(c, {bodyBoc: boc})), label(c)).toBeNull();
      expect(checkTonCall(msgOf(c, {bodyBoc: boc}), callOf(c), raw(c.trader)), label(c)).not.toBeNull();
    }
  });
});

// ── at the plan ─────────────────────────────────────────────────────────────────────────────────────────────────────

const planOf = (c: Case, source: Partial<Extract<Swap2ExecutionPlan["source"], {kind: "call"}>> = {}, over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan =>
  ({
    provider: "omniston",
    fromChain: "ton:-239",
    destChain: "ton:-239",
    destToken: tonIn(c) ? USDT : ZERO,
    recipient: friendly(c.dest),
    refundAddress: friendly(c.trader),
    sourceAmount: BigInt(c.amountIn),
    destAmount: BigInt(c.outputUnits ?? c.minOut),
    minDestAmount: BigInt(c.minOut),
    feeUsd: 0,
    etaSeconds: 30,
    validUntilMs: Date.now() + 45_000,
    approvals: [],
    source: {kind: "call", to: c.message.targetAddress, value: BigInt(c.message.sendAmount), cellBody: true, ...source},
    ...over,
  }) as Swap2ExecutionPlan;

/** execute.ts's arm, its checks only: checkPlanBrowser, then the venue's binding on the same BoC. */
async function armCheck(c: Case, o: {boc?: string; plan?: Swap2ExecutionPlan; r?: ReviewedSwap} = {}) {
  const body = captureTonBody();
  body.decodeTonBody(o.boc ?? bocOf(c));
  const plan = o.plan ?? planOf(c);
  const r = o.r ?? reviewedOf(c);
  return checkPlanBrowser(plan, r, venueRule("omniston"), undefined, body) ?? (await checkTonCallBinding(plan, r, body.boc()));
}

describe("checkPlanBrowser and the binding, as execute.ts arms a swap", () => {
  it("passes every recorded swap through a pinned DEX", async () => {
    for (const c of PINNED) expect(await armCheck(c), label(c)).toBeNull();
  });

  it("refuses an unpinned DEX, a tampered body, more TON than reviewed, a plain transfer, another pair", async () => {
    const cpmm = CASES.find((x) => x.protocols === "DeDustCPMMV2")!;
    expect(await armCheck(cpmm)).toMatch(/doesn't pin/);
    const v2 = of("StonFiV2", "ton")[0]!;
    expect(await armCheck(v2, {boc: v2Body(v2, {receiver: EVIL_ADDR})})).toMatch(/another recipient/);
    expect(await armCheck(v2, {boc: v2Body(v2, {refAddress: EVIL_ADDR})})).toMatch(/names a referral/);
    // More TON than the input and the 0.5 TON allowance: checkPlan refuses it first.
    expect(await armCheck(v2, {plan: planOf(v2, {value: BigInt(v2.amountIn) + TON_BODY_GAS + 1n})})).toMatch(/sends more than you reviewed/);
    // The whole input as a plain TON or USDT transfer to an address an API named: from TON the venue is paid by its call
    // only.
    expect(await armCheck(v2, {plan: planOf(v2, {cellBody: false, value: BigInt(v2.amountIn)})})).toMatch(/plain transfer this venue never makes/);
    const usdtIn = of("StonFiV1", "usdt")[0]!;
    expect(await armCheck(usdtIn, {plan: planOf(usdtIn, {}, {source: {kind: "token-transfer", token: USDT, recipient: STONFI_V1.router, amount: BigInt(usdtIn.amountIn)}})})).toMatch(
      /plain transfer this venue never makes/,
    );
    // Another token to receive, another jetton to pay: no call of the venue's reaches them.
    const usde = "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f";
    expect(await armCheck(v2, {plan: planOf(v2, {}, {destToken: usde}), r: reviewedOf(v2, {destToken: usde})})).toMatch(/for a token this venue's call isn't checked for/);
    expect(await armCheck(usdtIn, {r: reviewedOf(usdtIn, {fromContract: usde})})).toMatch(/networks or the token changed|paid in a jetton/);
  });
});

// ── on the TON Connect message ──────────────────────────────────────────────────────────────────────────────────────

describe("checkTonRequest on a swap: native-call for TON in, jetton-call for USDT in", () => {
  const req = (c: Case, msg: Partial<TonConnectRequest["messages"][number]> = {}): TonConnectRequest => ({
    validUntil: nowSec() + 300,
    network: "-239",
    from: raw(c.trader),
    messages: [{address: c.message.targetAddress, amount: c.message.sendAmount, payload: bocOf(c), ...msg}],
  });
  const expOf = (c: Case) =>
    tonIn(c)
      ? ({kind: "native-call", to: c.message.targetAddress, value: BigInt(c.message.sendAmount), bodyBoc: bocOf(c), call: callOf(c)} as const)
      : ({kind: "jetton-call", jettonWallet: raw(c.message.targetAddress), value: BigInt(c.message.sendAmount), bodyBoc: bocOf(c), call: callOf(c)} as const);
  const ctx = (c: Case) => ({self: raw(c.trader), now: Date.now()});

  it("passes exactly the armed swap; refuses another body, amount, target or validity", () => {
    for (const c of PINNED) {
      const exp = expOf(c);
      expect(checkTonRequest(req(c), exp, ctx(c)), label(c)).toBeNull();
      expect(checkTonRequest(req(c, {payload: rebuilt(c) === bocOf(c) ? b64(commentCell("x")) : rebuilt(c)}), exp, ctx(c)), label(c)).toMatch(/body isn't the reviewed one|can't be read/);
      expect(checkTonRequest(req(c, {amount: (BigInt(c.message.sendAmount) + 1n).toString()}), exp, ctx(c)), label(c)).toMatch(/another TON amount/);
      expect(checkTonRequest(req(c, {address: friendly(EVIL, true)}), exp, ctx(c)), label(c)).toMatch(tonIn(c) ? /another contract than the reviewed call's/ : /your own jetton wallet/);
      expect(checkTonRequest(req(c, {address: friendly(c.message.targetAddress)}), exp, ctx(c)), label(c)).toMatch(tonIn(c) ? /another contract|bounceable/ : /your own jetton wallet/);
      expect(checkTonRequest({...req(c), validUntil: nowSec() + 301}, exp, ctx(c)), label(c)).toMatch(/validity is out of range/);
      expect(checkTonRequest({...req(c), messages: [...req(c).messages, ...req(c).messages]}, exp, ctx(c)), label(c)).toMatch(/more than the one reviewed message/);
    }
    // Armed so, a body the app's decode refuses is read and refused here too: another recipient, through DeDust.
    const dd = of("DeDust", "ton")[0]!;
    const evil = dedustBody(dd, {recipient: EVIL_ADDR});
    expect(checkTonRequest(req(dd, {payload: evil}), {...expOf(dd), bodyBoc: evil}, ctx(dd))).toMatch(/another recipient/);
    // A TON-in swap's message never passes as a jetton call, nor a USDT-in swap's as a native one.
    const usdtIn = of("StonFiV2", "usdt")[0]!;
    expect(checkTonRequest(req(dd), {kind: "jetton-call", jettonWallet: raw(dd.message.targetAddress), value: BigInt(dd.message.sendAmount), bodyBoc: bocOf(dd), call: callOf(dd)}, ctx(dd))).not.toBeNull();
    expect(checkTonRequest(req(usdtIn), {kind: "native-call", to: usdtIn.message.targetAddress, value: BigInt(usdtIn.message.sendAmount), bodyBoc: bocOf(usdtIn), call: callOf(usdtIn)}, ctx(usdtIn))).not.toBeNull();
  });
});

// ── the TON account ─────────────────────────────────────────────────────────────────────────────────────────────────

/** TonAPI for the payer: its USDT wallet (the account's proof) and that wallet's state; nothing else is asked. */
const tonApi = (c: Case, balance = "100000000000") =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url);
    const jw = pinnedJettonWallet(TON_USDT, raw(c.trader));
    if (u.includes("/methods/get_wallet_address")) return Response.json({success: true, decoded: {jetton_wallet_address: jw}});
    if (u.includes("/methods/get_wallet_data")) return Response.json({success: true, decoded: {balance, owner: raw(c.trader), jetton: TON_USDT}});
    return new Response("", {status: 500});
  });

/** A TON Connect wallet for the case's trader that records every request and never broadcasts. */
function fakeWallet(c: Case) {
  const sent: TonConnectRequest[] = [];
  const self = raw(c.trader);
  const signed = b64(beginCell().store(storeMessage({info: {type: "external-in", dest: Address.parseRaw(self), importFee: 0n}, init: null, body: beginCell().storeUint(1, 32).endCell()})).endCell());
  const signer: TonSourceSigner = {
    family: "ton",
    address: friendly(c.trader),
    rawAddress: self,
    walletName: "Tonkeeper",
    tonApiUrl: "https://tonapi.invalid",
    sender: {
      account: {address: self, chain: "-239"},
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

describe("the TON account signs a swap's one message, bound again right before the wallet", () => {
  it("TON in: the write's own pinned target, the TON it attaches, the exact BoC — no jetton wallet asked", async () => {
    for (const c of [...of("StonFiV1", "ton"), ...of("StonFiV2", "ton"), ...of("DeDust", "ton")]) {
      const w = fakeWallet(c);
      const fetch = tonApi(c);
      const account = tonEngineAccount(w.signer, {fetch: fetch as unknown as typeof globalThis.fetch}, callOf(c));
      await expect(account.getJettonWalletAddress(USDT), label(c)).rejects.toThrow(/contract payload/);
      await expect(account.sendTransaction({to: c.message.targetAddress, value: BigInt(c.message.sendAmount), bodyBoc: bocOf(c)}), label(c)).resolves.toMatchObject({hash: expect.stringMatching(/^[0-9a-f]{64}$/)});
      expect(w.sent, label(c)).toHaveLength(1);
      expect(w.sent[0]!.messages).toEqual([{address: c.message.targetAddress, amount: c.message.sendAmount, payload: bocOf(c)}]);
      expect(fetch).not.toHaveBeenCalled();
      // Nothing else: another body, a plain TON or jetton deposit — refused before the wallet.
      await expect(account.sendTransaction({to: c.message.targetAddress, value: BigInt(c.message.sendAmount), bodyBoc: rebuiltWith(c, EVIL_ADDR)})).rejects.toThrow(/didn't match the reviewed route/);
      await expect(account.sendTransaction({to: c.message.targetAddress, value: BigInt(c.message.sendAmount)})).rejects.toThrow(/paid by its TON contract call only/);
      await expect(account.transfer({token: USDT, recipient: STONFI_V1.router, amount: 1n})).rejects.toThrow(/paid by its TON contract call only/);
      expect(w.sent).toHaveLength(1);
    }
  });

  it("USDT in: the payer's proven USDT jetton wallet, then the exact BoC; another target is refused", async () => {
    for (const c of [...of("StonFiV1", "usdt"), ...of("StonFiV2", "usdt"), ...of("DeDust", "usdt")]) {
      const w = fakeWallet(c);
      const account = tonEngineAccount(w.signer, {fetch: tonApi(c) as unknown as typeof globalThis.fetch}, callOf(c));
      expect(await account.getJettonWalletAddress(USDT), label(c)).toBe(raw(c.message.targetAddress));
      await expect(account.sendTransaction({to: c.message.targetAddress, value: BigInt(c.message.sendAmount), bodyBoc: bocOf(c)}), label(c)).resolves.toMatchObject({hash: expect.any(String)});
      expect(w.sent[0]!.messages).toEqual([{address: c.message.targetAddress, amount: c.message.sendAmount, payload: bocOf(c)}]);
      await expect(account.sendTransaction({to: friendly(EVIL, true), value: BigInt(c.message.sendAmount), bodyBoc: bocOf(c)})).rejects.toThrow(/your own jetton wallet/);
      expect(w.sent).toHaveLength(1);
    }
  });
});

/** The case's body with its recipient rewritten, in its own layout. */
function rebuiltWith(c: Case, recipient: Addr): string {
  if (c.protocols === "StonFiV1") return v1Body(c, {to: recipient});
  if (c.protocols === "StonFiV2") return v2Body(c, {receiver: recipient});
  return dedustBody(c, {recipient});
}

// ── the whole flow ──────────────────────────────────────────────────────────────────────────────────────────────────

const stream = <T>(events: readonly T[]) => ({
  subscribe(o: {next?: (v: T) => void; complete?: () => void}) {
    for (const e of events) o.next?.(e);
    o.complete?.();
    return {unsubscribe() {}};
  },
});
const randomHex = (n: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");

/**
 * Omniston's WebSocket API from a recording: a fresh quote (new id, the recording's terms) for every RFQ, the swap built
 * as recorded (`patch` rewrites the message). Every build request is recorded.
 */
function fakeOmniston(c: Case, patch: (m: {targetAddress: string; sendAmount: string; payload: string}) => void = () => undefined, quote: Record<string, unknown> = {}) {
  const builds: {quoteId: string; owner: string; dest: string; refund: string; excess: string}[] = [];
  const client: OmnistonClientLike = {
    requestForQuote: () => {
      const rfqId = randomHex(32);
      const q = {...c.quote, ...quote, rfqId, quoteId: randomHex(32), quoteTimestamp: nowSec()} as unknown as OmnistonQuote;
      return stream([{$case: "ack", value: {rfqId}}, {$case: "quoteUpdated", rfqId, value: q}]);
    },
    async tonBuildSwap(req) {
      builds.push({
        quoteId: req.quoteId,
        owner: req.transferSrcAddress.chain.value as string,
        dest: req.traderDstAddress.chain.value as string,
        refund: req.refundSrcAddress.chain.value as string,
        excess: req.gasExcessAddress.chain.value as string,
      });
      const m = {...c.message};
      patch(m);
      return {messages: [m]};
    },
    tonBuildEscrowTransfer: () => Promise.reject(new Error("not an escrow")),
    evmBuildOrderPayload: () => Promise.reject(new Error("not an EVM source")),
    orderRegisterSignedOrder: () => Promise.reject(new Error("not an EVM source")),
    orderTrack: () => stream([]),
    orderDiscloseHtlcSecret: () => Promise.reject(new Error("not an order")),
  };
  return {client, builds};
}

const tonToken = (c: Case): SwapToken => ({
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
  amount: c.amountIn,
  balance: "loaded",
  usd: 2,
  owner: friendly(c.trader),
  payMode: "wallet",
});
const usdtToken = (c: Case): SwapToken => ({...tonToken(c), key: `ton:${USDT.toLowerCase()}`, symbol: "USDT", catalogSymbol: "USDT", decimals: 6, contract: USDT, gasToken: false, usd: 1});

/** The page's Omniston as production builds it (lazyOmniston → buildOmniston over IndexedDB), on `api`'s client. */
async function rig(c: Case, patch?: Parameters<typeof fakeOmniston>[1], quote?: Record<string, unknown>) {
  const api = fakeOmniston(c, patch, quote);
  mocks.client = api.client;
  const provider = lazyOmniston(DEFAULT_RUNTIME_CONFIG, createProviderStores(), {});
  await lazyLoads([provider]);
  const w = fakeWallet(c);
  const router = new CrossChainRouter([provider]);
  const [from, to] = tonIn(c) ? [tonToken(c), usdtToken(c)] : [usdtToken(c), tonToken(c)];
  const run = () =>
    executeSwap({from, to, reviewed: reviewedOf(c), signer: w.signer}, {router: () => router, tonAccount: {fetch: tonApi(c) as unknown as typeof globalThis.fetch}});
  return {run, sent: w.sent, api};
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One recording per DEX and direction that carries its quote (the SDK's: the RFQ answer it was built for). */
const FLOW = ["StonFiV1", "StonFiV2", "DeDust"].flatMap((p) => (["ton", "usdt"] as const).map((src) => of(p, src).find((c) => c.quote))).filter((c): c is Case => !!c);

describe("executeSwap from a TON wallet through Omniston's swap: the real engine and provider, a recorded API", () => {
  it("sends ONE TON Connect message — the pinned DEX entry or the payer's USDT wallet, the TON attached, the exact recorded body", async () => {
    expect(FLOW.map((c) => `${c.protocols} ${tonIn(c) ? "ton" : "usdt"}`)).toEqual(["StonFiV1 ton", "StonFiV2 ton", "StonFiV2 usdt", "DeDust ton", "DeDust usdt"]);
    for (const c of FLOW) {
      const {run, sent, api} = await rig(c);
      const res = await run();
      expect(api.builds, label(c)).toHaveLength(1);
      // The build was asked for the review's addresses: the payer for the transfer, refund and excess; the recipient.
      const self = raw(c.trader);
      expect([raw(api.builds[0]!.owner), raw(api.builds[0]!.refund), raw(api.builds[0]!.excess), raw(api.builds[0]!.dest)]).toEqual([self, self, self, raw(c.dest)]);
      expect(sent, label(c)).toHaveLength(1);
      expect(sent[0]!.messages).toEqual([{address: c.message.targetAddress, amount: c.message.sendAmount, payload: bocOf(c)}]);
      expect(Address.parseFriendly(sent[0]!.messages[0]!.address).isBounceable).toBe(true);
      expect(sent[0]!.validUntil - nowSec()).toBeLessThanOrEqual(300);
      expect(res.id).toMatch(/^awk1\.omniston\./);
      expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("refuses builds its provider lets through (TonAPI answering yes) before the wallet is asked", async () => {
    const v1 = FLOW.find((c) => c.protocols === "StonFiV1")!;
    const v2 = FLOW.find((c) => c.protocols === "StonFiV2" && tonIn(c))!;
    const dd = FLOW.find((c) => c.protocols === "DeDust" && !tonIn(c))!;
    const cpmm = CASES.find((c) => c.protocols === "DeDustCPMMV2" && c.quote)!;
    const set = (boc: string) => (m: {payload: string}) => void (m.payload = Buffer.from(boc, "base64").toString("hex"));
    const cases: [Case, Parameters<typeof fakeOmniston>[1], RegExp, Record<string, unknown>?][] = [
      // DeDust CPMM v2's pool: the package's checks pass it (its code label), no pin names it.
      [cpmm, undefined, /doesn't pin/],
      // The swap asks the router for another wallet's output (the package's leg check, TonAPI's answer, says yes).
      [v1, set(v1Body(v1, {ask: EVIL_ADDR})), /asks the router for another token/],
      // A referral with no fee, a deadline a day away, a refund forward: the package reads and discards them.
      [v2, set(v2Body(v2, {refAddress: EVIL_ADDR})), /names a referral/],
      [v2, set(v2Body(v2, {deadline: BigInt(nowSec() + 86_400)})), /deadline is out of range/],
      [v2, set(v2Body(v2, {refundFwdGas: 1n})), /refund payload/],
      // DeDust: a payload handed to the recipient, which the package skips.
      [dd, set(dedustBody(dd, {fulfill: commentCell("x")})), /hands the recipient a payload/],
      // TON sent to another contract: the package's target check (TonAPI says yes) lets it through, no pin does.
      [v2, (m) => void (m.targetAddress = friendly(EVIL, true)), /doesn't pin/],
      // 0.6 TON of gas on top of the input, quoted so: inside the package's 2 TON cap, above the app's 0.5 TON (the
      // engine's ceiling).
      [v2, (m) => void (m.sendAmount = (BigInt(v2.amountIn) + 600_000_000n).toString()), /more than the 500000000 gas ceiling/, {gasBudget: "600000000"}],
    ];
    for (const [c, patch, why, quote] of cases) {
      const {run, sent} = await rig(c, patch, quote);
      const e = await run().catch((x: unknown) => x);
      expect((e as Error).message, `${label(c)} ${String(why)}`).toMatch(why);
      expect(swapErrorText(e, "TON")).not.toMatch(/may still/);
      // Refused by the review hook itself (nothing armed), or by the engine's TON gas ceiling (0.5 TON, execute.ts)
      // before it.
      expect(e instanceof SwapReviewMismatch || /gas ceiling/.test((e as Error).message), String(why)).toBe(true);
      expect(sent).toHaveLength(0);
    }
  });
});
