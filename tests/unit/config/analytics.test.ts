// Page-view counting on the hosted interface (D31): Vercel's same-origin script, never on a local host or against
// GPC / Do Not Track, and every event's URL cut to origin + path (no query, no # route).
import {describe, expect, it} from "vitest";
import {ANALYTICS_SCRIPT, startAnalytics, type AnalyticsWindow} from "../../../src/config/analytics";

function fakeWindow(hostname: string, nav: AnalyticsWindow["navigator"] = {doNotTrack: null}): AnalyticsWindow & {scripts: HTMLScriptElement[]} {
  const scripts: HTMLScriptElement[] = [];
  return {
    scripts,
    location: {hostname, origin: `https://${hostname}`, pathname: "/"},
    navigator: nav,
    document: {
      createElement: ((tag: string) => document.createElement(tag)) as Document["createElement"],
      head: {appendChild: (n: HTMLScriptElement) => (scripts.push(n), n)} as unknown as HTMLHeadElement,
    },
  };
}

describe("startAnalytics", () => {
  it("adds Vercel's same-origin script once, deferred", () => {
    const w = fakeWindow("swap.cp0x.com");
    expect(startAnalytics(w)).toBe(true);
    expect(w.scripts).toHaveLength(1);
    expect(w.scripts[0]!.getAttribute("src")).toBe(ANALYTICS_SCRIPT);
    expect(w.scripts[0]!.defer).toBe(true);
  });

  it("cuts every event's URL to origin + path: no query, no # route", () => {
    const w = fakeWindow("swap.cp0x.com");
    startAnalytics(w);
    const call = w.vaq!.find((args) => args[0] === "beforeSend")!;
    const beforeSend = call[1] as (e: {type: string; url: string}) => {type: string; url: string};
    expect(beforeSend({type: "pageview", url: "https://swap.cp0x.com/?x=1#/?to=0x7099000000000000000000000000000000079C8"})).toEqual({
      type: "pageview",
      url: "https://swap.cp0x.com/",
    });
  });

  it("does nothing on a local host (dev, e2e)", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "swap.localhost"]) {
      const w = fakeWindow(host);
      expect(startAnalytics(w)).toBe(false);
      expect(w.scripts).toHaveLength(0);
      expect(w.va).toBeUndefined();
    }
  });

  it("does nothing when the browser asks not to be tracked (GPC or Do Not Track)", () => {
    for (const nav of [{doNotTrack: null, globalPrivacyControl: true}, {doNotTrack: "1"}]) {
      const w = fakeWindow("swap.cp0x.com", nav);
      expect(startAnalytics(w)).toBe(false);
      expect(w.scripts).toHaveLength(0);
    }
  });
});
