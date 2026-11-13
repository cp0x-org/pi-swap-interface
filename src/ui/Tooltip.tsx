/**
 * A tooltip: shows on hover (pointer devices, after 0.2 s) and while focus is
 * inside what it wraps, and is wired as the description of what it wraps, so a
 * screen reader hears it without hovering. The visible tip is drawn on <body>
 * at a fixed place read from the trigger, so no clipping container (the route
 * panel, a scrolling list, the phone route sheet) cuts it and it sits above
 * every sheet: centred on the trigger, on `side` unless only the other side has
 * room, kept 8 px inside the viewport (placeTooltip). A scroll or resize drops
 * a hover tip (the pointer is elsewhere now) and moves a focus one with its
 * trigger. The description is a hidden copy in place, there while no tip
 * shows; the drawn tip is aria-hidden. Touch has no hover: put what matters in
 * the row too.
 */
import {useId, useLayoutEffect, useRef, useState, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {cx} from "./cx";
import s from "./Tooltip.module.css";

/** Props of the tooltip wrapper. */
export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** Where the tip goes when it has room there (else the other side). Default "top". */
  side?: "top" | "bottom";
  className?: string;
}

/** A box in viewport px (a DOMRect is one). */
export interface TipAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The tip's top-left corner in viewport px, and the side of the trigger it ended up on. */
export interface TipPlacement {
  left: number;
  top: number;
  side: "top" | "bottom";
}

/** Between the trigger and the tip, and the least the tip keeps from the viewport's edges (px). */
const GAP = 8;
const MARGIN = 8;

/**
 * Where a `tip`-sized tooltip goes for a trigger at `anchor` in a `viewport` (all px): centred on the trigger, slid
 * back inside the viewport's margin (to the left margin when it is wider than the room); on `side` when it fits there,
 * else on the other side when that fits, else on the roomier one. Pure, so the tests need no layout.
 */
export function placeTooltip(
  anchor: TipAnchor,
  tip: {width: number; height: number},
  viewport: {width: number; height: number},
  side: "top" | "bottom" = "top",
): TipPlacement {
  const room = {top: anchor.top - GAP - MARGIN, bottom: viewport.height - anchor.bottom - GAP - MARGIN};
  const other = side === "top" ? "bottom" : "top";
  const fits = (at: "top" | "bottom") => room[at] >= tip.height;
  const at = fits(side) || (!fits(other) && room[side] >= room[other]) ? side : other;
  const centred = (anchor.left + anchor.right) / 2 - tip.width / 2;
  const left = Math.max(MARGIN, Math.min(centred, viewport.width - MARGIN - tip.width));
  return {left: Math.round(left), top: Math.round(at === "top" ? anchor.top - GAP - tip.height : anchor.bottom + GAP), side: at};
}

/** Hover tips only where the primary pointer hovers (a tap would leave one stuck); everywhere when matchMedia is missing. */
const canHover = () => typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover)").matches;

export function Tooltip({content, children, side = "top", className}: TooltipProps) {
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const open = hover || focus;

  // The tip mounts at 0,0 (so it measures at its own width) and moves to its place before the first paint.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = tip.current;
      const w = wrap.current;
      if (!t || !w) return;
      const root = document.documentElement;
      const p = placeTooltip(w.getBoundingClientRect(), {width: t.offsetWidth, height: t.offsetHeight}, {width: root.clientWidth, height: root.clientHeight}, side);
      t.style.left = `${p.left}px`;
      t.style.top = `${p.top}px`;
      t.dataset.side = p.side;
    };
    place();
    const onMove = () => {
      setHover(false);
      place();
    };
    // Capture: a scroll of any container (the route list, a sheet) moves the trigger too.
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, side, content]);

  return (
    <span
      ref={wrap}
      className={cx(s.wrap, className)}
      aria-describedby={id}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch" && canHover()) setHover(true);
      }}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node && wrap.current?.contains(e.relatedTarget))) setFocus(false);
      }}
    >
      {children}
      <span role="tooltip" id={id} hidden>
        {content}
      </span>
      {open
        ? createPortal(
            <span ref={tip} className={cx(s.tip, hover && !focus && s.delayed)} aria-hidden="true">
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
