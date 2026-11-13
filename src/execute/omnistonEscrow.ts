/**
 * Omniston's escrow from a TON wallet, bound beyond its bytes (D35 part B): the `bind` of tonPlan.ts's Omniston escrow
 * rule, a chunk of its own (@ton/core and the Omniston package) loaded for that call only. It runs on the exact BoC
 * checkTonCall read — before anything is armed (execute.ts) and again right before the wallet is asked
 * (accounts/ton.ts) — once the app's own decode passed (the transfer; the escrow order's owner, destination, minimum and
 * single keccak lock):
 *
 *   1. The build this page's Omniston provider made and checked (omnistonBuilds.ts): its validateTonEscrowPayload
 *      passed on these very bytes against the quote it cached. A body it didn't build and check is refused, and so is
 *      one whose quote id isn't that build's.
 *   2. The hashlock is this browser's: the one secret IndexedDB holds for that quote (stores.ts, saved with durability
 *      "strict" before the provider asked for the escrow), hashed with keccak-256, is the escrow's hashlock. So the
 *      preimage the swap needs is on disk before anything is signed — a tab closed after signing still has it for the
 *      activity tracker's next poll — and no preimage but this browser's unlocks the payer's jettons.
 *   3. The package's payload check again (validateTonEscrowPayload), on these bytes: the amount, the owner (the payer),
 *      the destination network, token and recipient from the review; the hashlock of step 2; the quote's side — its
 *      id, the resolver, the resolver's deposit, the exclusivity window, what the resolver sends — as step 1's build
 *      had it; and its pins (escrow and execution code, authority key, the timelocks, no Dutch auction, one fill).
 *   4. The package's build verifier as the phone runs it (`omnistonEscrowVerifier`: mobile pins.ts), with a quote and
 *      a request rebuilt from the review, never the live quote: the escrow branch, the audited settlement contract,
 *      the amount, the owner, the destination, the resolver bound to send at least the reviewed minimum.
 *
 * The secret itself never leaves stores.ts here: only its hash is compared. The reason it refuses ("omniston: …"), or null.
 */
import {Buffer} from "buffer";
import {Cell} from "@ton/core";
import {hexToBytes, keccak256} from "viem";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {omnistonVerifyBuild} from "@anywalletkit/protocol-swap2-omniston/provider";
import {createOmnistonTonValidators} from "@anywalletkit/protocol-swap2-omniston/validators";
import {ccAsset, ccAssetByToken} from "@anywalletkit/swap2-assets";
import {getRuntimeConfig} from "../config";
import type {ReviewedSwap} from "../contracts/execution";
import {omnistonEscrowBuild} from "../swap/omnistonBuilds";
import {createProviderStores, type ProviderStores} from "../swap/stores";
import type {TonCallMessage} from "./tonPlan";

/** The one hashing function the package's escrow check takes (one keccak execution). */
const KECCAK = "HASHING_FUNCTION_KECCAK256";

/**
 * The package's build verifier as the phone runs it (mobile pins.ts): `omnistonVerifyBuild` over the package's TON
 * validators, no integrator (a body naming one is refused), and an escrow body only from a jetton source — the jetton
 * wallet is what binds the message's target; nothing binds where native TON would go.
 */
export function omnistonEscrowVerifier(tonApiUrl: string): (quote: Quote, tx: UnsignedTx, params?: QuoteParams) => Promise<string | null> {
  const verify = omnistonVerifyBuild({...createOmnistonTonValidators({tonApiUrl}), integratorAddress: null});
  return async (quote, tx, params) => {
    if (tx.bodyBoc !== undefined && params && quote.providerData?.settlement !== "swap" && !ccAsset(params.sourceChain, params.sourceToken)?.contract)
      return "an escrow body needs a jetton source";
    return verify(quote, tx, params);
  };
}

/** The escrow order's quote id and hashlock (hex) and its forward payload (hex BoC), read again from the BoC; null when it isn't one. */
function escrowOf(boc: string): {quoteId: string; hashlock: string; forwardHex: string} | null {
  try {
    const cells = Cell.fromBoc(Buffer.from(boc, "base64"));
    if (cells.length !== 1) return null;
    const transfer = cells[0]!;
    if (transfer.refs.length !== 1) return null;
    const forward = transfer.refs[0]!;
    const order = forward.beginParse();
    order.skip(32);
    const quoteId = order.loadBuffer(32).toString("hex");
    // config → its state → the execution: op, then the hashlock.
    const execution = forward.refs[0]!.refs[0]!.refs[1]!.beginParse();
    execution.skip(32);
    const hashlock = execution.loadBuffer(32).toString("hex");
    return {quoteId, hashlock, forwardHex: Buffer.from(forward.toBoc()).toString("hex")};
  } catch {
    return null;
  }
}

let stores: ProviderStores | undefined;
/** The secrets IndexedDB holds (stores.ts), read back from disk as a reloaded tab would read them. */
const secrets = () => (stores ??= createProviderStores()).omnistonSecrets;

/** Why `msg` (from the reviewed route `r`'s payer) is not an Omniston escrow this browser can complete, or null. */
export async function checkOmnistonEscrow(r: ReviewedSwap, msg: TonCallMessage): Promise<string | null> {
  const sell = r.fromContract === null ? undefined : ccAssetByToken(r.fromChain, r.fromContract);
  if (!sell?.contract) return "omniston: an escrow body needs a jetton source";
  const body = escrowOf(msg.bodyBoc);
  if (!body) return "omniston: the escrow order can't be read";
  const payloadHex = Buffer.from(msg.bodyBoc, "base64").toString("hex");

  // 1. A build this page's provider made and checked, for this very quote.
  const built = omnistonEscrowBuild(payloadHex);
  if (!built) return "omniston: this escrow wasn't built and checked by this page's Omniston provider";
  if (built.quoteId.toLowerCase().padStart(64, "0") !== body.quoteId) return "omniston: the escrow names another quote than the one its provider checked";

  // 2. The hashlock of the one secret this browser holds for that quote.
  let held: string[] | undefined;
  try {
    held = await secrets().load(built.quoteId);
  } catch {
    return "omniston: the escrow's secret can't be read from this browser's storage";
  }
  if (!held || held.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(held[0]!)) return "omniston: this browser holds no secret for the escrow, so it could never complete";
  const lock = keccak256(hexToBytes(`0x${held[0]!}`)).slice(2);
  if (lock !== body.hashlock || built.secretHashes.length !== 1 || built.secretHashes[0] !== lock || built.hashingFunction !== KECCAK)
    return "omniston: the escrow's hashlock isn't the secret this browser holds";

  // 3. The package's payload check on these bytes: the review's side from the review, the quote's from step 1.
  const tonApiUrl = getRuntimeConfig().tonApiUrl;
  const payload = createOmnistonTonValidators({tonApiUrl}).validateTonEscrowPayload;
  let ok: boolean;
  try {
    ok =
      (await payload({
        payloadBocHex: payloadHex,
        forwardPayloadBocHex: body.forwardHex,
        quoteId: built.quoteId,
        inputUnits: r.amountIn.toString(),
        resolverSendsUnits: built.resolverSendsUnits,
        srcHtlcSecurityDepositUnits: built.srcHtlcSecurityDepositUnits,
        protocolAddress: built.protocolAddress,
        ownerAddress: r.refundAddress,
        destinationChain: r.destChain,
        destinationAddress: r.recipient,
        outputTokenAddress: r.destToken,
        initialResolverAddress: built.initialResolverAddress,
        secretHashes: [hexToBytes(`0x${lock}`)],
        hashingFunction: KECCAK,
        exclusivityTimeout: built.exclusivityTimeout,
      })) === true;
  } catch {
    ok = false;
  }
  if (!ok) return "omniston: the escrow isn't the one its provider checked for this swap (quote, resolver, deposit, owner or destination)";

  // 4. The package's build verifier, with a quote and a request rebuilt from the review.
  const quote = {
    provider: "omniston",
    intentId: "",
    depositAddress: "",
    depositMemo: null,
    sourceAmount: r.amountIn.toString(),
    destAmount: r.minOut.toString(),
    minDestAmount: r.minOut.toString(),
    feeUsd: 0,
    etaSeconds: 0,
    reliability: 0,
    validUntilMs: 0,
  } satisfies Quote;
  const params: QuoteParams = {
    sourceChain: r.fromChain,
    sourceToken: sell.symbol,
    destChain: r.destChain,
    destToken: r.destToken,
    amountIn: r.amountIn.toString(),
    minAmountOut: r.minOut.toString(),
    slippageBps: r.slippageBps,
    destAddress: r.recipient,
    refundAddress: r.refundAddress,
  };
  const tx: UnsignedTx = {chain: r.fromChain, to: msg.to, value: msg.value.toString(), bodyBoc: msg.bodyBoc};
  const why = await omnistonEscrowVerifier(tonApiUrl)(quote, tx, params);
  return why === null ? null : `omniston: ${why}`;
}
