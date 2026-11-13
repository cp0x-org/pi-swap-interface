/**
 * checkPlanBrowser's TON rule (D10): what a TON source may be before anything is armed. A deposit only — TON to an
 * address, or a jetton transfer, with at most a text comment — never an approval or a contract payload (a cell
 * body: Omniston's, not signed here yet), and every address a mainnet one (EQ…/UQ… with its checksum, or raw on
 * workchain 0 / -1). The message the wallet then signs is checked again in tonGate.ts.
 */
import type {Swap2ExecutionPlan} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {isAddressFor} from "../catalog";

/** A TON mainnet address in a strict form (no test-only friendly address, no other workchain). */
const mainnet = (a: string): boolean => isAddressFor("ton", a) && (!a.includes(":") || /^(-1|0):/.test(a));

/** Why a TON source plan is not a deposit this app signs, or null. */
export function checkTonPlan(plan: Swap2ExecutionPlan): string | null {
  if (plan.approvals.length) return "an approval on a network that has none";
  const s = plan.source;
  if (s.kind === "call") {
    if (s.cellBody) return "a TON contract payload this app doesn't sign yet";
    if (!mainnet(s.to)) return "a deposit address that isn't a TON mainnet address";
    if (s.value <= 0n) return "a TON deposit of nothing";
  }
  if (s.kind === "token-transfer" && !mainnet(s.recipient)) return "a deposit address that isn't a TON mainnet address";
  return null;
}
