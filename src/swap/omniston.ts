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
import {recordOmnistonEscrow} from "./omnistonBuilds";
import type {ProviderStores} from "./stores";

const json = (d: unknown) => JSON.stringify(d ?? {}, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v));

/** Bounded diagnostics (the SDK never puts secrets in them) for "why is this pending?" on the status screen. */
export const omnistonTrace: string[] = [];
const log = (line: string) => {
  omnistonTrace.push(line);
  if (omnistonTrace.length > 200) omnistonTrace.shift();
  console.debug(line);
};

/**
 * The real provider; zero fee (no integrator fields), one HTLC execution (the TON escrow builder commits one). A TON
 * source's secret is saved to `stores.omnistonSecrets` (IndexedDB, durability "strict") before the escrow is asked for,
 * and disclosed only once `validateEvmOutputPosition` proved the delivery on the EVM network (the package's
 * trackIntent, which the activity tracker polls after a reload too); every escrow whose payload check passes is kept
 * for the gate (omnistonBuilds.ts, D35).
 */
export function buildOmniston(config: RuntimeConfig, stores: ProviderStores, rpcUrls: Record<string, string[]>): CrossChainProvider {
  const tonApi = {tonApiUrl: config.tonApiUrl};
  const refusal = (v: string) => (reason: string, details?: Record<string, unknown>) =>
    log(`[omniston-validator] ${v} ${reason} ${json(details)}`);
  const ton = createOmnistonTonValidators({...tonApi, onRefusal: refusal("tonOutput")});
  return omnistonProvider({
    apiUrl: config.api.omnistonWs,
    maxUsd: config.omniston.maxUsd,
    trustedSettlementContracts: AUDITED_OMNISTON_SETTLEMENT_CONTRACTS,
    ...(config.omniston.evmSource ? {trustedEvmOrderProtocols: AUDITED_OMNISTON_EVM_ORDER_PROTOCOLS} : {}),
    maxHtlcExecutions: 1,
    ...ton,
    // The same check, unchanged; a pass is kept by its exact payload for the gate to run it again (D35).
    validateTonEscrowPayload: async (input) => {
      const ok = await ton.validateTonEscrowPayload(input);
      if (ok === true) recordOmnistonEscrow(input);
      return ok;
    },
    validateEvmOutputPosition: createOmnistonEvmOutputValidator({rpcUrls, onRefusal: refusal("evmOutput")}),
    validateEvmInputPosition: createOmnistonEvmInputValidator({rpcUrls, onRefusal: refusal("evmInput")}),
    locateEvmDelivery: createOmnistonEvmDeliveryLocator({rpcUrls}),
    locateTonDelivery: createOmnistonTonDeliveryLocator(tonApi),
    trace: (event, details) => log(`[omniston] ${event} ${json(details)}`),
    quoteStore: stores.omnistonQuotes,
    secretStore: stores.omnistonSecrets,
  });
}
