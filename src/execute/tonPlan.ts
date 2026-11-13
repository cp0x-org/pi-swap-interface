/**
 * checkPlanBrowser's TON rule (D10, D35): what a TON source may be before anything is armed. A deposit — TON to an
 * address, or a jetton transfer, with at most a text comment — and every address a mainnet one (EQ…/UQ… with its
 * checksum, or raw on workchain 0 / -1); never an approval. A contract payload (a cell body) only as a venue's TON
 * contract call listed in TON_CALLS — Symbiosis paid in USDT for a token it releases directly on an EVM network
 * today — and only when its exact BoC passes tonGate.ts's checkTonCall: the app's own decode of the jetton transfer
 * and of the venue's instruction, then the venue package's verifier, all held to the reviewed route. A listed venue
 * is paid by its contract call only, never by a plain deposit. The message the wallet then signs is checked again in
 * tonGate.ts.
 *
 * No @ton/core here (the main bundle): the BoC is read by the TON chunk, which execute.ts hands in as `TonBodyCheck`;
 * a venue's instruction is read through the `Slice` that chunk hands over (a type only here).
 */
import type {Slice} from "@ton/core";
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {SYMBIOSIS_TON_CHAIN_ID, SYMBIOSIS_TON_PORTAL_RAW, symbiosisChain} from "@anywalletkit/protocol-swap2-symbiosis/config";
import {SYMBIOSIS_POOLS, SYMBIOSIS_SYNTHS, type SymbiosisSynth} from "@anywalletkit/protocol-swap2-symbiosis/pools";
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
  /**
   * The least TON its transfer forwards to that contract. TEP-74: a transfer forwarding none sends the contract no
   * transfer_notification, and one too small can't pay for its work — the jettons sit with it, the instruction never runs.
   */
  minForwardTon: bigint;
  /** Whether its call paid in `jetton` (raw) for `destToken` on `destChain` (null = native) is one the checks here hold. */
  serves(jetton: string, destChain: string, destToken: string | null): boolean;
  /** The app's own read of the venue's instruction (the transfer's forward payload), against the reviewed route. */
  instruction(r: ReviewedSwap, s: Slice): string | null;
  /** The package's own check of the exact message, against the request rebuilt from the reviewed route. */
  verify(r: ReviewedSwap, msg: TonCallMessage): string | null;
}

/** Symbiosis' bridge request on TON: the forward payload's op (the TON Portal's), as its package reads it. */
const SYMBIOSIS_TON_REQUEST = 0x5e7d9020;
/** 0.05 TON: what the TON Portal's notification is paid with in every recording (the SDK's, 2026-11-13's dry quotes). */
const SYMBIOSIS_TON_FORWARD = 50_000_000n;

/** The pinned synthetic of `real` (lowercase hex) from Symbiosis chain `chain`, or undefined. */
const synthOf = (chain: number, real: string): string | undefined =>
  Object.keys(SYMBIOSIS_SYNTHS).find((k) => SYMBIOSIS_SYNTHS[k]!.chain === chain && SYMBIOSIS_SYNTHS[k]!.real === real);

/**
 * What Symbiosis burns on its host chain to release `destToken` on `destChain` with nothing after it, for a jetton
 * paid on TON: the token's pinned synthetic, when a pinned pool trades it against the jetton's own (the TON Portal
 * mints the synthetic of the master's last 20 bytes); else undefined. The package's pools are like-asset, so what
 * is released is worth the jetton unit for unit (at its own decimals). EVM destinations only: a Tron or TON payout
 * from TON needs an EVM address of the payer's (`fallbackReceiver`), which a TON wallet doesn't have.
 */
export function symbiosisRelease(jetton: string, destChain: string, destToken: string | null): SymbiosisSynth | undefined {
  const dest = symbiosisChain(destChain);
  const raw = toRawAddress(jetton);
  if (dest?.family !== "evm" || !raw?.startsWith("0:") || !destToken || !/^0x[0-9a-fA-F]{40}$/.test(destToken)) return undefined;
  const from = synthOf(SYMBIOSIS_TON_CHAIN_ID, `0x${raw.slice(-40)}`);
  const to = synthOf(dest.id, destToken.toLowerCase());
  if (!from || !to || !Object.values(SYMBIOSIS_POOLS).some((pool) => pool.includes(from) && pool.includes(to))) return undefined;
  return SYMBIOSIS_SYNTHS[to];
}

/** `amount` of a token with `decimals` in 18-decimal units: like-asset amounts compared unit for unit. */
const scale18 = (amount: bigint, decimals: number): bigint => amount * 10n ** BigInt(18 - decimals);

/**
 * The app's own read of Symbiosis' bridge request (beside its package's): the op, its three cells (head, sides,
 * tail) and nothing else, the head read to its end — the jetton and the amount the review pays, and the relayers'
 * fee (`stableBridgingFee`), which the package bounds only by "less than the amount". What that fee leaves must
 * cover the reviewed minimum unit for unit (a direct release of a like-asset token, `symbiosisRelease`): a fee
 * taking up to the whole input would starve the host-chain swap, the request revert, and the refund come back less
 * that fee. So the most it can cost is what the review's own minimum already allowed.
 */
function symbiosisInstruction(r: ReviewedSwap, s: Slice): string | null {
  const sell = r.fromContract === null ? undefined : ccAssetByToken(r.fromChain, r.fromContract);
  const release = r.fromContract === null ? undefined : symbiosisRelease(r.fromContract, r.destChain, r.destToken);
  if (!sell || !release) return "symbiosis: the route isn't a direct release this app checks";
  try {
    if (s.loadUint(32) !== SYMBIOSIS_TON_REQUEST) return "symbiosis: the forward payload isn't a bridge request";
    if (s.remainingBits !== 0 || s.remainingRefs !== 3) return "symbiosis: the bridge request isn't its three cells";
    const head = s.loadRef().beginParse();
    const fee = head.loadCoins();
    const master = head.loadAddress().toRawString();
    const amount = head.loadCoins();
    head.loadUintBig(160); // the recipient on the host chain: the package binds it
    if (head.remainingBits !== 0 || head.remainingRefs !== 0) return "symbiosis: the bridge request's head carries trailing data";
    if (master !== toRawAddress(r.fromContract!)) return "symbiosis: the bridge request moves another jetton than the one you pay";
    if (amount !== r.amountIn) return "symbiosis: the bridge request moves another amount than the reviewed one";
    if (scale18(r.amountIn - fee, sell.decimals) < scale18(r.minOut, release.decimals)) return "symbiosis: the relayers' fee leaves less than the reviewed minimum";
    return null;
  } catch {
    return "symbiosis: the bridge request can't be read";
  }
}

/**
 * Symbiosis' check of a TON-source message (`checkSymbiosisTonMessage`): one jetton transfer of the sell amount to its
 * pinned TON Portal, the bridge request decoded against its pins — the host chain, its pools, the burn on the
 * destination — crediting only the reviewed recipient, reverted only by the payer's addresses or Symbiosis' pinned
 * revert service, and guaranteeing at least the reviewed minimum. The request is the reviewed route's, never the quote's.
 * A route that swaps again on the destination is refused: its burn's relayers' fee isn't bound by anything.
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
    const bound = checkSymbiosisTonMessage(req, {to: msg.to, value: msg.value.toString(), bodyBoc: msg.bodyBoc}, r.minOut);
    if (bound.destSwap !== null) return "symbiosis: the route swaps again on the destination, which this app doesn't sign from TON";
    return null;
  } catch (e) {
    return `symbiosis: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Venue → its TON contract call. A venue missing here never gets a cell body signed from a TON wallet; each one comes
 * with its package's verifier, a decode of its instruction of the app's own, and tests of its own.
 */
export const TON_CALLS: Readonly<Record<string, TonCallRule>> = {
  // A jetton transfer to the pinned TON Portal carrying the bridge request. USDT, the jetton the package bridges; TON's
  // native coin leaves through a partner exchange, which the package refuses. Only a token the Portal's pools release
  // directly on an EVM network: the bridge request's fee is held to the reviewed minimum unit for unit.
  symbiosis: {
    jettons: [TON_USDT],
    destinations: [SYMBIOSIS_TON_PORTAL_RAW],
    minForwardTon: SYMBIOSIS_TON_FORWARD,
    serves: (jetton, destChain, destToken) => symbiosisRelease(jetton, destChain, destToken) !== undefined,
    instruction: symbiosisInstruction,
    verify: symbiosisTonCall,
  },
};

/**
 * Is `provider`, paid in `contract` (a TON jetton in any spelling; null = native TON) for `destToken` on `destChain`
 * (null = native), a contract call signed here?
 */
export function tonCallSigned(provider: string, contract: string | null, destChain: string, destToken: string | null): boolean {
  const raw = contract === null ? null : toRawAddress(contract);
  const rule = TON_CALLS[provider];
  return !!raw && !!rule?.jettons.includes(raw) && rule.serves(raw, destChain, destToken);
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
  /** The least TON the transfer forwards to that contract (TON_CALLS). */
  minForwardTon: bigint;
  /** The app's own read of the venue's instruction (the forward payload), bound to the reviewed route. */
  instruction(s: Slice): string | null;
  /** The venue's own verifier on the same message (TON_CALLS), bound to the reviewed route. */
  verify(msg: TonCallMessage): string | null;
}

/** The reviewed route's TON contract call, or undefined when the route is none this app signs. */
export function tonCallOf(r: ReviewedSwap): TonCallExpected | undefined {
  const rule = TON_CALLS[r.provider];
  if (!rule || r.fromChain !== "ton:-239" || !tonCallSigned(r.provider, r.fromContract, r.destChain, r.destToken)) return undefined;
  return {
    provider: r.provider,
    jetton: r.fromContract!,
    amount: r.amountIn,
    destinations: rule.destinations,
    minForwardTon: rule.minForwardTon,
    instruction: (s) => rule.instruction(r, s),
    verify: (msg) => rule.verify(r, msg),
  };
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
  const rule = TON_CALLS[plan.provider];
  if (s.kind !== "call" || !rule) return "a TON contract payload this app doesn't sign yet";
  if (r.fromContract === null) return "a TON contract call paid in TON, which this venue's call isn't checked for";
  const raw = toRawAddress(r.fromContract);
  if (!raw || !rule.jettons.includes(raw)) return "a TON contract call paid in a jetton this venue's call isn't checked for";
  const call = tonCallOf(r);
  if (!call) return "a TON contract call for a token this venue's call isn't checked for";
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
  // A listed venue is paid from TON by its contract call only: a plain deposit for it would go wherever its API named.
  if (TON_CALLS[plan.provider] && !(s.kind === "call" && s.cellBody)) return "a plain transfer this venue never makes";
  if (s.kind === "call") {
    if (s.cellBody) return checkCellBody(plan, r, body);
    if (!mainnet(s.to)) return "a deposit address that isn't a TON mainnet address";
    if (s.value <= 0n) return "a TON deposit of nothing";
  }
  if (s.kind === "token-transfer" && !mainnet(s.recipient)) return "a deposit address that isn't a TON mainnet address";
  return null;
}
