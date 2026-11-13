// @vitest-environment node
/**
 * Live dry-quote smoke (opt-in: SWAP_LIVE=1). Proves the real wiring end to end — buildProviders over the default
 * runtime config, the page engine, gas from a public RPC, prices from DefiLlama — with ONE round:
 * Arbitrum USDC → Base USDC, 5 USDC, dest/refund = Anvil test account #1. Dry quotes only: nothing is built, signed or
 * sent. Node has no CORS, so this does not prove browser CORS (providers.md §2.4 / §8 measured that).
 */
import {describe, expect, it} from "vitest";
import type {RouteSnapshot} from "../../../src/contracts/routes";
import {appProviders, quoteRoutes} from "../../../src/swap/engine";
import {request} from "./fixtures";

const LIVE = process.env.SWAP_LIVE === "1";

describe.skipIf(!LIVE)("live dry quote", () => {
  it("Arbitrum USDC → Base USDC, 5 USDC", async () => {
    const res = await fetch("https://coins.llama.fi/prices/current/coingecko:ethereum,coingecko:usd-coin");
    const {coins} = (await res.json()) as {coins: Record<string, {price: number}>};
    const prices = {ETH: coins["coingecko:ethereum"]!.price, USDC: coins["coingecko:usd-coin"]!.price};

    const started = Date.now();
    const firstSeen: Record<string, number> = {};
    const updates: RouteSnapshot[] = [];
    const final = await quoteRoutes(
      {mode: "live", req: request()},
      (s) => {
        updates.push(s);
        for (const r of s.routes) firstSeen[r.provider] ??= Date.now() - started;
      },
      prices,
    );

    expect(final).not.toBeNull();
    const rows = final!.routes.map((r) => ({
      provider: r.provider,
      firstMs: firstSeen[r.provider],
      out: r.destAmount.toString(),
      min: r.minDestAmount.toString(),
      eta: r.etaSeconds,
      tags: r.tags.join(","),
      gasUsd: r.gasUsd?.toFixed(4) ?? null,
      netUsd: r.netValueUsd?.toFixed(4) ?? null,
      spender: r.approvalSpender,
      execution: r.execution,
      trust: r.trust,
    }));
    const report = {
      built: appProviders().map((p) => p.name),
      asked: final!.asked,
      totalMs: Date.now() - started,
      updates: updates.map((u) => ({routes: u.routes.map((r) => r.provider), pending: u.pending, rejected: u.rejections.map((r) => r.provider)})),
      prices,
      routes: rows,
      rejections: final!.rejections,
    };
    console.log(JSON.stringify(report, null, 2));
    if (process.env.SWAP_LIVE_OUT) (await import("node:fs")).writeFileSync(process.env.SWAP_LIVE_OUT, JSON.stringify(report, null, 2));

    expect(updates[0]!.pending).toEqual(final!.asked);
    expect(final!.pending).toEqual([]);
    expect(final!.routes.length).toBeGreaterThan(0);
    // Every asked venue either quoted or said why.
    const answered = new Set([...final!.routes.map((r) => r.provider), ...final!.rejections.map((r) => r.provider)]);
    for (const p of final!.asked) expect(answered.has(p)).toBe(true);
    // ERC-20 source: every calldata route names the spender it needs.
    for (const r of final!.routes) if (r.execution === "calldata") expect(r.approvalSpender).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 40_000);
});
