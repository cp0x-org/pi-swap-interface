/**
 * WalletConnect, only when runtime config has a project id and only once
 * the user picks it (D11). AppKit's QR modal stays off — it loads a remote
 * wallet list and telemetry; the screens draw `pairingUri` with ui QrCode —
 * and WalletConnect's own telemetry is turned off. The connector module and
 * @walletconnect/ethereum-provider load as a lazy chunk.
 */
import type {CreateConnectorFn} from "wagmi";
import type {WalletConnectParameters} from "wagmi/connectors/walletConnect";

/** Shown in the phone wallet's approval prompt. `url` must be this page's origin (WalletConnect Verify checks it). */
export function walletConnectParameters(projectId: string, origin: string): WalletConnectParameters {
  return {
    projectId,
    showQrModal: false,
    telemetryEnabled: false,
    metadata: {
      name: "cp0x Swap",
      description: "Permissionless swaps and bridges. Your wallet signs; no account, no fee.",
      url: origin,
      // Our own icon, from this page's origin: the wallet fetches it from here and nowhere else.
      icons: [`${origin}/apple-touch-icon.png`],
    },
  };
}

/** Loads wagmi's walletConnect connector factory (a dynamic import, so it never ships in the main chunk). */
export type LoadWalletConnect = () => Promise<(p: WalletConnectParameters) => CreateConnectorFn>;

export const loadWalletConnect: LoadWalletConnect = async () => (await import("wagmi/connectors/walletConnect")).walletConnect;
