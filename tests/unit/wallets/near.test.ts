// NEAR wallets over NEAR Connect's injection protocol, with fake injected wallets on an EventTarget. No network.
import {describe, expect, it, vi} from "vitest";
import type {NearInjectedWallet} from "../../../src/contracts/execution";
import {createWalletsController} from "../../../src/wallets/controller";
import {NEAR_INJECTED_EVENT, NEAR_READY_EVENT, nearOptions, nearUnsupported} from "../../../src/wallets/near/injected";
import {createNearRuntime} from "../../../src/wallets/near/runtime";
import {createWalletsStore} from "../../../src/wallets/state";
import {memoryKeyValue, NEAR_WALLET_KEY} from "../../../src/wallets/storage";
import {controllerDeps, flush, ICON} from "./fakes";

const ALICE = "alice.near";
const IMPLICIT = "e".repeat(64);

/** An injected NEAR wallet that answers the page's ready event (as HOT's extension does). */
function fakeNearWallet(o: {id?: string; name?: string; accounts?: string[]; reject?: boolean; features?: Record<string, unknown>; icon?: string} = {}) {
  let signedIn: string[] = [];
  const granted = o.accounts ?? [ALICE];
  const wallet = {
    manifest: {id: o.id ?? "hot-wallet", name: o.name ?? "HOT Wallet", icon: o.icon ?? ICON, features: o.features ?? {signAndSendTransaction: true}},
    signIn: vi.fn(async (_d?: unknown) => {
      if (o.reject) throw new Error("User rejected the request");
      signedIn = granted;
      return granted.map((accountId) => ({accountId}));
    }),
    signOut: vi.fn(async () => {
      signedIn = [];
    }),
    getAccounts: vi.fn(async () => signedIn.map((accountId) => ({accountId}))),
    signAndSendTransaction: vi.fn(async () => {
      throw new Error("the wallets module never signs");
    }),
    /** The wallet already trusts this site (a reload). */
    trust() {
      signedIn = granted;
    },
  };
  return wallet;
}

/** An EventTarget standing in for `window`; `announce` makes a wallet answer every ready event. */
function fakeWindow() {
  const events = new EventTarget();
  const readies = vi.fn();
  events.addEventListener(NEAR_READY_EVENT, readies);
  const announce = (w: object) => {
    const send = () => events.dispatchEvent(new CustomEvent(NEAR_INJECTED_EVENT, {detail: w}));
    events.addEventListener(NEAR_READY_EVENT, send);
    send(); // a wallet that loads after the page announces itself once
  };
  return {events, readies, announce};
}

describe("which NEAR wallets are listed", () => {
  it("needs a manifest and the four methods, and no feature the wallet says it lacks", () => {
    expect(nearUnsupported(fakeNearWallet())).toBeNull();
    expect(nearUnsupported({...fakeNearWallet(), manifest: {id: "", name: "X"}})).toBe("no manifest id or name");
    expect(nearUnsupported({...fakeNearWallet(), signAndSendTransaction: undefined})).toBe("missing a method");
    expect(nearUnsupported(fakeNearWallet({features: {signInWithoutAddKey: false}}))).toBe("a feature it says it lacks");
    expect(nearUnsupported(fakeNearWallet({features: {mainnet: false}}))).toBe("a feature it says it lacks");
    expect(nearUnsupported(null)).toBe("no manifest id or name");
  });

  it("prefixes ids, dedupes by manifest id and keeps data icons only", () => {
    const out = nearOptions([
      fakeNearWallet(),
      fakeNearWallet({name: "HOT again"}),
      fakeNearWallet({id: "meteor-wallet", name: "Meteor", icon: "https://cdn.example/meteor.png"}),
    ] as unknown as NearInjectedWallet[]);
    expect(out).toEqual([
      {id: "near:hot-wallet", family: "near", name: "HOT Wallet", icon: ICON, kind: "injected"},
      {id: "near:meteor-wallet", family: "near", name: "Meteor", kind: "injected"},
    ]);
  });
});

describe("NEAR connection", () => {
  const setup = (seed: Record<string, string> = {}) => {
    const win = fakeWindow();
    const store = createWalletsStore();
    const kv = memoryKeyValue(seed);
    const rt = createNearRuntime({events: win.events, store, kv});
    return {win, store, kv, rt};
  };

  it("asks the extensions once at start and lists each wallet that answers, once", () => {
    const {win, store, rt} = setup();
    win.announce(fakeNearWallet());
    rt.start();
    rt.start();
    expect(win.readies).toHaveBeenCalledTimes(1);
    expect(store.get().options.map((o) => o.id)).toEqual(["near:hot-wallet"]);
    // A wallet loading later announces itself; a broken detail is ignored.
    win.events.dispatchEvent(new CustomEvent(NEAR_INJECTED_EVENT, {detail: {manifest: {id: "broken"}}}));
    win.announce(fakeNearWallet({id: "meteor-wallet", name: "Meteor"}));
    expect(store.get().options.map((o) => o.id)).toEqual(["near:hot-wallet", "near:meteor-wallet"]);
  });

  it("connects with signIn for mainnet and no access key, and remembers the wallet", async () => {
    const {win, store, kv, rt} = setup();
    const w = fakeNearWallet({accounts: [IMPLICIT]});
    win.announce(w);
    rt.start();
    await rt.connect("near:hot-wallet");
    expect(w.signIn).toHaveBeenCalledWith({network: "mainnet"});
    expect(store.get().near).toEqual({family: "near", address: IMPLICIT, walletName: "HOT Wallet", walletIcon: ICON});
    expect(store.get().owners).toEqual({near: IMPLICIT});
    expect(rt.current()?.accountId).toBe(IMPLICIT);
    expect(kv.get(NEAR_WALLET_KEY)).toBe("hot-wallet");
    expect(w.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("refuses an account the page can't pay from, and a wallet that shares none", async () => {
    const {win, store, rt} = setup();
    win.announce(fakeNearWallet({accounts: ["alice.tg"]}));
    win.announce(fakeNearWallet({id: "empty", name: "Empty", accounts: []}));
    rt.start();
    await expect(rt.connect("near:hot-wallet")).rejects.toMatchObject({answered: true, message: expect.stringMatching(/can't pay from yet/)});
    await expect(rt.connect("near:empty")).rejects.toMatchObject({answered: true, message: "Empty didn't share a NEAR mainnet account."});
    await expect(rt.connect("near:gone")).rejects.toMatchObject({answered: true});
    expect(store.get().near).toBeNull();
  });

  it("reconnects the remembered wallet silently with getAccounts, never signIn", async () => {
    const {win, store, rt} = setup({[NEAR_WALLET_KEY]: "hot-wallet"});
    const w = fakeNearWallet();
    w.trust();
    win.announce(w);
    rt.start();
    await flush();
    expect(w.getAccounts).toHaveBeenCalledWith({network: "mainnet"});
    expect(w.signIn).not.toHaveBeenCalled();
    expect(store.get().near?.address).toBe(ALICE);
  });

  it("stays disconnected when the remembered wallet no longer shares an account", async () => {
    const {win, store, rt} = setup({[NEAR_WALLET_KEY]: "hot-wallet"});
    const w = fakeNearWallet();
    win.announce(w);
    rt.start();
    await flush();
    expect(w.signIn).not.toHaveBeenCalled();
    expect(store.get().near).toBeNull();
  });

  it("disconnects: forgets the wallet and signs out of it", async () => {
    const {win, store, kv, rt} = setup();
    const w = fakeNearWallet();
    win.announce(w);
    rt.start();
    await rt.connect("near:hot-wallet");
    await rt.disconnect();
    expect(store.get().near).toBeNull();
    expect(kv.get(NEAR_WALLET_KEY)).toBeNull();
    expect(w.signOut).toHaveBeenCalledWith({network: "mainnet"});
  });

  it("signs out of the previous wallet when another one connects", async () => {
    const {win, store, rt} = setup();
    const hot = fakeNearWallet();
    const meteor = fakeNearWallet({id: "meteor-wallet", name: "Meteor", accounts: [IMPLICIT]});
    win.announce(hot);
    win.announce(meteor);
    rt.start();
    await rt.connect("near:hot-wallet");
    await rt.connect("near:meteor-wallet");
    expect(hot.signOut).toHaveBeenCalled();
    expect(store.get().near?.walletName).toBe("Meteor");
  });
});

describe("NEAR through the controller", () => {
  it("connects by option id, hands out a mainnet signer, and refuses without a wallet", async () => {
    const win = fakeWindow();
    const w = fakeNearWallet();
    win.announce(w);
    const c = createWalletsController({...controllerDeps(), nearEvents: win.events, nearRpcUrls: () => ["https://near-rpc.invalid"]});
    c.start();
    await expect(c.getSigner("near:mainnet")).rejects.toMatchObject({answered: true, message: "Connect a NEAR wallet first."});
    await c.connect("near:hot-wallet");
    expect(c.getState().error).toBeNull();
    const signer = await c.getSigner("near:mainnet");
    expect(signer).toMatchObject({family: "near", accountId: ALICE, rpcUrls: ["https://near-rpc.invalid"]});
    await expect(c.getSigner("near:testnet")).rejects.toMatchObject({answered: true});
    await c.disconnect("near");
    expect(c.getState().near).toBeNull();
  });

  it("shows a declined sign-in in the user's words", async () => {
    const win = fakeWindow();
    win.announce(fakeNearWallet({reject: true}));
    const c = createWalletsController({...controllerDeps(), nearEvents: win.events});
    c.start();
    await c.connect("near:hot-wallet");
    expect(c.getState().error).toBe("You declined in your wallet.");
    expect(c.getState().near).toBeNull();
  });

  it("lists no NEAR wallet without a place to listen", () => {
    const c = createWalletsController(controllerDeps());
    c.start();
    expect(c.getState().options.filter((o) => o.family === "near")).toEqual([]);
  });
});
