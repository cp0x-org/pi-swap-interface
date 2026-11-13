/**
 * Surfaces: the card panel, the glass capsule and the 1 px divider. The
 * design has no borders — surfaces separate by fill and shadow, and a divider
 * is the only line, inside a surface.
 */
import type {CSSProperties} from "react";
import type {CardProps, GlassProps} from "../contracts/ui";
import {cx} from "./cx";
import s from "./Surface.module.css";

/** surface1 panel with the card "levitation" shadow; padding defaults to 14. */
export function Card({padding = 14, className, style, ...rest}: CardProps) {
  return <div {...rest} className={cx(s.card, className)} style={{padding, ...style}} />;
}

/** Blurred, cyan-tinted capsule (TxDock, the activity button); `dark` stays dark over any backdrop. */
export function Glass({dark, className, ...rest}: GlassProps) {
  return <div {...rest} className={cx(s.glass, dark && s.dark, className)} />;
}

/** Props of the divider line. */
export interface DividerProps {
  vertical?: boolean;
  /** Horizontal inset in px on both ends (a list row's padding). */
  inset?: number;
  className?: string;
  style?: CSSProperties;
}

/** The divider colour as a 1 px rule; decorative (no separator role). */
export function Divider({vertical, inset, className, style}: DividerProps) {
  return (
    <div
      aria-hidden="true"
      className={cx(s.divider, vertical && s.vertical, className)}
      style={inset ? {marginInline: inset, ...style} : style}
    />
  );
}
