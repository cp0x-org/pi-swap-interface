/**
 * Wallet connections as the rest of the app sees them. The wallets module owns
 * wagmi (EVM: injected EIP-6963 + WalletConnect), Wallet Standard (Solana), the
 * injected Tron wallets (TronLink: TIP-6963 / window.tron), TON Connect (TON)
 * and NEAR Connect's injected wallets (NEAR); nothing else touches a connector.
 * Execution gets wallets only as a SourceSigner (execution.ts) from `getSigner`.
 */
import type {Owners} from "./domain";
import type {EvmTransport} from "./execution";

/** Families the browser signs for. */
export type WalletFamily = "evm" | "solana" | "tron" | "ton" | "near";

/** One button in the connect menu. */
export interface WalletOption {
  /**
   * Stable id: EIP-6963 / TIP-6963 rdns, "walletconnect", the Wallet Standard wallet name, "tonconnect" (TON Connect
   * UI's modal), "tonconnect:<app name>" (a TON wallet installed here), or "near:<manifest id>".
   */
  id: string;
  family: WalletFamily;
  name: string;
  /** Data-URI icon the wallet announces (EIP-6963 / Wallet Standard / NEAR manifest). Never a remote URL. */
  icon?: string;
  /**
   * "tonconnect": the one TON entry that opens TON Connect UI's modal (its official wallet list: QR, app links,
   * extensions); a TON wallet whose JS bridge is on the page is "injected".
   */
  kind: "injected" | "walletconnect" | "wallet-standard" | "tonconnect";
}

export interface EvmConnection {
  family: "evm";
  /** Checksummed. */
  address: string;
  /** The wallet's current chain id (it may differ from the pay chain until getSigner switches it). */
  chainId: number;
  walletName: string;
  walletIcon?: string;
  transport: EvmTransport;
}

export interface SolanaConnection {
  family: "solana";
  /** Base58. */
  address: string;
  walletName: string;
  walletIcon?: string;
}

export interface TronConnection {
  family: "tron";
  /** Base58 (T…). */
  address: string;
  walletName: string;
  walletIcon?: string;
}

export interface TonConnection {
  family: "ton";
  /** User-friendly, non-bounceable (UQ…), mainnet. */
  address: string;
  walletName: string;
  walletIcon?: string;
}

export interface NearConnection {
  family: "near";
  /** The account id: implicit (64 hex) or named (`alice.near`). */
  address: string;
  walletName: string;
  walletIcon?: string;
}

export type WalletConnection = EvmConnection | SolanaConnection | TronConnection | TonConnection | NearConnection;

export interface WalletsState {
  evm: EvmConnection | null;
  solana: SolanaConnection | null;
  tron: TronConnection | null;
  ton: TonConnection | null;
  near: NearConnection | null;
  /** Connected addresses per family — feeds SwapToken.owner. */
  owners: Owners;
  /** Connect-menu entries, installed wallets first. WalletConnect only when runtime config has a projectId. */
  options: readonly WalletOption[];
  /** The option being connected, or null. */
  connecting: string | null;
  /**
   * WalletConnect pairing URI while it connects (wagmi `display_uri`): the screens render it with ui QrCode — AppKit's
   * modal is not used (D11: it loads a remote wallet list and telemetry). `connecting` names which option it belongs
   * to. TON has none: TON Connect UI's modal draws its own QR from the self-hosted list (D11, owner 2026-11-13).
   */
  pairingUri: string | null;
  /** Last connect/disconnect failure, in the user's words. */
  error: string | null;
}

/** What useWallets() returns: the state plus its actions. */
export interface WalletsApi extends WalletsState {
  /** Opens the wallet's own prompt. Rejection sets `error` ("You declined in your wallet."), never throws. */
  connect(optionId: string): Promise<void>;
  /**
   * Disconnects that family's wallet. While a connect of that family is still pending (a pairing QR or TON Connect's
   * modal is open), it cancels that attempt instead and keeps any wallet already connected: a TON Connect attempt is
   * aborted and its modal closes, while WalletConnect cannot abort a pairing (its QR just stops being shown). The
   * wallet menu calls this for a pending WalletConnect pairing when it closes.
   */
  disconnect(family: WalletFamily): Promise<void>;
}

/** The connect menu split by family, for a ConnectSheet that shows one family at a time. */
export interface ConnectOptionGroups {
  evm: WalletOption[];
  solana: WalletOption[];
  tron: WalletOption[];
  ton: WalletOption[];
  near: WalletOption[];
  /** Any installed (non-WalletConnect) wallet for that family. */
  installed: Readonly<Record<WalletFamily, boolean>>;
}
