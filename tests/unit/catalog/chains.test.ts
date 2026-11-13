// Ported from cp0x-elysium packages/shared/src/chains.test.ts @756b115 (verbatim; import path only).
import {describe, expect, it} from "vitest";
import {CHAINS, EVM_CHAINS, NON_EVM_CHAINS, chainByCaip2, chainById, chainBySlug, explorerAddressUrl, explorerTxUrl} from "../../../src/shared/chains";

describe("chain catalog", () => {
  it("covers the SDK: 31 EVM + 6 non-EVM", () => {
    expect(EVM_CHAINS).toHaveLength(31);
    expect(NON_EVM_CHAINS).toHaveLength(6);
    expect(CHAINS).toHaveLength(37);
  });

  it("has unique slugs, caip2 ids and chain ids", () => {
    expect(new Set(CHAINS.map((c) => c.slug)).size).toBe(CHAINS.length);
    expect(new Set(CHAINS.map((c) => c.caip2)).size).toBe(CHAINS.length);
    expect(new Set(EVM_CHAINS.map((c) => c.chainId)).size).toBe(EVM_CHAINS.length);
  });

  // wallet-evm ≥0.6 re-signs after "nonce too low" only when two endpoints confirm the nonce is spent (scan 2026-10-30 F1).
  it("gives every EVM chain at least two RPCs on different hosts", () => {
    for (const c of EVM_CHAINS) expect(new Set(c.rpc.map((u) => u.split("/")[2])).size, c.slug).toBeGreaterThanOrEqual(2);
  });

  it("looks chains up", () => {
    expect(chainById(8453)?.slug).toBe("base");
    expect(chainByCaip2("ton:-239")?.native.symbol).toBe("TON");
  });

  it("links transactions and addresses to each explorer's own routes", () => {
    const tron = chainBySlug("tron")!;
    const hash = "e8e2ba728902927c7f9336b9685bc8fb58662fc1eaa33f478c1d4fcfccf871df";
    expect(explorerTxUrl(tron, hash)).toBe(`https://tronscan.org/transaction/${hash}/overview`);
    expect(explorerAddressUrl(tron, "TXYZ")).toBe("https://tronscan.org/address/TXYZ");
    expect(explorerTxUrl(chainBySlug("ethereum")!, "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(explorerTxUrl(chainBySlug("solana")!, "sig")).toBe("https://solscan.io/tx/sig");
    expect(explorerTxUrl(chainBySlug("ton")!, "bd9d")).toBe("https://tonviewer.com/transaction/bd9d");
    expect(explorerAddressUrl(chainBySlug("ton")!, "UQabc")).toBe("https://tonviewer.com/UQabc");
  });
});
