/**
 * The wallet menu (D11): per family, the connected wallet (copy, disconnect)
 * or the wallets this browser announces — EIP-6963 injected wallets and, when
 * configured, WalletConnect for EVM; Wallet Standard wallets that can sign
 * Solana transactions; injected Tron wallets (TronLink); TON wallets installed
 * here, and "TON Connect", which closes the menu and opens TON Connect UI's
 * own modal (its official wallet list, owner 2026-11-13); NEAR wallets
 * injected by browser extensions (NEAR Connect's protocol). WalletConnect's
 * pairing QR is drawn here from the pairing link (no remote modal). Icons are
 * the data URIs wallets announce, WalletConnect's bundled mark, the bundled
 * TON logo, and each section's network logo.
 */
import {useRef} from "react";
import type {WalletFamily, WalletOption, WalletsApi} from "../../contracts/wallets";
import {connectOptionGroups} from "../../wallets";
import {shortAddress} from "../../catalog";
import {Button, ChainLogo, CopyButton, Icon, QrCode, Sheet, SheetHeader, Spinner, Text, WALLETCONNECT_LOGO} from "../../ui";
import {FAMILY_LABEL} from "../labels";
import s from "./Connect.module.css";

export interface ConnectSheetProps {
  open: boolean;
  /** Show this family first (the CTA "Connect EVM wallet" opens on EVM). */
  focus: WalletFamily | null;
  wallets: WalletsApi;
  onClose(): void;
  /** Opens Settings (RPCs, venues): on phones the header has no gear, so the wallet menu offers it. */
  onSettings?: () => void;
}

const NONE_FOUND: Readonly<Record<WalletFamily, string>> = {
  evm: "No EVM wallet found in this browser. Install a browser wallet (MetaMask, Rabby, Coinbase Wallet…) and reload.",
  solana: "No Solana wallet found in this browser. Install one that supports Wallet Standard (Phantom, Solflare, Backpack…) and reload.",
  tron: "No Tron wallet found in this browser. Install TronLink and reload — or pay from any Tron wallet by QR.",
  ton: "No TON wallet is offered here.",
  near: "No NEAR wallet extension found in this browser. Install one (such as HOT Wallet) and reload — or pay NEAR from a deposit address.",
};

/** The menu's sections, in this order unless the CTA focused one. */
const FAMILIES: readonly WalletFamily[] = ["evm", "solana", "tron", "ton", "near"];

/** The network logo beside each section's title (catalog slug; EVM shows Ethereum's, as the wallet's connect sheet does). */
const FAMILY_NETWORK: Readonly<Record<WalletFamily, string>> = {evm: "ethereum", solana: "solana", tron: "tron", ton: "ton", near: "near"};

export function ConnectSheet({open, focus, wallets, onClose, onSettings}: ConnectSheetProps) {
  const groups = connectOptionGroups(wallets.options);
  const order: WalletFamily[] = focus ? [focus, ...FAMILIES.filter((f) => f !== focus)] : [...FAMILIES];
  const anyConnected = !!wallets.evm || !!wallets.solana || !!wallets.tron || !!wallets.ton || !!wallets.near;
  /**
   * A pending pairing goes with the sheet (D11), so its QR never outlives the menu and the options never stay locked:
   * a WalletConnect attempt (its QR has nowhere else to show and WalletConnect can't abort a pairing — otherwise every
   * option stays disabled until the proposal expires). An installed wallet's pending connect is left to its own prompt,
   * and a TON Connect attempt to its own modal, which the menu is closed for.
   */
  const cancelPairing = () => {
    const pending = wallets.options.find((o) => o.id === wallets.connecting);
    if (pending?.kind === "walletconnect") void wallets.disconnect(pending.family);
  };
  const hide = (then: () => void) => () => {
    cancelPairing();
    then();
  };
  const close = hide(onClose);
  /**
   * TON Connect UI's modal renders outside this sheet, which is modal (focus trap, outside pointers blocked, scroll
   * lock): the menu closes first and the modal opens once it is gone (D11). An attempt that ends in an error reopens
   * the menu on TON (SwapScreen), so the error below is seen.
   */
  const tonPick = useRef<string | null>(null);
  const pick = (o: WalletOption) => {
    if (o.kind !== "tonconnect") return void wallets.connect(o.id);
    tonPick.current = o.id;
    onClose();
  };
  const closed = () => {
    const id = tonPick.current;
    tonPick.current = null;
    if (id) void wallets.connect(id);
  };
  return (
    <Sheet open={open} onClose={close} onClosed={closed} label="Wallets" width={420} phoneHeight="tall" data-testid="swap-connect">
      <div className={s.body}>
        <SheetHeader
          title={anyConnected ? "Wallets" : "Connect a wallet"}
          sub="Your wallet signs every swap in this browser"
          onClose={close}
        />
        {wallets.pairingUri ? <Pairing uri={wallets.pairingUri} /> : null}
        {order.map((family) => (
          <FamilySection key={family} family={family} options={groups[family]} wallets={wallets} onPick={pick} />
        ))}
        {wallets.error ? (
          <Text as="p" variant="meta" color="var(--red)" role="alert" data-testid="swap-connect-error">
            {wallets.error}
          </Text>
        ) : null}
        {onSettings ? (
          <Button block kind="ghost" height={48} icon="gear" iconPosition="left" title="Settings" onClick={hide(onSettings)} data-testid="swap-connect-settings" />
        ) : null}
      </div>
    </Sheet>
  );
}

function FamilySection({family, options, wallets, onPick}: {family: WalletFamily; options: readonly WalletOption[]; wallets: WalletsApi; onPick(o: WalletOption): void}) {
  const conn = wallets[family];
  return (
    <section className={s.section} aria-label={`${FAMILY_LABEL[family]} wallets`}>
      <span className={s.title}>
        <ChainLogo slug={FAMILY_NETWORK[family]} size={16} />
        <Text as="h3" variant="caps" color="var(--dim)">
          {FAMILY_LABEL[family]}
        </Text>
      </span>
      {conn ? (
        <div className={s.connected} data-testid={`swap-wallet-${family}`}>
          <WalletIcon icon={conn.walletIcon} />
          <span className={s.optionText}>
            <Text variant="small" weight={600} lines={1}>
              {conn.walletName}
            </Text>
            <Text variant="meta" color="var(--muted)" tabular selectable lines={1}>
              {shortAddress(conn.address, 8, 6)}
            </Text>
          </span>
          <CopyButton value={conn.address} aria-label={`Copy ${FAMILY_LABEL[family]} address`} />
          <Button kind="ghost" height={40} title="Disconnect" onClick={() => void wallets.disconnect(family)} data-testid={`swap-disconnect-${family}`} />
        </div>
      ) : options.length ? (
        <div className={s.options}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={s.option}
              disabled={wallets.connecting !== null}
              aria-busy={wallets.connecting === o.id || undefined}
              onClick={() => onPick(o)}
              data-testid={`swap-connect-${o.id}`}
            >
              {o.kind === "tonconnect" ? (
                <span className={s.icon} aria-hidden="true">
                  <ChainLogo slug="ton" size={28} />
                </span>
              ) : (
                <WalletIcon icon={o.kind === "walletconnect" ? WALLETCONNECT_LOGO : o.icon} />
              )}
              <span className={s.optionText}>
                <Text variant="small" weight={600} lines={1}>
                  {o.name}
                </Text>
                <Text variant="meta" color="var(--dim)" lines={1}>
                  {o.kind === "walletconnect" ? "Scan with a phone wallet" : o.kind === "tonconnect" ? "Tonkeeper, MyTonWallet and other TON wallets" : "Installed"}
                </Text>
              </span>
              {wallets.connecting === o.id ? <Spinner size={16} color="var(--muted)" /> : <Icon name="chevronRight" size={14} color="var(--muted)" />}
            </button>
          ))}
        </div>
      ) : (
        <Text as="p" variant="meta" color="var(--muted)">
          {NONE_FOUND[family]}
        </Text>
      )}
    </section>
  );
}

/** The wallet's announced icon (a data: URI by contract) or WalletConnect's bundled mark, else a neutral glyph. */
function WalletIcon({icon}: {icon?: string}) {
  return (
    <span className={s.icon} aria-hidden="true">
      {icon?.startsWith("data:") || icon === WALLETCONNECT_LOGO ? <img src={icon} alt="" width={28} height={28} /> : <Icon name="wallet" size={16} />}
    </span>
  );
}

/** WalletConnect pairing: our own QR of the URI, and the link to copy into a wallet on this device. */
function Pairing({uri}: {uri: string}) {
  return (
    <div className={s.pairing} data-testid="swap-walletconnect-qr">
      <QrCode value={uri} size={208} aria-label="WalletConnect pairing QR code" />
      <Text variant="small" color="var(--ink2)">
        Scan with your phone wallet, then approve the connection there.
      </Text>
      <CopyButton value={uri} label="Copy link" aria-label="Copy WalletConnect link" />
    </div>
  );
}
