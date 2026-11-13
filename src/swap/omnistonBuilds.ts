/**
 * The TON → EVM escrow transfers this page's Omniston provider built and checked (D35 part B). Every one it builds
 * goes through its `validateTonEscrowPayload` (the package's validatePayload: the payload against the quote it cached —
 * the quote id, the resolver, its deposit, the exclusivity window, what it sends — the trader, the destination and the
 * hashlock of the secret it just stored); omniston.ts keeps each pass here, by its exact payload. The gate
 * (execute/omnistonEscrow.ts) finds the BoC the wallet would sign here and runs that check again on it, the fields the
 * review fixes taken from the review: a body this provider didn't build and check is never signed.
 *
 * In memory, per page — a build is signed in the page that made it or not at all — and bounded (the last few builds).
 * Hashes only: a secret never comes here (stores.ts holds it).
 */
import type {OmnistonProviderOptions} from "@anywalletkit/protocol-swap2-omniston/provider";

/** What the provider's payload check was handed (its option's argument). */
export type OmnistonEscrowCheck = Parameters<NonNullable<OmnistonProviderOptions["validateTonEscrowPayload"]>>[0];

/** That check as kept: the quote's side of it, the hashes as hex. */
export interface OmnistonEscrowBuild {
  quoteId: string;
  inputUnits: string;
  resolverSendsUnits: string;
  srcHtlcSecurityDepositUnits: string;
  protocolAddress: string;
  ownerAddress: string;
  destinationChain: string;
  destinationAddress: string;
  outputTokenAddress: string;
  initialResolverAddress: string;
  secretHashes: readonly string[];
  hashingFunction?: string;
  exclusivityTimeout: number;
}

/** How many builds are kept: one per Confirm, a few re-quotes at most. */
const KEEP = 16;
const builds = new Map<string, OmnistonEscrowBuild>();

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Keep a build the provider's payload check passed (omniston.ts, right after it passed). */
export function recordOmnistonEscrow(input: OmnistonEscrowCheck): void {
  const key = input.payloadBocHex.toLowerCase();
  builds.delete(key);
  builds.set(
    key,
    Object.freeze({
      quoteId: input.quoteId,
      inputUnits: input.inputUnits,
      resolverSendsUnits: input.resolverSendsUnits,
      srcHtlcSecurityDepositUnits: input.srcHtlcSecurityDepositUnits,
      protocolAddress: input.protocolAddress,
      ownerAddress: input.ownerAddress,
      destinationChain: input.destinationChain,
      destinationAddress: input.destinationAddress,
      outputTokenAddress: input.outputTokenAddress,
      initialResolverAddress: input.initialResolverAddress,
      secretHashes: Object.freeze(input.secretHashes.map(hex)),
      ...(input.hashingFunction !== undefined ? {hashingFunction: input.hashingFunction} : {}),
      exclusivityTimeout: input.exclusivityTimeout,
    }),
  );
  while (builds.size > KEEP) builds.delete(builds.keys().next().value!);
}

/** The build whose payload is exactly `payloadHex` (the BoC as hex), or undefined: none this page's provider checked. */
export const omnistonEscrowBuild = (payloadHex: string): OmnistonEscrowBuild | undefined => builds.get(payloadHex.toLowerCase());
