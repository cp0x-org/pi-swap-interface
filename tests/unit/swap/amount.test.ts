// Ported from cp0x-elysium apps/mobile/lib/send/amount.test.ts @756b115 (import paths changed).
import {describe, expect, it} from "vitest";
import {amountProblem, fieldText, formatFee, formatUnits, keypadPress, maxSendable, parseUnits, usdOf, type KeypadKey} from "../../../src/swap/amount";

const type = (keys: string, decimals: number) =>
  [...keys].reduce((t, c) => keypadPress(t, (c === "." ? "dot" : c === "<" ? "del" : c) as KeypadKey, decimals), "");

describe("keypadPress", () => {
  it("builds plain decimals", () => {
    expect(type("12.5", 18)).toBe("12.5");
    expect(type("0.001", 6)).toBe("0.001");
  });
  it("starts a bare dot as 0.", () => {
    expect(type(".5", 9)).toBe("0.5");
  });
  it("allows one dot only", () => {
    expect(type("1..2.3", 8)).toBe("1.23");
  });
  it("drops leading zeros", () => {
    expect(type("007", 8)).toBe("7");
    expect(type("0", 8)).toBe("0");
  });
  it("stops at the token's decimals", () => {
    expect(type("1.1234567", 6)).toBe("1.123456");
    expect(type("1.5", 0)).toBe("15");
  });
  it("deletes", () => {
    expect(type("1.25<<", 8)).toBe("1.");
    expect(type("<", 8)).toBe("");
  });
  it("caps the integer part", () => {
    expect(type("1".repeat(20), 8)).toBe("1".repeat(15));
  });
});

describe("parseUnits / formatUnits", () => {
  it("parses exactly", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("0.000000000000000001", 18)).toBe(1n);
    expect(parseUnits("123", 0)).toBe(123n);
    expect(parseUnits("0.", 9)).toBe(0n);
    expect(parseUnits("12345678901234.123456789012345678", 18)).toBe(12345678901234123456789012345678n);
  });
  it("rejects junk and excess decimals", () => {
    expect(parseUnits("", 6)).toBeNull();
    expect(parseUnits(".", 6)).toBeNull();
    expect(parseUnits("1.2.3", 6)).toBeNull();
    expect(parseUnits("-1", 6)).toBeNull();
    expect(parseUnits("1e5", 6)).toBeNull();
    expect(parseUnits("1.1234567", 6)).toBeNull();
  });
  it("round-trips", () => {
    for (const [v, d] of [
      [1n, 18],
      [1_500_000n, 6],
      [0n, 9],
      [10n ** 24n, 24],
    ] as const) {
      expect(parseUnits(formatUnits(v, d), d)).toBe(v);
    }
  });
});

describe("formatFee", () => {
  it("keeps 5 significant digits, rounding up", () => {
    expect(formatFee(123_456_000_000_000n, 18)).toBe("0.00012346");
    expect(formatFee(21_000_000_000_000n, 18)).toBe("0.000021");
    expect(formatFee(5_000n, 9)).toBe("0.000005");
    expect(formatFee(1_234_567n, 6)).toBe("1.2346");
  });
});

describe("usdOf", () => {
  it("prices base units", () => {
    expect(usdOf(1_500_000n, 6, 2)).toBe(3);
    expect(usdOf(1n, 6, undefined)).toBeUndefined();
  });
});

describe("maxSendable", () => {
  it("sends a token's whole balance", () => {
    expect(maxSendable({balance: 500n, fee: 1_000n, isNative: false})).toBe(500n);
  });
  it("leaves the fee on a native send", () => {
    expect(maxSendable({balance: 1_000_000n, fee: 21_000n, isNative: true})).toBe(979_000n);
  });
  it("adds headroom and a reserve", () => {
    expect(maxSendable({balance: 1_000_000n, fee: 10_000n, isNative: true, headroomPct: 20})).toBe(988_000n);
    expect(maxSendable({balance: 1_000_000n, fee: 10_000n, isNative: true, reserve: 90_000n})).toBe(900_000n);
  });
  it("never goes negative", () => {
    expect(maxSendable({balance: 10n, fee: 21_000n, isNative: true})).toBe(0n);
    expect(maxSendable({balance: 0n, fee: 0n, isNative: true})).toBe(0n);
  });
});

describe("amountProblem", () => {
  const base = {balance: 1_000n, isNative: true, nativeBalance: 1_000n, nativeSymbol: "ETH"};
  it("is quiet for no amount", () => {
    expect(amountProblem({...base, amount: null})).toBeNull();
    expect(amountProblem({...base, amount: 0n})).toBeNull();
  });
  it("flags more than the balance", () => {
    expect(amountProblem({...base, amount: 1_001n})).toBe("Insufficient balance");
    expect(amountProblem({...base, balance: 0n, nativeBalance: 0n, amount: 1n})).toBe("Insufficient balance");
  });
  it("waits for the fee before fee checks", () => {
    expect(amountProblem({...base, amount: 1_000n})).toBeNull();
  });
  it("native: amount + fee must fit", () => {
    expect(amountProblem({...base, amount: 990n, fee: 10n})).toBeNull();
    expect(amountProblem({...base, amount: 991n, fee: 10n})).toBe("Not enough ETH for the network fee");
  });
  it("token: the native balance pays the fee", () => {
    const tok = {...base, isNative: false, balance: 5_000n};
    expect(amountProblem({...tok, amount: 5_000n, fee: 1_000n})).toBeNull();
    expect(amountProblem({...tok, amount: 5_000n, fee: 1_001n})).toBe("Not enough ETH for the network fee");
  });
});

describe("fieldText", () => {
  it("shows at most 6 fraction digits, rounded down", () => {
    expect(fieldText(11_584_791_610_159_123_456n, 18)).toBe("11.584791");
    expect(fieldText(1_999_999_999_999_999_999n, 18)).toBe("1.999999");
    expect(fieldText(1_500_000n, 6)).toBe("1.5");
    expect(fieldText(12n, 0)).toBe("12");
    expect(fieldText(5n, 18)).toBe("0");
  });
});
