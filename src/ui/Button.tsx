/**
 * The wallet's buttons (apps/mobile/components/Button.tsx). Loading keeps the
 * title (no jump, no empty button) and puts a spinner where the icon was; a
 * loading button is also disabled, so a double click cannot fire twice. A
 * LinkButton is a real link in a button's exact look (an explorer page).
 */
import type {AnchorHTMLAttributes} from "react";
import type {ButtonKind, ButtonProps, IconButtonProps, IconName} from "../contracts/ui";
import {cx} from "./cx";
import {Icon} from "./Icon";
import {Spinner} from "./Spinner";
import s from "./Button.module.css";

/** Button props plus the mobile `iconPosition` (default right, as on the phone). */
export interface ButtonExtraProps extends ButtonProps {
  iconPosition?: "left" | "right";
}

const FG = {primary: "var(--on-accent)", secondary: "var(--ink)", ghost: "var(--ink2)"} as const;

export function Button({
  title,
  kind = "primary",
  height = 48,
  icon,
  iconPosition = "right",
  loading = false,
  block,
  disabled,
  className,
  type = "button",
  ...rest
}: ButtonExtraProps) {
  const glyph = loading ? <Spinner size={16} color={FG[kind]} /> : icon ? <Icon name={icon} size={16} /> : null;
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(s.button, s[kind], s[`h${height}`], block && s.block, loading && s.loading, className)}
    >
      {(iconPosition === "left" || loading) && glyph}
      <span className={s.label}>{title}</span>
      {iconPosition === "right" && !loading && glyph}
    </button>
  );
}

/** A link with a Button's look; it always opens in a new tab, without the opener or a referrer. */
export interface LinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "target" | "rel"> {
  title: string;
  href: string;
  /** Default "secondary". */
  kind?: ButtonKind;
  /** Default 48. */
  height?: 54 | 48 | 40;
  /** After the title; default "external". */
  icon?: IconName;
  block?: boolean;
}

export function LinkButton({title, kind = "secondary", height = 48, icon = "external", block, className, ...rest}: LinkButtonProps) {
  return (
    <a {...rest} target="_blank" rel="noopener noreferrer" className={cx(s.button, s[kind], s[`h${height}`], block && s.block, s.link, className)}>
      <span className={s.label}>{title}</span>
      <Icon name={icon} size={16} />
    </a>
  );
}

/** IconButton props plus the icon colour/size and the flat look of a sheet's close button. */
export interface IconButtonExtraProps extends IconButtonProps {
  iconColor?: string;
  /** Default 18. */
  iconSize?: number;
  /** "flat" = surface3, no shadow (SheetHeader close/back). Default "raised". */
  variant?: "raised" | "flat";
}

export function IconButton({icon, size = 36, iconSize = 18, iconColor, variant = "raised", className, style, type = "button", ...rest}: IconButtonExtraProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(s.iconButton, variant === "flat" && s.flat, className)}
      style={{width: size, height: size, ...style}}
    >
      <Icon name={icon} size={iconSize} color={iconColor} />
    </button>
  );
}
