// Ports mobile lib/swap/tokens.test.ts @756b115 (the cases that don't depend on holdings or wallet kinds), plus the
// web token model: every network listed, owner null without a wallet, payMode, gas tokens, balance states.
import {describe, expect, it} from "vitest";
import {
  TOKENS,
  TOKEN_BY_KEY,
  ZERO_ADDRESS,
  defaultPair,
  destTokenId,
  flipPair,
  matchesToken,
  pickSide,
  pickerNetworks,
  swapTokens,
  tokenKey,
  tokensOf,
} from "../../../src/catalog";
import type {Balance, Owners, PriceMap, SwapToken} from "../../../src/contracts";

const EVM = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const loaded = (rows: Record<string, string>): Record<string, Balance> =>
  Object.fromEntries(Object.entries(rows).map(([k, amount]) => [k, {amount, state: "loaded"} satisfies Balance]));
const universe = (owners: Owners, balances: Record<string, Balance> = {}, prices: PriceMap = {}) => swapTokens(TOKENS, balances, prices, owners);

const BASE_USDC = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";

describe("TOKENS", () => {
  it("is the 405 catalog assets on the 37 networks, keys unique", () => {
    expect(TOKENS).toHaveLength(405);
    expect(TOKEN_BY_KEY.size).toBe(405);
    expect(new Set(TOKENS.map((t) => t.chain)).size).toBe(37);
  });

  it("puts each network's native first, network display order", () => {
    expect(TOKENS[0]!.key).toBe("ethereum:native");
    expect(tokensOf("base")[0]!.key).toBe("base:native");
    expect(tokensOf("solana")[0]).toMatchObject({key: "solana:native", symbol: "SOL", decimals: 9, contract: null});
    // Catalog chains cp0x doesn't carry (Litecoin, Sui…) never show.
    expect(TOKENS.some((t) => t.caip2.startsWith("sui:"))).toBe(false);
  });

  it("gives natives the app's symbol, keeps the catalog's for the engine", () => {
    const ton = TOKEN_BY_KEY.get("ton:native")!;
    expect(ton.symbol).toBe("TON");
    expect(ton.catalogSymbol).toBe("GRAM");
    expect(TOKEN_BY_KEY.get("gnosis:native")).toMatchObject({symbol: "XDAI", catalogSymbol: "xDAI"});
    expect(destTokenId(ton)).toBe(ZERO_ADDRESS);
    expect(destTokenId(TOKEN_BY_KEY.get("solana:native")!)).toBe(ZERO_ADDRESS);
    expect(destTokenId(TOKEN_BY_KEY.get(BASE_USDC)!)).toBe(TOKEN_BY_KEY.get(BASE_USDC)!.contract);
    expect(destTokenId(TOKEN_BY_KEY.get(BASE_USDC)!).toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });

  it("keeps contract case (Solana/TON are case-sensitive) and lowercases only the key", () => {
    const usdc = TOKENS.find((t) => t.chain === "solana" && t.symbol === "USDC")!;
    expect(usdc.contract).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(usdc.key).toBe(tokenKey("solana", usdc.contract));
    expect(usdc.key).toBe("solana:epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v");
  });

  it("marks gas tokens: natives plus Celo CELO and Arc USDC by their ERC-20 face", () => {
    const celo = TOKENS.find((t) => t.chain === "celo" && t.symbol === "CELO")!;
    const arc = TOKENS.find((t) => t.chain === "arc" && t.symbol === "USDC")!;
    expect(celo).toMatchObject({contract: "0x471EcE3750Da237f93B8E339c536989b8978a438", gasToken: true, decimals: 18});
    expect(arc).toMatchObject({contract: "0x3600000000000000000000000000000000000000", gasToken: true, decimals: 6});
    expect(tokensOf("celo").some((t) => !t.contract)).toBe(false);
    expect(tokensOf("arc").some((t) => !t.contract)).toBe(false);
    expect(TOKENS.filter((t) => t.gasToken && t.contract).map((t) => t.chain).sort()).toEqual(["arc", "celo"]);
    expect(TOKENS.filter((t) => !t.contract).every((t) => t.gasToken)).toBe(true);
    expect(TOKENS.find((t) => t.chain === "celo" && t.symbol === "USDC")!.gasToken).toBe(false);
  });
});

describe("swapTokens", () => {
  it("lists every network; a family without a wallet has no owner and balance 'none'", () => {
    const all = universe({evm: EVM});
    expect(all).toHaveLength(405);
    const sol = all.find((t) => t.key === "solana:native")!;
    expect(sol).toMatchObject({owner: null, balance: "none", payMode: "connect", amount: "0"});
    const eth = all.find((t) => t.key === "ethereum:native")!;
    expect(eth).toMatchObject({owner: EVM, balance: "loading", payMode: "wallet"});
  });

  it("pays BTC, ZEC, TON, Tron and NEAR through a deposit address", () => {
    const all = universe({});
    for (const slug of ["bitcoin", "zcash", "ton", "tron", "near"])
      expect(all.filter((t) => t.chain === slug).every((t) => t.payMode === "deposit" && t.owner === null), slug).toBe(true);
    expect(all.filter((t) => t.family === "evm").every((t) => t.payMode === "connect")).toBe(true);
  });

  it("pays Tron from a connected Tron wallet, and only then", () => {
    const TRON = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi";
    const tron = universe({tron: TRON}).filter((t) => t.chain === "tron");
    expect(tron.map((t) => t.symbol).sort()).toEqual(["TRX", "USDT"]);
    expect(tron.every((t) => t.payMode === "wallet" && t.owner === TRON && t.balance === "loading")).toBe(true);
  });

  it("pays TON from a connected TON wallet, and by QR again once it disconnects", () => {
    const ton = "UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt";
    const tons = universe({ton}).filter((t) => t.chain === "ton");
    expect(tons.length).toBeGreaterThan(1);
    expect(tons.every((t) => t.payMode === "wallet" && t.owner === ton)).toBe(true);
    expect(universe({}).filter((t) => t.chain === "ton").every((t) => t.payMode === "deposit")).toBe(true);
  });

  it("pays NEAR from a connected NEAR wallet, and from a deposit address without one", () => {
    const near = universe({near: "alice.near"}).filter((t) => t.chain === "near");
    expect(near.length).toBeGreaterThan(1);
    expect(near.every((t) => t.payMode === "wallet" && t.owner === "alice.near")).toBe(true);
    expect(universe({evm: EVM}).filter((t) => t.chain === "near").every((t) => t.payMode === "deposit")).toBe(true);
  });

  it("puts held tokens first, by value, with their balances and owners", () => {
    const all = universe(
      {evm: EVM, solana: SOL},
      loaded({[BASE_USDC]: "5000000", "solana:native": "2000000000"}),
      {USDC: 1, SOL: 150},
    );
    expect(all[0]).toMatchObject({key: "solana:native", amount: "2000000000", owner: SOL, usd: 300, priceUsd: 150, balance: "loaded"});
    expect(all[1]).toMatchObject({key: BASE_USDC, owner: EVM, usd: 5});
    expect(all[2]!.amount).toBe("0");
  });

  it("breaks a USD tie by units, keeps unpriced holdings ahead of nothing", () => {
    const all = universe({evm: EVM}, loaded({"ethereum:native": "1000000000000000000", "base:native": "3000000000000000000"}));
    expect(all.slice(0, 2).map((t) => t.key)).toEqual(["base:native", "ethereum:native"]);
    expect(all[0]!.usd).toBe(0);
  });

  it("prices unheld tokens from the market map, display symbol first, router lookup rules", () => {
    const all = universe({evm: EVM}, {}, {ETH: 3000, GRAM: 2.5, WBTC: 90000});
    expect(all.find((t) => t.key === "ethereum:native")!.priceUsd).toBe(3000);
    expect(all.find((t) => t.key === "ton:native")!.priceUsd).toBe(2.5); // TON missing → catalog GRAM
    expect(all.find((t) => t.chain === "near" && t.symbol === "wBTC")!.priceUsd).toBe(90000); // wBTC → WBTC
    expect(all.find((t) => t.key === BASE_USDC)!.priceUsd).toBeUndefined(); // no $1 guess
  });

  it("shows a failed read as an error with amount 0 (never a loaded zero)", () => {
    const all = universe({evm: EVM}, {"ethereum:native": {amount: "0", state: "error"}, "base:native": {amount: "0", state: "loading"}});
    expect(all.find((t) => t.key === "ethereum:native")).toMatchObject({balance: "error", amount: "0", usd: 0});
    expect(all.find((t) => t.key === "base:native")!.balance).toBe("loading");
  });

  it("ignores balances of a family whose wallet is gone", () => {
    const all = universe({}, loaded({"ethereum:native": "1000"}));
    expect(all.find((t) => t.key === "ethereum:native")).toMatchObject({amount: "0", balance: "none", owner: null});
  });
});

describe("pair picking (mobile)", () => {
  it("picking the other side's token flips the pair", () => {
    expect(pickSide({pay: "a", receive: "b"}, "pay", "b")).toEqual({pay: "b", receive: "a"});
    expect(pickSide({pay: "a", receive: "b"}, "receive", "a")).toEqual({pay: "b", receive: "a"});
  });
  it("picking a third token replaces only that side", () => {
    expect(pickSide({pay: "a", receive: "b"}, "pay", "c")).toEqual({pay: "c", receive: "b"});
    expect(pickSide({pay: "a", receive: "b"}, "receive", "c")).toEqual({pay: "a", receive: "c"});
  });
  it("flip", () => {
    expect(flipPair({pay: "a", receive: "b"})).toEqual({pay: "b", receive: "a"});
  });
});

describe("defaultPair (mobile)", () => {
  const all = universe({evm: EVM}, loaded({"arbitrum:native": "10000000000000000"}), {ETH: 3000});
  const pay = all.filter((t) => t.payMode === "wallet");
  it("pays with the top holding and receives USDC on the same network", () => {
    expect(defaultPair(pay, all)).toEqual({pay: "arbitrum:native", receive: ARB_USDC});
  });
  it("honours the asked-for pay token (hash param)", () => {
    expect(defaultPair(pay, all, "base:native")?.pay).toBe("base:native");
  });
  it("paying USDC receives the network's native coin", () => {
    expect(defaultPair(pay, all, BASE_USDC)).toEqual({pay: BASE_USDC, receive: "base:native"});
  });
  it("a fresh wallet opens on the first native", () => {
    const fresh = universe({evm: EVM});
    expect(defaultPair(fresh.filter((t) => t.payMode === "wallet"), fresh)?.pay).toBe("ethereum:native");
  });
  it("nothing to pay with → no pair", () => {
    expect(defaultPair([], all)).toBeNull();
  });
});

describe("matchesToken (mobile)", () => {
  const t = {
    symbol: "USDC",
    catalogSymbol: "USDC",
    chainName: "Base",
    chain: "base",
    contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  } as SwapToken;
  it("by symbol, network, slug or contract prefix", () => {
    expect(matchesToken(t, "usd")).toBe(true);
    expect(matchesToken(t, "BASE")).toBe(true);
    expect(matchesToken(t, "0x8335")).toBe(true);
    expect(matchesToken(t, "0x")).toBe(false);
    expect(matchesToken(t, "sol")).toBe(false);
    expect(matchesToken(t, " ")).toBe(true);
  });
});

describe("pickerNetworks (mobile)", () => {
  const tok = (chain: string, amount = "0", usd = 0) => ({key: `${chain}:native`, chain, chainName: chain, amount, usd}) as SwapToken;

  it("pins the six, then held networks, then the rest in catalog order", () => {
    const nets = pickerNetworks([
      tok("bsc"),
      tok("polygon"),
      tok("optimism", "5", 12),
      tok("near"),
      tok("arbitrum"),
      tok("ton"),
      tok("bitcoin"),
      tok("tron", "1", 1),
      tok("solana"),
      tok("ethereum"),
      tok("optimism"),
      tok("base"),
    ]).map((n) => n.slug);
    expect(nets).toEqual(["ethereum", "solana", "tron", "bitcoin", "ton", "near", "optimism", "arbitrum", "base", "polygon", "bsc"]);
  });

  it("sums the held value per network", () => {
    const [n] = pickerNetworks([tok("base", "1", 2.5), tok("base", "0"), tok("base", "3", 1)]);
    expect(n).toMatchObject({slug: "base", held: true, usd: 3.5});
  });

  it("covers all 37 networks of the real universe", () => {
    expect(pickerNetworks(universe({evm: EVM}))).toHaveLength(37);
  });
});
