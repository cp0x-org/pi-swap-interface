/**
 * The real app (no demo) boots without a wallet. The network is stubbed so the run is deterministic: the two price
 * APIs answer empty maps, anything else is aborted and recorded, and never a cp0x domain is asked (D24).
 * - Previews on (the default, D7): an amount alone asks the venues for preview prices — never LI.FI (its keyless
 *   quota is ~75 /quote per 2 h per IP) — while the CTA still asks for a wallet; with every venue blocked the status
 *   says none could be reached.
 * - Previews off (the operator's kill switch in runtime-config.json): nothing but prices is asked for until a wallet
 *   or address exists.
 */
import {expect, test, type Page} from "@playwright/test";
import {expectNoHorizontalScroll, isCp0xHost, watchPage} from "./helpers";

const PRICE_STUBS: readonly {host: string; body: string}[] = [
  {host: "coins.llama.fi", body: JSON.stringify({coins: {}})},
  {host: "api.coingecko.com", body: "{}"},
];

/** Stub prices (and, when given, runtime-config.json); abort and record every other request off the page's origin. */
async function stubNetwork(page: Page, origin: string, runtimeConfig?: unknown): Promise<string[]> {
  const unexpected: string[] = [];
  if (runtimeConfig !== undefined)
    await page.route(`${origin}/runtime-config.json`, (route) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(runtimeConfig)}));
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const stub = PRICE_STUBS.find((s) => s.host === url.hostname);
      if (stub) return route.fulfill({status: 200, contentType: "application/json", body: stub.body});
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  return unexpected;
}

test("previews off: boots without a wallet and asks for one before quoting", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const unexpected = await stubNetwork(page, origin, {preview: {enabled: false}});

  await page.goto("./#/");
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  await expect(page.getByText("Demo", {exact: true})).toHaveCount(0);
  await expect(page.getByTestId("swap-hint")).toHaveText(/connect a wallet|enter the .+ address/i);
  await expect(page.getByTestId("swap-review")).toHaveText(/connect/i);

  // An amount alone still quotes nothing: the payer needs a wallet first.
  await page.getByTestId("swap-amount").fill("5");
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId("swap-hint")).toHaveText(/connect a wallet|enter the .+ address/i);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  expect(watch.errors, "page errors / console errors").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(unexpected, "requests other than the price APIs before any wallet or address").toEqual([]);
});

test("previews on: an amount without a wallet asks the venues for preview prices, never LI.FI, and still asks for a wallet", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const unexpected = await stubNetwork(page, origin);

  await page.goto("./#/");
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  // Nothing is asked before an amount: the hint asks for one.
  await expect(page.getByTestId("swap-hint")).toHaveText(/enter an amount/i);
  await page.waitForTimeout(1_000);
  expect(unexpected, "requests before an amount").toEqual([]);

  await page.getByTestId("swap-amount").fill("5");
  await expect(page.getByTestId("swap-review")).toHaveText(/^Connect .+ wallet to swap$/);
  await expect.poll(() => unexpected.length, {timeout: 10_000}).toBeGreaterThan(0);
  // Every venue host is blocked here. LI.FI (this build has no cp0x proxy) waits for the live quote and was sent
  // nothing, so it doesn't turn the connection problem into "No route": it isn't a refusal at all.
  await expect(page.getByTestId("swap-routes-status")).toHaveText("Couldn't reach any venue — check your connection and refresh.", {timeout: 15_000});
  await expectNoHorizontalScroll(page);

  // The aborted venue requests log "Failed to load resource" (they were blocked here on purpose); nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(unexpected.filter((u) => new URL(u).hostname === "li.quest"), "LI.FI is asked only for live quotes without cp0x's proxy").toEqual([]);
});
