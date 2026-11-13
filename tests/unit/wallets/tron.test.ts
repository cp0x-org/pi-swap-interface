/**
 * Injected Tron wallets (D11) over a fake window and a fake TronLink: discovery (TIP-6963, `window.tron`, the legacy
 * globals), connect / reject, account and network changes, the silent reconnect read from the wallet's TronWeb (never a
 * prompt), and getSigner's refusals. Nothing here signs or contacts a network.
 */
import {describe, expect, it} from "vitest";
import {createWalletsController} from "../../../src/wallets/controller";
import {createWalletsStore} from "../../../src/wallets/state";
import {memoryKeyValue, TRON_WALLET_KEY} from "../../../src/wallets/storage";
import {createTronDiscovery, LEGACY_TRON_ID, TRON_MAINNET_CHAIN_ID, tronOptionId, TRONLINK_RDNS} from "../../../src/wallets/tron/injected";
import {createTronRuntime} from "../../../src/wallets/tron/runtime";
import {controllerDeps, fakeTronLink, fakeTronWindow, flush, ICON, TRON_OTHER, TRON_OWNER} from "./fakes";

const TRONLINK = tronOptionId(TRONLINK_RDNS);

/** A wallet that answers TIP-6963's request on `win` with `provider`. */
function announceOn(win: EventTarget, provider: unknown, info: {rdns: string; name: string; icon?: string}) {
  const announce = () => win.dispatchEvent(new CustomEvent("TIP6963:announceProvider", {detail: {info: {uuid: "u-1", ...info}, provider}}));
  win.addEventListener("TIP6963:requestProvider", announce);
  return announce;
}

function setup(o: {globals?: Parameters<typeof fakeTronWindow>[0]; seed?: Record<string, string>} = {}) {
  const win = fakeTronWindow(o.globals);
  const discovery = createTronDiscovery(win);
  const store = createWalletsStore();
  const kv = memoryKeyValue(o.seed);
  const rt = createTronRuntime({discovery, store, kv});
  return {win, discovery, store, kv, rt};
}

describe("Tron wallet discovery", () => {
  it("lists TronLink from window.tron, under a tron: id apart from any EVM entry", () => {
    const {store, rt} = setup({globals: {tron: fakeTronLink()}});
    rt.start();
    expect(store.get().options).toEqual([{id: TRONLINK, family: "tron", name: "TronLink", kind: "injected"}]);
  });

  it("takes TIP-6963 announcements (data icons only), and doesn't list window.tron twice when it was announced", () => {
    const link = fakeTronLink();
    const {win, store, rt} = setup({globals: {tron: link}});
    announceOn(win, link, {rdns: TRONLINK_RDNS, name: "TronLink", icon: ICON});
    announceOn(win, fakeTronLink(), {rdns: "com.example.remote", name: "Remote", icon: "https://cdn.example/x.png"});
    rt.start();
    expect(store.get().options).toEqual([
      {id: TRONLINK, family: "tron", name: "TronLink", icon: ICON, kind: "injected"},
      {id: "tron:com.example.remote", family: "tron", name: "Remote", kind: "injected"},
    ]);
  });

  it("falls back to the legacy window.tronLink, and to a bare window.tronWeb", () => {
    const legacy = {request: async () => ({code: 200}), tronWeb: fakeTronLink({authorized: true}).tronWebObject};
    const a = setup({globals: {tronLink: legacy}});
    a.rt.start();
    expect(a.store.get().options).toEqual([{id: LEGACY_TRON_ID, family: "tron", name: "TronLink", kind: "injected"}]);
    const b = setup({globals: {tronWeb: fakeTronLink({authorized: true}).tronWebObject}});
    b.rt.start();
    expect(b.store.get().options.map((o) => o.name)).toEqual(["Tron browser wallet"]);
    expect(setup().discovery.list()).toEqual([]);
  });

  it("picks up a wallet injected after start (TronLink's initialized event)", () => {
    const {win, store, rt} = setup();
    rt.start();
    expect(store.get().options).toEqual([]);
    Object.assign(win, {tron: fakeTronLink()});
    win.dispatchEvent(new Event("tronLink#initialized"));
    expect(store.get().options.map((o) => o.id)).toEqual([TRONLINK]);
  });
});

describe("Tron connection", () => {
  it("connects with eth_requestAccounts only, follows account switches and locks, and disconnects", async () => {
    const link = fakeTronLink();
    const {store, kv, rt} = setup({globals: {tron: link}});
    rt.start();
    await rt.connect(TRONLINK);
    expect(link.requests).toEqual(["eth_requestAccounts"]);
    expect(store.get().tron).toEqual({family: "tron", address: TRON_OWNER, walletName: "TronLink"});
    expect(store.get().owners).toEqual({tron: TRON_OWNER});
    expect(kv.get(TRON_WALLET_KEY)).toBe(TRONLINK);

    link.switchTo(TRON_OTHER);
    expect(store.get().tron?.address).toBe(TRON_OTHER);
    link.lock();
    expect(store.get().tron).toBeNull();
    // Unlocking the remembered wallet brings it back without a prompt.
    link.unlock();
    expect(store.get().tron?.address).toBe(TRON_OTHER);
    expect(link.requests).toEqual(["eth_requestAccounts"]);

    await rt.disconnect();
    expect(store.get().tron).toBeNull();
    expect(kv.get(TRON_WALLET_KEY)).toBeNull();
    link.unlock();
    expect(store.get().tron).toBeNull();
  });

  it("reports the network the wallet names: chainChanged first, else TronWeb's node host", async () => {
    const link = fakeTronLink({host: "https://nile.trongrid.io"});
    const {rt} = setup({globals: {tron: link}});
    rt.start();
    await rt.connect(TRONLINK);
    expect(rt.current()?.network).toBe("test");
    link.chain(TRON_MAINNET_CHAIN_ID);
    expect(rt.current()?.network).toBe("mainnet");
    link.chain("0xcd8690dc");
    expect(rt.current()?.network).toBe("test");
  });

  it("reconnects the remembered wallet from its TronWeb on reload — no request at all", async () => {
    const link = fakeTronLink({authorized: true});
    const {store, rt} = setup({globals: {tron: link}, seed: {[TRON_WALLET_KEY]: TRONLINK}});
    rt.start();
    expect(store.get().tron?.address).toBe(TRON_OWNER);
    expect(link.requests).toEqual([]);
    // Not authorized for this origin any more: stays disconnected, still without a prompt.
    const gone = fakeTronLink({authorized: false});
    const b = setup({globals: {tron: gone}, seed: {[TRON_WALLET_KEY]: TRONLINK}});
    b.rt.start();
    expect(b.store.get().tron).toBeNull();
    expect(gone.requests).toEqual([]);
  });

  it("puts a declined connect in the user's words, through the controller", async () => {
    const win = fakeTronWindow({tron: fakeTronLink({reject: true})});
    const c = createWalletsController(controllerDeps({tron: createTronDiscovery(win)}));
    c.start();
    await c.connect(TRONLINK);
    expect(c.getState().error).toBe("You declined in your wallet.");
    expect(c.getState().tron).toBeNull();
  });

  it("legacy TronLink: tron_requestAccounts → {code: 200}, the account from its TronWeb", async () => {
    const tw = fakeTronLink({authorized: true}).tronWebObject;
    let code = 4001;
    const legacy = {request: async ({method}: {method: string}) => (method === "tron_requestAccounts" ? {code} : null), tronWeb: tw};
    const {store, rt} = setup({globals: {tronLink: legacy}});
    rt.start();
    await expect(rt.connect(LEGACY_TRON_ID)).rejects.toMatchObject({code: 4001});
    code = 200;
    await rt.connect(LEGACY_TRON_ID);
    expect(store.get().tron?.address).toBe(TRON_OWNER);
  });
});

describe("getSigner on Tron", () => {
  const controller = (link: ReturnType<typeof fakeTronLink>) => {
    const c = createWalletsController(controllerDeps({tron: createTronDiscovery(fakeTronWindow({tron: link}))}));
    c.start();
    return c;
  };

  it("hands execute the TronWeb, the account and the runtime Tron API — and refuses until it can", async () => {
    const link = fakeTronLink();
    const c = controller(link);
    await expect(c.getSigner("tron:728126428")).rejects.toMatchObject({message: "Connect a Tron wallet first.", answered: true});
    await c.connect(TRONLINK);
    await flush();
    const s = await c.getSigner("tron:728126428");
    expect(s).toMatchObject({family: "tron", owner: TRON_OWNER, walletName: "TronLink", apiUrls: ["https://tron.invalid"]});
    expect(s.family === "tron" && s.tronWeb).toBe(link.tronWebObject);
    expect(link.tronWebObject.trx.sign).not.toHaveBeenCalled();
    await expect(c.getSigner("tron:2494104990")).rejects.toThrow(/isn't supported here/);
  });

  it("refuses a wallet on a test network", async () => {
    const link = fakeTronLink();
    const c = controller(link);
    await c.connect(TRONLINK);
    link.chain("0x94a9059e");
    await expect(c.getSigner("tron:728126428")).rejects.toMatchObject({message: expect.stringMatching(/test network/), answered: true});
  });
});
