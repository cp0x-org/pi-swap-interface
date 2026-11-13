/**
 * The web's route row: the mobile RouteView plus how the payer executes it,
 * whether it needs a memo, and the venue's trust badge (ui-port.md §4.1). Kept
 * out of routes.ts so that file stays diffable against the wallet.
 */
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import type {Execution, WebRoute} from "../contracts/routes";
import type {QuoteGasLike} from "./gas";
import {toRouteView, type QuoteLike} from "./routes";
import {venueTrust} from "./venues";

/**
 * Venues whose route is always a wallet signature even though the dry quote
 * carries no txRequest: Chainflip's vault call is built only for a live quote,
 * Omniston's EVM source is a typed order, Symbiosis' TON source a jetton
 * transfer a TON wallet signs (chunk-BVFMCR2O.js:363-372, depositAddress "";
 * with btcSource off it never names one), and LI.FI (0.8.0) and USDT0 (0.5.0)
 * return a price-only quote, without its transaction, when it was priced for a
 * placeholder recipient or refund (a preview). Never offered as a deposit
 * address, so a QR payer reads "Needs a wallet that signs" instead of a dead end.
 */
const SIGNED_ONLY: ReadonlySet<string> = new Set(["chainflip", "omniston", "symbiosis", "lifi", "usdt0"]);

/** txRequest present (or a signed-only venue) → the wallet signs; else the payer sends to a deposit address. */
export function executionOf(q: Pick<Quote, "provider" | "txRequest">): Execution {
  return q.txRequest || SIGNED_ONLY.has(q.provider) ? "calldata" : "deposit";
}

/**
 * Venues whose `feeUsd` leaves out the bridge fee they charge on top (`nativeFee`): USDT0 reports its protocol fees only
 * (protocol-swap2-usdt0 0.5.0 chunk-V2H32VE3.js:289/474), so its Legacy Mesh into Tron read "fees $0.30" with ≈ $13 of
 * LayerZero fee on top. LI.FI's `feeUsd` sums its feeCosts, which already list it ("LayerZero native fee", included:
 * false; protocol-swap2-lifi 0.8.0 chunk-GWUGK4SG.js:1017).
 */
const FEE_USD_WITHOUT_BRIDGE_FEE: ReadonlySet<string> = new Set(["usdt0"]);

/** toRouteView + the web fields. `native`: the source chain's native coin at its price, for the bridge fee in USD. */
export function toWebRoute(
  q: QuoteLike & Partial<Pick<Quote, "depositMemo">>,
  source?: {chain: string; isToken: boolean},
  gasUsd?: (q: QuoteGasLike) => number,
  native?: {usd: number; decimals: number},
): WebRoute {
  const view = toRouteView(q, source, gasUsd);
  const bridgeFeeUsd =
    native && view.nativeFee > 0n && FEE_USD_WITHOUT_BRIDGE_FEE.has(q.provider) ? (Number(view.nativeFee) / 10 ** native.decimals) * native.usd : 0;
  return {
    ...view,
    execution: executionOf(q),
    hasMemo: typeof q.depositMemo === "string" && q.depositMemo !== "",
    trust: venueTrust(q.provider),
    ...(bridgeFeeUsd > 0 ? {bridgeFeeUsd} : {}),
  };
}
