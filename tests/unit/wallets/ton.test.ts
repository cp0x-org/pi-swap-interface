// TON Connect in the wallets module (D11): the menu (installed wallets, then TON Connect UI's modal), the self-hosted
// official list, a JS-bridge connect and one through the modal, mainnet only, the silent restore after a reload — and
// nothing loaded or contacted before the viewer picks TON. Fake TON Connect and a fake TON Connect UI.
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";
import {toFriendlyAddress} from "../../../src/catalog";
import {createWalletsController} from "../../../src/wallets/controller";
import {answered} from "../../../src/wallets/errors";
import {TON_WALLET_KEY, TONCONNECT_UI_KEYS, memoryKeyValue} from "../../../src/wallets/storage";
import {OFFICIAL_TON_WALLETS} from "../../../src/wallets/ton/officialWallets";
import {TON_CONNECT_WAIT_MS, type LoadTonConnect} from "../../../src/wallets/ton/runtime";
import {CP0X_TON_UI_WALLET, TONCONNECT_OPTION, isBundledTonIcon, tonOptions, tonWalletByApp, tonWalletOf} from "../../../src/wallets/ton/wallets";
import {controllerDeps, fakeTonConnect, fakeTonConnectUI, flush, TON_FALLBACK_LIST, TON_RAW} from "./fakes";

const FRIENDLY = toFriendlyAddress(TON_RAW)!;
/** What the official list calls Tonkeeper today (its names change from time to time). */
const TONKEEPER = tonWalletByApp("tonkeeper")!.name;

describe("TON wallets menu", () => {
  it("offers TON Connect's modal, after the wallets whose JS bridge is on the page (cp0x's first, one per bridge key)", () => {
    expect(tonOptions(() => false)).toEqual([TONCONNECT_OPTION]);
    expect(TONCONNECT_OPTION).toEqual({id: "tonconnect", family: "ton", name: "TON Connect", kind: "tonconnect"});
    expect(tonOptions((k) => k === "tonkeeper" || k === "cp0x").map((o) => [o.id, o.name, o.kind])).toEqual([
      ["tonconnect:cp0x", "cp0x", "injected"],
      ["tonconnect:tonkeeper", TONKEEPER, "injected"],
      ["tonconnect", "TON Connect", "tonconnect"],
    ]);
    // OKX lists two apps on one bridge key: one entry.
    expect(tonOptions((k) => k === "okxTonWallet").map((o) => o.id)).toEqual(["tonconnect:okxWallet", "tonconnect"]);
    expect(tonWalletOf("tonconnect:tonhub")?.jsBridgeKey).toBe("tonhub");
    expect(tonWalletOf("tonconnect")).toBeUndefined();
    expect(tonWalletOf("tonconnect:BitgetWeb3")).toBeUndefined(); // no JS bridge: the modal's only
    expect(tonWalletOf("Tonhub")).toBeUndefined();
    expect(tonWalletByApp("Tonkeeper")?.appName).toBe("tonkeeper");
    expect(tonWalletByApp("cp0x")?.name).toBe("cp0x");
  });

  it("serves TON Connect's official list self-hosted, every icon bundled, and a manifest naming cp0x Swap", () => {
    const list = JSON.parse(readFileSync("public/tonconnect-wallets.json", "utf8")) as {
      app_name: string;
      name: string;
      image: string;
      about_url: string;
      universal_url?: string;
      platforms: string[];
      bridge: {type: string; url?: string; key?: string}[];
    }[];
    expect(list.length).toBeGreaterThan(10);
    for (const w of list) {
      // What the SDK requires of an entry (isCorrectWalletConfigDTO), or it drops the wallet.
      expect(w.name && w.app_name && typeof w.about_url === "string" && w.platforms.length && w.bridge.length, w.app_name).toBeTruthy();
      const sse = w.bridge.find((b) => b.type === "sse");
      if (sse) expect(sse.url && w.universal_url, w.app_name).toBeTruthy();
      // Every image is a bundled file beside index.html, relative (a sub-path works): nothing is hotlinked.
      expect(w.image, w.app_name).toBe(`logos/ton-wallets/${w.app_name}.png`);
      expect(isBundledTonIcon(w.image), w.image).toBe(true);
      expect(existsSync(`public/${w.image}`), w.image).toBe(true);
    }
    expect(readdirSync("public/logos/ton-wallets").sort()).toEqual(list.map((w) => `${w.app_name}.png`).sort());
    // The menu's table is the same list (cp0x's wallet is ours, not in it).
    expect(OFFICIAL_TON_WALLETS).toEqual(
      list.map((w) => {
        const key = w.bridge.find((b) => b.type === "js")?.key;
        return {appName: w.app_name, name: w.name, ...(key ? {jsBridgeKey: key} : {})};
      }),
    );
    // cp0x's modal entry and TON Connect UI's own images are bundled too; none names a host.
    expect(existsSync(`public/${CP0X_TON_UI_WALLET.imageUrl}`)).toBe(true);
    expect(`${CP0X_TON_UI_WALLET.imageUrl} ${CP0X_TON_UI_WALLET.aboutUrl}`).not.toMatch(/:\/\/|cp0x\./);
    for (const f of ["ton-icon-48.png", "tg.png"]) expect(existsSync(`public/logos/tonconnect/${f}`), f).toBe(true);

    const manifest = JSON.parse(readFileSync("public/tonconnect-manifest.json", "utf8")) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(["iconUrl", "name", "url"]);
    expect(manifest.name).toBe("cp0x Swap");
    expect(manifest.iconUrl).toBe(`${manifest.url}/apple-touch-icon.png`);
  });
});

describe("TON Connect connections", () => {
  it("loads nothing at boot without a remembered TON wallet", async () => {
    const ton = fakeTonConnect();
    const ui = fakeTonConnectUI();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load}));
    c.start();
    await flush();
    expect(ton.load).not.toHaveBeenCalled();
    expect(ui.load).not.toHaveBeenCalled();
    expect(c.getState().options.filter((o) => o.family === "ton")).toEqual([TONCONNECT_OPTION]);
  });

  it("connects an installed wallet through its JS bridge, without the modal, and hands getSigner a mainnet signer", async () => {
    const ton = fakeTonConnect();
    const ui = fakeTonConnectUI();
    const kv = memoryKeyValue();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load, tonInjected: (k) => k === "tonkeeper", kv}));
    await c.connect("tonconnect:tonkeeper");
    expect(ton.sources).toEqual([{jsBridgeKey: "tonkeeper"}]);
    expect(ui.load).not.toHaveBeenCalled();
    expect(ton.load.mock.calls[0]![0]).toMatchObject({
      manifestUrl: "https://swap.example/tonconnect-manifest.json",
      walletsListSource: "https://swap.example/tonconnect-wallets.json",
    });
    const s = c.getState();
    expect(s.ton).toEqual({family: "ton", address: FRIENDLY, walletName: TONKEEPER});
    expect(s.owners.ton).toBe(FRIENDLY);
    expect(s.connecting).toBeNull();
    expect(s.error).toBeNull();
    expect(kv.get(TON_WALLET_KEY)).toBe("tonconnect:tonkeeper");
    const signer = await c.getSigner("ton:-239");
    expect(signer).toMatchObject({family: "ton", address: FRIENDLY, rawAddress: TON_RAW, walletName: TONKEEPER, tonApiUrl: "https://tonapi.invalid"});
    expect(signer.family === "ton" && signer.sender).toBe(ton.connector);
  });

  it("connects cp0x's wallet inside its in-app browser through its bridge (it is not in the official list)", async () => {
    const ton = fakeTonConnect({appName: "cp0x"});
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, tonInjected: (k) => k === "cp0x"}));
    c.start();
    expect(c.getState().options.filter((o) => o.family === "ton").map((o) => o.id)).toEqual(["tonconnect:cp0x", "tonconnect"]);
    await c.connect("tonconnect:cp0x");
    expect(ton.sources).toEqual([{jsBridgeKey: "cp0x"}]);
    expect(c.getState().ton).toMatchObject({address: FRIENDLY, walletName: "cp0x"});
  });

  it("opens TON Connect UI's modal, built once over the same connector, until a wallet picked there connects", async () => {
    const ton = fakeTonConnect({appName: "Tonhub"});
    const ui = fakeTonConnectUI();
    const kv = memoryKeyValue();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load, kv}));
    const first = c.connect("tonconnect");
    await flush();
    expect(ui.load).toHaveBeenCalledTimes(1);
    expect(ui.built[0]!.connector).toBe(ton.connector);
    expect(ui.built[0]!.includeWallets).toEqual([]);
    expect(ui.state().status).toBe("opened");
    expect(c.getState()).toMatchObject({connecting: "tonconnect", pairingUri: null, error: null});
    // The modal connects on its own; its connects end on this attempt's signal.
    expect(ui.modalSignals[0]!.aborted).toBe(false);
    ton.approve();
    await first;
    expect(c.getState()).toMatchObject({ton: {address: FRIENDLY, walletName: "Tonhub"}, connecting: null, error: null});
    expect(kv.get(TON_WALLET_KEY)).toBe("tonconnect");
    // A connection is never aborted after the fact (the SDK would close it).
    expect(ui.modalSignals[0]!.aborted).toBe(false);
    const signer = await c.getSigner("ton:-239");
    expect(signer.family === "ton" && signer.sender).toBe(ton.connector);

    await c.disconnect("ton");
    const second = c.connect("tonconnect");
    await flush();
    ton.approve();
    await second;
    expect(ui.load).toHaveBeenCalledTimes(1);
    expect(c.getState().ton).not.toBeNull();
  });

  it("lists cp0x's wallet in the modal when its in-app browser injects it, with bundled, host-less URLs", async () => {
    const ui = fakeTonConnectUI();
    const c = createWalletsController(controllerDeps({loadTonConnect: fakeTonConnect().load, loadTonConnectUI: ui.load, tonInjected: (k) => k === "cp0x"}));
    void c.connect("tonconnect");
    await flush();
    expect(ui.built[0]!.includeWallets).toEqual([
      {appName: "cp0x", name: "cp0x", jsBridgeKey: "cp0x", imageUrl: "apple-touch-icon.png", aboutUrl: "./", platforms: ["ios", "android"]},
    ]);
  });

  it("the viewer closing the modal cancels quietly and ends the modal's connect; a cancel from the app closes it", async () => {
    const ton = fakeTonConnect();
    const ui = fakeTonConnectUI();
    const kv = memoryKeyValue();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load, kv}));
    const first = c.connect("tonconnect");
    await flush();
    // A refusal while the modal is open is the modal's (2.4.4 shows it only on its desktop screen for one wallet): the
    // attempt goes on until the viewer closes it.
    ton.fail(new Error("[TON_CONNECT_SDK_ERROR] UserRejectsError: User rejects the action in the wallet."));
    await flush();
    expect(c.getState()).toMatchObject({connecting: "tonconnect", error: null});
    ui.close();
    await first;
    expect(c.getState()).toMatchObject({ton: null, connecting: null, pairingUri: null, error: null});
    expect(ui.modalSignals[0]!.aborted).toBe(true);
    expect(kv.get(TON_WALLET_KEY)).toBeNull();

    const second = c.connect("tonconnect");
    await flush();
    await c.disconnect("ton");
    await second;
    expect(ui.picker.closeModal).toHaveBeenCalledTimes(1);
    expect(ui.state().status).toBe("closed");
    expect(ui.modalSignals[1]!.aborted).toBe(true);
    expect(c.getState()).toMatchObject({ton: null, connecting: null, error: null});
  });

  it("gives up on a modal no wallet answers, so a stuck attempt can't keep the menu locked", async () => {
    vi.useFakeTimers();
    try {
      const ui = fakeTonConnectUI();
      const c = createWalletsController(controllerDeps({loadTonConnect: fakeTonConnect().load, loadTonConnectUI: ui.load}));
      const attempt = c.connect("tonconnect");
      await vi.advanceTimersByTimeAsync(0);
      expect(c.getState()).toMatchObject({connecting: "tonconnect"});
      await vi.advanceTimersByTimeAsync(TON_CONNECT_WAIT_MS);
      await attempt;
      expect(ui.picker.closeModal).toHaveBeenCalled();
      expect(ui.modalSignals[0]!.aborted).toBe(true);
      expect(c.getState()).toMatchObject({ton: null, connecting: null, error: "No TON wallet answered in time — try connecting again."});
    } finally {
      vi.useRealTimers();
    }
  });

  it("never builds TON Connect UI over the SDK's fallback list (ours didn't load): it answers, and the next pick fetches ours again", async () => {
    const fallback = fakeTonConnect({list: TON_FALLBACK_LIST});
    const ours = fakeTonConnect({appName: "Tonhub"});
    const ui = fakeTonConnectUI();
    const load = vi.fn<LoadTonConnect>().mockImplementationOnce(fallback.load).mockImplementation(ours.load);
    const c = createWalletsController(controllerDeps({loadTonConnect: load, loadTonConnectUI: ui.load}));
    await c.connect("tonconnect");
    expect(c.getState()).toMatchObject({ton: null, connecting: null, error: "TON Connect's wallet list didn't load — check your connection and try again."});
    // No modal over remote icons and other bridges: TON Connect UI was never built.
    expect(ui.load).not.toHaveBeenCalled();

    // The SDK keeps the list it fell back to: the connector holding it is dropped, and the next pick builds another.
    const second = c.connect("tonconnect");
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(ui.built[0]!.connector).toBe(ours.connector);
    expect(ui.state().status).toBe("opened");
    ours.approve();
    await second;
    expect(c.getState()).toMatchObject({ton: {walletName: "Tonhub"}, error: null});
  });

  it("keeps a connector holding the fallback list while a reload's restore still runs on it", async () => {
    const ton = fakeTonConnect({list: TON_FALLBACK_LIST});
    ton.restoreConnection.mockImplementation(() => new Promise<void>(() => {}));
    const ui = fakeTonConnectUI();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load, kv: memoryKeyValue({[TON_WALLET_KEY]: "tonconnect"})}));
    c.start();
    await c.connect("tonconnect");
    await c.connect("tonconnect");
    expect(c.getState().error).toBe("TON Connect's wallet list didn't load — check your connection and try again.");
    expect(ton.load).toHaveBeenCalledTimes(1);
    expect(ui.load).not.toHaveBeenCalled();
  });

  it("answers when TON Connect UI can't load or can't start in this browser", async () => {
    const offline = createWalletsController(
      controllerDeps({
        loadTonConnect: fakeTonConnect().load,
        loadTonConnectUI: async () => {
          throw new TypeError("Failed to fetch dynamically imported module");
        },
      }),
    );
    await offline.connect("tonconnect");
    expect(offline.getState()).toMatchObject({connecting: null, error: "TON Connect didn't load — check your connection and try again."});

    const blocked = createWalletsController(
      controllerDeps({
        loadTonConnect: fakeTonConnect().load,
        loadTonConnectUI: async () => {
          throw answered("TON Connect couldn't open in this browser — allow this site to store data, then try again.");
        },
      }),
    );
    await blocked.connect("tonconnect");
    expect(blocked.getState().error).toBe("TON Connect couldn't open in this browser — allow this site to store data, then try again.");
  });

  it("says so when the viewer declines in an installed wallet, and keeps only mainnet accounts", async () => {
    const declined = createWalletsController(controllerDeps({loadTonConnect: fakeTonConnect({reject: true}).load, tonInjected: () => true}));
    await declined.connect("tonconnect:tonkeeper");
    expect(declined.getState()).toMatchObject({ton: null, error: "You declined in your wallet."});

    const testnet = fakeTonConnect({chain: "-3"});
    const kv = memoryKeyValue();
    const c = createWalletsController(controllerDeps({loadTonConnect: testnet.load, tonInjected: () => true, kv}));
    await c.connect("tonconnect:tonkeeper");
    expect(c.getState().ton).toBeNull();
    expect(c.getState().error).toMatch(/didn't share a TON mainnet account/);
    expect(testnet.disconnect).toHaveBeenCalled();
    expect(kv.get(TON_WALLET_KEY)).toBeNull();
  });

  it("restores a remembered session after a reload without TON Connect UI, and forgets one that can't come back", async () => {
    const ton = fakeTonConnect({restorable: true});
    const ui = fakeTonConnectUI();
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, loadTonConnectUI: ui.load, kv: memoryKeyValue({[TON_WALLET_KEY]: "tonconnect"})}));
    c.start();
    const signer = await c.getSigner("ton:-239");
    expect(ton.restoreConnection).toHaveBeenCalled();
    expect(ui.load).not.toHaveBeenCalled();
    expect(signer).toMatchObject({family: "ton", address: FRIENDLY, walletName: TONKEEPER});

    const gone = fakeTonConnect({restorable: false});
    const kv = memoryKeyValue({[TON_WALLET_KEY]: "tonconnect:tonkeeper"});
    const d = createWalletsController(controllerDeps({loadTonConnect: gone.load, kv}));
    d.start();
    await expect(d.getSigner("ton:-239")).rejects.toMatchObject({message: "Connect a TON wallet first.", answered: true});
    expect(kv.get(TON_WALLET_KEY)).toBeNull();
  });

  it("disconnects: forgets the session and TON Connect UI's keys, tells the wallet; another TON network is refused", async () => {
    const ton = fakeTonConnect();
    const kv = memoryKeyValue(Object.fromEntries(TONCONNECT_UI_KEYS.map((k) => [k, "{}"])));
    const c = createWalletsController(controllerDeps({loadTonConnect: ton.load, tonInjected: () => true, kv}));
    await c.connect("tonconnect:tonkeeper");
    await expect(c.getSigner("ton:-3")).rejects.toMatchObject({answered: true});
    await c.disconnect("ton");
    expect(ton.disconnect).toHaveBeenCalled();
    expect(c.getState().ton).toBeNull();
    expect(c.getState().owners.ton).toBeUndefined();
    expect(kv.get(TON_WALLET_KEY)).toBeNull();
    for (const k of TONCONNECT_UI_KEYS) expect(kv.get(k), k).toBeNull();
  });
});
