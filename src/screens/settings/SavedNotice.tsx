/**
 * The saved-settings notice (D8): when this browser's Settings point a venue, a price API or an RPC at another
 * server, the swap screen and the review name every such host — quotes, deposit addresses and calldata then come
 * from a server the viewer's browser picked, not the site's operator. On an IPFS path gateway (one origin for every
 * site on it) saved settings are not applied at all, and the notice says so.
 */
import type {SavedOverrides} from "../../contracts/config";
import {chainByCaip2Web} from "../../catalog";
import {Text} from "../../ui";
import s from "./Settings.module.css";

const KEY_LABEL: Readonly<Record<string, string>> = {
  "api.lifi": "LI.FI",
  "api.nearIntents": "NEAR Intents",
  "api.relay": "Relay",
  "api.jupiter": "Jupiter",
  "api.chainflip": "Chainflip",
  "api.cctp": "CCTP attestations",
  "api.layerZeroScan": "LayerZero Scan",
  "api.symbiosis": "Symbiosis",
  "api.balancer": "Balancer",
  "api.omnistonWs": "Omniston",
  "api.thorNodes": "THORChain node",
  "api.thorConfirmNodes": "THORChain confirm node",
  "prices.defillama": "Prices",
  "prices.coingecko": "Prices",
};

/** "NEAR Intents via proxy.example · RPC for Ethereum, Base · Solana RPC" — or null when nothing is overridden. */
export function savedOverridesText(o: SavedOverrides): string | null {
  const parts = o.hosts.map((h) => `${KEY_LABEL[h.key] ?? h.key} via ${h.host}`);
  if (o.evmRpcChains.length) parts.push(`RPC for ${o.evmRpcChains.map((id) => chainByCaip2Web(`eip155:${id}`)?.name ?? `chain ${id}`).join(", ")}`);
  if (o.solanaRpc) parts.push("Solana RPC");
  return parts.length ? parts.join(" · ") : null;
}

export function SavedNotice({overrides, onSettings}: {overrides: SavedOverrides; onSettings?: () => void}) {
  if (overrides.ignored)
    return (
      <Text as="p" variant="meta" color="var(--muted)" className={s.notice} data-testid="swap-saved-ignored">
        Your saved settings are off here: this IPFS gateway gives every site one shared origin. Open the app on a subdomain gateway to use them.
      </Text>
    );
  const text = savedOverridesText(overrides);
  if (!text) return null;
  return (
    <div className={s.notice} role="note" data-testid="swap-saved-overrides">
      <Text as="p" variant="meta" color="var(--amber)" selectable>
        {`This browser's saved settings are in use — ${text}. Quotes, deposit addresses and balances come from those servers.`}
      </Text>
      {onSettings ? (
        <button type="button" className={s.noticeLink} onClick={onSettings}>
          Review in Settings
        </button>
      ) : null}
    </div>
  );
}
