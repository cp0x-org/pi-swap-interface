/**
 * Swap ids: `awk1.<provider>.<intentId>[.<sourceTxHash>[.<destTxHash>[.ok]]]`, each segment URI-encoded with `.` as
 * `%2E` (engine.md §4.6). swap2-core does not export its encodeId/decodeId, so the logic is copied: a deposit
 * ticket and a sped-up source transaction need ids the engine did not hand back.
 */
import {SWAP2_ID_PREFIX} from "@anywalletkit/protocol-swap2-core/swap2/base";

const enc = (v: string) => encodeURIComponent(v).replace(/\./g, "%2E");

/** The id the engine would give this swap (swap2-core encodeId, verbatim logic). */
export function encodeSwapId(provider: string, intentId: string, sourceTxHash?: string, destTxHash?: string, destTxConfirmed = false): string {
  const dest = destTxHash != null ? [destTxHash, ...(destTxConfirmed ? ["ok"] : [])] : [];
  const parts = [provider, intentId, ...(sourceTxHash != null ? [sourceTxHash, ...dest] : [])];
  return `${SWAP2_ID_PREFIX}.${parts.map(enc).join(".")}`;
}

/**
 * An id's provider, intent and source hash (mobile execute.ts decodeSwapId). The later segments (a claim's hash,
 * `.ok`) are not needed here: the record keeps the whole id claimSwap2 returns as `trackId`.
 */
export function decodeSwapId(id: string): {provider: string; intentId: string; sourceTxHash?: string} | null {
  const [prefix, p, i, h] = id.split(".");
  if (prefix !== SWAP2_ID_PREFIX || !p || !i) return null;
  try {
    return {provider: decodeURIComponent(p), intentId: decodeURIComponent(i), ...(h ? {sourceTxHash: decodeURIComponent(h)} : {})};
  } catch {
    return null;
  }
}
