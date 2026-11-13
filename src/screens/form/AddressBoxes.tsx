/**
 * The form's address boxes (D7): where the output goes (mobile "Send to
 * another address", forced on when no wallet of that family is connected)
 * and, for a payer with no connector (BTC, ZEC…) or none connected yet (TON),
 * the refund address that makes a QR payment possible. Each is validated for
 * its family; until it is valid nothing is quoted.
 */
import {useState} from "react";
import type {RecipientCheck, SwapRecipient, SwapToken} from "../../contracts/domain";
import {usePorts} from "../../config";
import {shortAddress} from "../../catalog";
import {Button, Chip, Field, IconButton, Switch, Text} from "../../ui";
import s from "./Form.module.css";

const canPaste = () => typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

/** Paste chip when empty (hidden where the browser has no clipboard read), a clear button otherwise. */
function Trailing({value, onChange, label}: {value: string; onChange(v: string): void; label: string}) {
  const [paste] = useState(canPaste);
  if (value) return <IconButton icon="close" aria-label={`Clear ${label}`} size={36} iconSize={13} variant="flat" className={s.clear} onClick={() => onChange("")} />;
  if (!paste) return null;
  return (
    <Chip
      label="Paste"
      aria-label={`Paste ${label}`}
      onClick={() => {
        void navigator.clipboard
          .readText()
          .then((t) => onChange(t.trim()))
          .catch(() => undefined);
      }}
    />
  );
}

export interface RecipientBoxProps {
  to: SwapToken;
  /** User switch state. */
  toOther: boolean;
  /** No wallet of this family (or it is a contract account, below): the field is on and the switch is locked. */
  forced: boolean;
  /** The connected EVM wallet has contract code and another wallet pays: it may not exist on this chain. */
  ownerIsContract?: boolean;
  text: string;
  check: SwapRecipient | null;
  onToggle(on: boolean): void;
  onText(text: string): void;
}

/** "Send to another address" (mobile index.tsx L351-426) with the web's forced mode and the EVM contract warning. */
export function RecipientBox({to, toOther, forced, ownerIsContract, text, check, onToggle, onText}: RecipientBoxProps) {
  const on = toOther || forced;
  const address = check?.kind === "ok" ? check.address : null;
  // A contract can't always move what it receives — said, not refused (a Safe is a contract too).
  const isContract = usePorts().catalog.useIsContract(to.caip2, on && to.family === "evm" ? address : null) === true;
  const sub = ownerIsContract
    ? `Your EVM wallet is a smart-contract account — it may not exist at the same address on ${to.chainName}. Enter an address you control there.`
    : on
    ? `${to.symbol} is paid out to this ${to.chainName} address`
    : to.owner
        ? `To this wallet on ${to.chainName} · ${shortAddress(to.owner)}`
        : `To this wallet on ${to.chainName}`;
  const label = `Recipient address on ${to.chainName}`;
  return (
    <section className={s.box} data-testid="swap-recipient-box" aria-label="Recipient">
      <div className={s.boxHead}>
        <div className={s.boxText}>
          <Text variant="bodyStrong">{forced ? `Receive on ${to.chainName}` : "Send to another address"}</Text>
          <Text variant="meta" color={ownerIsContract ? "var(--amber)" : "var(--muted)"} lines={ownerIsContract ? undefined : 1} data-testid="swap-recipient-sub">
            {sub}
          </Text>
        </div>
        {forced ? null : <Switch checked={on} onChange={onToggle} aria-label="Send to another address" data-testid="swap-recipient-toggle" />}
      </div>
      {on ? (
        <Field
          frame="address"
          aria-label={label}
          placeholder={`${to.chainName} address`}
          data-testid="swap-recipient"
          value={text}
          onChange={(e) => onText(e.target.value)}
          tone={check?.kind === "invalid" ? "invalid" : address ? "valid" : "neutral"}
          error={check?.kind === "invalid" ? check.reason : null}
          hint={
            address
              ? isContract
                ? `This is a contract on ${to.chainName} — make sure it can receive and move ${to.symbol}, or the funds are stuck there.`
                : `Valid ${to.chainName} address. Double-check it — a swap to the wrong address can't be undone.`
              : undefined
          }
          hintColor={address ? (isContract ? "var(--amber)" : "var(--green)") : undefined}
          trailing={<Trailing value={text} onChange={onText} label={label} />}
        />
      ) : null}
    </section>
  );
}

export interface RefundBoxProps {
  from: SwapToken;
  text: string;
  check: RecipientCheck | null;
  onText(text: string): void;
  /** The family has a browser wallet too (Tron, TON): offer it — the QR payment is the fallback. */
  onConnect?: () => void;
  /** "TON" in "Connect TON wallet". */
  walletLabel?: string;
}

/** A deposit-address payer: "pay from any wallet by QR", and the refund address that payment needs (web, ui-port §5.4). */
export function RefundBox({from, text, check, onText, onConnect, walletLabel}: RefundBoxProps) {
  const ok = check?.kind === "address";
  const bad = check?.kind === "invalid" ? check.reason : check?.kind === "name" ? `Paste the ${from.chainName} address — names aren't used for swaps.` : null;
  const label = `Your ${from.chainName} address for refunds`;
  return (
    <section className={s.box} data-testid="swap-refund-box" aria-label="Refund address">
      <div className={s.boxText}>
        <Text variant="bodyStrong">Pay from any wallet by QR</Text>
        <Text variant="meta" color="var(--muted)">
          {onConnect
            ? `Connect a ${walletLabel ?? from.chainName} wallet to sign here, or get a one-time deposit address after the review and send ${from.symbol} to it from any wallet.`
            : `${from.chainName} has no browser wallet here: after the review you get a one-time deposit address to send ${from.symbol} to from any wallet.`}
        </Text>
      </div>
      {onConnect ? (
        <Button kind="secondary" height={40} title={`Connect ${walletLabel ?? from.chainName} wallet`} onClick={onConnect} data-testid="swap-refund-connect" />
      ) : null}
      <Field
        frame="address"
        aria-label={label}
        placeholder={label}
        data-testid="swap-refund"
        value={text}
        onChange={(e) => onText(e.target.value)}
        tone={bad ? "invalid" : ok ? "valid" : "neutral"}
        error={bad}
        hint={`If the swap can't complete, ${from.symbol} goes back here.`}
        trailing={<Trailing value={text} onChange={onText} label={label} />}
      />
    </section>
  );
}
