/**
 * The layout's viewport class (version B, D23): phone < 640 ≤ tablet < 1024 ≤
 * desktop — the same edges the CSS media queries use, read through
 * matchMedia so JS and CSS never disagree about which layout is showing.
 */
import {useSyncExternalStore} from "react";
import type {Breakpoint} from "../contracts/ui";

const TABLET = "(min-width: 640px)";
const DESKTOP = "(min-width: 1024px)";

const hasMatchMedia = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/** The current class; "desktop" where matchMedia does not exist (tests, prerender). */
export function currentBreakpoint(): Breakpoint {
  if (!hasMatchMedia()) return "desktop";
  if (window.matchMedia(DESKTOP).matches) return "desktop";
  return window.matchMedia(TABLET).matches ? "tablet" : "phone";
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const lists = [window.matchMedia(TABLET), window.matchMedia(DESKTOP)];
  for (const l of lists) l.addEventListener("change", onChange);
  return () => {
    for (const l of lists) l.removeEventListener("change", onChange);
  };
}

/** phone < 640 ≤ tablet < 1024 ≤ desktop; re-renders when the viewport crosses an edge. */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, currentBreakpoint, () => "desktop");
}
