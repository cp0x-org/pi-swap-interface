import {getAddressEncoder, getProgramDerivedAddress, address as solAddress} from "@solana/kit";
import {CC_SOURCE_CHAINS} from "@anywalletkit/swap2-assets";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  type Address,
  type Hex,
} from "viem";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {
  MULTICALL3,
  TOKEN_2022_MINTS,
  ataOf,
  balanceSpecs,
  mergeBalances,
  multicallAddress,
  readEvmBalances,
  readNearBalances,
  readSolanaBalances,
  readTronBalances,
  readTonBalances,
  tokensOf,
  type BalanceSpec,
} from "../../../src/catalog";
import {readBalances, type BalanceResult} from "../../../src/catalog/balances";
import {resetPublicClients} from "../../../src/catalog/evm";
import {DEFAULT_RUNTIME_CONFIG, setRuntimeConfig} from "../../../src/config";
import type {Token} from "../../../src/contracts";

const EVM_OWNER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SOL_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TRON_OWNER = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi";

beforeEach(() => {
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  resetPublicClients();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setRuntimeConfig(DEFAULT_RUNTIME_CONFIG);
  resetPublicClients();
});

// ── EVM ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("readEvmBalances", () => {
  type Call = {address: string; functionName: string; args: readonly unknown[]};
  const fakeClient = (answer: (calls: readonly Call[]) => {status: "success" | "failure"; result?: unknown; error?: Error}[]) => {
    const seen: {contracts: readonly Call[]; allowFailure?: boolean; multicallAddress?: string; batchSize?: number}[] = [];
    const client = {
      multicall: vi.fn(async (args: {contracts: readonly Call[]; allowFailure?: boolean; multicallAddress?: string; batchSize?: number}) => {
        seen.push(args);
        return answer(args.contracts);
      }),
    };
    return {client: client as unknown as Parameters<typeof readEvmBalances>[0], seen};
  };

  it("reads the native with Multicall3.getEthBalance and contracts with balanceOf, in one call", async () => {
    const tokens = tokensOf("base");
    const {client, seen} = fakeClient((calls) => calls.map((_, i) => ({status: "success", result: BigInt(i + 1)})));
    const out = await readEvmBalances(client, "base", tokens, EVM_OWNER);
    expect(seen).toHaveLength(1);
    const [first, ...rest] = seen[0]!.contracts;
    expect(first).toMatchObject({address: MULTICALL3, functionName: "getEthBalance", args: [EVM_OWNER]});
    expect(rest.every((c, i) => c.functionName === "balanceOf" && c.address === tokens[i + 1]!.contract && c.args[0] === EVM_OWNER)).toBe(true);
    expect(seen[0]).toMatchObject({allowFailure: true, multicallAddress: MULTICALL3, batchSize: 4096});
    expect(out["base:native"]).toBe(1n);
    expect(Object.keys(out)).toEqual(tokens.map((t) => t.key));
  });

  it("uses zkSync's own Multicall3", async () => {
    const {client, seen} = fakeClient((calls) => calls.map(() => ({status: "success", result: 0n})));
    await readEvmBalances(client, "zksync", tokensOf("zksync"), EVM_OWNER);
    expect(multicallAddress("zksync")).toBe("0xF9cda624FBC7e059355ce98a31693d299FACd963");
    expect(seen[0]!.multicallAddress).toBe("0xF9cda624FBC7e059355ce98a31693d299FACd963");
    expect(seen[0]!.contracts[0]!.address).toBe("0xF9cda624FBC7e059355ce98a31693d299FACd963");
  });

  it("reads Celo and Arc gas tokens by balanceOf only (no native entry, no double count)", async () => {
    for (const slug of ["celo", "arc"]) {
      const {client, seen} = fakeClient((calls) => calls.map(() => ({status: "success", result: 0n})));
      await readEvmBalances(client, slug, tokensOf(slug), EVM_OWNER);
      expect(seen[0]!.contracts.every((c) => c.functionName === "balanceOf"), slug).toBe(true);
    }
  });

  it("returns null for a failed read and throws when the whole call fails", async () => {
    const tokens = tokensOf("arbitrum").slice(0, 3);
    const {client} = fakeClient(() => [
      {status: "success", result: 5n},
      {status: "failure", error: new Error("reverted")},
      {status: "success", result: "not a bigint"},
    ]);
    const out = await readEvmBalances(client, "arbitrum", tokens, EVM_OWNER);
    expect(out).toEqual({[tokens[0]!.key]: 5n, [tokens[1]!.key]: null, [tokens[2]!.key]: null});
    const broken = {multicall: vi.fn(async () => Promise.reject(new Error("all RPCs down")))} as unknown as Parameters<typeof readEvmBalances>[0];
    await expect(readEvmBalances(broken, "arbitrum", tokens, EVM_OWNER)).rejects.toThrow("all RPCs down");
  });

  // viem's allowFailure turns a failed eth_call into one failure per token: that must reject, not cache "unknown".
  it("throws when every read failed", async () => {
    const tokens = tokensOf("arbitrum");
    const {client} = fakeClient((calls) => calls.map(() => ({status: "failure", error: new Error("HTTP request failed")})));
    await expect(readEvmBalances(client, "arbitrum", tokens, EVM_OWNER)).rejects.toThrow("HTTP request failed");
  });
});

/** A JSON-RPC endpoint that answers Multicall3.aggregate3 for real: decodes the calldata, encodes each result. */
function multicallRpc(balanceOf: (token: string, owner: string) => bigint | "revert", native: (owner: string) => bigint) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input instanceof Request ? input.url : input));
      const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: [{to: string; data: Hex}]};
      if (body.method !== "eth_call") throw new Error(`unexpected ${body.method}`);
      const {args} = decodeFunctionData({abi: multicall3Abi, data: body.params[0].data});
      const calls = args[0] as readonly {target: Address; allowFailure: boolean; callData: Hex}[];
      const results = calls.map((c) => {
        if (c.callData.startsWith("0x4d2301cc")) {
          const d = decodeFunctionData({abi: multicall3Abi, data: c.callData});
          return {success: true, returnData: encodeFunctionResult({abi: multicall3Abi, functionName: "getEthBalance", result: native(d.args[0] as string)})};
        }
        const d = decodeFunctionData({abi: erc20Abi, data: c.callData});
        const v = balanceOf(c.target, d.args[0] as string);
        return v === "revert"
          ? {success: false, returnData: "0x" as Hex}
          : {success: true, returnData: encodeFunctionResult({abi: erc20Abi, functionName: "balanceOf", result: v})};
      });
      const result = encodeFunctionResult({abi: multicall3Abi, functionName: "aggregate3", result: results});
      return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result}), {headers: {"content-type": "application/json"}});
    }),
  );
  return urls;
}

describe("readBalances (EVM, through our public client and fetch)", () => {
  it("decodes one real Multicall3 round trip into decimal strings, a reverting token as null", async () => {
    const tokens = tokensOf("ethereum");
    const usdc = tokens.find((t) => t.symbol === "USDC")!;
    const usdt = tokens.find((t) => t.symbol === "USDT")!;
    const urls = multicallRpc(
      (token, owner) => {
        expect(owner.toLowerCase()).toBe(EVM_OWNER.toLowerCase());
        if (token.toLowerCase() === usdc.contract!.toLowerCase()) return 1_250_000_000n;
        if (token.toLowerCase() === usdt.contract!.toLowerCase()) return "revert";
        return 0n;
      },
      () => 12_000_000_000_000_000n,
    );
    const spec = balanceSpecs({evm: EVM_OWNER}).find((s) => s.slug === "ethereum")!;
    const out = await readBalances(spec);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).href).toBe(new URL(DEFAULT_RUNTIME_CONFIG.evmRpc[1]![0]!).href);
    expect(out["ethereum:native"]).toBe("12000000000000000");
    expect(out[usdc.key]).toBe("1250000000");
    expect(out[usdt.key]).toBeNull();
    expect(Object.keys(out)).toHaveLength(tokens.length);
  });

  it("refuses to read a chain whose runtime RPC list was emptied", async () => {
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, evmRpc: {...DEFAULT_RUNTIME_CONFIG.evmRpc, 8453: []}});
    resetPublicClients();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const spec = balanceSpecs({evm: EVM_OWNER}).find((s) => s.slug === "base")!;
    await expect(readBalances(spec)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Solana ───────────────────────────────────────────────────────────────────────────────────────────────────────

const SOLANA_MINTS = [
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", // cbBTC
  "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT", // USDe
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD (Token-2022)
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", // USDS
  "LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L", // LINK
  "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ", // WBTC
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG (Token-2022)
  "72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1", // ENA
  "AavE1kKKnesPw4MuRJmJ9jZs9QzEE8CPxQ3ViczUDfc1", // AAVE
  "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", // USDY
];

describe("Solana token programs", () => {
  // TOKEN_2022_MINTS was read on-chain for exactly these mints: a catalog change must re-check it (catalog.live.test.ts).
  it("pins the catalog's Solana mints the Token-2022 set was checked against", () => {
    const cc = CC_SOURCE_CHAINS.find((c) => c.caip2 === "solana:mainnet")!;
    expect(cc.assets.filter((a) => a.contract).map((a) => a.contract)).toEqual(SOLANA_MINTS);
    expect([...TOKEN_2022_MINTS].every((m) => SOLANA_MINTS.includes(m))).toBe(true);
  });

  it("derives each ATA under the mint's own token program", async () => {
    const enc = getAddressEncoder();
    const derive = async (program: string, mint: string) =>
      (
        await getProgramDerivedAddress({
          programAddress: solAddress("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
          seeds: [enc.encode(solAddress(SOL_OWNER)), enc.encode(solAddress(program)), enc.encode(solAddress(mint))],
        })
      )[0];
    const usdc = SOLANA_MINTS[0]!;
    const pyusd = SOLANA_MINTS[4]!;
    expect(await ataOf(SOL_OWNER, usdc)).toBe(await derive("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", usdc));
    expect(await ataOf(SOL_OWNER, pyusd)).toBe(await derive("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", pyusd));
    expect(await ataOf(SOL_OWNER, pyusd)).not.toBe(await derive("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", pyusd));
  });
});

type RpcBody = {method: string; params: unknown[]};
/** Solana JSON-RPC by URL; `account(ata)` answers getMultipleAccounts entries. */
function solanaRpc(handler: (url: string, body: RpcBody) => {status?: number; json: unknown}) {
  const seen: {url: string; body: RpcBody}[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as RpcBody;
      seen.push({url, body});
      const r = handler(url, body);
      const status = r.status ?? 200;
      return {ok: status < 300, status, json: async () => r.json} as Response;
    }),
  );
  return seen;
}

const tokenAccount = (mint: string, owner: string, amount: string) => ({
  owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  data: {program: "spl-token", parsed: {type: "account", info: {mint, owner, tokenAmount: {amount, decimals: 6}}}},
});

describe("readSolanaBalances", () => {
  const tokens = tokensOf("solana");
  const usdc = tokens.find((t) => t.symbol === "USDC")!;
  const usdt = tokens.find((t) => t.symbol === "USDT")!;
  const pyusd = tokens.find((t) => t.symbol === "PYUSD")!;
  const usde = tokens.find((t) => t.symbol === "USDe")!;

  it("reads SOL plus the derived ATAs, ≤ 10 accounts per call, and decodes each", async () => {
    const atas = new Map<string, string>();
    for (const t of tokens.filter((x) => x.contract)) atas.set(await ataOf(SOL_OWNER, t.contract!), t.contract!);
    const seen = solanaRpc((_url, body) => {
      if (body.method === "getBalance") return {json: {jsonrpc: "2.0", id: 1, result: {context: {slot: 1}, value: 3_200_000_000}}};
      const [list] = body.params as [string[]];
      const value = list.map((ata) => {
        const mint = atas.get(ata)!;
        if (mint === usdc.contract) return tokenAccount(mint, SOL_OWNER, "85500000");
        if (mint === pyusd.contract) return tokenAccount(mint, SOL_OWNER, "1000000");
        if (mint === usdt.contract) return tokenAccount("So11111111111111111111111111111111111111112", SOL_OWNER, "5"); // wrong mint
        if (mint === usde.contract) return {owner: "x", data: ["AAAA", "base64"]}; // unparsed
        return null; // no ATA
      });
      return {json: {jsonrpc: "2.0", id: 1, result: {context: {slot: 1}, value}}};
    });
    const out = await readSolanaBalances(SOL_OWNER, tokens);

    const gma = seen.filter((s) => s.body.method === "getMultipleAccounts");
    expect(gma.map((s) => (s.body.params[0] as string[]).length)).toEqual([10, 3]);
    expect(gma.flatMap((s) => s.body.params[0] as string[])).toEqual([...atas.keys()]);
    expect(gma[0]!.body.params[1]).toMatchObject({encoding: "jsonParsed"});
    expect(seen.every((s) => s.url === DEFAULT_RUNTIME_CONFIG.solanaRpc[0])).toBe(true);
    expect(seen.some((s) => s.body.method === "getTokenAccountsByOwner")).toBe(false);

    expect(out["solana:native"]).toBe(3_200_000_000n);
    expect(out[usdc.key]).toBe(85_500_000n);
    expect(out[pyusd.key]).toBe(1_000_000n);
    expect(out[usdt.key]).toBeNull();
    expect(out[usde.key]).toBeNull();
    expect(out[tokens.find((t) => t.symbol === "LINK")!.key]).toBe(0n);
    expect(Object.keys(out)).toHaveLength(tokens.length);
  });

  it("refuses a token account owned by someone else", async () => {
    solanaRpc((_u, body) =>
      body.method === "getBalance"
        ? {json: {result: {value: 0}}}
        : {json: {result: {value: (body.params[0] as string[]).map(() => tokenAccount(usdc.contract!, "SomeoneElse1111111111111111111111111111111", "9"))}}},
    );
    const out = await readSolanaBalances(SOL_OWNER, [usdc]);
    expect(out[usdc.key]).toBeNull();
  });

  it("treats a short page as unknown rather than shifting balances onto the wrong tokens", async () => {
    solanaRpc((_u, body) =>
      body.method === "getBalance" ? {json: {result: {value: 1}}} : {json: {result: {value: [tokenAccount(usdc.contract!, SOL_OWNER, "7")]}}},
    );
    const out = await readSolanaBalances(SOL_OWNER, tokens);
    expect(tokens.filter((t) => t.contract).every((t) => out[t.key] === null)).toBe(true);
  });

  it("falls through to the next runtime RPC on an HTTP or JSON-RPC error, throws when all fail", async () => {
    const [first, second] = DEFAULT_RUNTIME_CONFIG.solanaRpc;
    const seen = solanaRpc((url, body) => {
      if (url === first) return body.method === "getBalance" ? {status: 403, json: {error: {message: "Request blocked"}}} : {json: {error: {code: -32600, message: "nope"}}};
      return body.method === "getBalance" ? {json: {result: {value: 42}}} : {json: {result: {value: (body.params[0] as string[]).map(() => null)}}};
    });
    const out = await readSolanaBalances(SOL_OWNER, tokens);
    expect(out["solana:native"]).toBe(42n);
    expect(seen.filter((s) => s.url === second).length).toBe(3);

    solanaRpc(() => ({status: 503, json: null}));
    await expect(readSolanaBalances(SOL_OWNER, tokens)).rejects.toThrow();
  });
});

describe("readNearBalances", () => {
  const tokens = tokensOf("near");
  const usdt = tokens.find((t) => t.symbol === "USDT")!;
  const usdc = tokens.find((t) => t.symbol === "USDC")!;
  const NEAR_RPC = "https://rpc.mainnet.fastnear.com";
  const viewArgs = (body: RpcBody) => {
    const p = body.params as unknown as {args_base64: string};
    return JSON.parse(atob(p.args_base64)) as unknown;
  };
  const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))];

  it("reads spendable NEAR (total − locked − storage) and each NEP-141 with ft_balance_of over the NEAR RPC", async () => {
    const seen = solanaRpc((_url, body) => {
      const p = body.params as unknown as {request_type: string; account_id: string; method_name?: string};
      if (p.request_type === "view_account") return {json: {result: {amount: "3000000000000000000000000", locked: "1000000000000000000000000", storage_usage: 182}}};
      if (p.account_id === usdt.contract) return {json: {result: {result: bytes("5000000")}}};
      if (p.account_id === usdc.contract) return {json: {result: {error: "wasm execution failed"}}};
      return {json: {result: {result: bytes("0")}}};
    });
    const out = await readNearBalances("alice.near", tokens);
    expect(seen.every((s) => s.url === NEAR_RPC && s.body.method === "query")).toBe(true);
    expect(seen.filter((s) => (s.body.params as unknown as {method_name?: string}).method_name === "ft_balance_of").map((s) => viewArgs(s.body))).toContainEqual({account_id: "alice.near"});
    expect(out["near:native"]).toBe(2_000_000_000_000_000_000_000_000n - 182n * 10n ** 19n);
    expect(out[usdt.key]).toBe(5_000_000n);
    expect(out[usdc.key]).toBeNull();
    expect(Object.keys(out)).toHaveLength(tokens.length);
  });

  it("an account that doesn't exist yet holds nothing; a NEAR read that fails everywhere throws", async () => {
    solanaRpc((_u, body) =>
      (body.params as unknown as {request_type: string}).request_type === "view_account"
        ? {json: {error: {name: "HANDLER_ERROR", cause: {name: "UNKNOWN_ACCOUNT"}}}}
        : {json: {result: {result: bytes("0")}}},
    );
    const out = await readNearBalances("e".repeat(64), tokens);
    expect(out["near:native"]).toBe(0n);
    expect(out[usdt.key]).toBe(0n);
    solanaRpc(() => ({status: 503, json: null}));
    await expect(readNearBalances("alice.near", tokens)).rejects.toThrow();
  });

  it("asks the runtime config's NEAR list only; an emptied list asks nothing (D8)", async () => {
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, nearRpc: ["https://near.example"]});
    const seen = solanaRpc(() => ({json: {result: {amount: "0", locked: "0", storage_usage: 0, result: bytes("0")}}}));
    await readNearBalances("alice.near", tokens);
    expect(new Set(seen.map((s) => s.url))).toEqual(new Set(["https://near.example"]));
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, nearRpc: []});
    const none = solanaRpc(() => ({json: null}));
    await expect(readNearBalances("alice.near", tokens)).rejects.toThrow(/No NEAR RPC/);
    expect(none).toEqual([]);
  });
});

// ── orchestration ────────────────────────────────────────────────────────────────────────────────────────────────

describe("balanceSpecs", () => {
  it("reads every EVM chain for an EVM owner and Solana for a Solana owner", () => {
    expect(balanceSpecs({})).toEqual([]);
    const evm = balanceSpecs({evm: EVM_OWNER});
    expect(evm).toHaveLength(31);
    expect(evm.every((s) => s.family === "evm" && s.owner === EVM_OWNER && s.tokens.length > 0)).toBe(true);
    expect(evm.find((s) => s.slug === "elysium")).toMatchObject({chainId: 99901});
    const both = balanceSpecs({evm: EVM_OWNER, solana: SOL_OWNER});
    expect(both).toHaveLength(32);
    expect(both.find((s) => s.family === "solana")).toMatchObject({slug: "solana", owner: SOL_OWNER});
    expect(balanceSpecs({near: "alice.near"})).toEqual([expect.objectContaining({family: "near", slug: "near", owner: "alice.near"})]);
    // No reader for these families: nothing is fetched for them.
    expect(balanceSpecs({btc: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"})).toEqual([]);
    expect(balanceSpecs({tron: TRON_OWNER})).toEqual([expect.objectContaining({family: "tron", slug: "tron", owner: TRON_OWNER})]);
  });
});

describe("readTronBalances", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The Tron API: answers per path, recording each call (host, path, body). */
  const tronApi = (answer: (host: string, path: string, body: Record<string, unknown>) => {status: number; json: unknown}) => {
    const calls: {host: string; path: string; body: Record<string, unknown>}[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const u = new URL(input);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({host: u.host, path: u.pathname, body});
        const a = answer(u.host, u.pathname, body);
        return new Response(JSON.stringify(a.json), {status: a.status});
      }),
    );
    return calls;
  };
  const tokens = tokensOf("tron");

  it("TRX from getaccount, USDT from balanceOf(owner); an unseen account is 0 TRX", async () => {
    const calls = tronApi((_h, path) =>
      path === "/wallet/getaccount"
        ? {status: 200, json: {}}
        : {status: 200, json: {result: {result: true}, constant_result: ["0".repeat(56) + "05f5e100"], transaction: {ret: [{}]}}},
    );
    const out = await readTronBalances(TRON_OWNER, tokens, ["https://tron.test"]);
    expect(out).toEqual({"tron:native": 0n, [tokens.find((t) => t.contract)!.key]: 100_000_000n});
    const call = calls.find((c) => c.path === "/wallet/triggerconstantcontract")!;
    expect(call.body).toMatchObject({owner_address: TRON_OWNER, contract_address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", function_selector: "balanceOf(address)", visible: true});
    // The owner's 20 address bytes (TV6Mu… = 41 d1c4…af2e), left-padded to a 32-byte word.
    expect(call.body.parameter).toBe(`${"0".repeat(24)}d1c4bb7b2f39aba5707711719b2236b5b605af2e`);
  });

  it("moves to the next host on a failure; a reverted read is unknown, never 0", async () => {
    tronApi((host, path) =>
      host === "a.tron.test"
        ? {status: 503, json: null}
        : path === "/wallet/getaccount"
          ? {status: 200, json: {balance: 7}}
          : {status: 200, json: {result: {result: true}, transaction: {ret: [{ret: "FAILED"}]}}},
    );
    const out = await readTronBalances(TRON_OWNER, tokens, ["https://a.tron.test", "https://b.tron.test"]);
    expect(Object.values(out).sort()).toEqual([7n, null]);
  });
});

describe("mergeBalances", () => {
  const tok = (key: string) => ({key}) as Token;
  const spec = (slug: string, keys: string[]): BalanceSpec => ({family: "evm", slug, chainId: 1, owner: EVM_OWNER, tokens: keys.map(tok)});
  const specs = [spec("a", ["a:1", "a:2"]), spec("b", ["b:1"]), spec("c", ["c:1"]), spec("d", ["d:1"])];

  it("loaded, null → error, failed first read → error, pending → loading; data survives a failed refetch", () => {
    const results: BalanceResult[] = [
      {data: {"a:1": "100", "a:2": null}, isError: false, isPending: false},
      {data: undefined, isError: true, isPending: false},
      {data: undefined, isError: false, isPending: true},
      {data: {"d:1": "7"}, isError: true, isPending: false},
    ];
    const {byKey, loading} = mergeBalances(specs, results);
    expect(byKey).toEqual({
      "a:1": {amount: "100", state: "loaded"},
      "a:2": {amount: "0", state: "error"},
      "b:1": {amount: "0", state: "error"},
      "c:1": {amount: "0", state: "loading"},
      "d:1": {amount: "7", state: "loaded"},
    });
    expect(loading).toBe(true);
  });

  it("is not loading once every read answered", () => {
    const results: BalanceResult[] = specs.map(() => ({data: {}, isError: false, isPending: false}));
    expect(mergeBalances(specs, results).loading).toBe(false);
    // A key the read did not return is unknown, not zero.
    expect(mergeBalances(specs, results).byKey["a:1"]).toEqual({amount: "0", state: "error"});
  });
});

// ── TON ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("readTonBalances", () => {
  const TON_OWNER = "UQAj-peZGPH-cC25EAv4Q-h8cBXszTmkch6ba6wXC8BM40qt";
  const RAW = "0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3";
  const USDT_MASTER = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
  const tokens = tokensOf("ton");
  const usdt = tokens.find((t) => t.symbol === "USDT")!;
  const native = tokens.find((t) => t.contract === null)!;

  it("reads TON (precision kept) and the catalog jettons by master, one TonAPI call each, for the raw address", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u));
      if (String(u).endsWith("/jettons"))
        return new Response(JSON.stringify({balances: [{balance: "929188090649245", jetton: {address: USDT_MASTER}}, {balance: "5", jetton: {address: `0:${"ee".repeat(32)}`}}]}));
      return new Response(`{"address":"${RAW}","balance":90071992547409931,"status":"active"}`);
    });
    const out = await readTonBalances(TON_OWNER, tokens, {base: "https://tonapi.invalid/", fetch: fetchImpl as unknown as typeof fetch});
    expect(urls).toEqual([`https://tonapi.invalid/v2/accounts/${encodeURIComponent(RAW)}`, `https://tonapi.invalid/v2/accounts/${encodeURIComponent(RAW)}/jettons`]);
    expect(out[native.key]).toBe(90071992547409931n);
    expect(out[usdt.key]).toBe(929188090649245n);
    expect(tokens.filter((t) => t.contract !== null && t !== usdt).every((t) => out[t.key] === 0n)).toBe(true);
  });

  it("marks what failed unknown (never 0), and throws when TonAPI answered nothing", async () => {
    const half = vi.fn(async (u: string | URL | Request) => (String(u).endsWith("/jettons") ? new Response("", {status: 429}) : new Response(`{"balance":7}`)));
    const out = await readTonBalances(TON_OWNER, tokens, {base: "https://tonapi.invalid", fetch: half as unknown as typeof fetch});
    expect(out[native.key]).toBe(7n);
    expect(out[usdt.key]).toBeNull();
    const none = vi.fn(async () => new Response("", {status: 500}));
    await expect(readTonBalances(TON_OWNER, tokens, {base: "https://tonapi.invalid", fetch: none as unknown as typeof fetch})).rejects.toThrow();
  });

  it("is asked only for a connected TON wallet", () => {
    expect(balanceSpecs({}).some((s) => s.family === "ton")).toBe(false);
    expect(balanceSpecs({ton: TON_OWNER}).filter((s) => s.family === "ton").map((s) => s.slug)).toEqual(["ton"]);
  });
});
