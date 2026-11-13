import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PRICE_IDS, TOKENS, fetchPrices, priceFor, tokenPrice} from "../../../src/catalog";
import {fromGecko, fromLlama, lastKnownPrices, loadPrices, rememberPrices} from "../../../src/catalog/prices";
import {DEFAULT_RUNTIME_CONFIG, setRuntimeConfig} from "../../../src/config";

type Reply = {status?: number; body?: unknown; throws?: Error};
type Route = (url: string) => Reply;

const calls: string[] = [];
function mockFetch(route: Route) {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const r = route(url);
      if (r.throws) throw r.throws;
      const status = r.status ?? 200;
      return {ok: status >= 200 && status < 300, status, json: async () => r.body} as Response;
    }),
  );
}

const llamaKey = (id: string) => (id.includes(":") ? id : `coingecko:${id}`);
/** A DefiLlama answer pricing every id at `price(id)`. */
const llamaBody = (price: (id: string) => number, only?: (id: string) => boolean) => ({
  coins: Object.fromEntries(
    [...new Set(Object.values(PRICE_IDS))].filter((id) => !only || only(id)).map((id) => [llamaKey(id), {price: price(id), symbol: "X", timestamp: 1, confidence: 0.99}]),
  ),
});
const geckoBody = (price: (id: string) => number) =>
  Object.fromEntries([...new Set(Object.values(PRICE_IDS))].filter((id) => !id.includes(":")).map((id) => [id, {usd: price(id)}]));

const isLlama = (u: string) => u.startsWith("https://coins.llama.fi/");
const isGecko = (u: string) => u.startsWith("https://api.coingecko.com/");

beforeEach(() => {
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
});

describe("PRICE_IDS", () => {
  // Every symbol the token list shows, or the router ranks by, has an id — except Sei fastUSD (no price anywhere).
  it("covers every catalog token except Sei fastUSD", () => {
    const all = Object.fromEntries(Object.keys(PRICE_IDS).map((s) => [s, 1]));
    const unpriced = TOKENS.filter((t) => tokenPrice(t, all) === undefined || priceFor(all, t.catalogSymbol) === undefined);
    expect(unpriced.map((t) => `${t.chain}:${t.catalogSymbol}`)).toEqual(["sei:fastUSD"]);
  });

  it("has both spellings of the renamed natives", () => {
    expect(PRICE_IDS.TON).toBe(PRICE_IDS.GRAM);
    expect(PRICE_IDS.XDAI).toBe(PRICE_IDS.xDAI);
  });

  it("keys 124 unique DefiLlama coins", () => {
    expect(new Set(Object.values(PRICE_IDS).map(llamaKey)).size).toBe(124);
  });
});

describe("fromLlama", () => {
  it("asks once for every unique key, sorted, and maps the price back to every symbol of that id", async () => {
    mockFetch(() => ({body: llamaBody((id) => (id === "tether" ? 0.9995 : 2))}));
    const p = await fromLlama();
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.origin).toBe("https://coins.llama.fi");
    expect(url.pathname.startsWith("/prices/current/")).toBe(true);
    expect(url.searchParams.get("searchWidth")).toBe("6h");
    const keys = decodeURIComponent(url.pathname.slice("/prices/current/".length)).split(",");
    expect(keys).toEqual([...new Set(keys)].sort());
    expect(keys).toContain("coingecko:ethereum");
    expect(keys).toContain("sei:0x5Cf6826140C1C56Ff49C808A1A75407Cd1DF9423");
    expect(p.USDT).toBe(0.9995);
    expect(p.USDT0).toBe(0.9995);
    expect(p.ETH).toBe(2);
    expect(Object.keys(p)).toHaveLength(Object.keys(PRICE_IDS).length);
  });

  it("matches contract keys case-insensitively and drops unusable prices", async () => {
    mockFetch(() => ({
      body: {
        coins: {
          "sei:0x5cf6826140c1c56ff49c808a1a75407cd1df9423": {price: 0.31},
          "coingecko:ethereum": {price: 0},
          "coingecko:bitcoin": {price: -1},
          "coingecko:solana": {price: "150"},
          "coingecko:tron": {price: Number.NaN},
          "coingecko:near": {},
          "coingecko:the-open-network": {price: 2.4},
        },
      },
    }));
    expect(await fromLlama()).toEqual({iSEI: 0.31, TON: 2.4, GRAM: 2.4});
  });

  it("uses the runtime config's base URL", async () => {
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, prices: {defillama: "https://llama.example.org/", coingecko: "https://gecko.example.org/api/v3"}});
    mockFetch(() => ({body: {coins: {}}}));
    await fromLlama();
    expect(calls[0]!.startsWith("https://llama.example.org/prices/current/")).toBe(true);
  });

  it("throws on an HTTP error", async () => {
    mockFetch(() => ({status: 502, body: {}}));
    await expect(fromLlama()).rejects.toThrow("defillama 502");
  });
});

describe("fromGecko", () => {
  it("asks for plain ids only and maps simple/price back", async () => {
    mockFetch(() => ({body: {...geckoBody(() => 3), "usd-coin": {usd: 1.0001}}}));
    const p = await fromGecko();
    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/api/v3/simple/price");
    expect(url.searchParams.get("vs_currencies")).toBe("usd");
    const ids = url.searchParams.get("ids")!.split(",");
    expect(ids.some((id) => id.includes(":"))).toBe(false);
    expect(p.USDC).toBe(1.0001);
    expect(p["USDC.e"]).toBe(1.0001);
    expect(p.iSEI).toBeUndefined(); // DefiLlama-only key
  });
});

describe("fetchPrices", () => {
  it("returns DefiLlama alone when it answers fully", async () => {
    mockFetch((u) => (isLlama(u) ? {body: llamaBody(() => 5)} : {throws: new Error("must not call CoinGecko")}));
    const p = await fetchPrices();
    expect(p.ETH).toBe(5);
    expect(calls.every(isLlama)).toBe(true);
  });

  it("falls back to CoinGecko when DefiLlama is unreachable (a CORS-less error is a TypeError)", async () => {
    mockFetch((u) => (isLlama(u) ? {throws: new TypeError("Failed to fetch")} : {body: geckoBody(() => 7)}));
    const p = await fetchPrices();
    expect(p.ETH).toBe(7);
    expect(calls.filter(isGecko)).toHaveLength(1);
  });

  it("tops up a thin DefiLlama answer from CoinGecko, DefiLlama winning", async () => {
    mockFetch((u) => (isLlama(u) ? {body: llamaBody(() => 9, (id) => id === "ethereum")} : {body: geckoBody(() => 7)}));
    const p = await fetchPrices();
    expect(p.ETH).toBe(9);
    expect(p.BTC).toBe(7);
  });

  it("keeps the thin DefiLlama answer when CoinGecko is rate-limited", async () => {
    mockFetch((u) => (isLlama(u) ? {body: llamaBody(() => 9, (id) => id === "ethereum")} : {status: 429, body: {}}));
    expect(await fetchPrices()).toEqual({ETH: 9});
  });

  it("never throws: {} when both fail", async () => {
    mockFetch(() => ({throws: new TypeError("Failed to fetch")}));
    expect(await fetchPrices()).toEqual({});
  });
});

describe("loadPrices / warm start", () => {
  it("throws when nothing is priced, so react-query keeps the last good map", async () => {
    mockFetch(() => ({throws: new TypeError("Failed to fetch")}));
    await expect(loadPrices()).rejects.toThrow();
    expect(lastKnownPrices()).toBeUndefined();
  });

  it("remembers a fresh map and offers it back while recent", async () => {
    mockFetch(() => ({body: llamaBody(() => 4)}));
    const p = await loadPrices();
    expect(lastKnownPrices()).toEqual(p);
  });

  it("ignores a remembered map older than 30 minutes, from the future, or malformed", () => {
    rememberPrices({ETH: 3000}, 1_000_000);
    expect(lastKnownPrices(1_000_000 + 29 * 60_000)).toEqual({ETH: 3000});
    expect(lastKnownPrices(1_000_000 + 31 * 60_000)).toBeUndefined();
    expect(lastKnownPrices(999_000)).toBeUndefined();
    localStorage.setItem("cp0x.prices.v1", "{not json");
    expect(lastKnownPrices()).toBeUndefined();
    localStorage.setItem("cp0x.prices.v1", JSON.stringify({at: Date.now(), prices: {ETH: "x", NOPE: 1, BTC: 90000}}));
    expect(lastKnownPrices()).toEqual({BTC: 90000});
  });

  it("survives blocked storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(lastKnownPrices()).toBeUndefined();
    expect(() => rememberPrices({ETH: 1})).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe("priceFor", () => {
  it("follows the router's lookup: as written, upper-cased, then without a leading w", () => {
    const p = {ETH: 3000, WBTC: 90000, S: 0.5, BTC: 95000};
    expect(priceFor(p, "ETH")).toBe(3000);
    expect(priceFor(p, "wBTC")).toBe(90000);
    expect(priceFor(p, "wS")).toBeUndefined(); // the router strips only from 3+ characters (wS has its own id)
    expect(priceFor(p, "s")).toBe(0.5);
    expect(priceFor(p, "WETH")).toBe(3000);
    expect(priceFor(p, "USDC")).toBeUndefined(); // no $1 default for display
    expect(priceFor({ETH: 0}, "ETH")).toBeUndefined();
  });
});
