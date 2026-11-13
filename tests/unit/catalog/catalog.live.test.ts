// Opt-in live checks (LIVE=1 pnpm exec vitest run tests/unit/catalog/catalog.live.test.ts): read-only calls to the
// public price API and RPCs this module depends on (catalog.md Appendix B). Never part of the default run.
import {CC_SOURCE_CHAINS} from "@anywalletkit/swap2-assets";
import {describe, expect, it} from "vitest";
import {
  PRICE_IDS,
  TOKEN_2022_MINTS,
  ataOf,
  balanceSpecs,
  evmRpcUrls,
  multicallAddress,
  publicClient,
  readSolanaBalances,
  tokensOf,
} from "../../../src/catalog";
import {readBalances} from "../../../src/catalog/balances";
import {fromLlama} from "../../../src/catalog/prices";
import {DEFAULT_RUNTIME_CONFIG} from "../../../src/config";
import {EVM_CHAINS} from "../../../src/shared";

const LIVE = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env?.LIVE === "1";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params})});
  const j = (await res.json()) as {result?: T; error?: {message?: string}};
  if (j.result === undefined) throw new Error(`${url} ${method}: ${j.error?.message ?? res.status}`);
  return j.result;
}

/** The runtime Solana RPCs in order, first answer wins (publicnode rate-limits shared IPs). */
async function solana<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (const url of DEFAULT_RUNTIME_CONFIG.solanaRpc) {
    try {
      return await rpc<T>(url, method, params);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

describe.skipIf(!LIVE)("live: prices", () => {
  it("prices every PRICE_IDS key on DefiLlama", async () => {
    const p = await fromLlama();
    expect(Object.keys(PRICE_IDS).filter((s) => !(s in p))).toEqual([]);
  });
});

describe.skipIf(!LIVE)("live: Solana", () => {
  const mints = CC_SOURCE_CHAINS.find((c) => c.caip2 === "solana:mainnet")!.assets.flatMap((a) => (a.contract ? [a.contract] : []));

  it("TOKEN_2022_MINTS is exactly the catalog mints owned by Token-2022", async () => {
    const owners: string[] = [];
    for (let i = 0; i < mints.length; i += 10) {
      const page = await solana<{value: ({owner: string} | null)[]}>("getMultipleAccounts", [mints.slice(i, i + 10), {encoding: "base64", dataSlice: {offset: 0, length: 0}}]);
      owners.push(...page.value.map((v) => v?.owner ?? "missing"));
    }
    expect(mints.filter((_, i) => owners[i] === TOKEN_2022).sort()).toEqual([...TOKEN_2022_MINTS].sort());
  }, 30_000);

  it("derives real ATAs (classic and Token-2022) and reads a holder's balance through them", async () => {
    for (const symbol of ["USDC", "PYUSD"]) {
      const token = tokensOf("solana").find((t) => t.symbol === symbol)!;
      // getTokenLargestAccounts is an indexed method: publicnode refuses it, solanavibestation serves it.
      const largest = await rpc<{value: {address: string}[]}>("https://public.rpc.solanavibestation.com", "getTokenLargestAccounts", [token.contract]);
      const accounts = await solana<{value: ({data: {parsed: {info: {owner: string; mint: string}}}} | null)[]}>("getMultipleAccounts", [
        largest.value.slice(0, 10).map((a) => a.address),
        {encoding: "jsonParsed"},
      ]);
      let matched: string | null = null;
      for (const [i, acc] of accounts.value.entries()) {
        const owner = acc?.data.parsed.info.owner;
        if (owner && (await ataOf(owner, token.contract!)) === largest.value[i]!.address) {
          matched = owner;
          break;
        }
      }
      expect(matched, `${symbol}: no top holder's account is its derived ATA`).not.toBeNull();
      const out = await readSolanaBalances(matched!, tokensOf("solana"));
      expect(out[token.key], symbol).toBeTypeOf("bigint");
      expect(out[token.key]! > 0n, symbol).toBe(true);
    }
  }, 60_000);
});

describe.skipIf(!LIVE)("live: EVM", () => {
  it("every runtime RPC answers eth_chainId with its chain id", async () => {
    const wrong: string[] = [];
    await Promise.all(
      EVM_CHAINS.flatMap((c) =>
        evmRpcUrls(c.chainId!).map(async (url) => {
          try {
            const id = await rpc<string>(url, "eth_chainId", []);
            if (Number(id) !== c.chainId) wrong.push(`${c.slug} ${url} → ${id}`);
          } catch (e) {
            wrong.push(`${c.slug} ${url} → ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      ),
    );
    expect(wrong).toEqual([]);
  }, 60_000);

  it("Multicall3 is deployed at our address on every EVM chain", async () => {
    const missing: string[] = [];
    await Promise.all(
      EVM_CHAINS.map(async (c) => {
        const code = await publicClient(c.chainId!).getCode({address: multicallAddress(c.slug)});
        if (!code || code === "0x") missing.push(c.slug);
      }),
    );
    expect(missing).toEqual([]);
  }, 60_000);

  it("reads a known address's Ethereum balances in one multicall", async () => {
    const spec = balanceSpecs({evm: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}).find((s) => s.slug === "ethereum")!;
    const out = await readBalances(spec);
    expect(BigInt(out["ethereum:native"]!)).toBeGreaterThan(0n);
    expect(Object.values(out).filter((v) => v === null)).toEqual([]);
  }, 30_000);
});
