// QR deposits (D20) and CCTP claims (engine.md §8.3) against in-process venues; records land in fake IndexedDB.
import "fake-indexeddb/auto";
import {describe, expect, it} from "vitest";
import type {WalletClient} from "viem";
import {base, mainnet} from "viem/chains";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import type {CrossChainProvider, Quote, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import type {SwapToken} from "../../../src/contracts/domain";
import type {EvmSourceSigner} from "../../../src/contracts/execution";
import type {QuoteRequest} from "../../../src/contracts/routes";
import {getSwaps} from "../../../src/activity";
import {issueDeposit} from "../../../src/execute/deposit";
import {claimSwap, previewClaim} from "../../../src/execute/claim";
import {SwapGateRefusal, SwapReviewMismatch} from "../../../src/execute/gate";
import {encodeSwapId} from "../../../src/execute/ids";

const BTC_REFUND = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const BTC_DEPOSIT = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
const ME = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

const btc: SwapToken = {
  key: "bitcoin:native",
  chain: "bitcoin",
  caip2: "bitcoin:mainnet",
  chainName: "Bitcoin",
  family: "btc",
  symbol: "BTC",
  catalogSymbol: "BTC",
  decimals: 8,
  contract: null,
  gasToken: true,
  amount: "0",
  balance: "none",
  usd: 0,
  owner: null,
  payMode: "deposit",
};
const eth: SwapToken = {...btc, key: "ethereum:native", chain: "ethereum", caip2: "eip155:1", chainName: "Ethereum", family: "evm", symbol: "ETH", catalogSymbol: "ETH", decimals: 18, owner: ME, payMode: "wallet"};

const req: QuoteRequest = {from: btc, to: eth, amountIn: 1_000_000n, slippageBps: 50, recipient: ME, refundAddress: BTC_REFUND};

function nearVenue(over: Partial<Quote> = {}): CrossChainProvider & {params: unknown[]} {
  const params: unknown[] = [];
  return {
    name: "near_intents",
    supportsSameChain: false,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async (p) => {
      params.push(p);
      return {
        provider: "near_intents",
        intentId: "dep-intent",
        depositAddress: BTC_DEPOSIT,
        depositMemo: null,
        sourceAmount: p.amountIn,
        destAmount: "300000000000000000",
        minDestAmount: "298600000000000000",
        feeUsd: 1,
        etaSeconds: 600,
        reliability: 0.95,
        validUntilMs: Date.now() + 55_000,
        ...over,
      };
    },
    buildDeposit: async (q: Quote): Promise<UnsignedTx> => ({chain: "", to: q.depositAddress, value: q.sourceAmount}),
    trackIntent: async () => ({state: "pending"}),
    params,
  };
}

const MIN = 297_000_000_000_000_000n;

describe("issueDeposit", () => {
  it("asks a live quote held to the review, then saves a deposit record before returning the address", async () => {
    const v = nearVenue();
    const t = await issueDeposit({req, provider: "near_intents", minOut: MIN}, {router: () => new CrossChainRouter([v])});
    expect(v.params[0]).toMatchObject({dry: false, minAmountOut: MIN.toString(), refundAddress: BTC_REFUND, destAddress: ME, amountIn: "1000000"});
    expect(t).toMatchObject({id: encodeSwapId("near_intents", "dep-intent"), depositAddress: BTC_DEPOSIT, depositMemo: null, sourceAmount: 1_000_000n, minDestAmount: 298_600_000_000_000_000n});
    const r = getSwaps().find((x) => x.id === t.id);
    expect(r).toMatchObject({mode: "deposit", status: "pending", accountId: `deposit:${BTC_REFUND}`, deposit: {address: BTC_DEPOSIT, memo: null, amount: "1000000"}});
  });

  it("refuses a route that needs a signature, a memo, a foreign address or a short minimum", async () => {
    const issue = (over: Partial<Quote>, minOut = MIN) => issueDeposit({req, provider: "near_intents", minOut}, {router: () => new CrossChainRouter([nearVenue(over)])});
    await expect(issue({txRequest: {to: ME, data: "0x01", value: "0"}})).rejects.toBeInstanceOf(SwapReviewMismatch);
    await expect(issue({depositMemo: "=:ETH.ETH:0x"})).rejects.toThrow(/memo/);
    await expect(issue({depositAddress: ME})).rejects.toThrow(/isn't a Bitcoin address/);
    await expect(issue({depositAddress: BTC_REFUND})).rejects.toThrow(/your own refund address/);
    await expect(issue({}, 299_000_000_000_000_000n)).rejects.toThrow(/no route available/); // the router holds the floor too
  });

  it("still issues one for a Tron payer (the QR stays the fallback while no Tron wallet is connected)", async () => {
    const TRON_REFUND = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi";
    const TRON_DEPOSIT = "TEcDijvKSXcfWT7S6rd44H5vNgufm7Y4XC";
    const usdt: SwapToken = {...btc, key: "tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t", chain: "tron", caip2: "tron:728126428", chainName: "Tron", family: "tron", symbol: "USDT", catalogSymbol: "USDT", decimals: 6, contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"};
    const v = nearVenue({depositAddress: TRON_DEPOSIT});
    const t = await issueDeposit({req: {...req, from: usdt, refundAddress: TRON_REFUND}, provider: "near_intents", minOut: MIN}, {router: () => new CrossChainRouter([v])});
    expect(t.depositAddress).toBe(TRON_DEPOSIT);
  });

  it("gives a TON payer without a connected wallet a deposit address (the QR fallback)", async () => {
    const TON_REFUND = "UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt";
    const TON_DEPOSIT = "UQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq5jh";
    const ton: SwapToken = {...btc, key: "ton:native", chain: "ton", caip2: "ton:-239", chainName: "TON", family: "ton", symbol: "TON", catalogSymbol: "GRAM", decimals: 9};
    const v = nearVenue({depositAddress: TON_DEPOSIT});
    const t = await issueDeposit({req: {...req, from: ton, amountIn: 5_000_000_000n, refundAddress: TON_REFUND}, provider: "near_intents", minOut: MIN}, {router: () => new CrossChainRouter([v])});
    expect(t.depositAddress).toBe(TON_DEPOSIT);
  });

  it("refuses wallet payers, bad refund or recipient addresses — no venue is asked", async () => {
    const v = nearVenue();
    const router = () => new CrossChainRouter([v]);
    await expect(issueDeposit({req: {...req, from: eth, refundAddress: ME}, provider: "near_intents", minOut: MIN}, {router})).rejects.toThrow(/Pay from your/);
    await expect(issueDeposit({req: {...req, refundAddress: "bc1qnotanaddress"}, provider: "near_intents", minOut: MIN}, {router})).rejects.toThrow(/refund address/);
    await expect(issueDeposit({req: {...req, recipient: "0x123"}, provider: "near_intents", minOut: MIN}, {router})).rejects.toThrow(/address to receive/);
    expect(v.params).toHaveLength(0);
  });

  it("still gives NEAR a deposit address: a NEAR wallet is optional", async () => {
    const near: SwapToken = {...btc, key: "near:native", chain: "near", caip2: "near:mainnet", chainName: "NEAR", family: "near", symbol: "NEAR", catalogSymbol: "NEAR", decimals: 24};
    const deposit = "d".repeat(64);
    const v = nearVenue({depositAddress: deposit});
    const t = await issueDeposit({req: {...req, from: near, refundAddress: "alice.near"}, provider: "near_intents", minOut: MIN}, {router: () => new CrossChainRouter([v])});
    expect(t.depositAddress).toBe(deposit);
    expect(v.params[0]).toMatchObject({sourceChain: "near:mainnet", refundAddress: "alice.near"});
  });
});

const MESSENGER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const CLAIM_DATA = "0x57ecfd28" + "00".repeat(64);

function cctpVenue(build: () => UnsignedTx | null): CrossChainProvider {
  return {
    name: "cctp",
    supportsSameChain: false,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => null,
    buildDeposit: async () => ({chain: "", to: "", value: "0"}),
    trackIntent: async () => ({state: "action-required", claim: {chain: "eip155:8453", ready: true}}),
    buildClaim: async () => build(),
    claimTargets: () => [MESSENGER],
  };
}

function evmSigner(chain: EvmSourceSigner["chain"] = base) {
  const calls: unknown[] = [];
  const wallet = {
    getAddresses: async () => [ME],
    getChainId: async () => chain.id,
    sendTransaction: async (args: unknown) => {
      calls.push(args);
      return `0x${"c".repeat(64)}`;
    },
  } as unknown as WalletClient;
  const pub = {
    getCode: async () => undefined,
    getBlockNumber: async () => 10n,
    waitForTransactionReceipt: async () => ({status: "success", blockNumber: 1n}),
  } as unknown as EvmSourceSigner["pub"];
  const signer: EvmSourceSigner = {family: "evm", wallet, pub, chain, rpcUrls: [], owner: ME, transport: "injected"};
  const reads = {
    getBalance: async () => 10n ** 18n,
    getAllowance: async () => 0n,
    getTokenInfo: async () => ({decimals: 6}) as never,
    quoteSendTransaction: async () => ({fee: 1n}),
    simulateTransaction: async () => ({ok: true as const, gas: 1n, returnData: "0x" as const}),
  };
  return {signer, calls, reads};
}

describe("claims", () => {
  const ID = encodeSwapId("cctp", "intent-1", "0xsrc");
  const claimTx = (): UnsignedTx => ({chain: "eip155:8453", to: MESSENGER, data: CLAIM_DATA, value: "0", chainId: 8453});

  it("previews read-only, then sends exactly the previewed claim", async () => {
    const router = new CrossChainRouter([cctpVenue(claimTx)]);
    expect(await previewClaim(ID, {router: () => router})).toEqual({chain: "eip155:8453", to: MESSENGER, data: CLAIM_DATA, value: 0n});
    const {signer, calls, reads} = evmSigner();
    const res = await claimSwap(ID, signer, {router: () => router, evmReads: () => reads});
    expect(res).toMatchObject({chain: "eip155:8453", hash: `0x${"c".repeat(64)}`});
    expect(res.id).toBe(`${ID}.0x${"c".repeat(64)}.ok`);
    expect(calls).toEqual([expect.objectContaining({to: MESSENGER, data: CLAIM_DATA, value: 0n})]);
  });

  it("a claim the venue rebuilds differently is refused by the gate — the wallet is never called", async () => {
    let n = 0;
    const router = new CrossChainRouter([cctpVenue(() => ({...claimTx(), data: n++ === 0 ? CLAIM_DATA : `0x57ecfd28${"11".repeat(64)}`}))]);
    const {signer, calls, reads} = evmSigner();
    await expect(claimSwap(ID, signer, {router: () => router, evmReads: () => reads})).rejects.toBeInstanceOf(SwapGateRefusal);
    expect(calls).toHaveLength(0);
  });

  it("refuses a pending attestation, another chain, or a non-EVM signer", async () => {
    const pending = new CrossChainRouter([cctpVenue(() => null)]);
    expect(await previewClaim(ID, {router: () => pending})).toBeNull();
    const {signer, calls, reads} = evmSigner(mainnet);
    await expect(claimSwap(ID, signer, {router: () => pending, evmReads: () => reads})).rejects.toThrow(/isn't ready/);
    const ready = new CrossChainRouter([cctpVenue(claimTx)]);
    await expect(claimSwap(ID, signer, {router: () => ready, evmReads: () => reads})).rejects.toThrow(/Switch your wallet to Base/);
    await expect(claimSwap(ID, {family: "solana"} as never, {router: () => ready})).rejects.toThrow(/Connect an EVM wallet/);
    expect(calls).toHaveLength(0);
  });
});
