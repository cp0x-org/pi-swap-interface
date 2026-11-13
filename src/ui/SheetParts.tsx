/**
 * The building blocks every sheet shares (Cp0xSheetParts.tsx, TxReviewCard.tsx):
 * the header with back/close, stat tiles, key/value facts and the review card.
 * Values that a user checks (amounts, addresses) are selectable.
 */
import type {FactsProps, SheetHeaderProps, TilesProps, TxReviewCardProps} from "../contracts/ui";
import {IconButton} from "./Button";
import {cx} from "./cx";
import {Icon} from "./Icon";
import {Text} from "./Text";
import {Tooltip} from "./Tooltip";
import s from "./SheetParts.module.css";

const TONE = {green: "var(--green)", amber: "var(--amber)", red: "var(--red)"} as const;

/** Header: optional back, 44 px icon, title (18 px, one line) + sub, optional close. */
export function SheetHeader({title, sub, icon, onClose, onBack}: SheetHeaderProps) {
  return (
    <div className={s.header}>
      {onBack ? <IconButton icon="back" aria-label="Back" size={34} iconSize={15} variant="flat" onClick={onBack} data-testid="sheet-back" /> : null}
      {icon ? <span className={s.headerIcon}>{icon}</span> : null}
      <div className={s.headerText}>
        <Text as="h2" variant="title" lines={1} className={s.headerTitle}>
          {title}
        </Text>
        {sub ? (
          <Text variant="meta" color="var(--muted)" lines={1}>
            {sub}
          </Text>
        ) : null}
      </div>
      {onClose ? <IconButton icon="close" aria-label="Close" size={34} iconSize={15} variant="flat" onClick={onClose} data-testid="sheet-close" /> : null}
    </div>
  );
}

/** A row of stat tiles (deposit amount + timer); `action` sits beside the value (copy). */
export function Tiles({tiles}: TilesProps) {
  return (
    <div className={s.tiles}>
      {tiles.map((t) => (
        <div key={t.k} className={s.tile}>
          <Text variant="caps" color="var(--muted)" className={s.tileKey}>
            {t.k}
          </Text>
          <div className={s.tileValueRow}>
            <Text weight={600} tabular lines={1} selectable className={s.tileValue} color={t.tone ? TONE[t.tone] : undefined}>
              {t.v}
            </Text>
            {t.action}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Key/value facts with a divider between rows (deposit details). */
export function Facts({facts}: FactsProps) {
  return (
    <dl className={s.facts}>
      {facts.map((f) => (
        <div key={f.k} className={s.fact}>
          <dt className={s.factKey}>
            <Text variant="small" color="var(--muted)">
              {f.k}
            </Text>
          </dt>
          <dd className={s.factValue}>
            <Text variant="small" selectable>
              {f.v}
            </Text>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Key/value review rows on one card (review, receipt); values selectable so an address can be checked. A row's note
 * sits dim on the value's line, after a gap rather than a separator (a note that wraps under the value never starts
 * with one), and wraps only when the row is too narrow; its tip is a focusable info mark beside the key.
 */
export function TxReviewCard({rows, compact}: TxReviewCardProps) {
  return (
    <dl className={cx(s.review, compact && s.compact)}>
      {rows.map((r) => (
        <div key={r.k} className={s.reviewRow}>
          <dt className={s.reviewKey}>
            <Text variant="small" color="var(--muted)">
              {r.k}
            </Text>
            {r.tip ? (
              <Tooltip content={r.tip}>
                <button type="button" className={s.info} aria-label={`About ${r.k.toLowerCase()}`}>
                  <Icon name="info" size={13} />
                </button>
              </Tooltip>
            ) : null}
          </dt>
          <dd className={s.reviewValue}>
            <span className={s.reviewValueLine}>
              <span className={s.reviewMain}>
                {r.icon}
                <Text variant="small" tabular selectable color={r.color} className={s.right} data-testid={r.testId}>
                  {r.v}
                </Text>
              </span>
              {r.badge ? <span className={s.reviewBadge}>{r.badge}</span> : null}
              {r.note ? (
                <Text variant="meta" tabular selectable color="var(--dim)" className={s.right}>
                  {r.note}
                </Text>
              ) : null}
            </span>
            {r.sub ? (
              <Text variant="meta" tabular selectable color="var(--dim)" className={s.right}>
                {r.sub}
              </Text>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
