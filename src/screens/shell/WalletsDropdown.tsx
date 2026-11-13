/**
 * The header's wallets (ARCHITECTURE D33, ui-port §5.2): "Connect wallet" (the wallet sheet) until one is connected,
 * then one button — the wallets' icons stacked, the address (one wallet) or "N wallets" — that opens a dropdown of
 * them: each with its network, address, copy and disconnect, then "Connect another wallet" (the wallet sheet) while a
 * family is left. At ≥ 640 px a menu-look popover under the button, right-aligned to it; below that the app's bottom
 * sheet (as NetworkPicker). Escape, a press outside and focus leaving it close it, Escape handing focus back to the
 * button (the sheet does that itself). Focus is never left on <body>: a disconnect moves it to the next row's disconnect
 * (the last wallet's to "Connect wallet", the list closing), and on a phone the wallet sheet opens only once the list's
 * sheet has handed focus back to the button, so its own close returns it there too.
 */
import {useEffect, useId, useRef, useState, type RefObject} from "react";
import type {WalletConnection, WalletFamily, WalletsApi} from "../../contracts/wallets";
import {shortAddress} from "../../catalog";
import {Button, ChainLogo, CopyButton, Icon, IconButton, Sheet, SheetHeader, Text, useBreakpoint} from "../../ui";
import {FAMILY_LABEL, plural} from "../labels";
import s from "./Shell.module.css";

/** The header's order of the families (the wallet sheet's, D11). */
const FAMILIES: readonly WalletFamily[] = ["evm", "solana", "tron", "ton", "near"];

const FAMILY_SLUG = {evm: "ethereum", solana: "solana", tron: "tron", ton: "ton", near: "near"} as const;

/** The wallet announced its own icon (a data URI; never a remote URL). */
const ownIcon = (c: WalletConnection) => c.walletIcon?.startsWith("data:") === true;

/** The wallet's announced icon or its family's network logo. */
function ConnIcon({c, size}: {c: WalletConnection; size: number}) {
  return ownIcon(c) ? (
    <img src={c.walletIcon} alt="" width={size} height={size} className={s.connIcon} />
  ) : (
    <ChainLogo slug={FAMILY_SLUG[c.family]} size={size} />
  );
}

export function WalletsDropdown({wallets, onWallets}: {wallets: WalletsApi; onWallets(): void}) {
  const phone = useBreakpoint() === "phone";
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const rows = useRef<HTMLUListElement>(null);
  // Set when the menu disconnects a wallet: once it is gone, a row left (or "Connect wallet") takes the focus.
  const refocus = useRef<{gone: WalletFamily; to: WalletFamily | null} | null>(null);
  // Set when the phone sheet's "Connect another wallet" is pressed: the wallet sheet waits for this one to be gone.
  const connectNext = useRef(false);
  const menuId = useId();
  const titleId = useId();
  const conns = FAMILIES.map((f) => wallets[f]).filter((c): c is WalletConnection => c !== null);
  const none = conns.length === 0;
  const connected = conns.map((c) => c.family).join(" ");
  // Gone from elsewhere too (the wallet sheet, the extension itself): closed, so a later connect never reopens it.
  if (open && none) setOpen(false);

  const show = () => {
    connectNext.current = false;
    // Focused first, so the phone sheet (which hands focus back to what was focused when it opened) returns here.
    trigger.current?.focus({preventScroll: true});
    setOpen(true);
  };
  const disconnect = (family: WalletFamily) => {
    // the next row's disconnect, the previous row's after the last row; none left: the list closes
    const i = conns.findIndex((c) => c.family === family);
    const to = (conns[i + 1] ?? conns[i - 1])?.family ?? null;
    refocus.current = {gone: family, to};
    if (!to) setOpen(false);
    void wallets.disconnect(family);
  };
  const connectMore = () => {
    setOpen(false);
    // The wallet sheet hands focus back to what was focused when it opened: the button, not a row that is gone. The
    // popover lets the button take it now; the phone sheet traps focus until it is gone and then hands it to the
    // button itself, so there the wallet sheet opens after that (onClosed).
    if (phone) {
      connectNext.current = true;
      return;
    }
    trigger.current?.focus({preventScroll: true});
    onWallets();
  };
  const sheetClosed = () => {
    if (!connectNext.current) return;
    connectNext.current = false;
    onWallets();
  };

  useEffect(() => {
    const r = refocus.current;
    if (!r || connected.split(" ").includes(r.gone)) return;
    refocus.current = null;
    // family ids are plain identifiers, safe inside a quoted attribute selector; a list closed meanwhile has no rows
    const to = r.to ? rows.current?.querySelector<HTMLElement>(`[data-disconnect="${r.to}"]`) : box.current?.querySelector("button");
    to?.focus({preventScroll: true});
  }, [connected]);

  // The popover is ours to close (the phone sheet has its own Escape and backdrop).
  useEffect(() => {
    if (!open || phone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      // back to the button from inside the dropdown (or from nowhere: a press on its text); never pulled from elsewhere
      const at = document.activeElement;
      if (!at || at === document.body || box.current?.contains(at)) trigger.current?.focus({preventScroll: true});
    };
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, phone]);

  if (none)
    return (
      <div ref={box} className={s.wallets}>
        <Button height={40} title={wallets.connecting ? "Connecting…" : "Connect wallet"} loading={!!wallets.connecting} onClick={onWallets} data-testid="swap-connect-open" />
      </div>
    );

  const one = conns.length === 1 ? conns[0] : undefined;
  const list = <WalletRows listRef={rows} conns={conns} more={conns.length < FAMILIES.length} onDisconnect={disconnect} onConnectMore={connectMore} />;
  return (
    <div
      ref={box}
      className={s.wallets}
      // focus gone past the popover (Tab on past its last button, Shift+Tab off the button) closes it; a press on its
      // text (focus to nowhere) keeps it. The phone sheet is a portal with its own focus trap.
      onBlur={
        open && !phone
          ? (e) => {
              const to = e.relatedTarget;
              if (to instanceof Node && !box.current?.contains(to)) setOpen(false);
            }
          : undefined
      }
    >
      <button
        ref={trigger}
        type="button"
        className={s.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open && !phone ? menuId : undefined}
        aria-label={one ? `${FAMILY_LABEL[one.family]} wallet ${one.walletName} ${shortAddress(one.address)}` : `${plural(conns.length, "wallet")} connected`}
        onClick={() => (open ? setOpen(false) : show())}
        data-testid="swap-wallet-pill"
      >
        <span className={s.stack}>
          {conns.map((c) => (
            <span key={c.family} className={ownIcon(c) ? `${s.stackIcon} ${s.stackSquare}` : s.stackIcon} data-testid={`swap-wallet-pill-${c.family}`}>
              <ConnIcon c={c} size={22} />
            </span>
          ))}
        </span>
        <span className={s.pillText}>{one ? shortAddress(one.address, 4, 4) : plural(conns.length, "wallet")}</span>
        <Icon name="chevronDown" size={12} color="var(--muted)" className={s.pillChevron} />
      </button>
      {phone ? (
        <Sheet open={open} onClose={() => setOpen(false)} onClosed={sheetClosed} label="Connected wallets" phoneHeight="half" data-testid="swap-wallets-menu">
          <div className={s.walletsSheet}>
            <SheetHeader title="Connected wallets" onClose={() => setOpen(false)} />
            {list}
          </div>
        </Sheet>
      ) : open ? (
        <div
          id={menuId}
          role="dialog"
          aria-labelledby={titleId}
          className={s.walletsPopover}
          data-testid="swap-wallets-menu"
        >
          <Text as="h2" id={titleId} variant="caps" color="var(--dim)" className={s.walletsTitle}>
            Connected wallets
          </Text>
          {list}
        </div>
      ) : null}
    </div>
  );
}

/** One row per connected wallet, then "Connect another wallet" while a family is left. */
function WalletRows({
  listRef,
  conns,
  more,
  onDisconnect,
  onConnectMore,
}: {
  listRef: RefObject<HTMLUListElement | null>;
  conns: readonly WalletConnection[];
  more: boolean;
  onDisconnect(family: WalletFamily): void;
  onConnectMore(): void;
}) {
  return (
    <>
      <ul ref={listRef} className={s.walletRows}>
        {conns.map((c) => (
          <li key={c.family} className={s.walletRow} data-testid={`swap-wallet-row-${c.family}`}>
            <span className={s.walletIcon} aria-hidden="true">
              <ConnIcon c={c} size={32} />
              {/* the network in the corner of the wallet's own icon (a network logo needs none) */}
              {ownIcon(c) ? (
                <span className={s.walletBadge}>
                  <ChainLogo slug={FAMILY_SLUG[c.family]} size={14} />
                </span>
              ) : null}
            </span>
            <span className={s.walletText}>
              <Text variant="small" weight={600} lines={1}>
                {c.walletName}
                <span className={s.walletNetwork}> · {FAMILY_LABEL[c.family]}</span>
              </Text>
              <Text variant="meta" color="var(--muted)" tabular selectable lines={1}>
                {shortAddress(c.address, 6, 4)}
              </Text>
            </span>
            <CopyButton value={c.address} aria-label={`Copy ${FAMILY_LABEL[c.family]} address`} data-testid={`swap-wallet-copy-${c.family}`} />
            <IconButton
              icon="power"
              size={32}
              iconSize={15}
              variant="flat"
              aria-label={`Disconnect ${FAMILY_LABEL[c.family]} wallet`}
              onClick={() => onDisconnect(c.family)}
              data-disconnect={c.family}
              data-testid={`swap-wallet-disconnect-${c.family}`}
            />
          </li>
        ))}
      </ul>
      {more ? (
        <Button block kind="ghost" height={40} icon="plus" iconPosition="left" title="Connect another wallet" onClick={onConnectMore} data-testid="swap-wallets-connect-more" />
      ) : null}
    </>
  );
}
