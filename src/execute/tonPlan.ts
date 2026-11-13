/**
 * checkPlanBrowser's TON rule (D10, D35): what a TON source may be before anything is armed. A deposit — TON to an
 * address, or a jetton transfer, with at most a text comment — and every address a mainnet one (EQ…/UQ… with its
 * checksum, or raw on workchain 0 / -1); never an approval. A contract payload (a cell body) only as a venue's TON
 * contract call listed in TON_CALLS — Symbiosis paid in USDT today — and only when its exact BoC passes tonGate.ts's
 * checkTonCall: the app's own decode of the jetton transfer, then the venue package's verifier, both held to the
 * reviewed route. The message the wallet then signs is checked again in tonGate.ts.
 *
 * No @ton/core here (the main bundle): the BoC is read by the TON chunk, which execute.ts hands in as `TonBodyCheck`.
 */
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {SYMBIOSIS_TON_PORTAL_RAW} from "@anywalletkit/protocol-swap2-symbiosis/config";
import {checkSymbiosisTonMessage, symbiosisRequest} from "@anywalletkit/protocol-swap2-symbiosis/verify";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {isAddressFor, toRawAddress} from "../catalog";
import type {ReviewedSwap} from "../contracts/execution";

/** A TON mainnet address in a strict form (no test-only friendly address, no other workchain). */
const mainnet = (a: string): boolean => isAddressFor("ton", a) && (!a.includes(":") || /^(-1|0):/.test(a));

/** USDT's jetton master on TON (raw): the one jetton whose wallet code the app pins (tonGate.ts PINNED_JETTON_CODE). */
export const TON_USDT = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";

/** A TON contract call's message: where it is sent, the TON it attaches, its cell body (a base64 BoC). */
export interface TonCallMessage {
  to: string;
  value: bigint;
  bodyBoc: string;
}

/**
 * A venue's TON contract call (D35): a jetton transfer from the payer's own jetton wallet to the venue's contract,
 * whose forward payload is the venue's instruction to it. Everything here comes from the venue's package or the app.
 */
interface TonCallRule {
  /** The jetton masters (raw) it may be paid in, each with pinned wallet code. Never native TON. */
  jettons: readonly string[];
  /** The contracts (raw) its transfer may pay. */
  destinations: readonly string[];
  /** The package's own check of the exact message, against the request rebuilt from the reviewed route. */
  verify(r: ReviewedSwap, msg: TonCallMessage): string | null;
}

/**
 * Symbiosis' check of a TON-source message (`checkSymbiosisTonMessage`): one jetton transfer of the sell amount to its
 * pinned TON Portal, the bridge request decoded against its pins — the host chain, its pools, the burn on the
 * destination — crediting only the reviewed recipient, reverted only by the payer's addresses or Symbiosis' pinned
 * revert service, and guaranteeing at least the reviewed minimum. The request is the reviewed route's, never the quote's.
 */
function symbiosisTonCall(r: ReviewedSwap, msg: TonCallMessage): string | null {
  const sell = r.fromContract === null ? undefined : ccAssetByToken(r.fromChain, r.fromContract);
  if (!sell?.contract || toRawAddress(sell.contract) !== toRawAddress(r.fromContract!)) return "symbiosis: the token you pay isn't the catalog's";
  const req = symbiosisRequest({
    sourceChain: r.fromChain,
    sourceToken: sell.symbol,
    destChain: r.destChain,
    destToken: r.destToken,
    amountIn: r.amountIn.toString(),
    destAddress: r.recipient,
    refundAddress: r.refundAddress,
  });
  if (typeof req === "string") return `symbiosis: ${req}`;
  if (req.sellToken === null || toRawAddress(req.sellToken) !== toRawAddress(r.fromContract!)) return "symbiosis: the token you pay isn't the catalog's";
  try {
    checkSymbiosisTonMessage(req, {to: msg.to, value: msg.value.toString(), bodyBoc: msg.bodyBoc}, r.minOut);
    return null;
  } catch (e) {
    return `symbiosis: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Venue → its TON contract call. A venue missing here never gets a cell body signed from a TON wallet; each one comes
 * with its package's verifier and tests of its own.
 */
export const TON_CALLS: Readonly<Record<string, TonCallRule>> = {
  // A jetton transfer to the pinned TON Portal carrying the bridge request. USDT, the jetton the package bridges; TON's
  // native coin leaves through a partner exchange, which the package refuses.
  symbiosis: {jettons: [TON_USDT], destinations: [SYMBIOSIS_TON_PORTAL_RAW], verify: symbiosisTonCall},
};

/** Is `provider`, paid in `contract` (a TON jetton in any spelling; null = native TON), a contract call signed here? */
export function tonCallSigned(provider: string, contract: string | null): boolean {
  const raw = contract === null ? null : toRawAddress(contract);
  return !!raw && !!TON_CALLS[provider]?.jettons.includes(raw);
}

/**
 * What the reviewed route fixes about its TON contract call — the expectation tonGate.ts's checkTonCall holds the exact
 * BoC to, at the plan and again on the TON Connect message. Every field is the review's or the venue package's.
 */
export interface TonCallExpected {
  provider: string;
  /** The jetton master paid in, as the review named it (one with pinned wallet code). */
  jetton: string;
  /** The jettons the transfer moves: the reviewed input. */
  amount: bigint;
  /** The contracts (raw) the transfer may pay: the venue's, from its package. */
  destinations: readonly string[];
  /** The venue's own verifier on the same message (TON_CALLS), bound to the reviewed route. */
  verify(msg: TonCallMessage): string | null;
}

/** The reviewed route's TON contract call, or undefined when the route is none this app signs. */
export function tonCallOf(r: ReviewedSwap): TonCallExpected | undefined {
  const rule = TON_CALLS[r.provider];
  if (!rule || r.fromChain !== "ton:-239" || !tonCallSigned(r.provider, r.fromContract)) return undefined;
  return {provider: r.provider, jetton: r.fromContract!, amount: r.amountIn, destinations: rule.destinations, verify: (msg) => rule.verify(r, msg)};
}

/**
 * The cell body the engine was handed, and the reader for it — both from the TON chunk (tonGate.ts captureTonBody,
 * which execute.ts loads for a TON payer only).
 */
export interface TonBodyCheck {
  /** The exact BoC execute.ts's decodeTonBody kept (the last one the engine decoded); undefined before any. */
  boc(): string | undefined;
  /** tonGate.ts checkTonCall: why the message is not the reviewed call from `self` (raw), or null. */
  check(msg: TonCallMessage, call: TonCallExpected, self: string): string | null;
}

/** Why a cell-body source is not the reviewed route's TON contract call, or null. */
function checkCellBody(plan: Swap2ExecutionPlan, r: ReviewedSwap, body: TonBodyCheck | undefined): string | null {
  const s = plan.source;
  if (s.kind !== "call" || !TON_CALLS[plan.provider]) return "a TON contract payload this app doesn't sign yet";
  if (r.fromContract === null) return "a TON contract call paid in TON, which this venue's call isn't checked for";
  const call = tonCallOf(r);
  if (!call) return "a TON contract call paid in a jetton this venue's call isn't checked for";
  if (s.data !== undefined || s.memo !== undefined || s.memoEncoding !== undefined || s.chainId !== undefined || s.gasLimit !== undefined)
    return "a payload this network doesn't carry";
  const boc = body?.boc();
  if (!body || !boc) return "the TON contract call's body is missing";
  const self = toRawAddress(r.refundAddress);
  if (!self) return "the refund address isn't a TON address";
  return body.check({to: s.to, value: s.value, bodyBoc: boc}, call, self);
}

/** Why a TON source plan is not one this app signs, or null. `body`: the cell body's reader (a TON payer's execution). */
export function checkTonPlan(plan: Swap2ExecutionPlan, r: ReviewedSwap, body?: TonBodyCheck): string | null {
  if (plan.approvals.length) return "an approval on a network that has none";
  const s = plan.source;
  if (s.kind === "call") {
    if (s.cellBody) return checkCellBody(plan, r, body);
    if (!mainnet(s.to)) return "a deposit address that isn't a TON mainnet address";
    if (s.value <= 0n) return "a TON deposit of nothing";
  }
  if (s.kind === "token-transfer" && !mainnet(s.recipient)) return "a deposit address that isn't a TON mainnet address";
  return null;
}
