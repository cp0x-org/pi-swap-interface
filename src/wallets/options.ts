/**
 * The connect menu's entries, as pure functions over what the browser
 * announced: EIP-6963 injected wallets (via wagmi's connectors), Wallet
 * Standard Solana wallets, injected Tron wallets (TIP-6963 / window.tron), TON
 * wallets installed here plus TON Connect's modal (ton/wallets.ts), NEAR
 * Connect's injected NEAR wallets, and WalletConnect when the operator set a
 * project id. Installed wallets come first; WalletConnect is last.
 */
import type {ConnectOptionGroups, WalletOption} from "../contracts/wallets";

/** The option id WalletConnect uses everywhere (contract: WalletOption.id). */
export const WALLETCONNECT_ID = "walletconnect";

/** WalletConnect's menu entry. No icon: the ui ships its own mark (no remote icon, D13). */
export const WALLETCONNECT_OPTION: WalletOption = {id: WALLETCONNECT_ID, family: "evm", name: "WalletConnect", kind: "walletconnect"};

/** wagmi's targetless injected() connector (window.ethereum): shown only for wallets that don't speak EIP-6963. */
export const LEGACY_INJECTED_ID = "injected";
export const LEGACY_INJECTED_NAME = "Browser wallet";

const DATA_ICON = /^data:image\/(svg\+xml|png|webp|gif|jpeg)[;,]/i;

/** A wallet-announced icon, only when it is a data: URI — a remote URL would leak the visitor to its host (D13). */
export function dataIcon(icon: unknown): string | undefined {
  return typeof icon === "string" && DATA_ICON.test(icon) ? icon : undefined;
}

/** The connector fields the menu reads (wagmi Connector satisfies it). */
export interface ConnectorLike {
  id: string;
  name: string;
  type: string;
  icon?: string | undefined;
}

/**
 * EVM injected entries from wagmi's connectors: one per EIP-6963 wallet
 * (id = its rdns), in announce order, deduped by id. The targetless
 * window.ethereum connector appears only when no wallet announced itself and
 * something is injected, so a 6963 wallet is never listed twice. WalletConnect
 * and any other connector type are left out (WalletConnect is added by
 * `menuOptions`, lazily).
 */
export function evmOptions(connectors: readonly ConnectorLike[], o: {legacyInjected: boolean}): WalletOption[] {
  const announced = connectors.some((c) => c.type === "injected" && c.id !== LEGACY_INJECTED_ID);
  const seen = new Set<string>();
  const out: WalletOption[] = [];
  for (const c of connectors) {
    if (c.type !== "injected" || seen.has(c.id)) continue;
    const legacy = c.id === LEGACY_INJECTED_ID;
    if (legacy && (announced || !o.legacyInjected)) continue;
    seen.add(c.id);
    out.push({
      id: c.id,
      family: "evm",
      name: legacy ? LEGACY_INJECTED_NAME : c.name,
      ...(dataIcon(c.icon) ? {icon: dataIcon(c.icon)} : {}),
      kind: "injected",
    });
  }
  return out;
}

/** The whole menu: installed EVM wallets, then Solana, Tron, TON and NEAR wallets, then WalletConnect (only with a project id). */
export function menuOptions(o: {
  evm: readonly WalletOption[];
  solana: readonly WalletOption[];
  tron?: readonly WalletOption[];
  ton?: readonly WalletOption[];
  near?: readonly WalletOption[];
  walletConnect: boolean;
}): WalletOption[] {
  return [...o.evm, ...o.solana, ...(o.tron ?? []), ...(o.ton ?? []), ...(o.near ?? []), ...(o.walletConnect ? [WALLETCONNECT_OPTION] : [])];
}

/** Two option lists hold the same entries (keeps the snapshot stable when a rescan finds nothing new). */
export function sameOptions(a: readonly WalletOption[], b: readonly WalletOption[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i]!;
      return x.id === y.id && x.family === y.family && x.name === y.name && x.icon === y.icon && x.kind === y.kind;
    })
  );
}

/** The connect menu split by family (the shape lives in the contracts, src/contracts/wallets.ts). */
export type {ConnectOptionGroups} from "../contracts/wallets";

/** Group the menu by family, keeping its order (installed first, WalletConnect last). */
export function connectOptionGroups(options: readonly WalletOption[]): ConnectOptionGroups {
  const evm = options.filter((o) => o.family === "evm");
  const solana = options.filter((o) => o.family === "solana");
  const tron = options.filter((o) => o.family === "tron");
  const ton = options.filter((o) => o.family === "ton");
  const near = options.filter((o) => o.family === "near");
  return {
    evm,
    solana,
    tron,
    ton,
    near,
    installed: {
      evm: evm.some((o) => o.kind !== "walletconnect"),
      solana: solana.length > 0,
      tron: tron.length > 0,
      ton: ton.some((o) => o.kind === "injected"),
      near: near.length > 0,
    },
  };
}
