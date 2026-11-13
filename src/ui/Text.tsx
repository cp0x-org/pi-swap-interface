/**
 * The only text primitive (apps/mobile/components/Text.tsx): the wallet's type
 * scale as classes, so a screen names a variant instead of sizes. Colour is a
 * token variable (default ink); `selectable` keeps addresses and review values
 * copyable while rows and buttons stay unselectable.
 */
import type {TextProps, TextVariant} from "../contracts/ui";
import {cx} from "./cx";
import s from "./Text.module.css";

const VARIANT: Record<TextVariant, string | undefined> = {
  balance: s.balance,
  balanceCents: s.balanceCents,
  hero: s.hero,
  title: s.title,
  amount: s.amount,
  listTitle: s.listTitle,
  body: s.body,
  bodyStrong: s.bodyStrong,
  small: s.small,
  meta: s.meta,
  caps: s.caps,
  tag: s.tag,
};

/** Text in one of the twelve variants; `as` picks the element (span by default). */
export function Text({variant = "body", color, weight, tabular, lines, selectable, as: Tag = "span", className, style, ...rest}: TextProps) {
  return (
    <Tag
      {...rest}
      className={cx(s.text, VARIANT[variant], tabular && s.tabular, lines === 1 && s.lines1, lines === 2 && s.lines2, selectable && s.selectable, className)}
      style={color || weight ? {color, fontWeight: weight, ...style} : style}
    />
  );
}
