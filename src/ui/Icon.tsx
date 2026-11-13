/**
 * The cp0x icon set (apps/mobile/components/Icon.tsx, paths from the design
 * prototype): 24×24 grid, butt caps, round joins, stroke 2.6 — 3.0 at ≤ 12 px
 * so thin sizes stay legible. Decorative: the control around it carries the name.
 */
import type {ReactElement} from "react";
import type {IconName, IconProps} from "../contracts/ui";

const fill = (c: string) => ({fill: c, stroke: "none"});

const ICONS: Record<IconName, (color: string) => ReactElement> = {
  arrowRight: () => <path d="M4 12 H19 M13.5 6.5 L19 12 L13.5 17.5" />,
  back: () => <path d="M15 4.5 L7.5 12 L15 19.5" />,
  chevronDown: () => <path d="M6 9 L12 15 L18 9" />,
  chevronRight: () => <path d="M9 5 L16 12 L9 19" />,
  close: () => <path d="M6 6 L18 18 M18 6 L6 18" />,
  check: () => <path d="M5 12.5 L10 17.5 L19 7" />,
  search: () => (
    <>
      <circle cx="10.5" cy="10.5" r="6.75" />
      <path d="M15.5 15.5 L20.5 20.5" />
    </>
  ),
  scan: () => (
    <>
      <path d="M3.5 9 V7 a3.5 3.5 0 0 1 3.5 -3.5 H9 M15 3.5 H17 a3.5 3.5 0 0 1 3.5 3.5 V9 M20.5 15 V17 a3.5 3.5 0 0 1 -3.5 3.5 H15 M9 20.5 H7 a3.5 3.5 0 0 1 -3.5 -3.5 V15" />
      <rect x="8" y="8" width="8" height="8" rx="2.5" />
    </>
  ),
  scanLine: () => (
    <path d="M3.5 9 V7 a3.5 3.5 0 0 1 3.5 -3.5 H9 M15 3.5 H17 a3.5 3.5 0 0 1 3.5 3.5 V9 M20.5 15 V17 a3.5 3.5 0 0 1 -3.5 3.5 H15 M9 20.5 H7 a3.5 3.5 0 0 1 -3.5 -3.5 V15 M3.5 12 H20.5" />
  ),
  gear: () => (
    <>
      <path d="M18.85 9.79 L21.41 10.09 L21.41 13.91 L18.85 14.21 L18.41 15.28 L20.00 17.30 L17.30 20.00 L15.28 18.41 L14.21 18.85 L13.91 21.41 L10.09 21.41 L9.79 18.85 L8.72 18.41 L6.70 20.00 L4.00 17.30 L5.59 15.28 L5.15 14.21 L2.59 13.91 L2.59 10.09 L5.15 9.79 L5.59 8.72 L4.00 6.70 L6.70 4.00 L8.72 5.59 L9.79 5.15 L10.09 2.59 L13.91 2.59 L14.21 5.15 L15.28 5.59 L17.30 4.00 L20.00 6.70 L18.41 8.72 Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  send: () => <path d="M12 20 V5 M6 11 L12 5 L18 11" />,
  receive: () => <path d="M12 4 V19 M6 13 L12 19 L18 13" />,
  swap: () => <path d="M4 8 H18.5 M14.5 4 L18.5 8 L14.5 12 M20 16 H5.5 M9.5 12 L5.5 16 L9.5 20" />,
  flip: () => <path d="M8 4 V19.5 M4.5 16 L8 19.5 L11.5 16 M16 20 V4.5 M12.5 8 L16 4.5 L19.5 8" />,
  plus: () => <path d="M12 4.5 V19.5 M4.5 12 H19.5" />,
  external: () => <path d="M7 17 L17 7 M9 7 H17 V15" />,
  refresh: () => <path d="M19 12 A7 7 0 1 1 16.95 7.05 M17.5 3.5 V7.5 H13.5" />,
  copy: () => (
    <>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="3.5" />
      <path d="M15.5 4.5 H8 a3.5 3.5 0 0 0 -3.5 3.5 V15.5" />
    </>
  ),
  share: () => <path d="M12 15 V4 M7.5 8.5 L12 4 L16.5 8.5 M4.5 14 V16.5 a3.5 3.5 0 0 0 3.5 3.5 H16 a3.5 3.5 0 0 0 3.5 -3.5 V14" />,
  import: () => <path d="M12 3.5 V14 M7.5 9.5 L12 14 L16.5 9.5 M4.5 20 H19.5" />,
  lock: () => (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="3.5" />
      <path d="M8 10.5 V8 a4 4 0 0 1 8 0 V10.5" />
    </>
  ),
  cloud: () => <path d="M7 18.5 H17 a4 4 0 0 0 0.6 -7.95 A5.5 5.5 0 0 0 6.9 9.6 A4.5 4.5 0 0 0 7 18.5 Z" />,
  eye: () => (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M2.5 12 C5 7.5 8 5.5 12 5.5 C16 5.5 19 7.5 21.5 12 C19 16.5 16 18.5 12 18.5 C8 18.5 5 16.5 2.5 12 Z" />
    </>
  ),
  wallet: (c) => (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="4" />
      <path d="M3 10 H21" />
      <circle cx="16.5" cy="14.5" r="1.4" {...fill(c)} />
    </>
  ),
  deals: () => (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="5.5" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  hubs: (c) => (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2.5" {...fill(c)} />
    </>
  ),
  explore: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12 H20.5 M12 3.5 C9 7 9 17 12 20.5 C15 17 15 7 12 3.5 Z" />
    </>
  ),
  profile: () => (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5 a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  activity: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5 V12 L15 14" />
    </>
  ),
  info: () => (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11 V16.5 M12 7.75 V7.8" />
    </>
  ),
  // web: disconnect (the header's wallet rows)
  power: () => <path d="M12 3.5 V12 M7.4 7.1 A7.5 7.5 0 1 0 16.6 7.1" />,
  allChains: (c) => (
    <>
      <circle cx="7.5" cy="7.5" r="2.5" {...fill(c)} />
      <circle cx="16.5" cy="7.5" r="2.5" {...fill(c)} />
      <circle cx="7.5" cy="16.5" r="2.5" {...fill(c)} />
      <circle cx="16.5" cy="16.5" r="2.5" {...fill(c)} />
    </>
  ),
};

/** Every icon name, for the gallery and tests. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** One stroke icon; `color` defaults to the surrounding text colour. */
export function Icon({name, size = 24, color = "currentColor", className}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={size <= 12 ? 3 : 2.6}
      strokeLinecap="butt"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name](color)}
    </svg>
  );
}
