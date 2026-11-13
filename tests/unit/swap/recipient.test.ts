import {describe, expect, it, vi} from "vitest";
import type {Family, RecipientCheck} from "../../../src/contracts/domain";
import {swapRecipient} from "../../../src/swap/recipient";

// The address check itself is the catalog's (mobile lib/send/recipient.ts, tested there); this file tests what the swap
// adds on top, so the catalog answer is canned per input.
const CANNED: Record<string, RecipientCheck> = {
  "": {kind: "empty"},
  bad: {kind: "invalid", reason: "Checksum mismatch — this address has a typo."},
  "vitalik.eth": {kind: "name", name: "vitalik.eth"},
  "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba": {kind: "address", address: "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba"},
  "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045": {kind: "address", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"},
  "7dhbwxmci3dt8ufywyzwebLXgycu7Y3iL6trKn1Y7ARj": {kind: "address", address: "7dhbwxmci3dt8ufywyzwebLXgycu7Y3iL6trKn1Y7ARj"},
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": {kind: "address", address: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj"},
};
vi.mock("../../../src/catalog", () => ({
  checkRecipient: (input: string, _family: Family): RecipientCheck => CANNED[input.trim()] ?? {kind: "invalid", reason: "Not an address."},
}));

const evm = {family: "evm" as const, chainName: "Base", owner: "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA"};
const sol = {family: "solana" as const, chainName: "Solana", owner: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj"};

describe("swapRecipient", () => {
  it("passes the catalog's empty / invalid verdicts through", () => {
    expect(swapRecipient("", evm)).toEqual({kind: "empty"});
    expect(swapRecipient("bad", evm)).toEqual({kind: "invalid", reason: "Checksum mismatch — this address has a typo."});
  });
  it("refuses a name: swaps take addresses only", () => {
    expect(swapRecipient("vitalik.eth", evm)).toEqual({kind: "invalid", reason: "Paste the Base address — names aren't used for swaps."});
  });
  it("refuses the connected wallet's own address (EVM case-insensitive, Solana exact)", () => {
    expect(swapRecipient("0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba", evm)).toMatchObject({kind: "invalid", reason: expect.stringContaining("own address")});
    expect(swapRecipient("7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", sol)).toMatchObject({kind: "invalid"});
    expect(swapRecipient("7dhbwxmci3dt8ufywyzwebLXgycu7Y3iL6trKn1Y7ARj", sol)).toEqual({kind: "ok", address: "7dhbwxmci3dt8ufywyzwebLXgycu7Y3iL6trKn1Y7ARj"});
  });
  it("with no wallet on that family the typed address is the only one: no own-address check", () => {
    expect(swapRecipient("0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba", {...evm, owner: null})).toEqual({kind: "ok", address: "0x8abe813577e47415a3cd0bbc68c7abca2c4c55ba"});
    expect(swapRecipient("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", evm)).toEqual({kind: "ok", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"});
  });
});
