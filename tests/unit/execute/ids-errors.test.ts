// Swap ids against the engine's own, and swapErrorText's order (mobile errors.test.ts + D25's web texts).
import {describe, expect, it} from "vitest";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";
import {
  Swap2InFlightError,
  Swap2InsufficientGasError,
  Swap2MaybeSentError,
  Swap2QuoteError,
  Swap2ValidationError,
} from "@anywalletkit/protocol-swap2-core/errors";
import type {CrossChainProvider, IntentRef} from "@anywalletkit/protocol-swap2-core/types";
import {answered, isWalletRejection, maybeSent, swapErrorText, swapFailureExpected, WALLET_DECLINED_TEXT} from "../../../src/execute/errors";
import {SwapGateRefusal, SwapReviewMismatch} from "../../../src/execute/gate";
import {decodeSwapId, encodeSwapId} from "../../../src/execute/ids";

describe("swap ids", () => {
  it("round-trips, dots and colons in the intent included", () => {
    const id = encodeSwapId("lifi", "lifi:8453.1", "0xabc");
    expect(id).toBe("awk1.lifi.lifi%3A8453%2E1.0xabc");
    expect(decodeSwapId(id)).toEqual({provider: "lifi", intentId: "lifi:8453.1", sourceTxHash: "0xabc"});
    expect(encodeSwapId("near_intents", "q1")).toBe("awk1.near_intents.q1");
    expect(decodeSwapId("awk1.near_intents.q1")).toEqual({provider: "near_intents", intentId: "q1"});
    expect(encodeSwapId("cctp", "i", "0xs", "0xd", true)).toBe("awk1.cctp.i.0xs.0xd.ok");
  });
  it("rejects what isn't a swap id", () => {
    expect(decodeSwapId("local.123")).toBeNull();
    expect(decodeSwapId("awk1.lifi")).toBeNull();
    expect(decodeSwapId("awk1.lifi.%E0%A4%A")).toBeNull();
  });
  it("the engine reads our ids exactly as its own", async () => {
    const seen: IntentRef[] = [];
    const p: CrossChainProvider = {
      name: "lifi",
      supportsSameChain: true,
      enabled: () => true,
      supportsRoute: () => true,
      getQuote: async () => null,
      buildDeposit: async () => ({chain: "", to: "", value: "0"}),
      trackIntent: async (ref) => {
        seen.push(ref);
        return {state: "completed", destTxHash: "0xd"};
      },
    };
    const protocol = new RouterSwap2Protocol(undefined, {fromChain: "eip155:8453", router: new CrossChainRouter([p])});
    const res = await protocol.getSwap2Status(encodeSwapId("lifi", "a.b:c", "0xsrc"));
    expect(seen[0]).toEqual({intentId: "a.b:c", sourceTxHash: "0xsrc"});
    expect(res).toMatchObject({status: "completed"});
  });
});

describe("swapErrorText (D25 order)", () => {
  const MAYBE = "The network didn't confirm it got the transaction — it may still go through. Check Activity before trying again.";
  it("mismatch, gate refusal, rejection", () => {
    expect(swapErrorText(new SwapReviewMismatch("the recipient changed"), "ETH")).toBe(
      "The live route isn't the one you reviewed (the recipient changed) — nothing was signed. Review it again.",
    );
    expect(swapErrorText(new SwapGateRefusal(), "ETH")).toBe("A transaction didn't match the reviewed route — it was refused before signing.");
    expect(swapErrorText(Object.assign(new Error("User rejected the request."), {code: 4001}), "ETH")).toBe(WALLET_DECLINED_TEXT);
    expect(swapErrorText(new Error("wrapped", {cause: {name: "UserRejectedRequestError", message: "x"}}), "ETH")).toBe(WALLET_DECLINED_TEXT);
    expect(WALLET_DECLINED_TEXT).toBe("You declined in your wallet — nothing was sent.");
  });
  it("a fee cap refusal comes before anything else but the mismatch", () => {
    expect(swapErrorText(Object.assign(new Error("Exceeded maximum fee cost"), {code: "fee-limit-exceeded"}), "SOL")).toMatch(/fee rose above the cap/);
  });
  it("maybe sent: source leg and claim", () => {
    expect(swapErrorText(new Swap2MaybeSentError("swap2: the source transaction may have been broadcast", "0xh", "awk1.lifi.i.0xh"), "ETH")).toBe(MAYBE);
    expect(swapErrorText(Object.assign(new Error("upstream request timeout"), {maybeSent: true, hash: "0xc"}), "ETH")).toBe(MAYBE);
  });
  it("gas, in flight, floor, no route, expired, raw", () => {
    expect(swapErrorText(new Swap2InsufficientGasError("swap2: native balance 0 cannot pay"), "ETH")).toBe("Not enough ETH to pay the network fees — nothing was sent.");
    expect(swapErrorText(new Swap2InFlightError("swap2: in progress"), "ETH")).toBe("This swap is already running — wait for its result.");
    expect(swapErrorText(new Swap2QuoteError("swap2: no route available for the requested pair :: lifi: floor breach (min=1 < floor=2)"), "ETH")).toMatch(/price moved below your minimum/);
    expect(swapErrorText(new Swap2QuoteError("swap2: no route available for the requested pair :: lifi: returned no quote"), "ETH")).toBe(
      "The route is no longer available (lifi: returned no quote). Refresh and pick a route again.",
    );
    expect(swapErrorText(new Error("swap2: quote expired"), "ETH")).toBe("The quote expired before signing — nothing was swapped. Review it again.");
    expect(swapErrorText(new Swap2ValidationError("swap2: quote calldata pulls the source token with transferFrom — refused"), "ETH")).toMatch(/^This route was refused for safety \(quote calldata pulls/);
    expect(swapErrorText(new Error("swap2: account is bound to 1, but fromChain is eip155:8453"), "ETH")).toMatch(/wallet is on another network/);
    expect(swapErrorText(new Error("swap: something odd\nstack"), "ETH")).toBe("something odd");
  });
  it("no Face ID anywhere", () => {
    for (const e of [new SwapGateRefusal(), new Error("x"), Object.assign(new Error("denied"), {code: 4001})]) expect(swapErrorText(e, "ETH")).not.toMatch(/Face ID/);
  });
});

describe("flags", () => {
  it("maybeSent reads only the engine's Swap2MaybeSentError", () => {
    expect(maybeSent(new Swap2MaybeSentError("m", "0xh", "awk1.x.y.0xh"))).toEqual({hash: "0xh", id: "awk1.x.y.0xh"});
    expect(maybeSent(new Swap2MaybeSentError("m"))).toEqual({});
    expect(maybeSent(Object.assign(new Error("approve lost"), {maybeSent: true}))).toBeNull();
  });
  it("expected failures", () => {
    expect(swapFailureExpected(Object.assign(new Error("no"), {code: 4001}))).toBe(true);
    expect(swapFailureExpected(new Swap2QuoteError("swap2: quote expired"))).toBe(true);
    expect(swapFailureExpected(new SwapReviewMismatch("x"))).toBe(false);
    expect(swapFailureExpected(new Error("boom"))).toBe(false);
  });
  it("isWalletRejection walks causes; answered marks without throwing on frozen errors", () => {
    expect(isWalletRejection(new Error("outer", {cause: Object.assign(new Error("inner"), {code: 4001})}))).toBe(true);
    expect(isWalletRejection(new Error("rpc down"))).toBe(false);
    expect((answered(new Error("x")) as {answered?: boolean}).answered).toBe(true);
    expect(() => answered(Object.freeze(new Error("x")))).not.toThrow();
  });
});
