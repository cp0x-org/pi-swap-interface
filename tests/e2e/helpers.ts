/**
 * Shared e2e plumbing: a page watcher (page errors, console errors, every request URL) and the screenshot path
 * convention `docs/screens/<width>-<state>.png`, so the design review always sees the last green run.
 */
import {expect, type Page, type TestInfo} from "@playwright/test";
import {fileURLToPath} from "node:url";

/** What a test saw on the page; asserted at the end of every test. */
export interface PageWatch {
  errors: string[];
  requests: string[];
}

/** Record page errors, console errors and every request the page makes. Call before the first goto. */
export function watchPage(page: Page): PageWatch {
  const watch: PageWatch = {errors: [], requests: []};
  // Every run is served with the shipped CSP (vite.config.ts preview.headers): a blocked script, eval, wasm or
  // request is an error here, not only on the hosted build.
  void page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on("pageerror", (e) => watch.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") watch.errors.push(`console.error: ${m.text()}`);
  });
  page.on("request", (r) => watch.requests.push(r.url()));
  return watch;
}

/**
 * The fake cp0x API the Standard build is made with (playwright.config.ts, D30). It never resolves: standard.spec.ts
 * answers every request to it. https, so the shipped CSP (connect-src https:) and the SDKs' https checks apply as on
 * the hosted build.
 */
export const E2E_CP0X_API = "https://cp0x-api.e2e.test";

/** Hosts the app must never contact at runtime (D24): any cp0x domain or backend. */
export const isCp0xHost = (url: string): boolean => {
  try {
    return /cp0x/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** The page fits its viewport: no horizontal scroll (version B layouts down to 375 px). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const {scroll, client} = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "page scrolls horizontally").toBeLessThanOrEqual(client);
}

const SCREENS_DIR = fileURLToPath(new URL("../../docs/screens/", import.meta.url));

/** Save `docs/screens/<width>-<state>.png` (animations finished, viewport only). */
export async function shot(page: Page, info: TestInfo, state: string): Promise<void> {
  const width = info.project.use.viewport?.width ?? page.viewportSize()?.width ?? 0;
  await page.screenshot({path: `${SCREENS_DIR}${width}-${state}.png`, animations: "disabled"});
}

/** True for the phone project (< 640 px: bottom sheets, compact route list). */
export const isPhone = (info: TestInfo): boolean => (info.project.use.viewport?.width ?? 1280) < 640;
