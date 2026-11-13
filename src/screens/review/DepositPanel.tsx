/**
 * QR payments (D20, ui-port.md §5.9): a one-time deposit address the payer
 * sends to from any wallet. The record is saved before this shows (execute's
 * issueDeposit), so tracking already runs. The QR carries the address (a
 * BIP-21 / zcash: URI with the amount); it is never drawn for an expired
 * quote or one that needs a memo.
 */
import type {DepositTicket} from "../../contracts/execution";
import type {Family, SwapToken} from "../../contracts/domain";
import type {QuoteRequest} from "../../contracts/routes";
import {chainByCaip2Web, shortAddress} from "../../catalog";
import {etaLabel, formatUnits, providerName} from "../../swap";
import {swapSteps} from "../../activity";
import {usePorts} from "../../config";
import {Button, CopyButton, QrCode, SheetHeader, SwapSteps, Text, Tiles, TokenIcon, TxReviewCard, countdownTone, formatCountdown, useCountdown} from "../../ui";
import {amountText} from "../labels";
import s from "./Review.module.css";

/** What the QR encodes: BIP-21 for BTC, `zcash:` for ZEC (both with the amount), the bare address elsewhere. */
export function depositUri(family: Family | undefined, address: string, amountDecimal: string): string {
  if (family === "btc") return `bitcoin:${address}?amount=${amountDecimal}`;
  if (family === "zcash") return `zcash:${address}?amount=${amountDecimal}`;
  return address;
}

export interface DepositDetailsProps {
  address: string;
  memo: string | null;
  /** Exact base units to send. */
  amount: bigint;
  decimals: number;
  symbol: string;
  chainName: string;
  /** Picks the QR URI scheme; unknown → the bare address. */
  family: Family | undefined;
  validUntilMs: number;
  /** "Get a new address" once expired; omitted where a new one can't be issued (activity). */
  onRenew?: () => void;
  renewing?: boolean;
}

/** QR, address with copy, the exact amount and the expiry countdown; blurred with a red warning once expired. */
export function DepositDetails({address, memo, amount, decimals, symbol, chainName, family, validUntilMs, onRenew, renewing}: DepositDetailsProps) {
  const left = useCountdown(validUntilMs);
  const expired = left === 0;
  const tone = countdownTone(left);
  const exact = formatUnits(amount, decimals);
  return (
    <>
      {memo ? (
        <Text as="p" variant="small" color="var(--red)">
          This route needs a memo your wallet may not add — it is not offered for QR payments.
        </Text>
      ) : (
        <div className={s.qrWrap}>
          <QrCode value={depositUri(family, address, exact)} expired={expired} aria-label={expired ? "Expired deposit address QR code" : `QR code of the ${chainName} deposit address`} />
        </div>
      )}
      {/* Expired: nothing here makes sending easy any more — no copy buttons, the address struck through. */}
      <div className={s.address}>
        <Text
          selectable={!expired}
          className={s.addressText}
          data-testid="swap-deposit-address"
          color={expired ? "var(--muted)" : undefined}
          style={expired ? {textDecoration: "line-through"} : undefined}
        >
          {address}
        </Text>
        {expired ? null : <CopyButton value={address} aria-label="Copy deposit address" data-testid="swap-deposit-copy" />}
      </div>
      <Tiles
        tiles={[
          {k: "Send exactly", v: `${exact} ${symbol}`, ...(expired ? {} : {action: <CopyButton value={exact} aria-label="Copy amount" size={28} />})},
          {k: "Expires in", v: formatCountdown(left), ...(tone !== "ink" ? {tone} : {})},
        ]}
      />
      {expired ? (
        <div className={s.expired} data-testid="swap-deposit-expired">
          <Text as="p" variant="small" weight={600} color="var(--red)">
            Expired — don&apos;t send to this address.
          </Text>
          <Text as="p" variant="meta" color="var(--ink2)">
            Already sent before it expired? Don&apos;t send again — that deposit is still being watched and processed. Get a new address only if you
            haven&apos;t sent anything.
          </Text>
          {onRenew ? <Button height={54} block title="Get a new address" icon="refresh" iconPosition="left" loading={renewing} onClick={onRenew} /> : null}
        </div>
      ) : null}
    </>
  );
}

export interface DepositPanelProps {
  ticket: DepositTicket;
  req: QuoteRequest;
  from: SwapToken;
  to: SwapToken;
  onRenew(): void;
  renewing: boolean;
  /** "I've sent it": the activity drawer takes over (tracking already runs). */
  onSent(): void;
  onClose(): void;
}

export function DepositPanel({ticket, req, from, to, onRenew, renewing, onSent, onClose}: DepositPanelProps) {
  const record = usePorts().activity.useSwap(ticket.id);
  const expired = useCountdown(ticket.validUntilMs) === 0;
  const toChainName = chainByCaip2Web(to.caip2)?.name ?? to.chainName;
  return (
    <div className={s.body} data-testid="swap-deposit">
      <SheetHeader
        icon={<TokenIcon token={from} size={44} />}
        title={`Send ${from.symbol} on ${from.chainName}`}
        sub={`${providerName(ticket.provider)} · ${etaLabel(ticket.etaSeconds)}`}
        onClose={onClose}
      />
      <DepositDetails
        address={ticket.depositAddress}
        memo={ticket.depositMemo}
        amount={ticket.sourceAmount}
        decimals={from.decimals}
        symbol={from.symbol}
        chainName={from.chainName}
        family={from.family}
        validUntilMs={ticket.validUntilMs}
        onRenew={onRenew}
        renewing={renewing}
      />
      {/* The review's compact rows (D34): one line each, the secondary fact dim beside the value. */}
      <TxReviewCard
        compact
        rows={[
          {k: "Network", v: from.chainName},
          {k: "Refund to", v: shortAddress(req.refundAddress, 8, 6), note: "refunds go here"},
          {k: "Receive", v: `≥ ${amountText(ticket.minDestAmount, to.decimals, to.symbol)}`, note: `on ${toChainName}`},
          {k: "To", v: shortAddress(req.recipient, 8, 6)},
        ]}
      />
      <Text as="p" variant="meta" color="var(--amber)" className={s.warning}>
        {`Only ${from.symbol} on ${from.chainName}. Another asset or network is lost. Send the exact amount in one transaction.`}
      </Text>
      {record ? <SwapSteps steps={swapSteps(record, toChainName)} /> : null}
      <div className={s.actions}>
        {/* Once expired the renewal is the main action; "I already sent it" stays for whoever paid in time. */}
        {expired ? (
          <Button block kind="ghost" height={40} title="I already sent it" onClick={onSent} data-testid="swap-deposit-sent" />
        ) : (
          <Button block height={54} title="I've sent it" onClick={onSent} data-testid="swap-deposit-sent" />
        )}
        <Button block kind="ghost" height={40} title="Cancel" onClick={onClose} />
      </div>
    </div>
  );
}
