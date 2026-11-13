/**
 * Small display helpers the screens share: family names, tone colours, amount
 * text and "ago" labels. Pure — no React, no ports.
 */
import type {StatusView} from "../contracts/activity";
import type {Family} from "../contracts/domain";
import type {WalletFamily} from "../contracts/wallets";
import {formatAmount} from "../catalog";

/** How the connect buttons name a family ("Connect EVM wallet"). */
export const FAMILY_LABEL: Readonly<Record<WalletFamily, string>> = {evm: "EVM", solana: "Solana", tron: "Tron", ton: "TON", near: "NEAR"};

/** The wallet family a token's family signs with in the browser, or null (BTC, ZEC…: deposit address only). */
export const walletFamilyOf = (family: Family): WalletFamily | null =>
  family === "evm" || family === "solana" || family === "tron" || family === "ton" || family === "near" ? family : null;

/** A status tone as a token colour (mobile status.tsx TONE). */
export const TONE_COLOR: Readonly<Record<StatusView["tone"], string>> = {
  progress: "var(--accent)",
  action: "var(--amber)",
  ok: "var(--green)",
  warn: "var(--amber)",
  bad: "var(--red)",
};

/** "1,204.5 USDC" from base units — display only. */
export const amountText = (units: bigint | string, decimals: number, symbol: string): string =>
  `${formatAmount(units.toString(), decimals)} ${symbol}`;

/** Base units → a plain decimal for the amount field ("12.5", no grouping), so "Try again" refills it exactly. */
export function plainUnits(units: string, decimals: number): string {
  let v: bigint;
  try {
    v = BigInt(units);
  } catch {
    return "";
  }
  const scale = 10n ** BigInt(decimals);
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / scale}.${frac}` : `${v / scale}`;
}

/** "just now", "12 s ago", "3 min ago", "2 h ago" — how fresh a quote or a record is. */
export function agoLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

/** "1 route" / "3 routes". */
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
