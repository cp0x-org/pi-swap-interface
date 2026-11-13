// Ported from cp0x-elysium apps/mobile/lib/dapp/bytes.test.ts @756b115 (verbatim; import path only).
import {describe, expect, it} from "vitest";
import {base58ToBytes, base64ToBytes, bytesToBase58, bytesToBase64, bytesToHex, hexToBytes, isBase64, isHexString, readableText} from "../../../src/catalog/bytes";

describe("hex", () => {
  it("round-trips with and without 0x", () => {
    expect(bytesToHex(hexToBytes("0xdeadBEEF"))).toBe("0xdeadbeef");
    expect(bytesToHex(hexToBytes("00ff"), false)).toBe("00ff");
  });
  it("refuses odd or non-hex input", () => {
    expect(() => hexToBytes("0xabc")).toThrow();
    expect(() => hexToBytes("0xzz")).toThrow();
    expect(isHexString("0x")).toBe(true);
    expect(isHexString("0x1")).toBe(false);
    expect(isHexString("hello")).toBe(false);
  });
});

describe("base64", () => {
  it("matches Buffer for every padding length", () => {
    for (const s of ["", "a", "ab", "abc", "abcd", "ÿ\u0000binary"]) {
      const bytes = new TextEncoder().encode(s);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect([...base64ToBytes(Buffer.from(bytes).toString("base64"))]).toEqual([...bytes]);
    }
  });
  it("accepts url-safe and unpadded input, refuses garbage", () => {
    expect([...base64ToBytes("-_8")]).toEqual([0xfb, 0xff]);
    expect(isBase64("aGVsbG8")).toBe(true);
    expect(isBase64("not base64!")).toBe(false);
    expect(isBase64("")).toBe(false);
  });
});

describe("base58", () => {
  it("round-trips, keeping leading zeros", () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3, 255]);
    expect([...base58ToBytes(bytesToBase58(bytes))]).toEqual([...bytes]);
  });
  it("decodes the System program to 32 zero bytes", () => {
    expect([...base58ToBytes("11111111111111111111111111111111")]).toEqual(new Array(32).fill(0));
  });
  it("matches a known vector", () => {
    expect(bytesToBase58(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
    expect(() => base58ToBytes("0OIl")).toThrow();
  });
});

describe("readableText", () => {
  it("passes text, refuses control bytes and invalid UTF-8", () => {
    expect(readableText(new TextEncoder().encode("Sign in to app.uniswap.org\nNonce: 1"))).toContain("uniswap");
    expect(readableText(new Uint8Array([0x01, 0x02]))).toBeNull();
    expect(readableText(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});
