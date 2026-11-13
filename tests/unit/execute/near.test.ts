/**
 * NEAR signing (D10, D11): the transaction a gated write becomes and the check it must pass, the injected wallet's
 * answer, the plan rule in checkPlanBrowser, and the real engine end to end over an in-process NEAR Intents-shaped
 * venue and a fake injected wallet that records every call. No network; nothing is ever sent.
 */
import {describe, expect, it, vi} from "vitest";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import type {CrossChainProvider, Quote, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {TOKEN_BY_KEY, bytesToBase58, bytesToBase64} from "../../../src/catalog";
import type {SwapToken} from "../../../src/contracts/domain";
import type {NearInjectedWallet, NearSourceSigner, ReviewedSwap} from "../../../src/contracts/execution";
import {gateAccount} from "../../../src/execute/accounts/gated";
import {
  checkNearTransaction,
  FT_TRANSFER_GAS,
  MAX_STORAGE_DEPOSIT,
  nearEngineAccount,
  nearTransactionFor,
  nearTxCost,
  sentHash,
  STORAGE_DEPOSIT_GAS,
  TGAS,
  type NearAction,
  type NearReads,
  type NearTx,
  type NearWrite,
} from "../../../src/execute/accounts/near";
import {signingWindow} from "../../../src/execute/accounts/solana";
import {swapErrorText, WALLET_DECLINED_TEXT} from "../../../src/execute/errors";
import {executeSwap} from "../../../src/execute/execute";
import {checkPlanBrowser, createSwapGate, planWrites, SwapGateRefusal, SwapReviewMismatch} from "../../../src/execute/gate";

const ME = "alice.near";
const DEPOSIT = "d".repeat(64);
const USDT = "usdt.tether-token.near";
const HASH = bytesToBase58(new Uint8Array(32).fill(7));
const ONE_NEAR = 10n ** 24n;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const EVM_ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const STORAGE_MIN = "1250000000000000000000";

type SendParams = Parameters<NearInjectedWallet["signAndSendTransaction"]>[0];

/** An action as the RPC reports it in a FinalExecutionOutcome (args base64 JSON, gas a number). */
const rpcAction = (a: NearAction) =>
  a.type === "Transfer"
    ? {Transfer: {deposit: a.params.deposit}}
    : {FunctionCall: {method_name: a.params.methodName, args: bytesToBase64(new TextEncoder().encode(JSON.stringify(a.params.args))), gas: Number(a.params.gas), deposit: a.params.deposit}};

/** What a wallet that did its job answers: the final outcome of exactly the transaction it was handed. */
const outcome = (p: SendParams) => ({
  status: {SuccessValue: ""},
  transaction: {signer_id: p.signerId, receiver_id: p.receiverId, actions: (p.actions as NearAction[]).map(rpcAction), hash: HASH},
  transaction_outcome: {id: HASH},
});

function fakeWallet(o: {accounts?: string[]; answer?: (p: SendParams) => unknown; throws?: unknown} = {}) {
  const calls: SendParams[] = [];
  const wallet: NearInjectedWallet = {
    manifest: {id: "hot-wallet", name: "HOT Wallet"},
    signIn: async () => [],
    signOut: async () => undefined,
    getAccounts: vi.fn(async () => (o.accounts ?? [ME]).map((accountId) => ({accountId}))),
    signAndSendTransaction: async (p) => {
      calls.push(p);
      if (o.throws !== undefined) throw o.throws;
      return o.answer ? o.answer(p) : outcome(p);
    },
  };
  return {wallet, calls};
}

function fakeReads(o: {registered?: unknown; bounds?: unknown; fail?: boolean; available?: bigint | null; accountFails?: boolean} = {}): NearReads {
  return {
    account: vi.fn(async () => {
      if (o.accountFails) throw new Error("rpc down");
      return o.available === null ? null : {available: o.available ?? 10n * ONE_NEAR};
    }),
    storageBalanceOf: vi.fn(async () => {
      if (o.fail) throw new Error("rpc down");
      return "registered" in o ? o.registered : {total: STORAGE_MIN, available: "0"};
    }),
    storageBalanceBounds: vi.fn(async () => ("bounds" in o ? o.bounds : {min: STORAGE_MIN, max: STORAGE_MIN})),
  };
}

const signerOf = (wallet: NearInjectedWallet): NearSourceSigner => ({family: "near", wallet, accountId: ME, rpcUrls: []});

const native: NearWrite = {kind: "native", to: DEPOSIT, amount: ONE_NEAR};
const token: NearWrite = {kind: "token", token: USDT, recipient: DEPOSIT, amount: 5_000_000n};
const ft = (args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({type: "FunctionCall", params: {methodName: "ft_transfer", args, gas: FT_TRANSFER_GAS.toString(), deposit: "1", ...over}}) as const;
const reg = (deposit = STORAGE_MIN, args: Record<string, unknown> = {account_id: DEPOSIT, registration_only: true}) =>
  ({type: "FunctionCall", params: {methodName: "storage_deposit", args, gas: STORAGE_DEPOSIT_GAS.toString(), deposit}}) as const;

describe("the transaction a NEAR write becomes", () => {
  it("native: one Transfer of the amount to the deposit address", async () => {
    const tx = await nearTransactionFor(native, fakeReads());
    expect(tx).toEqual({receiverId: DEPOSIT, actions: [{type: "Transfer", params: {deposit: ONE_NEAR.toString()}}]});
    expect(checkNearTransaction(tx, native)).toBeNull();
  });

  it("NEP-141 to a registered address: ft_transfer alone (1 yocto, 30 Tgas) on the token contract", async () => {
    const tx = await nearTransactionFor(token, fakeReads());
    expect(tx).toEqual({receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000000"})]});
    expect(checkNearTransaction(tx, token)).toBeNull();
  });

  it("NEP-141 to an unregistered address: storage_deposit for the token's minimum first", async () => {
    const reads = fakeReads({registered: null});
    const tx = await nearTransactionFor(token, reads);
    expect(tx.actions).toEqual([reg(), ft({receiver_id: DEPOSIT, amount: "5000000"})]);
    expect(reads.storageBalanceOf).toHaveBeenCalledWith(USDT, DEPOSIT);
    expect(checkNearTransaction(tx, token)).toBeNull();
    // A token that names no bounds gets the common minimum.
    expect((await nearTransactionFor(token, fakeReads({registered: null, bounds: null}))).actions[0]).toEqual(reg());
  });

  it("refuses a registration price above 0.0125 NEAR, a malformed one, and an unreadable registration", async () => {
    await expect(nearTransactionFor(token, fakeReads({registered: null, bounds: {min: (MAX_STORAGE_DEPOSIT + 1n).toString()}}))).rejects.toMatchObject({answered: true, message: /more than 0.0125 NEAR/});
    await expect(nearTransactionFor(token, fakeReads({registered: null, bounds: {min: "1e21"}}))).rejects.toMatchObject({answered: true});
    await expect(nearTransactionFor(token, fakeReads({fail: true}))).rejects.toMatchObject({answered: true, message: /Couldn't check/});
    await expect(nearTransactionFor(token, fakeReads({registered: "yes"}))).rejects.toMatchObject({answered: true});
  });

  it("checkNearTransaction refuses anything but the exact receiver, token, amount, memo and actions", () => {
    const good: NearTx = {receiverId: USDT, actions: [reg(), ft({receiver_id: DEPOSIT, amount: "5000000"})]};
    const bad: [string, NearTx, NearWrite][] = [
      ["another receiver", {receiverId: "evil.near", actions: [{type: "Transfer", params: {deposit: ONE_NEAR.toString()}}]}, native],
      ["another amount", {receiverId: DEPOSIT, actions: [{type: "Transfer", params: {deposit: "1"}}]}, native],
      ["two transfers", {receiverId: DEPOSIT, actions: [{type: "Transfer", params: {deposit: ONE_NEAR.toString()}}, {type: "Transfer", params: {deposit: "1"}}]}, native],
      ["another token", {...good, receiverId: "evil.near"}, token],
      ["another recipient", {receiverId: USDT, actions: [ft({receiver_id: "evil.near", amount: "5000000"})]}, token],
      ["another amount", {receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000001"})]}, token],
      ["a memo", {receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000000", memo: "x"})]}, token],
      ["ft_transfer_call", {receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000000"}, {methodName: "ft_transfer_call"})]}, token],
      ["more deposit", {receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000000"}, {deposit: "2"})]}, token],
      ["more gas", {receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000000"}, {gas: "300000000000000"})]}, token],
      ["registering another", {receiverId: USDT, actions: [reg(STORAGE_MIN, {account_id: "evil.near", registration_only: true}), good.actions[1]!]}, token],
      ["a costly registration", {receiverId: USDT, actions: [reg((MAX_STORAGE_DEPOSIT + 1n).toString()), good.actions[1]!]}, token],
      ["three actions", {receiverId: USDT, actions: [reg(), reg(), good.actions[1]!]}, token],
      ["a stray field", {...good, actions: [reg(), {...good.actions[1]!, extra: 1} as never]}, token],
    ];
    expect(checkNearTransaction(good, token)).toBeNull();
    for (const [what, tx, w] of bad) expect(checkNearTransaction(tx, w), what).not.toBeNull();
    // The reviewed memo, and only it, passes.
    expect(checkNearTransaction({receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000000", memo: "x"})]}, {...token, memo: "x"} as NearWrite)).toBeNull();
  });
});

describe("the wallet's answer", () => {
  const tx: NearTx = {receiverId: USDT, actions: [reg(), ft({receiver_id: DEPOSIT, amount: "5000000"})]};
  const p: SendParams = {network: "mainnet", signerId: ME, ...tx};
  /** The outcome with its reported transaction changed. */
  const reported = (t: Record<string, unknown>) => ({...outcome(p), transaction: {...outcome(p).transaction, ...t}});

  it("is the hash of exactly the built transaction, sent by the reviewed account", () => {
    expect(sentHash(outcome(p), ME, tx)).toBe(HASH);
    expect(sentHash({transactions: [outcome(p)]}, ME, tx)).toBe(HASH);
    // The same call with its args in another key order, or its gas as a string, is the same transaction.
    const [r, f] = outcome(p).transaction.actions as [unknown, {FunctionCall: Record<string, unknown>}];
    const reordered = {FunctionCall: {...f.FunctionCall, args: bytesToBase64(new TextEncoder().encode(JSON.stringify({amount: "5000000", receiver_id: DEPOSIT}))), gas: "30000000000000"}};
    expect(sentHash(reported({actions: [r, reordered]}), ME, tx)).toBe(HASH);
  });

  it("without a hash: maybe sent, never retried", () => {
    expect(() => sentHash(undefined, ME, tx)).toThrow(expect.objectContaining({maybeSent: true}));
    expect(() => sentHash({...reported({hash: "0xabc"}), transaction_outcome: undefined}, ME, tx)).toThrow(expect.objectContaining({maybeSent: true}));
  });

  it("an answer that doesn't show the signer, receiver and actions is unverified: maybe sent, tracked by its hash", () => {
    const unverified = [{transaction_outcome: {id: HASH}}, reported({signer_id: undefined}), reported({receiver_id: undefined}), reported({actions: undefined})];
    for (const a of unverified) expect(() => sentHash(a, ME, tx)).toThrow(expect.objectContaining({maybeSent: true, hash: HASH, message: expect.stringMatching(/didn't show what it sent/)}));
  });

  it("another signer, receiver, payee, amount, memo or action: maybe sent with the hash, flagged", () => {
    const other = (actions: NearAction[]) => outcome({...p, actions});
    const cases: [string, unknown][] = [
      ["another signer", outcome({...p, signerId: "bob.near"})],
      ["another receiver", outcome({...p, receiverId: "evil.near"})],
      ["another payee", other([reg(), ft({receiver_id: "other.near", amount: "5000000"})])],
      ["another amount", other([reg(), ft({receiver_id: DEPOSIT, amount: "5000001"})])],
      ["a memo", other([reg(), ft({receiver_id: DEPOSIT, amount: "5000000", memo: "x"})])],
      ["no registration", other([ft({receiver_id: DEPOSIT, amount: "5000000"})])],
      ["an extra action", other([...tx.actions, {type: "Transfer", params: {deposit: "1"}}])],
      ["an action it can't read", reported({actions: [{FunctionCall: {method_name: "ft_transfer", args: "not base64!", gas: 30e12, deposit: "1"}}]})],
      ["an action of another kind", reported({actions: [{Stake: {stake: "1", public_key: "ed25519:x"}}]})],
    ];
    for (const [what, a] of cases)
      expect(() => sentHash(a, ME, tx), what).toThrow(expect.objectContaining({maybeSent: true, hash: HASH, message: expect.stringMatching(/other than the reviewed one/)}));
  });

  it("a failed transaction moved nothing: answered", () => {
    const failed = {...outcome(p), status: {Failure: {ActionError: {kind: "FunctionCallError"}}}};
    expect(() => sentHash(failed, ME, tx)).toThrow(expect.objectContaining({answered: true, message: expect.stringMatching(/failed on chain/)}));
  });
});

describe("the NEAR engine account behind the gate", () => {
  const armed = (writes: Parameters<ReturnType<typeof createSwapGate>["arm"]>[0], o: Parameters<typeof fakeWallet>[0] = {}, reads = fakeReads()) => {
    const w = fakeWallet(o);
    const gate = createSwapGate("near:mainnet");
    const win = signingWindow();
    const raw = nearEngineAccount(signerOf(w.wallet), win, {reads});
    gate.arm(writes);
    return {account: gateAccount(raw, gate, win), raw, calls: w.calls, wallet: w.wallet};
  };

  it("sends exactly the armed native deposit, once", async () => {
    const {account, calls} = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR}]);
    await expect(account.sendTransaction({to: DEPOSIT, value: ONE_NEAR})).resolves.toEqual({hash: HASH});
    expect(calls).toEqual([{network: "mainnet", signerId: ME, receiverId: DEPOSIT, actions: [{type: "Transfer", params: {deposit: ONE_NEAR.toString()}}]}]);
    await expect(account.sendTransaction({to: DEPOSIT, value: ONE_NEAR})).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(calls).toHaveLength(1);
  });

  it("sends exactly the armed NEP-141 deposit, registering the address first", async () => {
    const {account, calls} = armed([{kind: "transfer", token: USDT, recipient: DEPOSIT, amount: 5_000_000n}], {}, fakeReads({registered: null}));
    await account.transfer({token: USDT, recipient: DEPOSIT, amount: 5_000_000n});
    expect(calls).toEqual([{network: "mainnet", signerId: ME, receiverId: USDT, actions: [reg(), ft({receiver_id: DEPOSIT, amount: "5000000"})]}]);
  });

  it("an unarmed or altered write never reaches the wallet", async () => {
    const {account, calls} = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR}]);
    await expect(account.sendTransaction({to: "evil.near", value: ONE_NEAR})).rejects.toBeInstanceOf(SwapGateRefusal);
    await expect(account.transfer({token: USDT, recipient: DEPOSIT, amount: 1n})).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(calls).toHaveLength(0);
  });

  it("a memo on a native transfer is refused, never dropped", async () => {
    const {account, calls} = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR, memo: "x"}]);
    await expect(account.sendTransaction({to: DEPOSIT, value: ONE_NEAR, memo: "x"} as never)).rejects.toMatchObject({answered: true, message: /field \(memo\)/});
    expect(calls).toHaveLength(0);
  });

  it("the raw account outside a gated write is refused (no signing window)", async () => {
    const {raw, calls} = armed([]);
    await expect(raw.sendTransaction({to: DEPOSIT, value: ONE_NEAR})).rejects.toMatchObject({answered: true, message: /outside a reviewed transaction/});
    expect(calls).toHaveLength(0);
  });

  it("refuses when the wallet no longer lists the reviewed account", async () => {
    const {account, calls} = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR}], {accounts: ["bob.near"]});
    await expect(account.sendTransaction({to: DEPOSIT, value: ONE_NEAR})).rejects.toMatchObject({answered: true, message: /switched accounts/});
    expect(calls).toHaveLength(0);
  });

  it("a rejection in the wallet is answered; any other wallet error may have been sent", async () => {
    const no = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR}], {throws: new Error("User rejected the request")});
    const e = await no.account.sendTransaction({to: DEPOSIT, value: ONE_NEAR}).catch((x: unknown) => x);
    expect(e).toMatchObject({answered: true});
    expect(swapErrorText(e, "NEAR")).toBe(WALLET_DECLINED_TEXT);
    const lost = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR}], {throws: new Error("RPC timeout")});
    await expect(lost.account.sendTransaction({to: DEPOSIT, value: ONE_NEAR})).rejects.toMatchObject({maybeSent: true});
  });

  it("a wallet that sent something else is caught in its answer", async () => {
    const {account} = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR}], {answer: (p) => outcome({...p, receiverId: "evil.near"})});
    await expect(account.sendTransaction({to: DEPOSIT, value: ONE_NEAR})).rejects.toMatchObject({maybeSent: true, hash: HASH});
    const payee = armed([{kind: "transfer", token: USDT, recipient: DEPOSIT, amount: 5_000_000n}], {answer: (p) => outcome({...p, actions: [ft({receiver_id: "other.near", amount: "5000000"})]})});
    await expect(payee.account.transfer({token: USDT, recipient: DEPOSIT, amount: 5_000_000n})).rejects.toMatchObject({maybeSent: true, hash: HASH});
  });

  it("what a transaction can cost: its deposits, plus its gas and 5 Tgas of fees at 2.5× the floor price", async () => {
    const fee = (tgas: bigint) => tgas * TGAS * 250_000_000n;
    expect(nearTxCost(await nearTransactionFor(native, fakeReads()))).toBe(ONE_NEAR + fee(5n));
    expect(nearTxCost(await nearTransactionFor(token, fakeReads()))).toBe(1n + fee(35n));
    expect(nearTxCost(await nearTransactionFor(token, fakeReads({registered: null})))).toBe(BigInt(STORAGE_MIN) + 1n + fee(45n));
  });

  it("an account that can't pay the deposits and the fee is refused before the wallet (nothing sent, not 'maybe sent')", async () => {
    const write = {kind: "transfer", token: USDT, recipient: DEPOSIT, amount: 5_000_000n} as const;
    const send = {token: USDT, recipient: DEPOSIT, amount: 5_000_000n};
    const cost = BigInt(STORAGE_MIN) + 1n + 45n * TGAS * 250_000_000n;
    for (const reads of [fakeReads({registered: null, available: cost - 1n}), fakeReads({registered: null, available: null})]) {
      const {account, calls} = armed([write], {}, reads);
      const e = await account.transfer(send).catch((x: unknown) => x);
      expect(e).toMatchObject({answered: true});
      expect(swapErrorText(e, "NEAR")).toBe("Not enough NEAR to pay the network fees — nothing was sent.");
      expect(calls).toHaveLength(0);
    }
    const unread = armed([write], {}, fakeReads({accountFails: true}));
    await expect(unread.account.transfer(send)).rejects.toMatchObject({answered: true, message: /Couldn't read your NEAR balance/});
    expect(unread.calls).toHaveLength(0);
    // A native amount equal to all it holds can't pay the fee either.
    const all = armed([{kind: "call", to: DEPOSIT, value: ONE_NEAR}], {}, fakeReads({available: ONE_NEAR}));
    await expect(all.account.sendTransaction({to: DEPOSIT, value: ONE_NEAR})).rejects.toMatchObject({answered: true});
    expect(all.calls).toHaveLength(0);
    // Exactly enough passes.
    const enough = armed([write], {}, fakeReads({registered: null, available: cost}));
    await expect(enough.account.transfer(send)).resolves.toEqual({hash: HASH});
  });
});

const plan = (over: Partial<Swap2ExecutionPlan> = {}): Swap2ExecutionPlan => ({
  provider: "near_intents",
  fromChain: "near:mainnet",
  destChain: "eip155:8453",
  destToken: USDC_BASE,
  recipient: EVM_ME,
  refundAddress: ME,
  sourceAmount: 5_000_000n,
  destAmount: 4_990_000n,
  minDestAmount: 4_960_000n,
  feeUsd: 0,
  etaSeconds: 60,
  validUntilMs: Date.now() + 60_000,
  approvals: [],
  source: {kind: "token-transfer", token: USDT, recipient: DEPOSIT, amount: 5_000_000n},
  ...over,
});

const reviewedUsdt: ReviewedSwap = {
  provider: "near_intents",
  fromChain: "near:mainnet",
  fromContract: USDT,
  amountIn: 5_000_000n,
  destChain: "eip155:8453",
  destToken: USDC_BASE,
  recipient: EVM_ME,
  refundAddress: ME,
  minOut: 4_950_000n,
  slippageBps: 50,
  approvalSpender: null,
  nativeFee: 0n,
};

describe("checkPlanBrowser on NEAR", () => {
  const deposit = {kind: "deposit"} as const;

  it("passes NEAR Intents' token or NEAR deposit and arms exactly it", () => {
    expect(checkPlanBrowser(plan(), reviewedUsdt, deposit)).toBeNull();
    expect(planWrites(plan()).writes).toEqual([{kind: "transfer", token: USDT, recipient: DEPOSIT, amount: 5_000_000n}]);
    const nat = plan({sourceAmount: ONE_NEAR, source: {kind: "call", to: DEPOSIT, value: ONE_NEAR}});
    expect(checkPlanBrowser(nat, {...reviewedUsdt, fromContract: null, amountIn: ONE_NEAR}, deposit)).toBeNull();
    expect(planWrites(nat).writes).toEqual([{kind: "call", to: DEPOSIT, value: ONE_NEAR}]);
  });

  it("refuses a venue without a deposit rule, memos, approvals, another amount, and paying the refund account", () => {
    const natReview = {...reviewedUsdt, fromContract: null, amountIn: ONE_NEAR};
    const cases: [Swap2ExecutionPlan, ReviewedSwap, RegExp][] = [
      [plan(), reviewedUsdt, /no deposit rule/],
      [plan({source: {kind: "token-transfer", token: USDT, recipient: DEPOSIT, amount: 5_000_000n, memo: "m"}}), reviewedUsdt, /memo/],
      [plan({sourceAmount: ONE_NEAR, source: {kind: "call", to: DEPOSIT, value: ONE_NEAR, memo: "m"}}), natReview, /memo/],
      [plan({approvals: [{token: USDT, spender: DEPOSIT, amount: 5_000_000n}]}), reviewedUsdt, /approval/],
      [plan({sourceAmount: ONE_NEAR, source: {kind: "call", to: DEPOSIT, value: ONE_NEAR - 1n}}), natReview, /reviewed token or amount/],
      [plan({source: {kind: "token-transfer", token: USDT, recipient: ME, amount: 5_000_000n}}), reviewedUsdt, /your own account/],
      [plan({source: {kind: "token-transfer", token: "evil.near", recipient: DEPOSIT, amount: 5_000_000n}}), reviewedUsdt, /reviewed token or amount/],
      [plan({source: {kind: "call", to: DEPOSIT, data: "0x00", value: 0n}}), reviewedUsdt, /calldata/],
    ];
    cases.forEach(([p, r, why], i) => expect(checkPlanBrowser(p, r, i === 0 ? undefined : deposit), String(why)).toMatch(why));
  });
});

// ── the real engine, end to end ─────────────────────────────────────────────────────────────────────────────────

const swapToken = (key: string, over: Partial<SwapToken> = {}): SwapToken => ({
  ...TOKEN_BY_KEY.get(key)!,
  amount: "0",
  balance: "loaded",
  usd: 0,
  owner: null,
  payMode: "wallet",
  ...over,
});
const NEAR = swapToken("near:native", {owner: ME});
const USDT_NEAR = swapToken(`near:${USDT}`, {owner: ME});
const USDC = swapToken(`base:${USDC_BASE.toLowerCase()}`, {owner: EVM_ME});

/** An in-process NEAR Intents-shaped venue: a per-quote deposit address, no transaction of its own. */
function nearVenue(over: Partial<Quote> = {}, name = "near_intents"): CrossChainProvider {
  return {
    name,
    supportsSameChain: false,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async (p) => ({
      provider: name,
      intentId: `near1click:${DEPOSIT}|`,
      depositAddress: DEPOSIT,
      depositMemo: null,
      sourceAmount: p.amountIn,
      destAmount: "4990000",
      minDestAmount: "4980000",
      feeUsd: 0.01,
      etaSeconds: 60,
      reliability: 0.95,
      validUntilMs: Date.now() + 60_000,
      ...over,
    }),
    buildDeposit: async (q: Quote): Promise<UnsignedTx> => ({chain: "", to: q.depositAddress, value: q.sourceAmount, ...(q.depositMemo ? {memo: q.depositMemo} : {})}),
    trackIntent: async () => ({state: "pending" as const}),
  } as CrossChainProvider;
}

function rig(provider: CrossChainProvider, o: {from?: SwapToken; r?: ReviewedSwap; wallet?: ReturnType<typeof fakeWallet>; reads?: NearReads} = {}) {
  const w = o.wallet ?? fakeWallet();
  const router = new CrossChainRouter([provider]);
  const run = () =>
    executeSwap({from: o.from ?? USDT_NEAR, to: USDC, reviewed: o.r ?? reviewedUsdt, signer: signerOf(w.wallet)}, {router: () => router, nearReads: () => o.reads ?? fakeReads()});
  return {run, calls: w.calls};
}

describe("executeSwap from NEAR (real engine, fake injected wallet)", () => {
  it("pays the NEP-141 deposit with one ft_transfer and returns its hash", async () => {
    const {run, calls} = rig(nearVenue());
    const res = await run();
    expect(res).toMatchObject({hash: HASH, depositTo: DEPOSIT});
    expect(res.id).toMatch(/^awk1\.near_intents\./);
    expect(calls).toEqual([{network: "mainnet", signerId: ME, receiverId: USDT, actions: [ft({receiver_id: DEPOSIT, amount: "5000000"})]}]);
  });

  it("pays a NEAR deposit with one Transfer", async () => {
    const {run, calls} = rig(nearVenue(), {from: NEAR, r: {...reviewedUsdt, fromContract: null, amountIn: ONE_NEAR}});
    await run();
    expect(calls).toEqual([{network: "mainnet", signerId: ME, receiverId: DEPOSIT, actions: [{type: "Transfer", params: {deposit: ONE_NEAR.toString()}}]}]);
  });

  it("refuses a memo'd quote, a venue with no deposit rule and a deposit to the payer — the wallet is never called", async () => {
    for (const [provider, why] of [
      [nearVenue({depositMemo: "42"}), /memo/],
      [nearVenue({}, "relay"), /no deposit rule|moved to/],
      [nearVenue({depositAddress: ME, intentId: `near1click:${ME}|`}), /your own account/],
    ] as const) {
      const {run, calls} = rig(provider, provider.name === "relay" ? {r: {...reviewedUsdt, provider: "relay"}} : {});
      const e = await run().catch((x: unknown) => x);
      expect(e, String(why)).toBeInstanceOf(SwapReviewMismatch);
      expect((e as Error).message).toMatch(why);
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses a signer that isn't the reviewed account, and a wallet that switched accounts", async () => {
    const other = rig(nearVenue(), {r: {...reviewedUsdt, refundAddress: "bob.near"}});
    await expect(other.run()).rejects.toThrow(/isn't the reviewed one/);
    expect(other.calls).toHaveLength(0);
    const switched = rig(nearVenue(), {wallet: fakeWallet({accounts: ["bob.near"]})});
    await expect(switched.run()).rejects.toThrow(/switched accounts/);
    expect(switched.calls).toHaveLength(0);
  });
});
