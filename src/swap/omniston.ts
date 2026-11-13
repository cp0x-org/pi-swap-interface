/**
 * The Omniston chunk (loaded by omnistonLazy whenever the venue is on, the
 * default). The server's construction (apps/api lib/crossChain) with the Turso
 * stores replaced by IndexedDB and the env RPC table by runtime config. The
 * audited settlement contracts and order protocols come from the SDK and are
 * never taken from config.
 */
import "./bufferPolyfill";
import {omnistonProvider} from "@anywalletkit/protocol-swap2-omniston/provider";
import {
  AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS,
  AUDITED_OMNISTON_SETTLEMENT_CONTRACTS,
  createOmnistonEvmDeliveryLocator,
  createOmnistonEvmInputValidator,
  createOmnistonEvmOutputValidator,
  createOmnistonTonDeliveryLocator,
  createOmnistonTonValidators,
} from "@anywalletkit/protocol-swap2-omniston/validators";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import type {RuntimeConfig} from "../contracts/config";
import type {ProviderStores} from "./stores";

const json = (d: unknown) => JSON.stringify(d ?? {}, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));

/** Bounded diagnostics (the SDK never puts secrets in them) for "why is this pending?" on the status screen. */
export const omnistonTrace: string[] = [];
const log = (line: string) => {
  omnistonTrace.push(line);
  if (omnistonTrace.length > 200) omnistonTrace.shift();
  console.debug(line);
};

/** The real provider; zero fee (no integrator fields), one HTLC execution (the TON escrow builder commits one). */
export function buildOmniston(config: RuntimeConfig, stores: ProviderStores, rpcUrls: Record<string, string[]>): CrossChainProvider {
  const tonApi = {tonApiUrl: config.tonApiUrl};
  const refusal = (v: string) => (reason: string, details?: Record<string, unknown>) =>
    log(`[omniston-validator] ${v} ${reason} ${json(details)}`);
  return omnistonProvider({
    apiUrl: config.api.omnistonWs,
    maxUsd: config.omniston.maxUsd,
    trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS,
    ...(config.omniston.evmSource ? {trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS} : {}),
    maxHtlcExecutions: 1,
    ...createOmnistonTonValidators({...tonApi, onRefusal: refusal("tonOutput")}),
    validateEvmOutputPosition: createOmnistonEvmOutputValidator({rpcUrls, onRefusal: refusal("evmOutput")}),
    validateEvmInputPosition: createOmnistonEvmInputValidator({rpcUrls, onRefusal: refusal("evmInput")}),
    locateEvmDelivery: createOmnistonEvmDeliveryLocator({rpcUrls}),
    locateTonDelivery: createOmnistonTonDeliveryLocator(tonApi),
    trace: (event, details) => log(`[omniston] ${event} ${json(details)}`),
    quoteStore: stores.omnistonQuotes,
    secretStore: stores.omnistonSecrets,
  });
}
