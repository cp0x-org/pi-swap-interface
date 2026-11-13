/** Is the tab visible? Polls and 30 s refreshes run only then (mobile lib/appFocus.ts appActive, web version). */
export const appActive = (): boolean => typeof document === "undefined" || document.visibilityState === "visible";
