/**
 * The token picker (mobile components/SwapTokenSheet.tsx, ui-port.md §5.7): a
 * search field, a rail of networks (pinned six, then held, then the rest) and
 * the chosen network's tokens, held first. "All" lists what the connected
 * wallets hold anywhere; typing searches every network. Long lists (search,
 * a big network) are virtualized. Import-by-address is not offered in v1.
 */
import {useVirtualizer} from "@tanstack/react-virtual";
import {useMemo, useRef, useState, type ReactNode, type RefObject} from "react";
import type {SwapToken} from "../../contracts/domain";
import {formatAmount, formatUsd, matchesToken, pickerNetworks} from "../../catalog";
import {AssetIcon, Divider, Field, Icon, Sheet, SheetHeader, Text, TokenIcon} from "../../ui";
import s from "./TokenSheet.module.css";

const ALL = "all";
/** Rows of the list; above this many the list is virtualized. */
const ROW_PX = 52;
const VIRTUAL_FROM = 60;

export interface TokenSheetProps {
  open: boolean;
  side: "pay" | "receive";
  tokens: readonly SwapToken[];
  /** The side's current token key. */
  selected?: string;
  onPick(t: SwapToken): void;
  onClose(): void;
}

export function TokenSheet({open, side, tokens, selected, onPick, onClose}: TokenSheetProps) {
  const search = useRef<HTMLInputElement>(null);
  const title = side === "pay" ? "You pay" : "You receive";
  return (
    <Sheet open={open} onClose={onClose} label={title} width={480} phoneHeight="full" flush initialFocus={search} data-testid="swap-token-sheet">
      {/* the sheet mounts its content only while open (and while closing), so each opening starts fresh */}
      <Picker key={side} title={title} side={side} tokens={tokens} selected={selected} onPick={onPick} onClose={onClose} search={search} />
    </Sheet>
  );
}

interface PickerProps extends Omit<TokenSheetProps, "open"> {
  title: string;
  search: RefObject<HTMLInputElement | null>;
}

function Picker({title, side, tokens, selected, onPick, onClose, search}: PickerProps) {
  const networks = useMemo(() => pickerNetworks(tokens), [tokens]);
  const anyHeld = networks.some((n) => n.held);
  // Open on the selected token's network, else "All" when something is held, else the first network (mobile L117-122).
  const [net, setNet] = useState<string>(() => tokens.find((t) => t.key === selected)?.chain ?? (anyHeld ? ALL : (networks[0]?.slug ?? ALL)));
  const [q, setQ] = useState("");
  const searching = q.trim().length > 0;
  const shown = useMemo(() => {
    if (searching) return tokens.filter((t) => matchesToken(t, q));
    if (net === ALL) return tokens.filter((t) => t.amount !== "0");
    return tokens.filter((t) => t.chain === net);
  }, [tokens, q, net, searching]);
  const current = networks.find((n) => n.slug === net);
  const heading = searching ? "Search results" : net === ALL ? "Your tokens" : (current?.name ?? "");
  const headingValue = searching ? "" : net === ALL ? (anyHeld ? formatUsd(networks.reduce((sum, n) => sum + n.usd, 0)) : "") : current?.held ? formatUsd(current.usd) : "";
  const showNetwork = searching || net === ALL;

  const scroller = useRef<HTMLDivElement>(null);
  const long = shown.length > VIRTUAL_FROM;

  const pick = (t: SwapToken) => {
    setQ("");
    onPick(t);
  };
  const row = (t: SwapToken) => <TokenRow key={t.key} t={t} side={side} selected={t.key === selected} showNetwork={showNetwork} onPick={() => pick(t)} />;

  return (
    <>
      <div className={s.top}>
        <SheetHeader title={title} onClose={onClose} />
        <Field
          ref={search}
          aria-label="Search tokens or networks"
          placeholder="Search tokens or networks"
          leading={<Icon name="search" size={16} color="var(--muted)" />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="swap-token-search"
          enterKeyHint="search"
        />
      </div>
      <Divider />
      <div className={s.body}>
        <nav className={s.rail} aria-label="Networks">
          {[{slug: ALL, name: "All networks", held: false}, ...networks].map((n) => (
            <button
              key={n.slug}
              type="button"
              className={s.railItem}
              aria-pressed={!searching && n.slug === net}
              aria-label={n.held ? `${n.name}, has balance` : n.name}
              title={n.name}
              data-testid={`swap-net-${n.slug}`}
              onClick={() => {
                setQ("");
                setNet(n.slug);
              }}
            >
              {n.slug === ALL ? (
                <span className={s.all}>
                  <Text variant="tag" color="var(--ink2)">
                    All
                  </Text>
                </span>
              ) : (
                <AssetIcon network={n.slug} size={30} />
              )}
              {n.held ? <span className={s.heldDot} aria-hidden="true" /> : null}
            </button>
          ))}
        </nav>
        <div className={s.pane}>
          <div className={s.heading}>
            <Text variant="bodyStrong" lines={1}>
              {heading}
            </Text>
            {headingValue ? (
              <Text variant="meta" color="var(--muted)" tabular>
                {headingValue}
              </Text>
            ) : null}
          </div>
          <div ref={scroller} className={s.scroll} role="list" aria-label={heading}>
            {shown.length === 0 ? (
              <Text as="p" variant="small" color="var(--muted)" className={s.empty}>
                {searching ? `Nothing matches “${q.trim()}”.` : net === ALL ? "No balances yet — pick a network on the left." : "No tokens on this network."}
              </Text>
            ) : long ? (
              <VirtualRows count={shown.length} scroller={scroller} render={(i) => row(shown[i]!)} />
            ) : (
              shown.map(row)
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Only the rows in view (plus overscan) are in the DOM: "All" + a search can list ~400 tokens. */
function VirtualRows({count, scroller, render}: {count: number; scroller: RefObject<HTMLDivElement | null>; render(i: number): ReactNode}) {
  // TanStack Virtual hands back fresh functions every render, so this component must not be memoized (and isn't).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtual = useVirtualizer({count, getScrollElement: () => scroller.current, estimateSize: () => ROW_PX, overscan: 8});
  return (
    <div className={s.virtual} style={{height: virtual.getTotalSize()}}>
      {virtual.getVirtualItems().map((v) => (
        <div key={v.key} className={s.virtualRow} style={{transform: `translateY(${v.start}px)`}}>
          {render(v.index)}
        </div>
      ))}
    </div>
  );
}

/** One token: icon (network badge when the list mixes networks), symbol, chain, and the held amount + USD. */
function TokenRow({t, side, selected, showNetwork, onPick}: {t: SwapToken; side: "pay" | "receive"; selected: boolean; showNetwork: boolean; onPick(): void}) {
  const held = t.amount !== "0";
  const qr = side === "pay" && t.payMode === "deposit";
  const connect = side === "pay" && t.payMode === "connect";
  const sub = [showNetwork ? t.chainName : null, qr ? "pay by QR" : connect ? "connect a wallet" : null].filter(Boolean).join(" · ");
  return (
    <div role="listitem">
      <button
        type="button"
        className={s.token}
        aria-current={selected || undefined}
        aria-label={`${t.symbol} on ${t.chainName}${held ? `, ${formatAmount(t.amount, t.decimals)} held` : ""}`}
        data-testid={`swap-token-${t.key}`}
        onClick={onPick}
      >
        <TokenIcon token={t} size={34} badge={showNetwork} />
        <span className={s.tokenText}>
          <Text variant="listTitle" lines={1}>
            {t.symbol}
          </Text>
          {sub ? (
            <Text variant="meta" color="var(--dim)" lines={1}>
              {sub}
            </Text>
          ) : null}
        </span>
        {held ? (
          <span className={s.held}>
            <Text variant="small" color="var(--ink2)" tabular>
              {formatAmount(t.amount, t.decimals)}
            </Text>
            <Text variant="meta" color="var(--dim)" tabular>
              {t.priceUsd !== undefined ? formatUsd(t.usd) : "—"}
            </Text>
          </span>
        ) : null}
      </button>
    </div>
  );
}
