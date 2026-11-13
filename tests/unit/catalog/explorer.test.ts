import {describe, expect, it} from "vitest";
import {addressUrl, txUrl} from "../../../src/catalog";

describe("txUrl / addressUrl", () => {
  it("links each shared family to its explorer's own routes", () => {
    expect(txUrl("eip155:1", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(txUrl("eip155:99901", "0xabc")).toBe("https://elysium.kinetiq.xyz/tx/0xabc");
    expect(txUrl("solana:mainnet", "sig")).toBe("https://solscan.io/tx/sig");
    expect(txUrl("tron:728126428", "h")).toBe("https://tronscan.org/transaction/h/overview");
    expect(txUrl("ton:-239", "h")).toBe("https://tonviewer.com/transaction/h");
    expect(txUrl("bitcoin:mainnet", "h")).toBe("https://mempool.space/tx/h");
    expect(addressUrl("ton:-239", "UQabc")).toBe("https://tonviewer.com/UQabc");
    expect(addressUrl("eip155:8453", "0x1")).toBe("https://basescan.org/address/0x1");
  });

  it("uses nearblocks' /txns/ and blockchair's /transaction/ routes", () => {
    expect(txUrl("near:mainnet", "h")).toBe("https://nearblocks.io/txns/h");
    expect(txUrl("zcash:mainnet", "h")).toBe("https://blockchair.com/zcash/transaction/h");
    expect(addressUrl("near:mainnet", "alice.near")).toBe("https://nearblocks.io/address/alice.near");
  });

  it("accepts the caip2 aliases wallets report", () => {
    expect(txUrl("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "sig")).toBe("https://solscan.io/tx/sig");
    expect(txUrl("bip122:000000000019d6689c085ae165831e93", "h")).toBe("https://mempool.space/tx/h");
  });

  it("is undefined without an explorer, a hash, or a known chain", () => {
    expect(txUrl("eip155:747474", "0xabc")).toBeUndefined(); // Katana
    expect(addressUrl("eip155:5042", "0x1")).toBeUndefined(); // Arc
    expect(txUrl("eip155:1", "")).toBeUndefined();
    expect(txUrl("eip155:424242", "0xabc")).toBeUndefined();
  });

  it("links catalog-only chains even when they are not listed", () => {
    expect(txUrl("litecoin:mainnet", "h")).toBe("https://blockchair.com/litecoin/transaction/h");
    expect(addressUrl("xrp:mainnet", "rX")).toBe("https://xrpscan.com/account/rX");
  });
});
