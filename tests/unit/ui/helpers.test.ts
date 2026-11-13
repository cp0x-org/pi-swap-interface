import {describe, expect, it} from "vitest";
import {amountFontSize, countdownTone, formatCountdown, venueTrustText} from "../../../src/ui";

describe("formatCountdown", () => {
  it("m:ss, rounded up so 0:00 means expired", () => {
    expect(formatCountdown(14 * 60_000)).toBe("14:00");
    expect(formatCountdown(95_000)).toBe("1:35");
    expect(formatCountdown(94_001)).toBe("1:35");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5_000)).toBe("0:00");
  });

  it("h:mm:ss from an hour up", () => {
    expect(formatCountdown(3_600_000 + 65_000)).toBe("1:01:05");
  });
});

describe("countdownTone", () => {
  it("amber under two minutes, red at zero", () => {
    expect(countdownTone(10 * 60_000)).toBe("ink");
    expect(countdownTone(119_000)).toBe("amber");
    expect(countdownTone(0)).toBe("red");
    expect(countdownTone(30_000, 20_000)).toBe("ink");
  });
});

describe("amountFontSize", () => {
  it("shrinks the receive amount with its length", () => {
    expect(amountFontSize("0.07841")).toEqual({size: 25, tracking: -0.8});
    expect(amountFontSize("1234567.891234")).toEqual({size: 21, tracking: -0.7});
    expect(amountFontSize("98765432101.123456")).toEqual({size: 18, tracking: -0.6});
  });
});

describe("venueTrustText", () => {
  it("words each trust level (D21)", () => {
    expect(venueTrustText("contracts", "Uniswap", "Base")).toBe("Quoted and settled by contracts on Base — no company API");
    expect(venueTrustText("own-node", "THORChain", "Bitcoin")).toBe("Quoted by a THORChain node");
    expect(venueTrustText("provider-api", "LI.FI", "Base")).toBe("Quoted by LI.FI's API — checked in your browser before you sign");
  });
});
