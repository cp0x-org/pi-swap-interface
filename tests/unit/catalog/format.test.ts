// Ported from cp0x-elysium packages/shared/src/format.test.ts @756b115 (verbatim; import path only).
import {describe, expect, it} from "vitest";
import {formatAmount, formatPct, formatUsd, formatUsdDelta, splitUsd, unitsToDecimal} from "../../../src/shared/format";

describe("format", () => {
  it("splits dollars and cents", () => {
    expect(splitUsd(20686.3)).toEqual({whole: "$20,686", cents: ".30"});
    expect(splitUsd(0)).toEqual({whole: "$0", cents: ".00"});
  });

  it("formats usd values and deltas", () => {
    expect(formatUsd(10113.4)).toBe("$10,113.40");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsdDelta(202.17)).toBe("+$202.17");
    expect(formatUsdDelta(-34.55)).toBe("-$34.55");
    expect(formatUsdDelta(0.001)).toBe("$0.00");
  });

  it("formats percentages", () => {
    expect(formatPct(2.0412)).toBe("+2.04%");
    expect(formatPct(-1.12)).toBe("-1.12%");
    expect(formatPct(0)).toBe("0.00%");
  });

  it("converts base units exactly", () => {
    expect(unitsToDecimal("5773252986299759339", 18)).toBe("5.773252986299759339");
    expect(unitsToDecimal("291368219", 6)).toBe("291.368219");
    expect(unitsToDecimal("100", 2)).toBe("1");
    expect(unitsToDecimal("5", 3)).toBe("0.005");
    expect(unitsToDecimal("0", 18)).toBe("0");
  });

  it("formats display amounts", () => {
    expect(formatAmount("3142000000000000000", 18)).toBe("3.142");
    expect(formatAmount("4200000000", 6)).toBe("4,200");
    expect(formatAmount("1", 18)).toBe("<0.0001");
    expect(formatAmount("0", 18)).toBe("0");
  });
});
