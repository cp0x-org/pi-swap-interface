/**
 * The design-system gallery for review (mounted at #/gallery by the app):
 * every primitive in every state, with made-up values only — no ports, no
 * network beyond the bundled logo files. Lazily imported so it never weighs
 * on the swap screen.
 */
import {useRef, useState, type ReactNode} from "react";
import type {SwapStep} from "../contracts/activity";
import type {ReviewRow, TextVariant} from "../contracts/ui";
import {colors, type as scale} from "../theme/tokens";
import {Button, IconButton, LinkButton} from "./Button";
import {Chip, TokenChip, type TokenChipToken} from "./Chip";
import {CopyButton} from "./CopyButton";
import {Countdown, formatCountdown} from "./Countdown";
import {AmountInput, AmountText, Field} from "./Field";
import {Icon, ICON_NAMES} from "./Icon";
import {AssetIcon, ChainLogo, ProviderLogo, TokenIcon} from "./LogoIcons";
import {NETWORK_LOGOS, PROVIDER_LOGOS, TOKEN_IMAGES, TOKEN_SVGS} from "./logos";
import {QrCode} from "./QrCode";
import {Sheet} from "./Sheet";
import {Facts, SheetHeader, Tiles, TxReviewCard} from "./SheetParts";
import {ReviewSkeleton, Skeleton} from "./Skeleton";
import {Spinner} from "./Spinner";
import {Card, Divider, Glass} from "./Surface";
import {StepDot, SwapSteps} from "./SwapSteps";
import {Switch} from "./Switch";
import {Badge, Tag, VenueBadge} from "./Tag";
import {Text} from "./Text";
import {showToast, Toaster} from "./Toast";
import {Tooltip} from "./Tooltip";
import {useBreakpoint} from "./breakpoint";
import s from "./Gallery.module.css";

const USDC: TokenChipToken = {symbol: "USDC", caip2: "eip155:8453", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base", chainName: "Base"};
const HYPE: TokenChipToken = {symbol: "HYPE", caip2: "eip155:99901", contract: null, chain: "elysium", chainName: "Elysium"};
const BTC: TokenChipToken = {symbol: "BTC", caip2: "bitcoin:mainnet", contract: null, chain: "bitcoin", chainName: "Bitcoin"};
const LONG: TokenChipToken = {symbol: "scrvUSD", caip2: "eip155:1", contract: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", chain: "ethereum", chainName: "Ethereum"};

const DEMO_ADDRESS = "bc1qdemo0notarealaddress0doNotSend0000000";

const STEPS: readonly (readonly SwapStep[])[] = [
  [
    {key: "approve", label: "Approve USDC", state: "done"},
    {key: "confirm", label: "You confirmed the transaction", state: "done"},
    {key: "swap", label: "Swap on Base", state: "active"},
    {key: "deliver", label: "Deliver ETH on Arbitrum", state: "todo"},
  ],
  [
    {key: "confirm", label: "Confirm the transaction", state: "failed"},
    {key: "swap", label: "Swap on Base", state: "todo"},
    {key: "deliver", label: "Deliver ETH on Arbitrum", state: "todo"},
  ],
  [
    {key: "confirm", label: "Deposit address issued", state: "done"},
    {key: "swap", label: "Send 0.0125 BTC", state: "done"},
    {key: "deliver", label: "Deliver USDC on Base", state: "done"},
  ],
];

const REVIEW: readonly ReviewRow[] = [
  {k: "You pay", v: "250 USDC", sub: "Base · $250.00"},
  {k: "You receive", v: "≈ 0.07841 ETH", sub: "Arbitrum · $249.12"},
  {k: "Minimum received", v: "0.07802 ETH", sub: "Auto slippage 0.5% · quoted 0.12%", testId: "gallery-min"},
  {k: "Route", v: "LI.FI", sub: "~2 min", icon: <ProviderLogo provider="lifi" size={18} />},
  {k: "Fees", v: "$0.41", sub: "Plus gas, up to $0.03 in ETH"},
  {k: "Approval", v: "Exact 250 USDC", sub: "Spender 0x1231de…a4ae"},
  {k: "To", v: "0x71C7…976F", sub: "Another Arbitrum address — not this wallet", color: "var(--amber)"},
];

function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <section className={s.section}>
      <Text as="h2" variant="caps" color="var(--dim)">
        {title}
      </Text>
      {children}
    </section>
  );
}

function Cell({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className={s.cell}>
      {children}
      <Text variant="meta" color="var(--dim)" className={s.cellLabel} title={label}>
        {label}
      </Text>
    </div>
  );
}

type SheetDemo = "dialog" | "drawer" | "flush" | "locked" | null;

export function Gallery() {
  const bp = useBreakpoint();
  const [on, setOn] = useState(true);
  const [amount, setAmount] = useState("250");
  const [address, setAddress] = useState("");
  const [sheet, setSheet] = useState<SheetDemo>(null);
  const [locked, setLocked] = useState(true);
  const [deadline] = useState(() => ({soon: Date.now() + 95_000, later: Date.now() + 14 * 60_000, past: Date.now() - 1}));
  const search = useRef<HTMLInputElement>(null);
  const close = () => setSheet(null);
  const addressTone = address === "" ? "neutral" : address.length >= 26 ? "valid" : "invalid";
  const tokenSymbols = [...new Set([...Object.keys(TOKEN_IMAGES), ...TOKEN_SVGS, "MON", "XDAI", "scrvUSD", "GOMINING", "wS"])];

  return (
    <main className={s.page}>
      <header className={s.head}>
        <Text as="h1" variant="hero">
          cp0x UI kit
        </Text>
        <Text variant="small" color="var(--muted)">
          Breakpoint: <Text weight={600}>{bp}</Text> · phone &lt; 640 ≤ tablet &lt; 1024 ≤ desktop
        </Text>
      </header>

      <Section title="Type scale">
        <div className={s.col}>
          {(Object.keys(scale) as TextVariant[]).map((v) => (
            <div key={v} className={s.spread}>
              <Text variant={v}>{v === "balance" ? "$12,480.06" : v === "amount" ? "0.07841 ETH" : `${v} — The quick swap 0123456789`}</Text>
              <Text variant="meta" color="var(--dim)" tabular>
                {scale[v].size}px · {scale[v].weight} · {scale[v].tracking}
              </Text>
            </div>
          ))}
          <Text lines={1} style={{maxWidth: 260}}>
            lines=1: a long line that ends in an ellipsis instead of wrapping onto the next one
          </Text>
          <Text lines={2} style={{maxWidth: 260}} color="var(--ink2)">
            lines=2: a longer text that is clamped to two lines, so a provider refusal never pushes the list around on a phone.
          </Text>
          <Text variant="small" selectable tabular>
            selectable: 0x71C7656EC7ab88b098defB751B7401B5f6d8976F
          </Text>
        </div>
      </Section>

      <Section title="Colors">
        <div className={s.grid}>
          {Object.entries(colors).map(([name, value]) => (
            <div key={name} className={s.swatch}>
              <span className={s.chip} style={{background: value}} />
              <span>
                <Text variant="small" weight={500}>
                  {name}
                </Text>
                <br />
                <Text variant="meta" color="var(--dim)" tabular>
                  {value}
                </Text>
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Icons (24 · 16 · 12)">
        <div className={s.row}>
          {ICON_NAMES.map((n) => (
            <Cell key={n} label={n}>
              <span className={s.row} style={{gap: 6, color: "var(--ink2)"}}>
                <Icon name={n} />
                <Icon name={n} size={16} />
                <Icon name={n} size={12} color="var(--accent)" />
              </span>
            </Cell>
          ))}
        </div>
      </Section>

      <Section title="Buttons">
        <div className={s.col}>
          {(["primary", "secondary", "ghost"] as const).map((kind) => (
            <div key={kind} className={s.row}>
              <Button kind={kind} height={54} title="Review swap" />
              <Button kind={kind} title="Get a new address" icon="refresh" />
              <Button kind={kind} height={40} title="Source on explorer" icon="external" iconPosition="left" />
              <LinkButton kind={kind} title="Source tx" href="https://example.com/" />
              <Button kind={kind} title="Confirm swap" loading />
              <Button kind={kind} title="Enter an amount" disabled />
            </div>
          ))}
          <Button block height={54} title="Review swap (block)" />
          <div className={s.row}>
            <IconButton icon="refresh" aria-label="Refresh routes" />
            <IconButton icon="gear" aria-label="Settings" />
            <IconButton icon="close" aria-label="Close" size={34} iconSize={15} variant="flat" />
            <IconButton icon="back" aria-label="Back" size={34} iconSize={15} variant="flat" />
            <IconButton icon="refresh" aria-label="Refresh (disabled)" disabled />
          </div>
        </div>
      </Section>

      <Section title="Chips, token chip, copy">
        <div className={s.row}>
          <Chip size="sm" label="Max" />
          <Chip size="sm" label="Max" disabled />
          <Chip label="Paste" />
          <CopyButton value={DEMO_ADDRESS} aria-label="Copy address" />
          <CopyButton value="0.0125" label="Copy" aria-label="Copy amount" />
        </div>
        <div className={s.row}>
          <TokenChip token={USDC} />
          <TokenChip token={HYPE} />
          <TokenChip token={BTC} />
          <TokenChip token={LONG} />
          <TokenChip token={null} />
        </div>
      </Section>

      <Section title="Tags, badges, tooltip">
        <div className={s.row}>
          {(["accent", "green", "muted", "amber", "red"] as const).map((t) => (
            <Tag key={t} tone={t}>
              {t}
            </Tag>
          ))}
          <Badge kind="best" />
          <Badge kind="fastest" />
          <Badge kind="warning">Memo</Badge>
          <VenueBadge trust="contracts" providerName="Uniswap" chainName="Base" />
          <VenueBadge trust="own-node" providerName="THORChain" chainName="Bitcoin" />
          <VenueBadge trust="provider-api" providerName="LI.FI" chainName="Base" />
          <Tooltip content="A tooltip on hover or keyboard focus">
            <Button kind="ghost" height={40} title="Hover or focus me" />
          </Tooltip>
        </div>
      </Section>

      <Section title="Inputs">
        <div className={s.grid2}>
          <div className={s.col}>
            <Field label="Search" placeholder="Search tokens or networks" leading={<Icon name="search" size={16} />} />
            <Field label="Refund address" frame="address" placeholder="Your Bitcoin address for refunds" hint="If the swap can't complete, BTC goes back here." />
            <Field
              frame="address"
              placeholder="Arbitrum address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              tone={addressTone}
              hint={addressTone === "valid" ? "Valid Arbitrum address. Double-check it — a swap to the wrong address can't be undone." : undefined}
              hintColor={addressTone === "valid" ? "var(--green)" : undefined}
              error={addressTone === "invalid" ? "That isn't an Arbitrum address." : null}
              trailing={address ? <IconButton icon="close" aria-label="Clear" size={36} iconSize={13} variant="flat" onClick={() => setAddress("")} /> : <Chip label="Paste" />}
            />
            <Field label="Disabled" value="0x71C7…976F" disabled readOnly />
          </div>
          <Card className={s.payCard}>
            <div className={s.spread}>
              <Text variant="caps" color="var(--dim)">
                You pay
              </Text>
              <span className={s.row} style={{gap: 8}}>
                <Text variant="meta" color="var(--muted)" tabular>
                  Balance 1,204.5
                </Text>
                <Chip size="sm" label="Max" />
              </span>
            </div>
            <div className={s.amountRow}>
              <TokenChip token={USDC} />
              <AmountInput aria-label="Amount to pay" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} invalid={Number(amount) > 1204.5} />
            </div>
            <Text variant="meta" color={Number(amount) > 1204.5 ? "var(--red)" : "var(--dim)"} tabular style={{textAlign: "right"}}>
              {Number(amount) > 1204.5 ? "Insufficient balance" : `≈ $${amount || "0.00"}`}
            </Text>
            <Divider />
            <div className={s.col} style={{gap: 4}}>
              <AmountText value="0.07841" />
              <AmountText value="1234567.891234" />
              <AmountText value="98765432101.123456" />
              <AmountText value={null} />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Switch">
        <div className={s.row}>
          <Switch checked={on} onChange={setOn} aria-label="Send to another address" />
          <Switch checked={!on} onChange={(v) => setOn(!v)} aria-label="Inverse" />
          <Switch checked disabled onChange={() => {}} aria-label="Forced on" />
          <Switch checked={false} disabled onChange={() => {}} aria-label="Disabled off" />
        </div>
      </Section>

      <Section title="Loading">
        <div className={s.grid2}>
          <Card className={s.col}>
            <div className={s.row}>
              <Spinner />
              <Spinner size={16} color="var(--muted)" />
              <Spinner size={28} color="var(--green)" label="Loading" />
            </div>
            <Skeleton width="70%" height={14} />
            <Skeleton width="45%" height={11} />
            <Skeleton width={110} height={26} />
          </Card>
          <ReviewSkeleton label="Getting a fresh quote…" />
        </div>
      </Section>

      <Section title="Surfaces">
        <div className={s.grid2}>
          <Card>
            <Text variant="listTitle">Card</Text>
            <Text as="p" variant="meta" color="var(--muted)">
              surface1, radius 20, card shadow, padding 14
            </Text>
          </Card>
          <div className={s.glassDemo}>
            <div className={s.row}>
              <Glass className={s.glassPill}>
                <Icon name="swap" size={15} color="var(--ink2)" />
                <Text variant="small" weight={600}>
                  Glass
                </Text>
              </Glass>
              <Glass dark className={s.glassPill}>
                <Icon name="activity" size={15} color="var(--ink2)" />
                <Text variant="small" weight={600}>
                  Glass dark
                </Text>
              </Glass>
            </div>
          </div>
          <div className={s.box}>
            <Text variant="small" weight={600} color="var(--amber)">
              Paid out to another address
            </Text>
            <Text variant="meta" color="var(--ink2)" selectable>
              0x71C7656EC7ab88b098defB751B7401B5f6d8976F on Arbitrum. Check every character — a swap sent to the wrong address can't be undone.
            </Text>
          </div>
        </div>
      </Section>

      <Section title="Venue logos (32 · pending · refused · 18)">
        <div className={s.row}>
          {[...PROVIDER_LOGOS, "newvenue"].map((p) => (
            <Cell key={p} label={p}>
              <span className={s.row} style={{gap: 6}}>
                <ProviderLogo provider={p} size={32} />
                <ProviderLogo provider={p} size={32} state="pending" />
                <ProviderLogo provider={p} size={32} state="refused" />
                <ProviderLogo provider={p} size={18} />
              </span>
            </Cell>
          ))}
        </div>
      </Section>

      <Section title="Network logos">
        <div className={s.row}>
          {[...NETWORK_LOGOS, "morph"].map((n) => (
            <Cell key={n} label={n}>
              <ChainLogo slug={n} />
            </Cell>
          ))}
        </div>
      </Section>

      <Section title="Token logos (PNG → SVG → chain → monogram)">
        <div className={s.row}>
          {tokenSymbols.map((sym) => (
            <Cell key={sym} label={sym}>
              <AssetIcon token={{symbol: sym, caip2: "", contract: null}} size={34} />
            </Cell>
          ))}
        </div>
        <div className={s.row}>
          {[USDC, HYPE, BTC, LONG].map((t) => (
            <span key={t.symbol} className={s.row} style={{gap: 14}}>
              <TokenIcon token={t} size={44} />
              <TokenIcon token={t} size={34} />
              <TokenIcon token={t} size={28} />
              <TokenIcon token={t} size={34} badge={false} />
            </span>
          ))}
        </div>
      </Section>

      <Section title="Review card, tiles, facts">
        <div className={s.grid2}>
          <TxReviewCard rows={REVIEW} />
          <Card className={s.col} padding={16}>
            <SheetHeader icon={<TokenIcon token={BTC} size={44} />} title="Send BTC on Bitcoin" sub="NEAR Intents · ~10 min" onClose={() => {}} />
            <Tiles
              tiles={[
                {k: "Send exactly", v: "0.0125 BTC", action: <CopyButton value="0.0125" aria-label="Copy amount" size={28} />},
                {k: "Expires in", v: formatCountdown(95_000), tone: "amber"},
              ]}
            />
            <Tiles tiles={[{k: "Received", v: "+249.12 USDC", tone: "green"}, {k: "Expired", v: "0:00", tone: "red"}]} />
            <Facts
              facts={[
                {k: "Network", v: "Bitcoin"},
                {k: "Refund to", v: "bc1qdemo…0000"},
                {k: "Receive", v: "≥ 249.12 USDC on Base"},
                {k: "To", v: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"},
              ]}
            />
          </Card>
        </div>
      </Section>

      <Section title="Swap steps">
        <div className={s.row}>
          {(["done", "active", "todo", "failed"] as const).map((st) => (
            <Cell key={st} label={st}>
              <StepDot state={st} />
            </Cell>
          ))}
        </div>
        <div className={s.grid2}>
          {STEPS.map((steps, i) => (
            <Card key={i} padding={20}>
              <SwapSteps steps={steps} activeDetail="Waiting for Base to confirm the swap…" />
            </Card>
          ))}
        </div>
      </Section>

      <Section title="QR, countdown">
        <div className={s.row} style={{alignItems: "flex-start", gap: 24}}>
          <QrCode value={`bitcoin:${DEMO_ADDRESS}?amount=0.0125`} aria-label="Deposit address QR code" />
          <QrCode value={DEMO_ADDRESS} expired aria-label="Expired deposit QR code" />
          <div className={s.col}>
            <Text variant="small" color="var(--muted)">
              14 min left: <Countdown until={deadline.later} />
            </Text>
            <Text variant="small" color="var(--muted)">
              Under 2:00 (amber): <Countdown until={deadline.soon} />
            </Text>
            <Text variant="small" color="var(--muted)">
              Expired (red): <Countdown until={deadline.past} />
            </Text>
          </div>
        </div>
      </Section>

      <Section title="Sheets and toasts">
        <div className={s.row}>
          <Button kind="secondary" title="Dialog / bottom sheet" onClick={() => setSheet("dialog")} />
          <Button kind="secondary" title="Right drawer (activity)" onClick={() => setSheet("drawer")} />
          <Button kind="secondary" title="Flush (token picker)" onClick={() => setSheet("flush")} />
          <Button
            kind="secondary"
            title="Locked (executing)"
            onClick={() => {
              setLocked(true);
              setSheet("locked");
            }}
          />
          <Button kind="ghost" title="Toast" onClick={() => showToast("Address copied", {tone: "green"})} />
          <Button kind="ghost" title="Warning toast" onClick={() => showToast("Couldn't refresh the quote", {tone: "amber"})} />
        </div>
      </Section>

      <Sheet open={sheet === "dialog"} onClose={close} label="Review swap" width={440} phoneHeight="tall">
        <div className={s.sheetBody}>
          <SheetHeader icon={<TokenIcon token={USDC} size={44} />} title="Review swap" sub="Base → Arbitrum" onClose={close} />
          <TxReviewCard rows={REVIEW} />
          <Text variant="meta" color="var(--dim)" style={{lineHeight: "17px"}}>
            Quotes come straight from each venue. Your wallet signs it in this browser.
          </Text>
          <Button block height={54} title="Confirm swap" onClick={close} />
        </div>
      </Sheet>

      <Sheet open={sheet === "drawer"} onClose={close} label="Activity" width={380} placement="drawer" phoneHeight="half">
        <div className={s.sheetBody}>
          <SheetHeader title="Activity" onClose={close} />
          <SwapSteps steps={STEPS[0] ?? []} activeDetail="Waiting for Base to confirm the swap…" />
        </div>
      </Sheet>

      <Sheet open={sheet === "flush"} onClose={close} label="You pay" width={480} phoneHeight="full" flush initialFocus={search}>
        <div style={{padding: "20px 20px 12px", display: "flex", flexDirection: "column", gap: 12}}>
          <SheetHeader title="You pay" onClose={close} />
          <Field ref={search} placeholder="Search tokens or networks" aria-label="Search tokens or networks" />
        </div>
        <Divider />
        <div className={s.flushBody}>
          <div className={s.rail}>
            {[...NETWORK_LOGOS].map((n) => (
              <ChainLogo key={n} slug={n} />
            ))}
          </div>
          <div className={s.list}>
            {tokenSymbols.map((sym) => (
              <div key={sym} className={s.row} style={{padding: "9px 10px"}}>
                <AssetIcon token={{symbol: sym, caip2: "", contract: null}} size={34} />
                <Text variant="listTitle">{sym}</Text>
              </div>
            ))}
          </div>
        </div>
      </Sheet>

      <Sheet open={sheet === "locked"} onClose={close} label="Swapping" locked={locked} width={440}>
        <div className={s.sheetBody}>
          <SheetHeader title="Swapping" sub={locked ? "Esc, backdrop and drag do nothing while locked" : "Unlocked: close works again"} onClose={locked ? undefined : close} />
          <SwapSteps steps={STEPS[0] ?? []} activeDetail="Confirm the swap in your wallet." />
          <Button block title={locked ? "Finish (unlock)" : "Close"} onClick={() => (locked ? setLocked(false) : close())} />
        </div>
      </Sheet>

      <Toaster />
    </main>
  );
}
