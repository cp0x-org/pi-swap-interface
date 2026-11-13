// Copied from cp0x-elysium packages/shared/src/format.ts @756b115 (verbatim). Owner: catalog.
/** Money and amount formatting shared by the app (en-US, tabular-friendly). */

const usdFmt = new Intl.NumberFormat("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});

/** 20686.3 → {whole: "$20,686", cents: ".30"} — the balance hero splits them. */
export function splitUsd(value: number): {whole: string; cents: string} {
  const s = usdFmt.format(Math.abs(value));
  const [w, c] = s.split(".");
  return {whole: `${value < 0 ? "-" : ""}$${w}`, cents: `.${c ?? "00"}`};
}

/** $1,234.56 · values under a cent show as <$0.01. */
export function formatUsd(value: number): string {
  if (value !== 0 && Math.abs(value) < 0.01) return value < 0 ? "-<$0.01" : "<$0.01";
  const {whole, cents} = splitUsd(value);
  return whole + cents;
}

/** Signed: +$202.17 / -$34.55 / $0.00 */
export function formatUsdDelta(value: number): string {
  if (Math.abs(value) < 0.005) return "$0.00";
  return `${value > 0 ? "+" : "-"}${formatUsd(Math.abs(value))}`;
}

/** +2.04% / -1.12% / 0.00% */
export function formatPct(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) return "0.00%";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** Base units → decimal string, exact (bigint), trimmed of trailing zeros. */
export function unitsToDecimal(amount: string, decimals: number): string {
  const neg = amount.startsWith("-");
  const digits = (neg ? amount.slice(1) : amount).replace(/^0+/, "") || "0";
  const padded = digits.padStart(decimals + 1, "0");
  const int = padded.slice(0, padded.length - decimals) || "0";
  const frac = decimals ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/**
 * Human amount: 3.1420 (4 decimals under 1 000), 12,345.6 above, thousands
 * grouped, tiny non-zero values as <0.0001. Display only — never parse back.
 */
export function formatAmount(amount: string, decimals: number): string {
  const n = Number(unitsToDecimal(amount, decimals));
  if (n === 0) return "0";
  if (n < 0.0001) return "<0.0001";
  const maxFrac = n >= 1000 ? 2 : 4;
  return new Intl.NumberFormat("en-US", {minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: maxFrac}).format(n);
}
