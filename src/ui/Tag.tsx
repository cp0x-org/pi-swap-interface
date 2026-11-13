/**
 * Small upper-case labels: the auction's Best/Fastest, the venue trust badge
 * (ui-port.md §5.6), warnings. Tones map to the wallet's colour pairs.
 */
import type {ReactNode} from "react";
import type {TagProps, VenueBadgeProps} from "../contracts/ui";
import type {VenueTrust} from "../contracts/routes";
import {cx} from "./cx";
import {Tooltip} from "./Tooltip";
import s from "./Tag.module.css";

/** A coloured tag; `title` becomes a hover/focus tooltip. */
export function Tag({children, tone, title}: TagProps) {
  const tag = <span className={cx(s.tag, s[tone])}>{children}</span>;
  return title ? <Tooltip content={title}>{tag}</Tooltip> : tag;
}

/** What each trust level means, worded for the tooltip and the RouteSheet sub-line (D21). */
export function venueTrustText(trust: VenueTrust, providerName: string, chainName: string): string {
  if (trust === "contracts") return `Quoted and settled by contracts on ${chainName} — no company API`;
  if (trust === "own-node") return "Quoted by a THORChain node";
  return `Quoted by ${providerName}'s API — checked in your browser before you sign`;
}

const TRUST: Record<VenueTrust, {tone: TagProps["tone"]; label: string}> = {
  contracts: {tone: "green", label: "On-chain"},
  "own-node": {tone: "accent", label: "Node"},
  "provider-api": {tone: "muted", label: "API"},
};

/** How permissionless a venue is: ON-CHAIN (contracts), NODE (THORChain), API (a company's quote API). */
export function VenueBadge({trust, providerName, chainName}: VenueBadgeProps) {
  const t = TRUST[trust];
  return (
    <Tag tone={t.tone} title={venueTrustText(trust, providerName, chainName)}>
      {t.label}
    </Tag>
  );
}

/** Named badges the screens use, so "Best"/"Fastest" look the same everywhere. */
export type BadgeKind = "best" | "fastest" | "contracts" | "node" | "api" | "warning";

/** Props of a named badge; `children` overrides the default label. */
export interface BadgeProps {
  kind: BadgeKind;
  children?: ReactNode;
  title?: string;
}

const BADGE: Record<BadgeKind, {tone: TagProps["tone"]; label: string}> = {
  best: {tone: "accent", label: "Best"},
  fastest: {tone: "green", label: "Fastest"},
  contracts: TRUST.contracts,
  node: TRUST["own-node"],
  api: TRUST["provider-api"],
  warning: {tone: "amber", label: "Check"},
};

export function Badge({kind, children, title}: BadgeProps) {
  const b = BADGE[kind];
  return (
    <Tag tone={b.tone} title={title}>
      {children ?? b.label}
    </Tag>
  );
}
