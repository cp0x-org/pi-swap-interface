/**
 * Design tokens from the cp0x Wallet handoff (README "Design tokens").
 * Dark theme only. No borders: surfaces are separated by fill + shadow.
 *
 * Copied from apps/mobile/theme/tokens.ts (756b115) for code that needs a value
 * in JS (the gallery, tests); styles use the same values as CSS variables
 * (tokens.css), and tests/unit/ui/tokens.test.ts keeps the two equal.
 */

/** The web sheet fill: the mobile Android value (iOS's `transparent` exists only for Liquid Glass). */
export const sheetBackground = "#16161f";

export const colors = {
  bg: "#16161f",
  bgOuter: "#0c0c11",
  surface1: "#1c1c27",
  surface2: "#1d1d28",
  surface3: "#22222d",
  surface3Alt: "#24242f",
  menu: "#20202b",
  menuHover: "#2a2a37",
  divider: "#26262f",

  ink: "#e8e8ef",
  ink2: "#c9c9d6",
  muted: "#8a8a9c",
  // web: mobile's #63636f is 2.85:1 on surface1, and here it carries text people decide by (route meta, USD values,
  // review subs). #878797 is 4.77:1 on surface1 and 5.08:1 on bg (WCAG AA 4.5:1).
  dim: "#878797",
  faint: "#4c4c5e",

  accent: "#00D4FF",
  accentPressed: "#4ce2ff",
  accentBg: "#0d2a34",
  accentBorder: "#124554",
  /** Text on an accent fill. */
  onAccent: "#06131a",
  glassTint: "#2dfffe",

  green: "#3ddc97",
  greenBg: "#182a22",
  red: "#ff5c6f",
  amber: "#e0a83c",
  backdrop: "rgba(0,0,0,.55)",
} as const;

export const radius = {
  tag: 6,
  chip: 10,
  control: 14,
  card: 20,
  sheet: 34,
  pill: 999,
} as const;

export const space = {
  page: 20,
  list: 12,
  row: 8,
  /** Scroll padding under the floating tab bar. */
  tabBarInset: 96,
} as const;

/** "Levitation" shadows — RN 0.76+ boxShadow takes the CSS syntax incl. inset. */
export const shadow = {
  card: "0 18px 36px -16px rgba(0,0,0,.75), 0 4px 10px -4px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.045)",
  button: "0 10px 22px -10px rgba(0,0,0,.7), 0 2px 6px -2px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.05)",
  /** Same levitation for the accent fill: deeper drop, glassy top rim, a touch of weight at the bottom edge. */
  buttonAccent:
    "0 14px 26px -12px rgba(0,0,0,.85), 0 3px 8px -3px rgba(0,0,0,.45), inset 0 1.5px 0 rgba(255,255,255,.55), inset 0 -2px 0 rgba(0,40,52,.18)",
  sheet: "0 30px 60px -20px rgba(0,0,0,.85), 0 8px 20px -8px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06)",
  menu: "0 18px 40px rgba(0,0,0,.55)",
} as const;

/** Mobile ships one family per weight; the web has one family "Cp0xGrotesk" with these four weights (fonts.css). */
export const fontWeights = [400, 500, 600, 700] as const;

export type FontWeight = (typeof fontWeights)[number];

/** Type scale (pt = CSS px) from the handoff. */
export const type = {
  balance: {size: 37, weight: 600, tracking: -1.4},
  balanceCents: {size: 22, weight: 500, tracking: -0.6},
  hero: {size: 40, weight: 600, tracking: -1.8, lineHeight: 41},
  title: {size: 20, weight: 600, tracking: -0.5},
  amount: {size: 30, weight: 600, tracking: -1},
  listTitle: {size: 14, weight: 600, tracking: 0},
  body: {size: 14, weight: 400, tracking: 0},
  bodyStrong: {size: 14, weight: 500, tracking: 0},
  small: {size: 13, weight: 400, tracking: 0},
  meta: {size: 12, weight: 400, tracking: 0},
  caps: {size: 11, weight: 600, tracking: 0.8, upper: true},
  tag: {size: 10, weight: 600, tracking: 0.4, upper: true},
} as const satisfies Record<string, {size: number; weight: FontWeight; tracking: number; lineHeight?: number; upper?: boolean}>;

export type TypeVariant = keyof typeof type;
