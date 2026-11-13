import {describe, expect, it} from "vitest";
import type {WalletOption} from "../../../src/contracts/wallets";
import {accountCodeKind, assertNotContract, SMART_ACCOUNT_TEXT} from "../../../src/wallets/evm/account";
import {evmConnectionOf, sameEvmConnection} from "../../../src/wallets/evm/connection";
import {connectErrorText, isUserRejection} from "../../../src/wallets/errors";
import {evmChainIdOf, familyOfCaip2} from "../../../src/wallets/family";
import {connectOptionGroups, dataIcon, evmOptions, menuOptions, WALLETCONNECT_OPTION} from "../../../src/wallets/options";
import {createWalletsStore} from "../../../src/wallets/state";
import {fakePub, ICON, OWNER} from "./fakes";

describe("familyOfCaip2", () => {
  it("maps eip155, solana, tron, ton and near, nothing else", () => {
    expect(familyOfCaip2("eip155:1")).toBe("evm");
    expect(familyOfCaip2("eip155:99901")).toBe("evm");
    expect(familyOfCaip2("solana:mainnet")).toBe("solana");
    expect(familyOfCaip2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe("solana");
    expect(familyOfCaip2("tron:728126428")).toBe("tron");
    expect(familyOfCaip2("ton:-239")).toBe("ton");
    expect(familyOfCaip2("near:mainnet")).toBe("near");
    for (const c of ["bitcoin:mainnet", "zcash:mainnet", "", "eip155"]) expect(familyOfCaip2(c)).toBeNull();
  });

  it("reads only well-formed EVM chain ids", () => {
    expect(evmChainIdOf("eip155:42161")).toBe(42161);
    expect(evmChainIdOf("eip155:99901")).toBe(99901);
    for (const c of ["eip155:", "eip155:0", "eip155:01", "eip155:1a", "solana:mainnet", "eip155:1:x"]) expect(evmChainIdOf(c)).toBeNull();
  });
});

describe("EVM menu entries", () => {
  const injected = (id: string, name: string, icon?: string) => ({id, name, type: "injected", icon});

  it("lists EIP-6963 wallets by rdns in announce order, deduped, with data icons only", () => {
    const out = evmOptions(
      [
        injected("injected", "Injected"),
        injected("io.metamask", "MetaMask", ICON),
        injected("io.rabby", "Rabby", "https://cdn.example/rabby.png"),
        injected("io.metamask", "MetaMask", ICON),
        {id: "walletConnect", name: "WalletConnect", type: "walletConnect"},
        {id: "mock", name: "Mock", type: "mock"},
      ],
      {legacyInjected: true},
    );
    expect(out).toEqual([
      {id: "io.metamask", family: "evm", name: "MetaMask", icon: ICON, kind: "injected"},
      {id: "io.rabby", family: "evm", name: "Rabby", kind: "injected"},
    ]);
  });

  it("shows the window.ethereum entry only when nothing announced and something is injected", () => {
    expect(evmOptions([injected("injected", "Injected")], {legacyInjected: true})).toEqual([
      {id: "injected", family: "evm", name: "Browser wallet", kind: "injected"},
    ]);
    expect(evmOptions([injected("injected", "Injected")], {legacyInjected: false})).toEqual([]);
  });

  it("orders the menu installed first, WalletConnect last and only when configured", () => {
    const evm: WalletOption[] = [{id: "io.metamask", family: "evm", name: "MetaMask", kind: "injected"}];
    const solana: WalletOption[] = [{id: "Phantom", family: "solana", name: "Phantom", kind: "wallet-standard"}];
    expect(menuOptions({evm, solana, walletConnect: false}).map((o) => o.id)).toEqual(["io.metamask", "Phantom"]);
    expect(menuOptions({evm, solana, walletConnect: true}).map((o) => o.id)).toEqual(["io.metamask", "Phantom", "walletconnect"]);
    const g = connectOptionGroups(menuOptions({evm: [], solana, walletConnect: true}));
    expect(g.evm).toEqual([WALLETCONNECT_OPTION]);
    expect(g.installed).toEqual({evm: false, solana: true, tron: false, ton: false, near: false});
    const near: WalletOption[] = [{id: "near:hot-wallet", family: "near", name: "HOT", kind: "injected"}];
    expect(menuOptions({evm, solana, near, walletConnect: true}).map((o) => o.id)).toEqual(["io.metamask", "Phantom", "near:hot-wallet", "walletconnect"]);
    expect(connectOptionGroups(menuOptions({evm, solana, near, walletConnect: false})).near.map((o) => o.id)).toEqual(["near:hot-wallet"]);
  });

  it("accepts only data: image icons", () => {
    expect(dataIcon(ICON)).toBe(ICON);
    expect(dataIcon("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(dataIcon("https://example.com/x.svg")).toBeUndefined();
    expect(dataIcon("data:text/html;base64,AAAA")).toBeUndefined();
    expect(dataIcon(undefined)).toBeUndefined();
  });
});

describe("evmConnectionOf", () => {
  const connector = {id: "io.metamask", name: "MetaMask", type: "injected", uid: "u1", icon: ICON};
  const state = (status: "connected" | "reconnecting" | "connecting" | "disconnected", current: string | null = "u1") => ({
    status,
    current,
    connections: new Map([["u1", {accounts: [OWNER] as const, chainId: 8453, connector: connector as never}]]),
  });

  it("is the current connection, checksummed, while connected or reconnecting", () => {
    const c = evmConnectionOf(state("connected"));
    expect(c).toEqual({family: "evm", address: OWNER, chainId: 8453, walletName: "MetaMask", walletIcon: ICON, transport: "injected"});
    expect(evmConnectionOf(state("reconnecting"))).toEqual(c);
    expect(sameEvmConnection(c, evmConnectionOf(state("connected")))).toBe(true);
  });

  it("is null when disconnected or with no current connection", () => {
    expect(evmConnectionOf(state("disconnected"))).toBeNull();
    expect(evmConnectionOf(state("connecting", null))).toBeNull();
  });

  it("names a WalletConnect session by its peer wallet", () => {
    const wc = {...connector, id: "walletConnect", name: "WalletConnect", type: "walletConnect", icon: undefined};
    const s = {status: "connected" as const, current: "u1", connections: new Map([["u1", {accounts: [OWNER] as const, chainId: 1, connector: wc as never}]])};
    expect(evmConnectionOf(s)?.walletName).toBe("WalletConnect");
    expect(evmConnectionOf(s, new Map([["u1", "Rainbow"]]))).toMatchObject({walletName: "Rainbow (WalletConnect)", transport: "walletconnect"});
  });
});

describe("smart-contract accounts (v1 refuses them)", () => {
  const delegation = `0xef0100${"ab".repeat(20)}`;

  it("classifies eth_getCode", () => {
    expect(accountCodeKind(undefined)).toBe("eoa");
    expect(accountCodeKind("0x")).toBe("eoa");
    expect(accountCodeKind(delegation)).toBe("delegated");
    expect(accountCodeKind(delegation.toUpperCase().replace("0XEF", "0xef"))).toBe("delegated");
    expect(accountCodeKind(`${delegation}00`)).toBe("contract");
    expect(accountCodeKind("0x608060405234801561001057600080fd5b50")).toBe("contract");
  });

  it("passes EOAs and 7702-delegated EOAs, refuses contracts, fails closed on a read error", async () => {
    await expect(assertNotContract(fakePub(undefined), OWNER, "Base")).resolves.toBeUndefined();
    await expect(assertNotContract(fakePub(delegation), OWNER, "Base")).resolves.toBeUndefined();
    await expect(assertNotContract(fakePub("0x6080"), OWNER, "Base")).rejects.toMatchObject({message: SMART_ACCOUNT_TEXT, answered: true});
    await expect(assertNotContract(fakePub(new Error("429")), OWNER, "Base")).rejects.toMatchObject({
      message: "Couldn't check your account on Base right now — try again.",
      answered: true,
    });
  });

  it("asks the public client for the owner's code", async () => {
    const pub = fakePub(undefined);
    await assertNotContract(pub, OWNER, "Base");
    expect(pub.getCode).toHaveBeenCalledWith({address: OWNER});
  });
});

describe("connect errors in the user's words", () => {
  it("recognises rejections by code, name, nested cause and text", () => {
    expect(isUserRejection({code: 4001})).toBe(true);
    expect(isUserRejection(Object.assign(new Error("x"), {name: "UserRejectedRequestError"}))).toBe(true);
    expect(isUserRejection(new Error("outer", {cause: {code: 4001}}))).toBe(true);
    expect(isUserRejection(new Error("User rejected the request."))).toBe(true);
    expect(isUserRejection(new Error("Connection request reset. Please try again."))).toBe(true);
    expect(isUserRejection(new Error("network down"))).toBe(false);
  });

  it("maps each kind to one sentence", () => {
    expect(connectErrorText({code: 4001}, "MetaMask")).toBe("You declined in your wallet.");
    expect(connectErrorText({code: -32002, message: "Request already pending"}, "MetaMask")).toBe(
      "MetaMask already has a request open — finish it in the wallet first.",
    );
    expect(connectErrorText(Object.assign(new Error("x"), {name: "ProviderNotFoundError"}), "Rabby")).toBe("Rabby isn't available in this browser.");
    expect(connectErrorText(Object.assign(new Error("Own text."), {answered: true}), "Rabby")).toBe("Own text.");
    expect(connectErrorText(new Error("boom"), "Rabby")).toBe("Couldn't connect Rabby. Try again.");
  });
});

describe("wallets store", () => {
  it("keeps the snapshot object until a field changes, and derives owners/options", () => {
    const store = createWalletsStore({walletConnect: true});
    let calls = 0;
    store.subscribe(() => calls++);
    const a = store.get();
    expect(a.options).toEqual([WALLETCONNECT_OPTION]);
    store.patch({connecting: null, evmOptions: []});
    expect(store.get()).toBe(a);
    expect(calls).toBe(0);
    store.patch({solana: {family: "solana", address: "So1", walletName: "Phantom"}});
    expect(store.get()).not.toBe(a);
    expect(store.get().owners).toEqual({solana: "So1"});
    expect(calls).toBe(1);
    store.patch({evmOptions: [{id: "io.rabby", family: "evm", name: "Rabby", kind: "injected"}]});
    const b = store.get();
    store.patch({evmOptions: [{id: "io.rabby", family: "evm", name: "Rabby", kind: "injected"}]});
    expect(store.get()).toBe(b);
  });
});
