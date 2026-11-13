// Ports mobile lib/addressFormat.test.ts and lib/send/recipient.test.ts @756b115, plus the web checksum checks.
import {describe, expect, it} from "vitest";
import {
  checkRecipient,
  detectAddressFamily,
  isAddressFor,
  sameTonAddress,
  shortAddress,
  toFriendlyAddress,
  toRawAddress,
} from "../../../src/catalog";

describe("detectAddressFamily (mobile, verbatim)", () => {
  it.each([
    ["0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "evm"],
    ["bc1qxwt75778nrw4w4pcuxehkp0x5s9c6a3qvhr54f", "btc"],
    ["t1bGpqumksMefr2H5Z2PvS1ciMKTK3SRmFh", "zcash"],
    ["TQn2x4XVP1MUurjG8cEA9Z9t5bBwrV4QmP", "tron"],
    ["UQCqtJxhqcA7c4rnF8_VDJQdJFT3mAyR1k_fHNxXS7-v4mEI", "ton"],
    ["873337476a7abeed77467fd49ed086b3af3a9628eb9b49a65098ac87da1026c0", "near"],
    ["alice.near", "near"],
    ["C6Xh71NbzEqNnjFBHRpDd4vAw5rRxis5mMsAALctapxK", "solana"],
  ])("%s → %s", (addr, family) => {
    expect(detectAddressFamily(addr)).toBe(family);
  });

  it("rejects junk", () => {
    expect(detectAddressFamily("hello")).toBeNull();
    expect(detectAddressFamily("0x123")).toBeNull();
  });
});

describe("shortAddress (mobile, verbatim)", () => {
  it("keeps head and tail", () => {
    expect(shortAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe("0xf39f…2266");
  });
});

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

describe("checkRecipient (mobile)", () => {
  it("accepts an address of the asset's family", () => {
    expect(checkRecipient(` ${EVM} `, "evm")).toEqual({kind: "address", address: EVM});
    expect(checkRecipient(EVM.toLowerCase(), "evm").kind).toBe("address");
    expect(checkRecipient("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "btc").kind).toBe("address");
    expect(checkRecipient("TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", "tron").kind).toBe("address");
    expect(checkRecipient("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV", "solana").kind).toBe("address");
    expect(checkRecipient("EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2", "ton").kind).toBe("address");
    expect(checkRecipient("alice.near", "near").kind).toBe("address");
    expect(checkRecipient("t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs", "zcash").kind).toBe("address");
  });
  it("catches a checksum typo", () => {
    const typo = EVM.replace("d8dA", "d8Da");
    expect(checkRecipient(typo, "evm")).toMatchObject({kind: "invalid", reason: expect.stringMatching(/checksum/i)});
  });
  it("names the family of a wrong-chain address", () => {
    // web: "an EVM" (mobile reads "a EVM").
    expect(checkRecipient(EVM, "tron")).toEqual({kind: "invalid", reason: "That's an EVM address — this asset is on Tron."});
    expect(checkRecipient("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "evm")).toMatchObject({kind: "invalid"});
  });
  it("treats dotted input as an ENS name on EVM only", () => {
    expect(checkRecipient("Vitalik.eth", "evm")).toEqual({kind: "name", name: "vitalik.eth"});
    expect(checkRecipient("alice.base.eth", "evm").kind).toBe("name");
    expect(checkRecipient("vitalik.eth", "solana").kind).toBe("invalid");
    expect(checkRecipient("vitalik", "evm").kind).toBe("invalid");
  });
  it("is empty for blank input", () => {
    expect(checkRecipient("   ", "evm")).toEqual({kind: "empty"});
  });
  it("accepts an all-uppercase bech32 address (BIP-173, QR codes) and hands on the lowercase form; mixed case stays refused", () => {
    expect(checkRecipient("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", "btc")).toEqual({kind: "address", address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"});
    expect(checkRecipient("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3t4", "btc").kind).toBe("invalid");
  });
  it("an invalid EVM address doesn't suggest an ENS name would do (names are refused for swaps)", () => {
    expect(checkRecipient("0x123", "evm")).toEqual({kind: "invalid", reason: "Not an EVM address."});
  });
});

describe("isAddressFor", () => {
  // Mobile accepted this as a Solana key by shape; a 34-character base58 string starting with "T" decodes to
  // 25 bytes, never a 32-byte Solana key, so the web check says no (it is a valid Tron address).
  it("reads a T-prefixed 34-char base58 string as Tron only", () => {
    const solT = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
    expect(isAddressFor("solana", solT)).toBe(false);
    expect(isAddressFor("tron", solT)).toBe(true);
    expect(isAddressFor("evm", solT)).toBe(false);
    expect(checkRecipient(solT, "solana")).toEqual({kind: "invalid", reason: "That's a Tron address — this asset is on Solana."});
  });

  it("verifies Bitcoin bech32 (v0), bech32m (taproot) and base58check", () => {
    for (const a of [
      "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", // P2WPKH
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", // P2WSH (BIP-173)
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", // P2TR (BIP-350)
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // P2PKH
      "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", // P2SH
    ])
      expect(isAddressFor("btc", a), a).toBe(true);
    // BIP-350: a v1 program with a bech32 (not bech32m) checksum.
    expect(isAddressFor("btc", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd")).toBe(false);
    // One character changed in each form.
    expect(isAddressFor("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr")).toBe(false);
    expect(isAddressFor("btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toBe(false);
    expect(checkRecipient("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb", "btc")).toEqual({kind: "invalid", reason: "Checksum mismatch — this address has a typo."});
  });

  it("verifies Zcash and Tron base58check with their version bytes", () => {
    expect(isAddressFor("zcash", "t1bGpqumksMefr2H5Z2PvS1ciMKTK3SRmFh")).toBe(true);
    expect(isAddressFor("zcash", "t1bGpqumksMefr2H5Z2PvS1ciMKTK3SRmFi")).toBe(false);
    expect(isAddressFor("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(true); // USDT-TRC20
    expect(isAddressFor("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe(false);
    // A valid Bitcoin P2PKH has the right checksum but the wrong version byte for Tron/Zcash.
    expect(isAddressFor("tron", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(false);
  });

  it("verifies TON friendly addresses by CRC and accepts raw ones", () => {
    expect(isAddressFor("ton", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")).toBe(true);
    expect(isAddressFor("ton", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDt")).toBe(false);
    expect(isAddressFor("ton", "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe")).toBe(true);
  });

  it("requires a Solana address to decode to 32 bytes", () => {
    expect(isAddressFor("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
    expect(isAddressFor("solana", "11111111111111111111111111111111")).toBe(true); // System program
    expect(isAddressFor("solana", "1111111111111111111111111111111")).toBe(false); // 31 bytes
    expect(checkRecipient("1111111111111111111111111111111", "solana")).toEqual({kind: "invalid", reason: "Not a Solana address."});
  });

  it("refuses every address for catalog-only families (no validator yet)", () => {
    expect(isAddressFor("ltc", "ltc1qg82jp9h6qr0hdkcn5uz3m9arxhkdt57v3rrcxm")).toBe(false);
    expect(checkRecipient("rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh", "xrp")).toEqual({kind: "invalid", reason: "XRP addresses can't be checked here yet."});
  });
});

describe("TON address forms (mobile lib/dapp/ton.ts)", () => {
  const EQ = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
  const RAW = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
  it("raw ↔ friendly", () => {
    expect(toRawAddress(EQ)).toBe(RAW);
    expect(toRawAddress(RAW.toUpperCase().replace("0:", "0:"))).toBe(RAW);
    const uq = toFriendlyAddress(RAW)!;
    expect(uq.startsWith("UQ")).toBe(true);
    expect(toRawAddress(uq)).toBe(RAW);
    expect(sameTonAddress(EQ, uq)).toBe(true);
    expect(toFriendlyAddress(EQ)).toBe(EQ);
  });
  it("refuses bad checksums and junk", () => {
    expect(toRawAddress(EQ.slice(0, -1) + "t")).toBeNull();
    expect(toRawAddress("hello")).toBeNull();
    expect(sameTonAddress("x", "x")).toBe(false);
    expect(toFriendlyAddress("nope")).toBeNull();
  });
});
