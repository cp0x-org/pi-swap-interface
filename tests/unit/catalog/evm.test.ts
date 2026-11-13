import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {MULTICALL3, VIEM_CHAINS, evmRpcUrls, isContractAddress, publicClient, toViemChain} from "../../../src/catalog";
import {resetPublicClients} from "../../../src/catalog/evm";
import {DEFAULT_RUNTIME_CONFIG, setRuntimeConfig} from "../../../src/config";
import {EVM_CHAINS, chainBySlug} from "../../../src/shared";

beforeEach(() => {
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  resetPublicClients();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  resetPublicClients();
});

describe("VIEM_CHAINS", () => {
  it("defines all 31 EVM catalog chains, Elysium included, from the catalog (not viem/chains)", () => {
    expect(VIEM_CHAINS).toHaveLength(31);
    expect(VIEM_CHAINS.map((c) => c.id)).toEqual(EVM_CHAINS.map((c) => c.chainId));
    const elysium = VIEM_CHAINS.find((c) => c.id === 99901)!;
    expect(elysium).toMatchObject({name: "Elysium", nativeCurrency: {symbol: "HYPE", decimals: 18}});
    expect(elysium.blockExplorers?.default.url).toBe("https://elysium.kinetiq.xyz");
    expect(VIEM_CHAINS.every((c) => c.nativeCurrency.decimals === 18)).toBe(true);
  });

  it("uses the runtime RPCs and the per-chain Multicall3", () => {
    const base = VIEM_CHAINS.find((c) => c.id === 8453)!;
    expect(base.rpcUrls.default.http).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[8453]);
    expect(base.contracts?.multicall3?.address).toBe(MULTICALL3);
    expect(VIEM_CHAINS.find((c) => c.id === 324)!.contracts?.multicall3?.address).toBe("0xF9cda624FBC7e059355ce98a31693d299FACd963");
    // Arc pays gas in USDC but is 18-decimal at the EVM level; Katana and Arc have no explorer.
    expect(VIEM_CHAINS.find((c) => c.id === 5042)!.nativeCurrency).toMatchObject({symbol: "USDC", decimals: 18});
    expect(VIEM_CHAINS.find((c) => c.id === 747474)!.blockExplorers).toBeUndefined();
  });

  it("keeps the catalog list in the definition when the runtime list is empty (wallets still need one to add the chain)", () => {
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, evmRpc: {...DEFAULT_RUNTIME_CONFIG.evmRpc, 99901: []}});
    expect(evmRpcUrls(99901)).toEqual([]);
    expect(toViemChain(chainBySlug("elysium")!).rpcUrls.default.http).toEqual(chainBySlug("elysium")!.rpc);
  });
});

describe("evmRpcUrls / publicClient", () => {
  it("reads the runtime config per call", () => {
    expect(evmRpcUrls(1)).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[1]);
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, evmRpc: {...DEFAULT_RUNTIME_CONFIG.evmRpc, 1: ["https://rpc.example.org"]}});
    expect(evmRpcUrls(1)).toEqual(["https://rpc.example.org"]);
    expect(evmRpcUrls(424242)).toEqual([]);
  });

  it("caches one client per chain and refuses chains outside the catalog", () => {
    expect(publicClient(8453)).toBe(publicClient(8453));
    expect(publicClient(8453).chain?.id).toBe(8453);
    expect(() => publicClient(424242)).toThrow(/unknown EVM chain/);
  });

  it("fails over to the next runtime RPC", async () => {
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, evmRpc: {...DEFAULT_RUNTIME_CONFIG.evmRpc, 8453: ["https://a.example.org", "https://b.example.org"]}});
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        hosts.push(url.host);
        if (url.host === "a.example.org") return new Response("busy", {status: 503});
        const {id} = JSON.parse(String(init?.body)) as {id: number};
        return new Response(JSON.stringify({jsonrpc: "2.0", id, result: "0x2105"}), {headers: {"content-type": "application/json"}});
      }),
    );
    expect(await publicClient(8453).getChainId()).toBe(8453);
    expect(hosts).toEqual(["a.example.org", "b.example.org"]);
  });
});

describe("isContractAddress", () => {
  const getCode = (code: string) => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
        calls.push(body);
        return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result: code}), {headers: {"content-type": "application/json"}});
      }),
    );
    return calls;
  };
  const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  it("is true for code, false for an EOA and for an EIP-7702 delegated EOA", async () => {
    const calls = getCode("0x6080604052");
    expect(await isContractAddress("eip155:8453", A)).toBe(true);
    expect(calls[0]).toMatchObject({method: "eth_getCode", params: [A, "latest"]});
    getCode("0x");
    expect(await isContractAddress("eip155:8453", A)).toBe(false);
    getCode(`0xef0100${"ab".repeat(20)}`);
    expect(await isContractAddress("eip155:8453", A)).toBe(false);
  });

  it("is false off EVM or for a non-address, without any request", async () => {
    const calls = getCode("0x6080");
    expect(await isContractAddress("solana:mainnet", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
    expect(await isContractAddress("eip155:8453", "vitalik.eth")).toBe(false);
    expect(await isContractAddress("eip155:424242", A)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
