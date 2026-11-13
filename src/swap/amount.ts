// Copied from cp0x-elysium apps/mobile/lib/send/amount.ts @756b115 (verbatim).
/**
 * Send amounts, exact: what the keypad builds (a decimal string in token
 * units), its base-unit bigint, MAX and the balance checks. Floats only for
 * the USD readout. No React — unit-tested in amount.test.ts.
 */
import {unitsToDecimal} from "@cp0x/shared";

export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "dot" | "del";

/** Integer digits the keypad accepts — far above any real balance, short enough to stay on one line. */
const MAX_INT_DIGITS = 15;

/**
 * The keypad's next string: one dot at most, no fraction digits past the
 * token's decimals, no leading zeros ("05" → "5"), "." → "0.".
 */
export function keypadPress(text: string, key: KeypadKey, decimals: number): string {
  if (key === "del") return text.slice(0, -1);
  if (key === "dot") {
    if (decimals === 0 || text.includes(".")) return text;
    return text === "" ? "0." : `${text}.`;
  }
  const [int = "", frac] = text.split(".");
  if (frac !== undefined) return frac.length >= decimals ? text : text + key;
  if (int === "0") return key;
  if (int.length >= MAX_INT_DIGITS) return text;
  return text + key;
}

/** "1.5" → 1500000n at 6 decimals. Null for anything that is not a plain non-negative decimal or has too many decimals. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [int = "", frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  return BigInt((int || "0") + frac.padEnd(decimals, "0"));
}

/** 1500000n at 6 decimals → "1.5" (exact, no grouping — what the keypad shows after MAX). */
export function formatUnits(value: bigint, decimals: number): string {
  return unitsToDecimal(value.toString(), decimals);
}

/**
 * An amount as an input field shows it: at most `digits` fraction digits,
 * rounded down (Max of 11.584791610159… SKY reads 11.584791). The exact value
 * travels beside it — a Max that left dust behind couldn't empty a position.
 */
export function fieldText(value: bigint, decimals: number, digits = 6): string {
  const unit = decimals > digits ? 10n ** BigInt(decimals - digits) : 1n;
  return formatUnits((value / unit) * unit, decimals);
}

/**
 * A fee for display: up to `sig` significant fraction digits, rounded UP so
 * the review never shows less than will be paid (0.000123456 ETH → 0.00012346).
 */
export function formatFee(value: bigint, decimals: number, sig = 5): string {
  const s = formatUnits(value, decimals);
  const [int = "0", frac = ""] = s.split(".");
  const lead = int === "0" ? (frac.match(/^0*/)?.[0].length ?? 0) : 0;
  const keep = int === "0" ? lead + sig : Math.max(0, sig - int.length);
  if (frac.length <= keep) return s;
  const unit = 10n ** BigInt(decimals - keep);
  const rounded = ((value + unit - 1n) / unit) * unit;
  return formatUnits(rounded, decimals);
}

/** USD value of a base-unit amount, for display only. */
export function usdOf(value: bigint, decimals: number, priceUsd: number | undefined): number | undefined {
  if (priceUsd === undefined) return undefined;
  return Number(unitsToDecimal(value.toString(), decimals)) * priceUsd;
}

export interface MaxInput {
  balance: bigint;
  /** Network fee for this send, native base units (quoted or estimated). */
  fee: bigint;
  /** The fee comes out of the same balance (native asset). */
  isNative: boolean;
  /** Native the account must keep (NEAR storage staking). */
  reserve?: bigint;
  /** Extra margin on the fee, percent — the fee can rise between MAX and signing. */
  headroomPct?: number;
}

/** MAX: a token sends all of it; the native coin sends what is left after the fee (and reserve). Never negative. */
export function maxSendable({balance, fee, isNative, reserve = 0n, headroomPct = 0}: MaxInput): bigint {
  if (!isNative) return balance;
  const withHeadroom = fee + (fee * BigInt(Math.round(headroomPct * 100))) / 10_000n;
  const left = balance - withHeadroom - reserve;
  return left > 0n ? left : 0n;
}

export interface AmountCheck {
  amount: bigint | null;
  balance: bigint;
  isNative: boolean;
  /** Known fee (native base units); undefined while quoting. */
  fee?: bigint;
  /** Native balance on the chain — pays the fee of a token send. */
  nativeBalance: bigint;
  nativeSymbol: string;
}

/** Why the amount can't be sent, or null. Fee checks wait for a fee. */
export function amountProblem({amount, balance, isNative, fee, nativeBalance, nativeSymbol}: AmountCheck): string | null {
  if (amount === null || amount === 0n) return null;
  if (amount > balance) return "Insufficient balance";
  if (fee === undefined) return null;
  if (isNative ? amount + fee > balance : fee > nativeBalance) return `Not enough ${nativeSymbol} for the network fee`;
  return null;
}
