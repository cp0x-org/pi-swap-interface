// Which page builds Fynd (D3, D30), the way a page decides it: startConnection() for the page's mode, then
// buildProviders() with its default extras, whose `fynd` is standardFynd(). Only a Standard page with Fynd on gets the
// slot (at the proxy, live once health keys it); Public and Custom never build Fynd and install no routing fetch.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ConnectionMode} from "../../../src/contracts/config";

const API = "https://cp0x-api.example.org";
const HEALTH = {
  venues: {lifi: "anonymous", relay: "anonymous", near_intents: "anonymous", jupiter: "anonymous", fynd: "keyed"},
  rpc: {configured: false, chains: []},
  thornode: false,
};
const realFetch = globalThis.fetch;
const pair = [{chain: "eip155:1", token: "USDC"}, {chain: "eip155:1", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7"}] as const;

/** A fresh page (module state included) in `mode`, booted the way main.tsx boots it, its health answering `fynd` (and `lifi`). */
async function boot(mode: ConnectionMode, opts: {fynd?: boolean; health?: "keyed" | "anonymous"; lifi?: "keyed" | "anonymous"} = {}) {
  vi.resetModules();
  const health = {...HEALTH, venues: {...HEALTH.venues, fynd: opts.health ?? "keyed", lifi: opts.lifi ?? "anonymous"}};
  const sent: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(JSON.stringify(health), {status: 200, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
  const cfg = await import("../../../src/config");
  const {buildProviders} = await import("../../../src/swap/providers");
  const base = opts.fynd === false ? {...cfg.DEFAULT_RUNTIME_CONFIG, providers: {...cfg.DEFAULT_RUNTIME_CONFIG.providers, fynd: false}} : cfg.DEFAULT_RUNTIME_CONFIG;
  if (mode === "standard") {
    const {config, plan} = cfg.standardSlots(base, API);
    cfg.setRuntimeConfig(config, undefined, {mode, api: API, plan, keys: {}});
  } else {
    cfg.setRuntimeConfig(base, undefined, {mode, api: API, plan: null, keys: mode === "custom" ? {lifi: "test-lifi"} : {}});
  }
  cfg.startConnection();
  if (mode === "standard") await vi.waitFor(() => expect(cfg.connectionStatus().health).toBe("ok"));
  return {cfg, sent, build: () => buildProviders()};
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the page's Fynd slot (standardFynd) and buildProviders' default extras", () => {
  it("Standard with Fynd keyed: the slot at the proxy, live, and Fynd built and routing", async () => {
    const {cfg, build} = await boot("standard");
    const slot = cfg.standardFynd();
    expect(slot?.base).toBe(`${API}/api/v2/swap-web/venue/fynd`);
    expect(slot?.live()).toBe(true);
    const fynd = build().find((p) => p.name === "fynd");
    expect(fynd?.supportsRoute(...pair)).toBe(true);
  });

  it("Standard without cp0x's Fynd key: built (the slot exists) but never routes", async () => {
    const {cfg, build} = await boot("standard", {health: "anonymous"});
    expect(cfg.standardFynd()?.live()).toBe(false);
    const fynd = build().find((p) => p.name === "fynd");
    expect(fynd?.supportsRoute(...pair)).toBe(false);
  });

  it("Standard with Fynd switched off: no slot, not built", async () => {
    const {cfg, build} = await boot("standard", {fynd: false});
    expect(cfg.standardFynd()).toBeUndefined();
    expect(build().map((p) => p.name)).not.toContain("fynd");
  });

  it.each(["public", "custom"] as const)("%s: no slot, Fynd not built, no routing fetch and no cp0x request", async (mode) => {
    const {cfg, sent, build} = await boot(mode);
    expect(cfg.standardFynd()).toBeUndefined();
    expect(cfg.standardFetch()).toBeUndefined();
    const names = build().map((p) => p.name);
    expect(names).toContain("curve");
    expect(names).not.toContain("fynd");
    expect(sent).toEqual([]);
  });
});

// What a preview round reads per round (D7): cp0x's proxy carries LI.FI and Fynd with cp0x's key only on a Standard
// page whose health keys them; every other page leaves both for the live quote and contacts no cp0x host for it.
describe("preview liveness per page (proxyVenueLive, proxySettled)", () => {
  it("Standard: live exactly for the venues health keys and the page has a slot for; settled once health answered", async () => {
    const {cfg} = await boot("standard", {lifi: "keyed"});
    await cfg.proxySettled();
    expect(cfg.proxyVenueLive("lifi")).toBe(true);
    expect(cfg.proxyVenueLive("fynd")).toBe(true);
    expect(cfg.proxyVenueLive("relay")).toBe(false);
    expect(cfg.proxyVenueLive("uniswap")).toBe(false);
  });

  it("Standard with LI.FI and Fynd anonymous at cp0x: neither is live", async () => {
    const {cfg} = await boot("standard", {lifi: "anonymous", health: "anonymous"});
    await cfg.proxySettled();
    expect(cfg.proxyVenueLive("lifi")).toBe(false);
    expect(cfg.proxyVenueLive("fynd")).toBe(false);
  });

  it.each(["public", "custom"] as const)("%s: never live (a Custom LI.FI key included), settled at once, nothing sent", async (mode) => {
    const {cfg, sent} = await boot(mode, {lifi: "keyed"});
    await cfg.proxySettled();
    expect(cfg.proxyVenueLive("lifi")).toBe(false);
    expect(cfg.proxyVenueLive("fynd")).toBe(false);
    expect(sent).toEqual([]);
  });
});
