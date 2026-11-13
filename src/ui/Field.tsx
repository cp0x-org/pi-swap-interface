/**
 * Inputs: the labelled field (also the bare text input — omit the label), the
 * address input frame with its validity border, and the big amount input /
 * display of the pay and receive cards. Values stay in the caller: these only
 * draw, label and describe them.
 */
import {useId, type InputHTMLAttributes, type ReactNode, type Ref} from "react";
import type {FieldProps} from "../contracts/ui";
import {cx} from "./cx";
import {Text} from "./Text";
import s from "./Field.module.css";

/** Field props plus a leading slot, a hint line and the address frame. */
export interface FieldExtraProps extends FieldProps {
  /** Drawn before the input (a search icon). */
  leading?: ReactNode;
  /** A line under the field when there is no error (meta, dim unless `hintColor`). */
  hint?: ReactNode;
  hintColor?: string;
  /** "address": the 52 px recipient/refund frame at 14 px. Default "field". */
  frame?: "field" | "address";
  /** The <input> (React 19 passes refs as props): focus the token search on open. */
  ref?: Ref<HTMLInputElement>;
}

const TONE = {neutral: undefined, valid: s.valid, invalid: s.invalid} as const;

export function Field({label, error, trailing, leading, hint, hintColor, tone = "neutral", frame = "field", id, className, ...input}: FieldExtraProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const noteId = `${inputId}-note`;
  const note = error ? (
    <Text as="p" id={noteId} variant="meta" color="var(--red)" selectable>
      {error}
    </Text>
  ) : hint ? (
    <Text as="p" id={noteId} variant="meta" color={hintColor ?? "var(--dim)"}>
      {hint}
    </Text>
  ) : null;
  return (
    <div className={s.field}>
      {label ? (
        <label htmlFor={inputId}>
          <Text variant="caps" color="var(--dim)">
            {label}
          </Text>
        </label>
      ) : null}
      <div className={cx(s.frame, frame === "address" && s.address, trailing != null && s.withTrailing, TONE[error ? "invalid" : tone])}>
        {leading != null ? <span className={s.leading}>{leading}</span> : null}
        <input
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          {...input}
          id={inputId}
          className={cx(s.input, className)}
          aria-invalid={error || tone === "invalid" ? true : undefined}
          aria-describedby={note ? noteId : input["aria-describedby"]}
        />
        {trailing != null ? <span className={s.trailing}>{trailing}</span> : null}
      </div>
      {note}
    </div>
  );
}

/** Props of the pay-side amount input; `invalid` paints it red (insufficient balance). */
export interface AmountInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode"> {
  invalid?: boolean;
  "aria-label": string;
  ref?: Ref<HTMLInputElement>;
}

/**
 * The big pay amount: decimal keypad on phones, no autocomplete/spellcheck; sanitizing is the caller's. It shrinks with
 * its length like the receive amount (web: a long MAX or a pasted amount was cut off at 25 px).
 */
export function AmountInput({invalid, className, placeholder = "0", style, ...rest}: AmountInputProps) {
  const f = amountFontSize(String(rest.value ?? ""));
  return (
    <input
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      {...rest}
      type="text"
      inputMode="decimal"
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      className={cx(s.amount, invalid && s.amountInvalid, className)}
      style={{...style, ...amountFontStyle(f)}}
    />
  );
}

/**
 * Font size and tracking of the pay and receive amounts by length: ≤ 10 chars 25 px,
 * ≤ 14 → 21 px, else 18 px; tracking −0.8 → −0.6 (ui-port.md §5.3).
 */
export function amountFontSize(text: string): {size: number; tracking: number} {
  const n = text.length;
  if (n <= 10) return {size: 25, tracking: -0.8};
  if (n <= 14) return {size: 21, tracking: -0.7};
  return {size: 18, tracking: -0.6};
}

/** The size as a style, capped by the viewport below 375 px: at 320 the card is ~120 px wide and a 10-character amount at 25 px no longer fits. */
const amountFontStyle = (f: {size: number; tracking: number}) => ({fontSize: `min(${f.size}px, ${(f.size / 3.75).toFixed(2)}vw)`, letterSpacing: f.tracking});

/** Props of the read-only amount (receive card). */
export interface AmountTextProps {
  /** The formatted amount, or null → a faint "0". */
  value: string | null;
  className?: string;
  "data-testid"?: string;
}

/** The receive amount: one line, shrinking with its length instead of wrapping. */
export function AmountText({value, className, ...rest}: AmountTextProps) {
  const text = value ?? "0";
  const f = amountFontSize(text);
  return (
    <span {...rest} className={cx(s.amountText, value === null && s.amountEmpty, className)} style={amountFontStyle(f)}>
      {text}
    </span>
  );
}
