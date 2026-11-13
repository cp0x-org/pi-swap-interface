// Ported from cp0x-elysium apps/mobile/lib/swap/gas.test.ts @756b115 (import paths changed).
import {describe, expect, it} from "vitest";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import {usdValue} from "@anywalletkit/protocol-swap2-router/value";
import {APPROVE_GAS, CALL_GAS, gasCostUsd, gasPricer, NATIVE_TRANSFER_GAS, ROUTER_RANKING, routeGasUnits, TOKEN_TRANSFER_GAS} from "../../../src/swap/gas";

describe("routeGasUnits", () => {
  it("takes the quote's gas limit and adds an approval for a token source", () => {
    // Shapes from production dry quotes (USDT → USDC on Ethereum).
    const fynd = {txRequest: {gasLimit: "289489", approvalAddress: "0x1644", to: "0x1644"}};
    const uniswap = {txRequest: {gasLimit: "377659", approvalAddress: "0x68b3", to: "0x68b3"}};
    expect(routeGasUnits(fynd, true)).toBe(289_489n + APPROVE_GAS);
    expect(routeGasUnits(uniswap, true)).toBe(377_659n + APPROVE_GAS);
    expect(routeGasUnits(fynd, false)).toBe(289_489n);
  });

  it("prices a deposit-address route as a transfer, a limit-less call as a contract call", () => {
    expect(routeGasUnits({}, false)).toBe(NATIVE_TRANSFER_GAS);
    expect(routeGasUnits({}, true)).toBe(TOKEN_TRANSFER_GAS);
    expect(routeGasUnits({txRequest: {to: "0xrouter"}}, false)).toBe(CALL_GAS);
  });
});

describe("gas in USD", () => {
  it("multiplies units by gas price at the native price", () => {
    // 300k gas at 2 gwei, ETH $2,300 → $1.38
    expect(gasCostUsd(300_000n, 2_000_000_000n, 2300)).toBeCloseTo(1.38, 6);
  });

  it("counts 0 off EVM or when a price is missing, never null", () => {
    const q = {txRequest: {gasLimit: "300000"}};
    expect(gasPricer({evm: false, isToken: false}, 2_000_000_000n, 2300)(q)).toBe(0);
    expect(gasPricer({evm: true, isToken: false}, null, 2300)(q)).toBe(0);
    expect(gasPricer({evm: true, isToken: false}, 2_000_000_000n, undefined)(q)).toBe(0);
    expect(gasPricer({evm: true, isToken: false}, 2_000_000_000n, 2300)(q)).toBeCloseTo(1.38, 6);
  });
});

describe("the auction with gas and without the reliability hints (ROUTER_RANKING)", () => {
  // USDT → USDC on Ethereum, the case that put Uniswap over Fynd: Fynd guarantees more and burns less gas.
  const venue = (name: string, minDest: string, gasLimit: string, reliability: number): CrossChainProvider => ({
    name,
    supportsSameChain: true,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => ({
      provider: name,
      intentId: `${name}:1`,
      depositAddress: "",
      depositMemo: null,
      txRequest: {to: "0xrouter", data: "0x", value: "0", chainId: 1, gasLimit, approvalAddress: "0xrouter"},
      sourceAmount: "3000000",
      destAmount: minDest,
      minDestAmount: minDest,
      feeUsd: 0,
      etaSeconds: 15,
      reliability,
      validUntilMs: Date.now() + 60_000,
    }),
    buildDeposit: async () => {
      throw new Error("not built");
    },
    trackIntent: async () => ({state: "pending"}),
  });
  const params = {sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:1", destToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amountIn: "3000000", destAddress: "0xme", slippageBps: 30};
  const prices = {USDC: 1, USDT: 1, ETH: 2300};
  const best = async (gasWei: bigint | null) => {
    const gas = gasPricer({evm: true, isToken: true}, gasWei, prices.ETH);
    const router = new CrossChainRouter([venue("uniswap", "2987200", "377659", 0.98), venue("fynd", "2988000", "289489", 0.96)], {
      ...ROUTER_RANKING,
      valueUsd: usdValue(prices, {gasUsd: (q) => gas(q)}),
    });
    const set = await router.getQuotes(params);
    return set!.quotes.find((q) => q.tags.includes("best"))!.provider;
  };

  it("picks the better guarantee when gas is unknown — the reliability hint no longer decides", async () => {
    expect(await best(null)).toBe("fynd");
  });

  it("picks the route that is best after gas", async () => {
    expect(await best(1_000_000_000n)).toBe("fynd");
  });

  it("lets gas outweigh a better price on Ethereum", async () => {
    const router = (wei: bigint | null) =>
      new CrossChainRouter([venue("lifi", "2995000", "900000", 0.97), venue("fynd", "2988000", "289489", 0.96)], {
        ...ROUTER_RANKING,
        valueUsd: usdValue(prices, {gasUsd: (q) => gasPricer({evm: true, isToken: true}, wei, prices.ETH)(q)}),
      });
    const pick = async (wei: bigint | null) => (await router(wei).getQuotes(params))!.quotes.find((q) => q.tags.includes("best"))!.provider;
    expect(await pick(null)).toBe("lifi"); // +$0.007 on price
    expect(await pick(2_000_000_000n)).toBe("fynd"); // −$2.81 on gas at 2 gwei
  });
});
