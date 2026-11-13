/**
 * The destination-chain claim of a two-phase swap (CCTP mint) — engine.md §8.3, mobile execute.ts
 * previewClaim / claimSwap. The claim is built read-only first and shown; on confirm it is ARMED exactly
 * (target + calldata, no value) on a fresh gate, and the engine rebuilds and sends it through the gated account on
 * the destination chain (the wallet must already be switched there: claimSwap2 checks the live chain).
 */
import type {CrossChainRouter} from "@anywalletkit/protocol-swap2-router/router";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";
import {Swap2StatusError} from "@anywalletkit/protocol-swap2-core/errors";
import type {ClaimPreview, ClaimResult, EvmSourceSigner, SourceSigner} from "../contracts/execution";
import {chainByCaip2Web} from "../catalog";
import {appRouter} from "../swap";
import {assertEoa, assertEvmWallet, evmEngineAccount, type EvmReads} from "./accounts/evm";
import {gateAccount} from "./accounts/gated";
import {refusal} from "./errors";
import {createSwapGate} from "./gate";
import {decodeSwapId} from "./ids";

/** What claims reach that tests replace. */
export interface ClaimDeps {
  /** The router the provider is looked up in; default appRouter(). */
  router?: () => CrossChainRouter;
  evmReads?: (signer: EvmSourceSigner) => EvmReads;
}

/** The claim a two-phase swap needs now (read-only; null while the attestation is pending). Shown before the user confirms. */
export async function previewClaim(id: string, deps: ClaimDeps = {}): Promise<ClaimPreview | null> {
  const ref = decodeSwapId(id);
  if (!ref) throw refusal("This isn't a swap id.");
  const provider = (deps.router ?? appRouter)().getProvider(ref.provider);
  const tx = await provider?.buildClaim?.({intentId: ref.intentId, ...(ref.sourceTxHash ? {sourceTxHash: ref.sourceTxHash} : {})});
  if (!tx || !tx.to || !tx.data) return null;
  let value: bigint;
  try {
    value = BigInt(tx.value || "0");
  } catch {
    throw refusal("The claim the venue built is malformed — nothing was signed.");
  }
  return {chain: tx.chain, to: tx.to, data: tx.data, value};
}

/**
 * Send the claim from an EVM signer already on the destination chain. Call ONLY from the claim's confirm. Returns
 * the claim hash and the id to keep polling with.
 */
export async function claimSwap(id: string, signer: SourceSigner, deps: ClaimDeps = {}): Promise<ClaimResult> {
  const ref = decodeSwapId(id);
  if (!ref) throw refusal("This isn't a swap id.");
  const claim = await previewClaim(id, deps);
  if (!claim) throw new Swap2StatusError("swap2: the claim isn't ready yet — the attestation is still pending. Try again in a minute.");
  const chain = chainByCaip2Web(claim.chain);
  const chainName = chain?.name ?? claim.chain;
  if (!claim.chain.startsWith("eip155:")) throw refusal("Claims are only supported on EVM networks.");
  if (signer.family !== "evm") throw refusal(`Connect an EVM wallet on ${chainName} to claim — nothing was sent.`);
  if (`eip155:${signer.chain.id}` !== claim.chain) throw refusal(`Switch your wallet to ${chainName} to claim — nothing was sent.`);
  if (claim.value !== 0n) throw refusal("The claim asks for a payment it never needs — nothing was signed.");
  await assertEvmWallet(signer);
  await assertEoa(signer.pub, signer.owner, chainName);

  const gate = createSwapGate(claim.chain);
  gate.arm([{kind: "call", to: claim.to, data: claim.data, value: 0n}]);
  const account = gateAccount(evmEngineAccount(signer, deps.evmReads ? {reads: deps.evmReads(signer)} : {}), gate);
  const protocol = new RouterSwap2Protocol(undefined, {fromChain: claim.chain, router: (deps.router ?? appRouter)().only(ref.provider)});
  try {
    const res = await protocol.claimSwap2(id, account);
    return {hash: res.hash, chain: res.chain, id: res.id};
  } finally {
    gate.disarm(); // never protocol.close(): the providers are shared (D2)
  }
}
