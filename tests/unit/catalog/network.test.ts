import {CC_SOURCE_CHAINS} from "@anywalletkit/swap2-assets";
import {describe, expect, it} from "vitest";
import {CHAIN_LIST, EXTRA_CHAINS, QR_FALLBACK_FAMILIES, SIGNING_FAMILIES, chainByCaip2Web, chainBySlugWeb, webChains} from "../../../src/catalog";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config";
import {CHAINS} from "../../../src/shared";

describe("CHAIN_LIST", () => {
  it("lists the 37 shared networks in the shared display order", () => {
    expect(CHAIN_LIST).toHaveLength(37);
    expect(CHAIN_LIST.map((c) => c.slug)).toEqual(CHAINS.map((c) => c.slug));
    expect(CHAIN_LIST.slice(0, 10).map((c) => c.slug)).toEqual(["ethereum", "arbitrum", "optimism", "base", "solana", "ton", "tron", "bitcoin", "near", "zcash"]);
  });

  it("carries the catalog flags: memo, key, receive-only", () => {
    expect(chainBySlugWeb("ton")).toMatchObject({memo: true, catalogKey: "ton", receiveOnly: false});
    expect(chainBySlugWeb("zcash")?.catalogKey).toBe("zec");
    expect(CHAIN_LIST.filter((c) => c.memo).map((c) => c.slug)).toEqual(["ton"]);
    expect(CHAIN_LIST.some((c) => c.receiveOnly)).toBe(false);
  });

  it("has Elysium as a normal EVM chain", () => {
    expect(chainBySlugWeb("elysium")).toMatchObject({caip2: "eip155:99901", chainId: 99901, family: "evm"});
  });

  it("takes RPC lists from the runtime config (no mainnet-beta for Solana)", () => {
    expect(chainBySlugWeb("solana")!.rpc).toEqual(DEFAULT_RUNTIME_CONFIG.solanaRpc);
    expect(chainBySlugWeb("solana")!.rpc.some((u) => u.includes("mainnet-beta"))).toBe(false);
    expect(chainBySlugWeb("base")!.rpc).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[8453]);
    expect(chainBySlugWeb("near")!.rpc).toEqual(DEFAULT_RUNTIME_CONFIG.nearRpc);
  });

  it("looks chains up by caip2, wallet aliases included", () => {
    expect(chainByCaip2Web("eip155:8453")?.slug).toBe("base");
    expect(chainByCaip2Web("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")?.slug).toBe("solana");
    expect(chainByCaip2Web("bip122:000000000019d6689c085ae165831e93")?.slug).toBe("bitcoin");
    expect(chainByCaip2Web("litecoin:mainnet")).toBeUndefined();
  });

  it("signs EVM, Solana, Tron, TON and NEAR; Tron, TON and NEAR pay by QR while no wallet of theirs is connected", () => {
    expect([...SIGNING_FAMILIES].sort()).toEqual(["evm", "near", "solana", "ton", "tron"]);
    expect([...QR_FALLBACK_FAMILIES].sort()).toEqual(["near", "ton", "tron"]);
  });
});

describe("catalog coverage", () => {
  // An SDK bump that adds a chain must not make its tokens vanish silently (catalog.md risk 7).
  it("maps every CC_SOURCE_CHAINS caip2 to a shared chain or an extra", () => {
    const known = new Set([...CHAINS, ...EXTRA_CHAINS].map((c) => c.caip2));
    expect(CC_SOURCE_CHAINS.map((c) => c.caip2).filter((id) => !known.has(id))).toEqual([]);
  });

  it("lists the 9 extras only on request; Cosmos is receive-only", () => {
    const all = webChains({extras: true});
    expect(all).toHaveLength(46);
    expect(all.slice(0, 37).map((c) => c.slug)).toEqual(CHAIN_LIST.map((c) => c.slug));
    expect(all.find((c) => c.slug === "cosmos")?.receiveOnly).toBe(true);
    expect(all.filter((c) => c.memo).map((c) => c.slug).sort()).toEqual(["stellar", "ton", "xrp"]);
    expect(webChains().map((c) => c.slug)).toEqual(CHAIN_LIST.map((c) => c.slug));
  });
});
