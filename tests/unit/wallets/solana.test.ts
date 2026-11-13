import {getWallets} from "@wallet-standard/app";
import {describe, expect, it} from "vitest";
import {createWalletsController} from "../../../src/wallets/controller";
import {createSolanaRuntime} from "../../../src/wallets/solana/runtime";
import {pickSolanaAccount, solanaOptions, solanaUnsupported} from "../../../src/wallets/solana/standard";
import {createWalletsStore} from "../../../src/wallets/state";
import {memoryKeyValue, SOLANA_WALLET_KEY} from "../../../src/wallets/storage";
import {controllerDeps, fakeRegistry, fakeSolanaWallet, flush, ICON, solAccount} from "./fakes";

describe("which Solana wallets are listed", () => {
  it("needs mainnet, standard:connect and solana:signTransaction with v0", () => {
    expect(solanaUnsupported(fakeSolanaWallet().wallet)).toBeNull();
    expect(solanaUnsupported(fakeSolanaWallet({signTransaction: false}).wallet)).toBe("no solana:signTransaction");
    expect(solanaUnsupported(fakeSolanaWallet({versions: ["legacy"]}).wallet)).toBe("no v0 transactions");
    expect(solanaUnsupported(fakeSolanaWallet({chains: ["solana:devnet"]}).wallet)).toBe("not on Solana mainnet");
    expect(solanaUnsupported(fakeSolanaWallet({chains: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]}).wallet)).toBeNull();
    const noConnect = fakeSolanaWallet().wallet;
    const {"standard:connect": _c, ...rest} = noConnect.features as Record<string, unknown>;
    expect(solanaUnsupported({...noConnect, features: rest as typeof noConnect.features})).toBe("no standard:connect");
  });

  it("hides unusable wallets, dedupes by name, keeps data icons only", () => {
    const out = solanaOptions([
      fakeSolanaWallet({name: "Phantom"}).wallet,
      fakeSolanaWallet({name: "Phantom"}).wallet,
      fakeSolanaWallet({name: "SignAndSendOnly", signTransaction: false}).wallet,
      fakeSolanaWallet({name: "LegacyOnly", versions: ["legacy"]}).wallet,
      fakeSolanaWallet({name: "Remote", icon: "https://cdn.example/icon.png"}).wallet,
    ]);
    expect(out).toEqual([
      {id: "Phantom", family: "solana", name: "Phantom", icon: ICON, kind: "wallet-standard"},
      {id: "Remote", family: "solana", name: "Remote", kind: "wallet-standard"},
    ]);
  });

  it("picks a mainnet account, preferring the connected address", () => {
    const a = solAccount("A111");
    const b = solAccount("B222");
    const devnet = solAccount("D333", ["solana:devnet"]);
    expect(pickSolanaAccount([devnet, a, b])).toBe(a);
    expect(pickSolanaAccount([a, b], "B222")).toBe(b);
    expect(pickSolanaAccount([devnet])).toBeUndefined();
  });
});

describe("Solana connection", () => {
  const setup = (seed: Record<string, string> = {}) => {
    const registry = fakeRegistry();
    const store = createWalletsStore();
    const kv = memoryKeyValue(seed);
    const rt = createSolanaRuntime({wallets: registry, store, kv});
    return {registry, store, kv, rt};
  };

  it("lists wallets as they register and drops them on unregister", () => {
    const {registry, store, rt} = setup();
    rt.start();
    expect(store.get().options).toEqual([]);
    const off = registry.register(fakeSolanaWallet({name: "Solflare"}).wallet);
    expect(store.get().options.map((o) => o.id)).toEqual(["Solflare"]);
    off();
    expect(store.get().options).toEqual([]);
  });

  it("connects, follows account changes, and disconnects", async () => {
    const {registry, store, kv, rt} = setup();
    const w = fakeSolanaWallet({name: "Phantom", accounts: [solAccount("A111")]});
    registry.register(w.wallet);
    rt.start();
    await rt.connect("Phantom");
    expect(store.get().solana).toEqual({family: "solana", address: "A111", walletName: "Phantom", walletIcon: ICON});
    expect(store.get().owners).toEqual({solana: "A111"});
    expect(kv.get(SOLANA_WALLET_KEY)).toBe("Phantom");
    expect(rt.current()?.account.address).toBe("A111");

    const before = store.get();
    w.change([solAccount("A111")]); // same address, new object: nothing visible changes
    expect(store.get()).toBe(before);
    w.change([solAccount("B222")]);
    expect(store.get().solana?.address).toBe("B222");
    expect(rt.current()?.account).toBe(w.wallet.accounts[0]);

    await rt.disconnect();
    expect(store.get().solana).toBeNull();
    expect(w.disconnect).toHaveBeenCalledOnce();
    expect(kv.get(SOLANA_WALLET_KEY)).toBeNull();
  });

  it("forgets the connection when the wallet drops every account or unregisters", async () => {
    const {registry, store, kv, rt} = setup();
    const w = fakeSolanaWallet();
    const off = registry.register(w.wallet);
    rt.start();
    await rt.connect("Phantom");
    w.change([]);
    expect(store.get().solana).toBeNull();
    expect(kv.get(SOLANA_WALLET_KEY)).toBeNull();
    await rt.connect("Phantom");
    off();
    expect(store.get().solana).toBeNull();
  });

  it("reconnects the remembered wallet silently when it registers", async () => {
    const {registry, store, rt} = setup({[SOLANA_WALLET_KEY]: "Backpack"});
    rt.start();
    const other = fakeSolanaWallet({name: "Phantom", trusted: true});
    registry.register(other.wallet);
    expect(other.connect).not.toHaveBeenCalled();
    const w = fakeSolanaWallet({name: "Backpack", trusted: true, accounts: [solAccount("K777")]});
    registry.register(w.wallet);
    await flush();
    expect(w.connect).toHaveBeenCalledWith({silent: true});
    expect(store.get().solana?.address).toBe("K777");
  });

  it("stays disconnected when the silent connect returns nothing (no prompt is ever opened)", async () => {
    const {registry, store, rt} = setup({[SOLANA_WALLET_KEY]: "Phantom"});
    const w = fakeSolanaWallet({trusted: false});
    registry.register(w.wallet);
    rt.start();
    await flush();
    expect(w.connect).toHaveBeenCalledTimes(1);
    expect(w.connect).toHaveBeenCalledWith({silent: true});
    expect(store.get().solana).toBeNull();
  });

  it("works over the real Wallet Standard registry", async () => {
    const w = fakeSolanaWallet({name: "RegistryWallet", accounts: [solAccount("R555")]});
    const registry = getWallets();
    const off = registry.register(w.wallet);
    const c = createWalletsController(controllerDeps({standard: registry}));
    c.start();
    expect(c.getState().options.map((o) => o.id)).toContain("RegistryWallet");
    await c.connect("RegistryWallet");
    expect(c.getState().solana?.address).toBe("R555");
    off();
    expect(c.getState().solana).toBeNull();
  });
});

describe("controller: Solana connect menu state", () => {
  it("a rejection lands in error, never throws", async () => {
    const registry = fakeRegistry([fakeSolanaWallet({reject: true}).wallet]);
    const c = createWalletsController(controllerDeps({standard: registry}));
    c.start();
    await expect(c.connect("Phantom")).resolves.toBeUndefined();
    expect(c.getState()).toMatchObject({solana: null, connecting: null, error: "You declined in your wallet."});
  });

  it("an unknown option id lands in error", async () => {
    const c = createWalletsController(controllerDeps());
    await c.connect("Nope");
    expect(c.getState().error).toBe("That wallet isn't available any more — reload the page and try again.");
  });
});
