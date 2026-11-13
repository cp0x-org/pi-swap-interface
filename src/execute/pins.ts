/**
 * What the browser trusts about each venue's EVM source leg (engine.md §7.3 LOCAL_PINS, defence in depth on top of
 * the providers' own checks): the contracts its calldata may call and the spenders it may approve. The lists come
 * from the provider packages themselves — the same code the providers run with — never from config or a server, so
 * a venue's API cannot name its own contract. They must agree with the provider options swap builds (LI.FI's Flare
 * Diamond is in `lifiPins`; a test checks it).
 *
 * NEAR Intents only ever pays a per-quote deposit address (nothing to pin: the "deposit" rule); Jupiter is a Solana
 * transaction the SDK account guards itself; Omniston's only spenders are its audited order protocols (swap's
 * `orderSpender`, so this file never imports the Omniston package — it stays out of the main bundle).
 *
 * Tron sources (a TronLink payment) have their own table, TRON_RULES: NEAR Intents' deposit address, and Chainflip's
 * Tron Vault (CF_VAULTS, from its package) with its hex note. THORChain's Tron source stays off (`tronSource: false`
 * in swap's providers), so it has no Tron rule either.
 */
import {balancerPins} from "@anywalletkit/protocol-swap2-balancer/provider";
import {cctpPins} from "@anywalletkit/protocol-swap2-cctp/provider";
import {CF_VAULTS, chainflipPins} from "@anywalletkit/protocol-swap2-chainflip/config";
import type {RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {curvePins} from "@anywalletkit/protocol-swap2-curve";
import {fyndPins} from "@anywalletkit/protocol-swap2-fynd/router";
import {lifiPins} from "@anywalletkit/protocol-swap2-lifi/provider";
import {relayPins} from "@anywalletkit/protocol-swap2-relay/verify";
import {symbiosisPins} from "@anywalletkit/protocol-swap2-symbiosis/verify";
import {thorchainPins} from "@anywalletkit/protocol-swap2-thorchain/provider";
import {uniswapPins} from "@anywalletkit/protocol-swap2-uniswap";
import {usdt0Pins} from "@anywalletkit/protocol-swap2-usdt0/config";
import {wrapPins} from "@anywalletkit/protocol-swap2-wrap/provider";
import {orderSpender} from "../swap";
import type {TronRule, VenueRule} from "./gate";

type Pins = Pick<RemotePins, "callTargets" | "spenders">;

const pinned = (pins: Pins): VenueRule => ({kind: "pins", pins});

let thor: Pins | null = null;
/** thorchainPins() builds a node client for its build check; only its router lists are used here, built on first use. */
const thorPins: Pins = {
  callTargets: (c) => (thor ??= thorchainPins()).callTargets(c),
  spenders: (c) => (thor ??= thorchainPins()).spenders(c),
};

const omnistonPins: Pins = {
  callTargets: () => [],
  spenders: (c) => {
    const s = orderSpender("omniston", c);
    return s ? [s] : [];
  },
};

/** Venue → its EVM rule. A venue missing here gets no EVM calldata or order signature at all (checkPlanBrowser). */
export const VENUE_RULES: Readonly<Record<string, VenueRule>> = {
  lifi: pinned(lifiPins),
  relay: pinned(relayPins),
  cctp: pinned(cctpPins),
  usdt0: pinned(usdt0Pins),
  chainflip: pinned(chainflipPins),
  uniswap: pinned(uniswapPins),
  // The pinned Router NG per chain (call target and the one spender).
  curve: pinned(curvePins),
  wrap: pinned(wrapPins),
  thorchain: pinned(thorPins),
  balancer: pinned(balancerPins),
  symbiosis: pinned(symbiosisPins),
  omniston: pinned(omnistonPins),
  // TychoRouterV3 per chain: every Fynd route settles through it (Fynd License).
  fynd: pinned(fyndPins),
  near_intents: {kind: "deposit"},
};

/** The rule checkPlanBrowser holds `provider`'s live plan to (undefined = none: calldata refused). */
export const venueRule = (provider: string): VenueRule | undefined => VENUE_RULES[provider];

const TRON = "tron:728126428";
const cfTronVault = (CF_VAULTS as Readonly<Record<string, string>>)[TRON];

/** Venue → how it may be paid from a Tron wallet. A venue missing here is never paid from one (checkPlanBrowser). */
export const TRON_RULES: Readonly<Record<string, TronRule>> = {
  near_intents: {kind: "deposit"},
  ...(cfTronVault ? {chainflip: {kind: "vault", to: [cfTronVault], memo: "hex"} as const} : {}),
};

/** The Tron rule checkPlanBrowser holds `provider`'s live plan to (undefined = none: refused). */
export const tronRule = (provider: string): TronRule | undefined => TRON_RULES[provider];
