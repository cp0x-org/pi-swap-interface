import {describe, expect, it} from "vitest";
// Test-only import: the main bundle must not pull the Omniston package (providerMeta.ts keeps an inline copy).
import {AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS} from "@anywalletkit/protocol-swap2-omniston/validators";
import {CF_VAULTS} from "@anywalletkit/protocol-swap2-chainflip/config";
import {DEFAULT_ON_PROVIDERS, STANDARD_ONLY_PROVIDERS} from "../../../src/swap/providers";
import {OMNISTON_ORDER_PROTOCOL, PROVIDER_NAMES, TWO_PHASE, orderSpender, providerName, venueScope} from "../../../src/swap/providerMeta";
import {VENUE_TRUST, venueTrustText} from "../../../src/swap/venues";

describe("Omniston order protocols", () => {
  it("the inline copy equals the SDK's audited table, chain by chain", () => {
    expect(Object.keys(OMNISTON_ORDER_PROTOCOL).sort()).toEqual(Object.keys(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS).sort());
    for (const [chain, list] of Object.entries(AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS)) {
      expect(OMNISTON_ORDER_PROTOCOL[chain]).toBe(list[0]);
    }
  });
});

describe("orderSpender", () => {
  it("names Omniston's order protocol and Chainflip's vault, nothing else", () => {
    expect(orderSpender("omniston", "eip155:8453")).toBe("0xe7405fAcDEDB2512e91F2886BDff13231343aF5E");
    expect(orderSpender("omniston", "eip155:4663")).toBeNull();
    expect(orderSpender("chainflip", "eip155:1")).toBe(CF_VAULTS["eip155:1"]);
    expect(orderSpender("chainflip", "eip155:42161")).toBe(CF_VAULTS["eip155:42161"]);
    expect(orderSpender("chainflip", "tron:728126428")).toBeNull();
    expect(orderSpender("chainflip", "eip155:8453")).toBeNull();
    expect(orderSpender("lifi", "eip155:8453")).toBeNull();
  });
});

describe("names and venue facts", () => {
  it("names every buildable venue, passes unknown ones through", () => {
    for (const p of [...DEFAULT_ON_PROVIDERS, ...STANDARD_ONLY_PROVIDERS]) expect(PROVIDER_NAMES[p]).toBeTruthy();
    expect(providerName("near_intents")).toBe("NEAR Intents");
    expect(providerName("curve")).toBe("Curve");
    expect(providerName("fynd")).toBe("Fynd");
    expect(providerName("lifi")).toBe("LI.FI");
    expect(providerName("mystery")).toBe("mystery");
  });
  it("only CCTP needs a claim on arrival", () => {
    expect([...TWO_PHASE]).toEqual(["cctp"]);
  });
  it("every buildable venue has a trust badge", () => {
    for (const p of [...DEFAULT_ON_PROVIDERS, ...STANDARD_ONLY_PROVIDERS]) expect(VENUE_TRUST[p]).toBeDefined();
    expect(VENUE_TRUST.thorchain).toBe("own-node");
    // Curve quotes and settles on the contracts; Fynd's route comes from its solver API.
    expect(VENUE_TRUST.curve).toBe("contracts");
    expect(VENUE_TRUST.fynd).toBe("provider-api");
    expect(venueTrustText("uniswap", "Base")).toBe("Quoted and settled by contracts on Base — no company API");
    expect(venueTrustText("thorchain", "Base")).toBe("Quoted by a THORChain node");
    expect(venueTrustText("relay", "Base")).toBe("Quoted by Relay's API — checked in your browser before you sign");
  });
});

describe("venueScope (the 'Not for this pair' lines)", () => {
  const side = (caip2: string, family: string, symbol: string) => ({caip2, family, symbol});
  const ethMain = side("eip155:1", "evm", "ETH");
  const usdtMain = side("eip155:1", "evm", "USDT");
  const usdcArb = side("eip155:42161", "evm", "USDC");
  const usdcBase = side("eip155:8453", "evm", "USDC");
  const usdcElysium = side("eip155:99901", "evm", "USDC");
  const sol = side("solana:mainnet", "solana", "SOL");
  const usdtSol = side("solana:mainnet", "solana", "USDT");

  it("names each venue's scope, with the pair's context where it is certain", () => {
    // Asked EVM → Solana since protocol-swap2-lifi 0.8.0; where it isn't asked, its chain table is why.
    expect(venueScope("lifi", ethMain, sol)).toBe("Doesn't cover these networks");
    expect(venueScope("lifi", side("bitcoin:mainnet", "btc", "BTC"), ethMain)).toBe("Doesn't cover these networks");
    expect(venueScope("uniswap", ethMain, sol)).toBe("Same-network swaps only");
    expect(venueScope("uniswap", sol, usdtSol)).toBe("Not on this network");
    expect(venueScope("curve", usdcArb, usdcBase)).toBe("Same-network swaps only");
    expect(venueScope("curve", sol, usdtSol)).toBe("Not on this network");
    expect(venueScope("fynd", usdcArb, usdcBase)).toBe("Same-network swaps only");
    expect(venueScope("fynd", side("eip155:10", "evm", "USDC"), side("eip155:10", "evm", "ETH"))).toBe("Not on this network");
    expect(venueScope("wrap", usdcArb, usdcBase)).toBe("Wraps only, like ETH ⇄ WETH");
    expect(venueScope("cctp", usdtMain, usdtSol)).toBe("Solana isn't supported here yet");
    expect(venueScope("cctp", usdcArb, usdcElysium)).toBe("Not on one of these networks");
    expect(venueScope("cctp", usdtMain, usdcBase)).toBe("Moves USDC only");
    expect(venueScope("cctp", usdcArb, side("eip155:42161", "evm", "USDC"))).toBe("Between networks only");
    expect(venueScope("cctp", usdtMain, side("tron:728126428", "tron", "USDT"))).toBe("Tron isn't supported here");
    expect(venueScope("usdt0", usdcArb, usdcBase)).toBe("Moves USDT only");
    expect(venueScope("usdt0", usdtMain, usdcElysium)).toBe("Moves USDT only");
    expect(venueScope("usdt0", usdtMain, side("eip155:99901", "evm", "USDT"))).toBe("Not on one of these networks");
    // The Legacy Mesh reaches TON and Tron from Ethereum USDT and Arbitrum USDT0 (asked there); never from TON or Tron.
    const usdtTon = side("ton:-239", "ton", "USDT");
    const usdtTron = side("tron:728126428", "tron", "USDT");
    expect(venueScope("usdt0", side("eip155:56", "evm", "USDT"), usdtTon)).toBe("Into TON from Ethereum or Arbitrum only");
    expect(venueScope("usdt0", side("eip155:137", "evm", "USDT0"), usdtTon)).toBe("Into TON from Ethereum or Arbitrum only");
    expect(venueScope("usdt0", side("eip155:56", "evm", "USDT"), usdtTron)).toBe("Into Tron from Ethereum or Arbitrum only");
    expect(venueScope("usdt0", ethMain, usdtTon)).toBe("Moves USDT only");
    expect(venueScope("usdt0", ethMain, usdtTron)).toBe("Moves USDT only");
    expect(venueScope("usdt0", usdtMain, side("ton:-239", "ton", "TON"))).toBe("Moves USDT only");
    expect(venueScope("usdt0", usdtMain, side("tron:728126428", "tron", "TRX"))).toBe("Moves USDT only");
    expect(venueScope("usdt0", usdtTon, usdtMain)).toBe("TON isn't supported here yet");
    expect(venueScope("usdt0", usdtTron, usdtMain)).toBe("Tron isn't supported here yet");
    expect(venueScope("usdt0", usdtMain, usdtSol)).toBe("Solana isn't supported here");
    expect(venueScope("jupiter", ethMain, sol)).toBe("Swaps within Solana only");
    expect(venueScope("relay", usdtMain, usdtSol)).toBe("EVM networks only here");
    expect(venueScope("relay", usdcArb, side("eip155:42161", "evm", "ETH"))).toBe("Between networks only");
  });

  it("bridges on a same-network pair, and venues whose answer is in their token list", () => {
    expect(venueScope("thorchain", usdcArb, side("eip155:42161", "evm", "ETH"))).toBe("Between networks only");
    expect(venueScope("near_intents", usdcArb, side("eip155:42161", "evm", "ETH"))).toBe("Between networks only");
    // USDT Ethereum → USDT Solana: THORChain has no USDT on Solana, but the line doesn't guess which token is missing.
    expect(venueScope("thorchain", usdtMain, usdtSol)).toBe("Doesn't cover this pair");
    expect(venueScope("chainflip", usdtMain, usdtSol)).toBe("Doesn't cover this pair");
  });

  it("Balancer, Symbiosis and Omniston (on by default since 2026-11-12)", () => {
    const ethArb = side("eip155:42161", "evm", "ETH");
    expect(venueScope("balancer", usdcArb, usdcBase)).toBe("Same-network swaps only");
    expect(venueScope("balancer", sol, usdtSol)).toBe("Not on this network");
    expect(venueScope("symbiosis", usdcArb, ethArb)).toBe("Between networks only");
    expect(venueScope("symbiosis", usdtMain, side("tron:728126428", "tron", "USDT"))).toBe("Doesn't cover this pair");
    // No Solana in its chain table: never "Between networks only" there, on one network or across.
    expect(venueScope("symbiosis", usdtMain, usdtSol)).toBe("Solana isn't supported here");
    expect(venueScope("symbiosis", sol, usdtSol)).toBe("Solana isn't supported here");
    // Omniston: EVM and TON only; its one same-network swap is TON ↔ TON; tokens only between networks.
    expect(venueScope("omniston", usdcArb, ethArb)).toBe("Between networks only");
    expect(venueScope("omniston", side("ton:-239", "ton", "TON"), side("ton:-239", "ton", "USDT"))).toBe("Doesn't cover this pair");
    expect(venueScope("omniston", usdtMain, usdtSol)).toBe("Doesn't cover these networks");
    expect(venueScope("omniston", sol, usdtSol)).toBe("Doesn't cover these networks");
    expect(venueScope("omniston", side("tron:728126428", "tron", "USDT"), side("tron:728126428", "tron", "TRX"))).toBe("Doesn't cover these networks");
    expect(venueScope("omniston", {...ethMain, contract: null}, {...usdcArb, contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"})).toBe("Tokens only between networks");
    expect(venueScope("omniston", {...usdcBase, contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}, {...ethArb, contract: null})).toBe("Tokens only between networks");
    expect(venueScope("omniston", usdcBase, usdcArb)).toBe("Doesn't cover this pair");
  });
});
