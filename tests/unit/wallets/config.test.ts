import {afterEach, describe, expect, it} from "vitest";
import {evmRpcUrls, toViemChain, VIEM_CHAINS} from "../../../src/catalog";
import {DEFAULT_RUNTIME_CONFIG, setRuntimeConfig, standardSlots} from "../../../src/config";
import {chainBySlug} from "../../../src/shared";
import {createWalletsController} from "../../../src/wallets/controller";
import {createWagmiConfig, evmTransport, wagmiParameters} from "../../../src/wallets/evm/config";
import {memoryKeyValue, wagmiStorage} from "../../../src/wallets/storage";
import {appConnectors, controllerDeps, fakeEip1193, flush, ICON, OWNER_CHECKSUM, testWallet} from "./fakes";

/** Every key of an object graph (cycles and functions skipped). */
function keysDeep(v: unknown, seen = new Set<unknown>()): string[] {
  if (!v || typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  return Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x, seen)]);
}

describe("wagmi config", () => {
  const params = wagmiParameters({chains: VIEM_CHAINS, rpcUrls: evmRpcUrls, storage: null});

  it("covers every catalog EVM chain, Elysium included, with our transports", () => {
    const ids = VIEM_CHAINS.map((c) => c.id);
    expect(ids).toContain(99901);
    expect(params.chains).toBe(VIEM_CHAINS);
    expect(Object.keys(params.transports!).map(Number).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    expect(params.multiInjectedProviderDiscovery).toBe(true);
    expect(params.ssr).toBe(false);
  });

  it("reads through the runtime config's RPC list, in order", () => {
    const t = params.transports![1]!({chain: VIEM_CHAINS.find((c) => c.id === 1)});
    const urls = (t.value as {transports: {value?: {url?: string}}[]}).transports.map((x) => x.value?.url);
    expect(urls).toEqual([...evmRpcUrls(1)]);
    expect(urls.length).toBeGreaterThan(0);
    expect(evmTransport([])({chain: VIEM_CHAINS[0]}).config.type).toBe("http");
  });

  it("has no dataSuffix anywhere and no SDK or WalletConnect connector at startup", () => {
    expect(keysDeep(params)).not.toContain("dataSuffix");
    const config = createWagmiConfig({...params, multiInjectedProviderDiscovery: false});
    expect(config.connectors.map((c) => c.type)).toEqual(["injected"]);
    expect(config.connectors[0]!.id).toBe("injected");
    const client = config.getClient({chainId: 1}) as {dataSuffix?: unknown};
    expect(client.dataSuffix).toBeUndefined();
  });
});

describe("cp0x's proxy never reaches a wallet (D30)", () => {
  afterEach(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG));
  const API = "https://cp0x-api.example.org";

  it("Standard puts the proxy first for our own reads, but strips it from the chain definition and wagmi's transports", () => {
    const {config, plan} = standardSlots(DEFAULT_RUNTIME_CONFIG, API);
    setRuntimeConfig(config, undefined, {mode: "standard", api: API, plan, keys: {}});
    const proxy = `${API}/api/v2/swap-web/rpc/8453`;
    expect(evmRpcUrls(8453)[0]).toBe(proxy);
    // The chain definition: what wagmi's switchChain hands wallet_addEthereumChain.
    const base = toViemChain(chainBySlug("base")!);
    expect(base.rpcUrls.default.http).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[8453]);
    // wagmi's transports: WalletConnect's rpcMap takes each chain's first transport URL from them.
    const params = wagmiParameters({chains: VIEM_CHAINS, rpcUrls: evmRpcUrls, storage: null});
    for (const id of [1, 8453, 99901]) {
      const t = params.transports![id]!({chain: VIEM_CHAINS.find((c) => c.id === id)});
      const urls = (t.value as {transports: {value?: {url?: string}}[]}).transports.map((x) => x.value?.url);
      expect(urls).toEqual(DEFAULT_RUNTIME_CONFIG.evmRpc[id]);
    }
  });

  it("a viewer's own Custom RPC stays in the definition (their wallet may use it, as before)", () => {
    setRuntimeConfig({...DEFAULT_RUNTIME_CONFIG, evmRpc: {...DEFAULT_RUNTIME_CONFIG.evmRpc, 8453: ["https://my-node.example", ...DEFAULT_RUNTIME_CONFIG.evmRpc[8453]!]}});
    expect(toViemChain(chainBySlug("base")!).rpcUrls.default.http[0]).toBe("https://my-node.example");
  });
});

describe("EIP-6963 discovery", () => {
  afterEach(() => {
    delete (window as Window & {ethereum?: unknown}).ethereum;
  });

  it("lists a wallet that announces itself after boot, by rdns with its icon", async () => {
    const c = createWalletsController(controllerDeps({discovery: true, connectors: appConnectors()}));
    c.start();
    await flush();
    expect(c.getState().options.filter((o) => o.family === "evm")).toEqual([]);
    const detail = Object.freeze({info: {uuid: "0b6c9f9a-1b55-4b1a-9c5e-0d0d6f7f0001", name: "Rabby Wallet", icon: ICON, rdns: "io.rabby"}, provider: fakeEip1193()});
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {detail}));
    await flush();
    expect(c.getState().options.filter((o) => o.family === "evm")).toEqual([{id: "io.rabby", family: "evm", name: "Rabby Wallet", icon: ICON, kind: "injected"}]);
  });

  it("offers window.ethereum as 'Browser wallet' when nothing announces", async () => {
    const c = createWalletsController(controllerDeps({legacyInjected: true, connectors: appConnectors()}));
    c.start();
    await flush();
    expect(c.getState().options.filter((o) => o.family === "evm")).toEqual([{id: "injected", family: "evm", name: "Browser wallet", kind: "injected"}]);
  });
});

describe("silent reconnect on reload", () => {
  it("restores the injected wallet from wagmi's persisted store without a prompt", async () => {
    const kv = memoryKeyValue();
    const first = fakeEip1193();
    const a = createWalletsController(controllerDeps({storage: wagmiStorage(kv), connectors: [testWallet(first)]}));
    a.start();
    await flush();
    await a.connect("io.test.wallet");
    expect(a.getState().evm?.address).toBe(OWNER_CHECKSUM);
    expect(kv.get("cp0x.wagmi.store")).toContain(OWNER_CHECKSUM);

    // Reload: a new page, the same storage, the wallet still trusts the site.
    const again = fakeEip1193({authorized: true});
    const b = createWalletsController(controllerDeps({storage: wagmiStorage(kv), connectors: [testWallet(again)]}));
    b.start();
    await b.evm.ready();
    expect(b.getState().evm).toMatchObject({address: OWNER_CHECKSUM, walletName: "Test Wallet"});
    expect(again.requests).not.toContain("eth_requestAccounts");
    expect(again.requests).not.toContain("wallet_requestPermissions");
  });

  it("stays disconnected after an explicit disconnect", async () => {
    const kv = memoryKeyValue();
    const a = createWalletsController(controllerDeps({storage: wagmiStorage(kv), connectors: [testWallet(fakeEip1193())]}));
    a.start();
    await flush();
    await a.connect("io.test.wallet");
    await a.disconnect("evm");
    const b = createWalletsController(controllerDeps({storage: wagmiStorage(kv), connectors: [testWallet(fakeEip1193({authorized: true}))]}));
    b.start();
    await b.evm.ready();
    expect(b.getState().evm).toBeNull();
  });
});
