import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, renderHook, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PRICE_IDS, catalogPort, tokensOf} from "../../../src/catalog";
import {DEFAULT_RUNTIME_CONFIG, setRuntimeConfig} from "../../../src/config";
import type {Owners} from "../../../src/contracts";

const SOL_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

let client: QueryClient;
const wrapper = ({children}: {children: ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

/** DefiLlama pricing every id at `price`; Solana RPC with SOL = `lamports` and no token accounts. */
function network(opts: {price: () => number; lamports?: () => number; llamaDown?: () => boolean}) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      const reply = (status: number, json: unknown) => ({ok: status < 300, status, json: async () => json}) as Response;
      if (url.startsWith("https://coins.llama.fi/")) {
        if (opts.llamaDown?.()) throw new TypeError("Failed to fetch");
        const ids = [...new Set(Object.values(PRICE_IDS))];
        return reply(200, {coins: Object.fromEntries(ids.map((id) => [id.includes(":") ? id : `coingecko:${id}`, {price: opts.price()}]))});
      }
      if (url.startsWith("https://api.coingecko.com/")) throw new TypeError("Failed to fetch");
      const body = JSON.parse(String(init?.body)) as {method: string; params: unknown[]};
      if (body.method === "getBalance") return reply(200, {result: {value: opts.lamports?.() ?? 0}});
      return reply(200, {result: {value: (body.params[0] as string[]).map(() => null)}});
    }),
  );
  return urls;
}

beforeEach(() => {
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  localStorage.clear();
  client = new QueryClient({defaultOptions: {queries: {retry: false}}});
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
});

describe("catalogPort.usePrices", () => {
  it("is one shared {} until loaded, then the map; an identical refresh keeps the same object", async () => {
    network({price: () => 2});
    const {result, rerender} = renderHook(() => catalogPort.usePrices(), {wrapper});
    const empty = result.current;
    rerender();
    expect(result.current).toBe(empty);
    await waitFor(() => expect(result.current.ETH).toBe(2));
    const first = result.current;
    await act(() => client.refetchQueries({queryKey: ["prices"]}));
    expect(result.current).toBe(first);
  });

  it("keeps the last good map when a refresh fails everywhere", async () => {
    let down = false;
    network({price: () => 3, llamaDown: () => down});
    const {result} = renderHook(() => catalogPort.usePrices(), {wrapper});
    await waitFor(() => expect(result.current.ETH).toBe(3));
    const good = result.current;
    down = true;
    await act(() => client.refetchQueries({queryKey: ["prices"]}));
    expect(result.current).toBe(good);
  });

  it("starts from the remembered map while the first fetch runs", async () => {
    localStorage.setItem("cp0x.prices.v1", JSON.stringify({at: Date.now(), prices: {ETH: 1234}}));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // never answers
    const {result} = renderHook(() => catalogPort.usePrices(), {wrapper});
    expect(result.current.ETH).toBe(1234);
  });
});

describe("catalogPort.useSwapTokens / useBalances", () => {
  it("reads the connected family's balances, sorts held first, and stays stable for an equal owners object", async () => {
    const urls = network({price: () => 100, lamports: () => 2_000_000_000});
    const {result, rerender} = renderHook(({owners}: {owners: Owners}) => catalogPort.useSwapTokens(owners), {
      wrapper,
      initialProps: {owners: {solana: SOL_OWNER}},
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.byKey.get("solana:native")!.balance).toBe("loading");
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.prices.SOL).toBe(100));
    expect(result.current.all[0]).toMatchObject({key: "solana:native", amount: "2000000000", balance: "loaded", usd: 200, owner: SOL_OWNER, payMode: "wallet"});
    const usdc = result.current.byKey.get(tokensOf("solana").find((t) => t.symbol === "USDC")!.key)!;
    expect(usdc).toMatchObject({amount: "0", balance: "loaded"});
    // No EVM wallet → no EVM reads at all; EVM tokens still listed (receive side, connect to pay).
    expect(urls.filter((u) => !u.startsWith("https://coins.llama.fi/")).every((u) => DEFAULT_RUNTIME_CONFIG.solanaRpc.includes(u))).toBe(true);
    expect(result.current.byKey.get("ethereum:native")).toMatchObject({balance: "none", owner: null, payMode: "connect"});
    expect(result.current.receive).toBe(result.current.all);
    expect(result.current.pay).toHaveLength(405);

    const before = result.current;
    rerender({owners: {solana: SOL_OWNER}}); // a new object with the same content
    expect(result.current).toBe(before);
  });

  it("marks every token of a failed chain read as an error, never zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input).startsWith("https://coins.llama.fi/")) return {ok: true, status: 200, json: async () => ({coins: {}})} as Response;
        throw new TypeError("Failed to fetch");
      }),
    );
    const {result} = renderHook(() => catalogPort.useBalances({solana: SOL_OWNER}), {wrapper});
    expect(result.current.byKey["solana:native"]).toEqual({amount: "0", state: "loading"});
    // The balance query retries once (≈1 s) before it reports the error.
    await waitFor(() => expect(result.current.loading).toBe(false), {timeout: 5_000});
    expect(result.current.byKey["solana:native"]).toEqual({amount: "0", state: "error"});
  });

  it("refresh() invalidates every ['bal'] query", async () => {
    let lamports = 1;
    network({price: () => 1, lamports: () => lamports});
    const {result} = renderHook(() => catalogPort.useBalances({solana: SOL_OWNER}), {wrapper});
    await waitFor(() => expect(result.current.byKey["solana:native"]).toEqual({amount: "1", state: "loaded"}));
    const stable = result.current.byKey;
    lamports = 5;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.byKey["solana:native"]).toEqual({amount: "5", state: "loaded"}));
    expect(result.current.byKey).not.toBe(stable);
  });
});
