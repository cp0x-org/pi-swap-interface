/**
 * Omniston's swap between TON and USDT from a TON wallet, through its package's verifier (D35 part C): the `bind` of
 * tonPlan.ts's Omniston swap rule, a chunk of its own (@ton/core and the Omniston package) loaded for that call only. It
 * runs on the exact BoC checkTonCall read — before anything is armed (execute.ts) and again right before the wallet is
 * asked (accounts/ton.ts) — once the app's own decode passed (tonSwap.ts: every field where the money goes held to the
 * review and to the pins of tonDexPins.ts).
 *
 * The package's build verifier `omnistonVerifyBuild` (`checkTonSwapPayload` on the body: the layout, the amount, the
 * recipient, refund and excess to the payer, the on-chain minimum, no referral, every cell to its end; then the DEX
 * the message pays and the facts the body depends on), as the phone runs it, but with nothing taken from TonAPI or
 * from Omniston: the quote and the request rebuilt from the review (the amount, the minimum, the payer, the recipient,
 * the tokens); the route one step through the DEX whose pinned contract the message pays — never the quote's route
 * steps or protocol labels; and its two chain-fact hooks answered by those same pins instead of TonAPI's code labels
 * (`validateTonSwapTarget`: that contract, for that DEX; `validateTonSwapLeg`: the router, its pTON wallet and the
 * wallet the swap asks it for, or the pool, are the pinned ones for the reviewed pair). No integrator: a referral
 * naming anyone is refused. The reason it refuses ("omniston: …"), or null.
 */
import {Buffer} from "buffer";
import {Address, Cell} from "@ton/core";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {omnistonVerifyBuild, type TonSwapLeg} from "@anywalletkit/protocol-swap2-omniston/provider";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {ZERO_ADDRESS} from "../catalog";
import type {ReviewedSwap} from "../contracts/execution";
import {tonDexAt, type TonDexPin} from "./tonDexPins";
import type {TonCallMessage} from "./tonPlan";

/** A TON address (any spelling @ton/core reads) as raw, or null. */
const rawOf = (a: string | null | undefined): string | null => {
  try {
    return a ? Address.parse(a).toRawString() : null;
  } catch {
    return null;
  }
};

/** The contract a jetton transfer's body pays (its destination), read again from the BoC; null when it isn't one. */
function transferDestination(boc: string): string | null {
  try {
    const cells = Cell.fromBoc(Buffer.from(boc, "base64"));
    if (cells.length !== 1) return null;
    const s = cells[0]!.beginParse();
    s.skip(32 + 64);
    s.loadCoins();
    return s.loadAddress().toRawString();
  } catch {
    return null;
  }
}

/** Whether the package's leg — a chain fact the body depends on — is the pinned one of `dex` for the reviewed pair. */
function pinnedLeg(leg: TonSwapLeg, dex: TonDexPin, pair: {input: string | null; output: string | null; nativeSource: boolean}): boolean {
  if (rawOf(leg.inputJetton) !== pair.input || rawOf(leg.outputJetton) !== pair.output) return false;
  if (dex.dex === "dedust") return leg.kind === "dedust-pool" && leg.version === 1 && rawOf(leg.pool) === dex.pool;
  if (leg.kind !== "stonfi-router" || leg.version !== dex.version) return false;
  // The router that runs the hop: named, or (STON.fi v2's TON input) the owner of the pTON wallet paid — pinned either
  // way.
  if (leg.router === null ? !pair.nativeSource : rawOf(leg.router) !== dex.router) return false;
  if (pair.nativeSource ? rawOf(leg.proxyTonWallet) !== dex.ptonWallet : leg.proxyTonWallet !== undefined) return false;
  return rawOf(leg.askWallet) === (pair.output === null ? dex.ptonWallet : dex.usdtWallet);
}

/** Why `msg` (from the reviewed route `r`'s payer) is not an Omniston swap its package's verifier passes on the pins, or null. */
export async function checkOmnistonSwap(r: ReviewedSwap, msg: TonCallMessage): Promise<string | null> {
  const nativeSource = r.fromContract === null;
  const sell = ccAssetByToken(r.fromChain, r.fromContract ?? ZERO_ADDRESS);
  const buy = ccAssetByToken(r.destChain, r.destToken);
  if (!sell || !buy) return "omniston: the swap's tokens aren't the catalog's";
  // The DEX is the one whose pinned contract the message pays: its own target (TON in), the transfer's destination
  // (USDT in).
  const contract = nativeSource ? rawOf(msg.to) : transferDestination(msg.bodyBoc);
  const dex = contract ? tonDexAt(contract, nativeSource) : undefined;
  if (!contract || !dex) return "omniston: the swap pays a contract the app doesn't pin";
  const pair = {input: rawOf(sell.contract), output: rawOf(buy.contract), nativeSource};

  const step = {protocol: dex.protocol, inputJetton: sell.contract ?? null, outputJetton: buy.contract ?? null};
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
    providerData: {settlement: "swap", protocols: dex.protocol, routeSteps: JSON.stringify([step])},
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
  const verify = omnistonVerifyBuild({
    validateTonSwapTarget: ({address, protocols}) => protocols.length === 1 && protocols[0] === dex.protocol && rawOf(address) === contract,
    validateTonSwapLeg: (leg) => pinnedLeg(leg, dex, pair),
    integratorAddress: null,
  });
  const tx: UnsignedTx = {chain: r.fromChain, to: msg.to, value: msg.value.toString(), bodyBoc: msg.bodyBoc};
  const why = await verify(quote, tx, params);
  return why === null ? null : `omniston: ${why}`;
}
