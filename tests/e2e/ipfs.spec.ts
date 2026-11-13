/**
 * The built app under an IPFS path gateway (`/ipfs/<cid>/`, one origin for every site on the gateway) with the
 * <meta> CSP the IPFS release injects: it boots under that policy, and saved settings another site on the same
 * origin could have planted are NOT applied (D8) — while at the origin's root the same settings apply and the swap
 * screen names the redirected host. Real mode, network stubbed: prices answer empty, everything else is aborted.
 */
import {readFile} from "node:fs/promises";
import {extname} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, test, type Page} from "@playwright/test";
import {contentSecurityPolicy} from "../../bin/headers.mjs";
import {expectNoHorizontalScroll, watchPage} from "./helpers";

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".md": "text/markdown",
  ".map": "application/json",
};
/** What a planted page would write: every venue / price base pointed at its own host. */
const PLANTED = {api: {nearIntents: "https://attacker.example/v0"}, prices: {defillama: "https://attacker.example/llama", coingecko: "https://attacker.example/cg"}};

/** Prices answer empty from the default hosts and from prices.example; anything else off-origin is aborted and recorded. */
async function stubNetwork(page: Page, origin: string): Promise<string[]> {
  const offOrigin: string[] = [];
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      offOrigin.push(url.href);
      if (url.hostname === "coins.llama.fi" || url.hostname === "prices.example") return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({coins: {}})});
      if (url.hostname === "api.coingecko.com") return route.fulfill({status: 200, contentType: "application/json", body: "{}"});
      return route.abort("blockedbyclient");
    },
  );
  return offOrigin;
}

test.beforeEach(({browserName: _browser}, info) => {
  test.skip(info.project.name !== "desktop", "one width is enough for the origin rules");
});

test("boots on a path gateway under the meta CSP and ignores planted saved settings", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const offOrigin = await stubNetwork(page, origin);
  const csp = contentSecurityPolicy({meta: true});
  await page.route(`${origin}/ipfs/${CID}/**`, async (route) => {
    let path = decodeURIComponent(new URL(route.request().url()).pathname.slice(`/ipfs/${CID}/`.length)) || "index.html";
    if (path === "runtime-config.json") return route.fulfill({status: 200, contentType: "application/json", body: "{}"});
    if (path.includes("..")) return route.abort();
    if (path.endsWith("/")) path += "index.html";
    let body: Buffer;
    try {
      body = await readFile(`${DIST}${path}`);
    } catch {
      return route.fulfill({status: 404, body: ""});
    }
    if (path === "index.html")
      body = Buffer.from(body.toString("utf8").replace(/(<meta charset=[^>]*>)/i, `$1\n<meta http-equiv="Content-Security-Policy" content="${csp}" />`));
    return route.fulfill({status: 200, contentType: TYPES[extname(path)] ?? "application/octet-stream", body});
  });
  await page.addInitScript((planted) => localStorage.setItem("cp0x.swap.settings.v1", JSON.stringify(planted)), PLANTED);

  await page.goto(`/ipfs/${CID}/#/`);
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  await expect(page.getByTestId("swap-saved-ignored")).toBeVisible();
  await expect(page.getByTestId("swap-saved-overrides")).toHaveCount(0);
  await page.waitForTimeout(1_000);
  await expectNoHorizontalScroll(page);
  expect(offOrigin.filter((u) => u.includes("attacker.example")), "planted hosts contacted").toEqual([]);
  expect(offOrigin.some((u) => u.startsWith("https://coins.llama.fi/")), "the operator's price API").toBe(true);
  expect(watch.errors, "page errors / console errors / CSP violations").toEqual([]);
});

test("at the origin's root saved settings apply, and the swap screen names the redirected host", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const offOrigin = await stubNetwork(page, origin);
  await page.addInitScript(() => localStorage.setItem("cp0x.swap.settings.v1", JSON.stringify({prices: {defillama: "https://prices.example"}})));
  await page.goto("./#/");
  const notice = page.getByTestId("swap-saved-overrides");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Prices via prices.example");
  await expect.poll(() => offOrigin.some((u) => u.startsWith("https://prices.example/"))).toBe(true);
  expect(watch.errors, "page errors / console errors").toEqual([]);
});
