// The form hook: MAX's gas reserve per gas token, pinning the pair on the first edit, reading a paste.
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, renderHook} from "@testing-library/react";
import type {ReactNode} from "react";
import {describe, expect, it} from "vitest";
import {PortsProvider} from "../../../src/config";
import type {SwapTokensState} from "../../../src/contracts/ports";
import {DEMO_EVM_ADDRESS, demoPorts, demoSwapTokens} from "../../../src/mocks";
import {TOKEN_BY_KEY} from "../../../src/catalog";
import {formatUnits, maxSwappable} from "../../../src/swap";
import {reserveFor, useSwapForm} from "../../../src/screens/form/useSwapForm";

const tok = (key: string) => {
  const t = TOKEN_BY_KEY.get(key);
  if (!t) throw new Error(`no token ${key}`);
  return t;
};

describe("reserveFor (MAX on a gas token)", () => {
  it("Arc USDC: the reserve is in the token's 6 decimals, so MAX leaves 0.05 USDC instead of 0", () => {
    const arc = tok("arc:0x3600000000000000000000000000000000000000");
    expect(arc.decimals).toBe(6);
    expect(reserveFor(arc)).toBe(50_000n);
    const balance = 1_000_000_000n; // 1000 USDC
    expect(formatUnits(maxSwappable(balance, arc.gasToken, reserveFor(arc)), arc.decimals)).toBe("999.95");
  });

  it("Celo CELO (18/18) and a native coin keep their reserve; a plain token keeps none", () => {
    const celo = tok("celo:0x471ece3750da237f93b8e339c536989b8978a438");
    expect(reserveFor(celo)).toBe(100_000_000_000_000_000n); // 0.1 CELO
    expect(reserveFor(tok("arbitrum:native"))).toBe(400_000_000_000_000n); // 0.0004 ETH
    expect(reserveFor(tok("arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831"))).toBe(0n);
  });
});

describe("useSwapForm", () => {
  const wrapper = ({children}: {children: ReactNode}) => (
    <QueryClientProvider client={new QueryClient()}>
      <PortsProvider ports={demoPorts}>{children}</PortsProvider>
    </QueryClientProvider>
  );
  const all = demoSwapTokens({evm: DEMO_EVM_ADDRESS});
  /** A balances-still-streaming state whose held-first order puts `first` on top. */
  const streaming = (first: string): SwapTokensState => {
    const lead = all.find((t) => t.key === first)!;
    const pay = [lead, ...all.filter((t) => t.payMode !== "none" && t.key !== first)];
    return {all, pay, receive: all, byKey: new Map(all.map((t) => [t.key, t])), prices: {}, loading: true, refresh: () => {}};
  };
  const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  const ARB_ETH = "arbitrum:native";

  it("the first edit pins the pair: a balance that lands later can't swap the token under a typed amount", () => {
    const {result, rerender} = renderHook(({t}) => useSwapForm(t, {amount: ""}, true), {wrapper, initialProps: {t: streaming(ARB_USDC)}});
    expect(result.current.pair?.pay).toBe(ARB_USDC);
    act(() => result.current.setAmount("100"));
    rerender({t: streaming(ARB_ETH)});
    expect(result.current.pair?.pay).toBe(ARB_USDC);
    expect(result.current.text).toBe("100");
  });

  it("without an edit the opening pair still follows the balances while they stream (control)", () => {
    const {result, rerender} = renderHook(({t}) => useSwapForm(t, {amount: ""}, true), {wrapper, initialProps: {t: streaming(ARB_USDC)}});
    rerender({t: streaming(ARB_ETH)});
    expect(result.current.pair?.pay).toBe(ARB_ETH);
  });

  it("a pasted '1,234.56' is 1234.56; an ambiguous one is refused with a note and the field keeps its value", () => {
    const {result} = renderHook(() => useSwapForm(streaming(ARB_USDC), {amount: "5"}, true), {wrapper});
    act(() => result.current.pasteAmount("1,234.56"));
    expect(result.current.text).toBe("1234.56");
    expect(result.current.pasteNote).toBeNull();
    act(() => result.current.pasteAmount("1,000"));
    expect(result.current.text).toBe("1234.56");
    expect(result.current.pasteNote).toMatch(/Is that 1000 or 1.000/);
    act(() => result.current.setAmount("2"));
    expect(result.current.pasteNote).toBeNull();
  });
});
