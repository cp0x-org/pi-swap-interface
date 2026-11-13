import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {createWalletsController} from "../../../src/wallets/controller";
import {SMART_ACCOUNT_TEXT} from "../../../src/wallets/evm/account";
import {WC_START_MS} from "../../../src/wallets/evm/runtime";
import {memoryKeyValue, WALLETCONNECT_KEY} from "../../../src/wallets/storage";
import {controllerDeps, fakeEip1193, fakePub, fakeWalletConnect, flush, ICON, OWNER_CHECKSUM, testWallet} from "./fakes";

const signerOf = async (c: ReturnType<typeof createWalletsController>, caip2: string) => {
  const s = await c.getSigner(caip2);
  if (s.family !== "evm") throw new Error("expected an EVM signer");
  return s;
};

describe("EVM connections over wagmi", () => {
  it("lists the injected wallet, connects it and shows the connection", async () => {
    const provider = fakeEip1193({chainId: 1});
    const c = createWalletsController(controllerDeps({connectors: [testWallet(provider)]}));
    c.start();
    await flush();
    expect(c.getState().options.filter((o) => o.family === "evm")).toEqual([{id: "io.test.wallet", family: "evm", name: "Test Wallet", icon: ICON, kind: "injected"}]);
    await c.connect("io.test.wallet");
    expect(c.getState()).toMatchObject({
      evm: {family: "evm", address: OWNER_CHECKSUM, chainId: 1, walletName: "Test Wallet", walletIcon: ICON, transport: "injected"},
      owners: {evm: OWNER_CHECKSUM},
      connecting: null,
      error: null,
    });
    provider.emit("chainChanged", "0xa4b1");
    expect(c.getState().evm?.chainId).toBe(42161);
    await c.disconnect("evm");
    expect(c.getState().evm).toBeNull();
    expect(c.getState().owners).toEqual({});
  });

  it("a declined connect sets the error and never throws", async () => {
    const c = createWalletsController(controllerDeps({connectors: [testWallet(fakeEip1193({rejectConnect: true}))]}));
    c.start();
    await flush();
    await expect(c.connect("io.test.wallet")).resolves.toBeUndefined();
    expect(c.getState()).toMatchObject({evm: null, connecting: null, error: "You declined in your wallet."});
  });

  it("connecting a second EVM wallet replaces the first", async () => {
    const a = fakeEip1193();
    const b = fakeEip1193({accounts: ["0x2222222222222222222222222222222222222222"]});
    const c = createWalletsController(controllerDeps({connectors: [testWallet(a, "io.a", "A"), testWallet(b, "io.b", "B")]}));
    c.start();
    await flush();
    await c.connect("io.a");
    await c.connect("io.b");
    expect(c.getState().evm?.walletName).toBe("B");
    expect(c.wagmi.state.connections.size).toBe(1);
  });
});

describe("getSigner (EVM)", () => {
  it("switches the wallet to the pay chain and binds a wallet client to it", async () => {
    const provider = fakeEip1193({chainId: 1});
    const pub = fakePub(undefined);
    const c = createWalletsController(controllerDeps({connectors: [testWallet(provider)], pub}));
    c.start();
    await flush();
    await c.connect("io.test.wallet");
    const s = await signerOf(c, "eip155:42161");
    expect(provider.requests).toContain("wallet_switchEthereumChain");
    expect(provider.chainId()).toBe(42161);
    expect(s.chain.id).toBe(42161);
    expect(s.wallet.chain?.id).toBe(42161);
    expect(s.wallet.account?.address).toBe(OWNER_CHECKSUM);
    expect(s.owner).toBe(OWNER_CHECKSUM);
    expect(s.transport).toBe("injected");
    expect(s.rpcUrls).toEqual(["https://rpc-42161.invalid"]);
    expect(s.pub).toBe(pub);
    expect(pub.getCode).toHaveBeenCalledWith({address: OWNER_CHECKSUM});
    // No attribution suffix on the signing client: it would change the armed calldata (D10).
    expect((s.wallet as {dataSuffix?: unknown}).dataSuffix).toBeUndefined();
  });

  it("does not prompt when the wallet is already on the chain; Elysium is a normal chain", async () => {
    const provider = fakeEip1193({chainId: 99901});
    const c = createWalletsController(controllerDeps({connectors: [testWallet(provider)]}));
    c.start();
    await flush();
    await c.connect("io.test.wallet");
    const s = await signerOf(c, "eip155:99901");
    expect(s.chain.id).toBe(99901);
    expect(provider.requests).not.toContain("wallet_switchEthereumChain");
  });

  it("a refused switch is an answered 'Switch your wallet to {Chain}' error", async () => {
    const c = createWalletsController(controllerDeps({connectors: [testWallet(fakeEip1193({chainId: 1, rejectSwitch: true}))]}));
    c.start();
    await flush();
    await c.connect("io.test.wallet");
    await expect(c.getSigner("eip155:42161")).rejects.toMatchObject({message: "Switch your wallet to Arbitrum to swap.", answered: true});
  });

  it("refuses a smart-contract account on the pay chain, before any switch prompt", async () => {
    const provider = fakeEip1193({chainId: 1});
    const c = createWalletsController(controllerDeps({connectors: [testWallet(provider)], pub: fakePub("0x60806040")}));
    c.start();
    await flush();
    await c.connect("io.test.wallet");
    await expect(c.getSigner("eip155:42161")).rejects.toMatchObject({message: SMART_ACCOUNT_TEXT, answered: true});
    expect(provider.requests).not.toContain("wallet_switchEthereumChain");
  });

  it("allows an EIP-7702 delegated EOA", async () => {
    const c = createWalletsController(controllerDeps({connectors: [testWallet(fakeEip1193())], pub: fakePub(`0xef0100${"12".repeat(20)}`)}));
    c.start();
    await flush();
    await c.connect("io.test.wallet");
    await expect(signerOf(c, "eip155:1")).resolves.toMatchObject({owner: OWNER_CHECKSUM});
  });
});

describe("getSigner refusals", () => {
  const c = createWalletsController(controllerDeps());
  c.start();

  it("not connected", async () => {
    await expect(c.getSigner("eip155:1")).rejects.toMatchObject({message: "Connect an EVM wallet first.", answered: true});
    await expect(c.getSigner("solana:mainnet")).rejects.toMatchObject({message: "Connect a Solana wallet first.", answered: true});
  });

  it("a chain no wallet signs on, or one outside the catalog", async () => {
    await expect(c.getSigner("bitcoin:mainnet")).rejects.toMatchObject({
      message: "No wallet signs on Bitcoin here — pay it from a deposit address instead.",
      answered: true,
    });
    await expect(c.getSigner("eip155:5")).rejects.toMatchObject({message: "eip155:5 isn't supported here.", answered: true});
    await expect(c.getSigner("solana:devnet")).rejects.toMatchObject({answered: true});
  });
});

describe("WalletConnect", () => {
  it("is hidden without a project id", () => {
    const c = createWalletsController(controllerDeps({projectId: ""}));
    expect(c.getState().options.some((o) => o.kind === "walletconnect")).toBe(false);
  });

  it("is listed last with a project id, and loads only when picked", async () => {
    const wc = fakeWalletConnect();
    const kv = memoryKeyValue();
    const c = createWalletsController(controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load, kv}));
    c.start();
    await flush();
    expect(c.getState().options.at(-1)).toEqual({id: "walletconnect", family: "evm", name: "WalletConnect", kind: "walletconnect"});
    expect(wc.load).not.toHaveBeenCalled();

    const done = c.connect("walletconnect");
    await flush();
    expect(wc.load).toHaveBeenCalledOnce();
    expect(wc.params[0]).toMatchObject({projectId: "0123456789abcdef", showQrModal: false, telemetryEnabled: false, metadata: {url: "https://swap.example"}});
    expect(c.getState()).toMatchObject({connecting: "walletconnect", pairingUri: "wc:test@2?relay-protocol=irn&symKey=00"});

    wc.approve();
    await done;
    expect(c.getState()).toMatchObject({
      connecting: null,
      pairingUri: null,
      evm: {transport: "walletconnect", walletName: "Rainbow (WalletConnect)", address: OWNER_CHECKSUM},
    });
    expect(kv.get(WALLETCONNECT_KEY)).toBe("1");
    await c.disconnect("evm");
    expect(kv.get(WALLETCONNECT_KEY)).toBeNull();
  });

  it("disconnect while pairing cancels the QR and keeps the existing wallet", async () => {
    const wc = fakeWalletConnect();
    const c = createWalletsController(
      controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load, connectors: [testWallet(fakeEip1193())]}),
    );
    c.start();
    await flush();
    await c.connect("io.test.wallet");
    void c.connect("walletconnect");
    await flush();
    expect(c.getState().pairingUri).not.toBeNull();
    await c.disconnect("evm");
    expect(c.getState()).toMatchObject({connecting: null, pairingUri: null, evm: {walletName: "Test Wallet"}});
  });

  describe("an attempt that shows no pairing QR in time (its relay refuses this site)", () => {
    beforeEach(() => void vi.useFakeTimers());
    afterEach(() => void vi.useRealTimers());

    const NO_START = "WalletConnect didn't start — its relay refused this site or isn't answering. Try a browser wallet or try again later.";
    const wcConnectors = (c: ReturnType<typeof createWalletsController>) => c.wagmi.connectors.filter((x) => x.type === "walletConnect");

    it("fails after WC_START_MS with an answer the connect sheet shows; the next attempt starts on a fresh connector", async () => {
      const wc = fakeWalletConnect({relay: false});
      const c = createWalletsController(controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load}));
      c.start();
      await vi.advanceTimersByTimeAsync(0);
      const done = c.connect("walletconnect");
      await vi.advanceTimersByTimeAsync(WC_START_MS - 1);
      expect(c.getState()).toMatchObject({connecting: "walletconnect", pairingUri: null, error: null});
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(c.getState()).toMatchObject({connecting: null, pairingUri: null, error: NO_START, evm: null});
      expect(wcConnectors(c)).toEqual([]);

      void c.connect("walletconnect");
      await vi.advanceTimersByTimeAsync(0);
      expect(wc.load).toHaveBeenCalledTimes(2);
      expect(wcConnectors(c)).toHaveLength(1);
      expect(c.getState()).toMatchObject({connecting: "walletconnect", error: null});
      // The dropped connector's relay answering late pairs nothing: its QR is never shown, nor lifts the new limit.
      wc.lateUri(0);
      expect(c.getState().pairingUri).toBeNull();
      await vi.advanceTimersByTimeAsync(WC_START_MS);
      expect(c.getState()).toMatchObject({connecting: null, pairingUri: null, error: NO_START});
    });

    it("no limit once the QR is shown: the user may take long to scan", async () => {
      const wc = fakeWalletConnect();
      const c = createWalletsController(controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load}));
      c.start();
      await vi.advanceTimersByTimeAsync(0);
      const done = c.connect("walletconnect");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(c.getState()).toMatchObject({connecting: "walletconnect", pairingUri: "wc:test@2?relay-protocol=irn&symKey=00", error: null});
      wc.approve();
      await done;
      expect(c.getState()).toMatchObject({connecting: null, error: null, evm: {transport: "walletconnect", walletName: "Rainbow (WalletConnect)"}});
    });

    it("a QR that comes late but within WC_START_MS lifts the limit", async () => {
      const wc = fakeWalletConnect({relay: false});
      const c = createWalletsController(controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load}));
      c.start();
      await vi.advanceTimersByTimeAsync(0);
      void c.connect("walletconnect");
      await vi.advanceTimersByTimeAsync(WC_START_MS - 1_000);
      wc.lateUri();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(c.getState()).toMatchObject({connecting: "walletconnect", pairingUri: "wc:late@2?relay-protocol=irn&symKey=00", error: null});
      expect(wcConnectors(c)).toHaveLength(1);
    });

    it("closing the sheet mid-attempt still cancels cleanly: no late error, the wallet kept, the dead connector dropped", async () => {
      const wc = fakeWalletConnect({relay: false});
      const c = createWalletsController(
        controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load, connectors: [testWallet(fakeEip1193())]}),
      );
      c.start();
      await vi.advanceTimersByTimeAsync(0);
      await c.connect("io.test.wallet");
      void c.connect("walletconnect");
      await vi.advanceTimersByTimeAsync(5_000);
      await c.disconnect("evm");
      expect(c.getState()).toMatchObject({connecting: null, pairingUri: null, error: null, evm: {walletName: "Test Wallet"}});
      await vi.advanceTimersByTimeAsync(WC_START_MS);
      expect(c.getState()).toMatchObject({connecting: null, error: null, evm: {walletName: "Test Wallet"}});
      expect(wcConnectors(c)).toEqual([]);
    });

    describe("cancelled at 5 s, tried again at 6 s on the same connector", () => {
      const cancelThenRetry = async () => {
        const wc = fakeWalletConnect({relay: false});
        const c = createWalletsController(controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load}));
        c.start();
        await vi.advanceTimersByTimeAsync(0);
        void c.connect("walletconnect");
        await vi.advanceTimersByTimeAsync(5_000);
        await c.disconnect("evm");
        await vi.advanceTimersByTimeAsync(1_000);
        void c.connect("walletconnect");
        await vi.advanceTimersByTimeAsync(0);
        expect(wc.load).toHaveBeenCalledTimes(1);
        // 15 s: the cancelled attempt's deadline leaves the connector to the retry.
        await vi.advanceTimersByTimeAsync(WC_START_MS - 6_000);
        expect(wcConnectors(c)).toHaveLength(1);
        expect(c.getState()).toMatchObject({connecting: "walletconnect", pairingUri: null, error: null});
        return {wc, c};
      };

      it("a QR that comes at 16 s is shown and lifts the retry's limit", async () => {
        const {wc, c} = await cancelThenRetry();
        await vi.advanceTimersByTimeAsync(1_000);
        wc.lateUri(0);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(c.getState()).toMatchObject({connecting: "walletconnect", pairingUri: "wc:late@2?relay-protocol=irn&symKey=00", error: null});
        expect(wcConnectors(c)).toHaveLength(1);
      });

      it("no QR: the retry fails on its own deadline (21 s) and drops the connector", async () => {
        const {c} = await cancelThenRetry();
        await vi.advanceTimersByTimeAsync(6_000 - 1);
        expect(c.getState()).toMatchObject({connecting: "walletconnect", error: null});
        await vi.advanceTimersByTimeAsync(1);
        expect(c.getState()).toMatchObject({connecting: null, pairingUri: null, error: NO_START});
        expect(wcConnectors(c)).toEqual([]);
      });
    });

    it("a QR nobody is shown (it came after the cancel) lifts no limit: the dead attempt still drops its connector", async () => {
      const wc = fakeWalletConnect({relay: false});
      const c = createWalletsController(controllerDeps({projectId: "0123456789abcdef", loadWalletConnect: wc.load}));
      c.start();
      await vi.advanceTimersByTimeAsync(0);
      void c.connect("walletconnect");
      await vi.advanceTimersByTimeAsync(5_000);
      await c.disconnect("evm");
      await vi.advanceTimersByTimeAsync(5_000);
      wc.lateUri();
      expect(c.getState()).toMatchObject({connecting: null, pairingUri: null, error: null});
      await vi.advanceTimersByTimeAsync(WC_START_MS - 10_000);
      expect(wcConnectors(c)).toEqual([]);
      expect(c.getState()).toMatchObject({connecting: null, pairingUri: null, error: null});
    });
  });

  it("reconnects at boot only when the last session was WalletConnect", async () => {
    const wc = fakeWalletConnect();
    const c = createWalletsController(controllerDeps({projectId: "abc", loadWalletConnect: wc.load, kv: memoryKeyValue({[WALLETCONNECT_KEY]: "1"})}));
    c.start();
    await flush();
    expect(wc.load).toHaveBeenCalledOnce();
  });
});
