/**
 * The wallets' external store: one WalletsState snapshot for
 * useSyncExternalStore. The snapshot object changes only when a field
 * changes, so screens and balance queries keyed on `owners` don't re-render
 * on every wagmi or Wallet Standard event.
 */
import type {Owners} from "../contracts/domain";
import type {EvmConnection, NearConnection, SolanaConnection, TonConnection, TronConnection, WalletOption, WalletsState} from "../contracts/wallets";
import {menuOptions, sameOptions} from "./options";

/** What the runtimes write; the snapshot is derived from it. */
export interface WalletsFields {
  evm: EvmConnection | null;
  solana: SolanaConnection | null;
  tron: TronConnection | null;
  ton: TonConnection | null;
  near: NearConnection | null;
  evmOptions: readonly WalletOption[];
  solanaOptions: readonly WalletOption[];
  tronOptions: readonly WalletOption[];
  tonOptions: readonly WalletOption[];
  nearOptions: readonly WalletOption[];
  /** The operator set a WalletConnect project id. */
  walletConnect: boolean;
  connecting: string | null;
  pairingUri: string | null;
  error: string | null;
}

export interface WalletsStore {
  /** The current snapshot (same object until something changes; safe in render). */
  get(): WalletsState;
  fields(): Readonly<WalletsFields>;
  /** Merge a change; listeners run only when a field actually changed. */
  patch(change: Partial<WalletsFields>): void;
  subscribe(listener: () => void): () => void;
}

const ownersOf = (f: Pick<WalletsFields, "evm" | "solana" | "tron" | "ton" | "near">): Owners => ({
  ...(f.evm ? {evm: f.evm.address} : {}),
  ...(f.solana ? {solana: f.solana.address} : {}),
  ...(f.tron ? {tron: f.tron.address} : {}),
  ...(f.ton ? {ton: f.ton.address} : {}),
  ...(f.near ? {near: f.near.address} : {}),
});

function snapshotOf(f: WalletsFields): WalletsState {
  return {
    evm: f.evm,
    solana: f.solana,
    tron: f.tron,
    ton: f.ton,
    near: f.near,
    owners: ownersOf(f),
    options: menuOptions({
      evm: f.evmOptions,
      solana: f.solanaOptions,
      tron: f.tronOptions,
      ton: f.tonOptions,
      near: f.nearOptions,
      walletConnect: f.walletConnect,
    }),
    connecting: f.connecting,
    pairingUri: f.pairingUri,
    error: f.error,
  };
}

const sameField = (k: keyof WalletsFields, a: unknown, b: unknown): boolean =>
  k === "evmOptions" || k === "solanaOptions" || k === "tronOptions" || k === "tonOptions" || k === "nearOptions"
    ? sameOptions(a as WalletOption[], b as WalletOption[])
    : Object.is(a, b);

export const EMPTY_FIELDS: WalletsFields = {
  evm: null,
  solana: null,
  tron: null,
  ton: null,
  near: null,
  evmOptions: [],
  solanaOptions: [],
  tronOptions: [],
  tonOptions: [],
  nearOptions: [],
  walletConnect: false,
  connecting: null,
  pairingUri: null,
  error: null,
};

export function createWalletsStore(initial: Partial<WalletsFields> = {}): WalletsStore {
  let fields: WalletsFields = {...EMPTY_FIELDS, ...initial};
  let snapshot = snapshotOf(fields);
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    fields: () => fields,
    patch(change) {
      const keys = (Object.keys(change) as (keyof WalletsFields)[]).filter((k) => !sameField(k, fields[k], change[k]));
      if (!keys.length) return;
      const next = {...fields};
      for (const k of keys) (next as Record<string, unknown>)[k] = change[k];
      fields = next;
      snapshot = snapshotOf(fields);
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
