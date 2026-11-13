/**
 * Demo scenes for design review and screenshots (D15): `#/demo/<scene>?demo=1`
 * (or `#/?demo=1&scene=<scene>`) opens the swap screen already in that state —
 * a review, a deposit QR, the activity drawer, refused routes, preview prices
 * before a wallet… Scenes only take effect in demo mode; with real ports they
 * are ignored. Every value
 * here is fixture data: the BTC refund address is BIP-173's published test
 * vector and the demo deposit address is invalid, so nothing can be paid.
 */
import type {ActivityItem} from "../contracts/activity";

export const SCENES = [
  "review",
  "executing",
  "error",
  "deposit",
  "deposit-expired",
  "refused",
  "activity",
  "status",
  "claim",
  "connect",
  "tokens",
  "settings",
  "routes",
  "preview",
] as const;

/** One reviewable state of the screen. */
export type Scene = (typeof SCENES)[number];

const isScene = (v: string): v is Scene => (SCENES as readonly string[]).includes(v);

/** The scene named by the hash path (`/demo/<scene>`) or the `scene` query, or null. */
export function sceneFrom(path: string, query: URLSearchParams): Scene | null {
  const m = /^\/demo\/([a-z-]+)\/?$/.exec(path);
  const name = m?.[1] ?? query.get("scene") ?? "";
  return isScene(name) ? name : null;
}

/** BIP-173's example P2WPKH address: valid, public, used only to fill the demo refund field. */
export const DEMO_BTC_REFUND = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

/** The form a scene opens with (token keys of src/mocks fixtures). */
export interface ScenePreset {
  pay?: string;
  receive?: string;
  amount?: string;
  refund?: string;
}

const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BTC = "bitcoin:native";
const ARB_ETH = "arbitrum:native";
const ETH = "ethereum:native";

/** Form presets per scene; scenes without one keep the screen's normal opening pair. */
export function scenePreset(scene: Scene | null): ScenePreset | null {
  switch (scene) {
    // "preview" opens with no wallet (demoWallets defaults to none there): preview prices, the connect CTA, the budget.
    case "review":
    case "executing":
    case "error":
    case "routes":
    case "preview":
      return {pay: ARB_USDC, receive: BASE_USDC, amount: "250"};
    case "deposit":
    case "deposit-expired":
      return {pay: BTC, receive: ARB_USDC, amount: "0.015", refund: DEMO_BTC_REFUND};
    // Under Chainflip's minimum, and LI.FI's route to Ethereum pays someone else: an amount and a safety section.
    case "refused":
      return {pay: ARB_ETH, receive: ETH, amount: "0.008"};
    default:
      return null;
  }
}

/** Scenes that open the review once the routes are in, and what the review then does by itself. */
export const REVIEW_SCENES: Readonly<Partial<Record<Scene, "none" | "confirm" | "error" | "issue" | "expired">>> = {
  review: "none",
  executing: "confirm",
  error: "error",
  deposit: "issue",
  "deposit-expired": "expired",
};

/** The record a status scene opens: the claim-needed CCTP swap, or an in-flight wallet swap. */
export function sceneStatusId(scene: Scene | null, items: readonly ActivityItem[]): string | null {
  if (scene === "claim") return items.find((i) => i.record.status === "action-required")?.record.id ?? null;
  if (scene === "status") return items.find((i) => i.record.status === "pending" && i.record.mode !== "deposit")?.record.id ?? null;
  return null;
}
