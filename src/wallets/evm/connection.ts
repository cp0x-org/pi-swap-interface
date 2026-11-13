/**
 * wagmi state → the app's EvmConnection, as pure functions. One EVM wallet
 * at a time: the current wagmi connection is the EVM connection. While wagmi
 * reconnects at boot the persisted address is already shown (wagmi's own
 * rule), so the form doesn't flash "Connect a wallet"; getSigner waits for the
 * reconnect to finish before it uses it.
 */
import {getAddress} from "viem";
import type {State} from "wagmi";
import type {EvmTransport} from "../../contracts/execution";
import type {EvmConnection} from "../../contracts/wallets";
import {LEGACY_INJECTED_ID, LEGACY_INJECTED_NAME, dataIcon} from "../options";

/** wagmi's connector type for WalletConnect. */
export const WALLETCONNECT_TYPE = "walletConnect";

export const transportOf = (connectorType: string): EvmTransport =>
  connectorType === WALLETCONNECT_TYPE ? "walletconnect" : "injected";

/** The wallet's name as the header shows it. WalletConnect names the phone wallet when the session says which. */
export function walletNameOf(connector: {id: string; name: string; type: string}, peerName?: string): string {
  if (connector.type === WALLETCONNECT_TYPE) return peerName ? `${peerName} (WalletConnect)` : "WalletConnect";
  return connector.id === LEGACY_INJECTED_ID ? LEGACY_INJECTED_NAME : connector.name;
}

/** The current connection, or null. `peerNames`: WalletConnect peer wallet names by connector uid. */
export function evmConnectionOf(
  state: Pick<State, "connections" | "current" | "status">,
  peerNames: ReadonlyMap<string, string> = new Map(),
): EvmConnection | null {
  if (state.status === "disconnected" || !state.current) return null;
  const c = state.connections.get(state.current);
  const first = c?.accounts[0];
  if (!c || !first) return null;
  const icon = dataIcon(c.connector.icon);
  return {
    family: "evm",
    address: getAddress(first),
    chainId: c.chainId,
    walletName: walletNameOf(c.connector, peerNames.get(c.connector.uid)),
    ...(icon ? {walletIcon: icon} : {}),
    transport: transportOf(c.connector.type),
  };
}

export const sameEvmConnection = (a: EvmConnection | null, b: EvmConnection | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.address === b.address &&
    a.chainId === b.chainId &&
    a.walletName === b.walletName &&
    a.walletIcon === b.walletIcon &&
    a.transport === b.transport);
