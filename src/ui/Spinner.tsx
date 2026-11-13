/**
 * The small activity ring. Decorative by default (the control or status line
 * next to it says what is happening); pass `label` when it stands alone.
 */
import type {SpinnerProps} from "../contracts/ui";
import s from "./Spinner.module.css";

/** Spinner props plus an optional accessible name for a standalone spinner. */
export interface SpinnerExtraProps extends SpinnerProps {
  label?: string;
}

export function Spinner({size = 20, color = "var(--accent)", label}: SpinnerExtraProps) {
  return (
    <span
      className={s.spinner}
      style={{width: size, height: size, color}}
      {...(label ? {role: "status", "aria-label": label} : {"aria-hidden": true})}
    />
  );
}
