/**
 * Paying from a Tron wallet in the real app (D11, D20), with a fake TronLink injected into the page (fakeTron.ts): its
 * TronWeb's `trx.sign` hands the txID to the test process, which signs it with a throwaway key made for this run. Nothing
 * real is contacted: the price APIs, 1Click and the Tron API answer from stubs; every other request is aborted and
 * recorded.
 * - Without a wallet a Tron payer keeps the QR (the refund box, "Get deposit address") and the Tron API is never asked.
 * - Connected from the refund box, the same pair becomes a wallet swap: balances come from the Tron API, the NEAR
 *   Intents route is reviewed and confirmed, TronLink is asked to sign exactly once, and the transaction broadcast is
 *   the reviewed USDT transfer to the deposit address the live quote named — built and broadcast by the page. While
 *   TronLink holds the prompt the sheet stays the review (locked, its steps under it); the status comes after the
 *   broadcast.
 */
import {expect, test, type Page, type Route} from "@playwright/test";
import {AMOUNT, answerTronSwap, DEPOSIT_HEX, injectTronLink, newTronSeen, OWNER_HEX, RECIPIENT, sha, USDC_BASE, USDT_TRON} from "./fakeTron";
import {isCp0xHost, watchPage} from "./helpers";

const json = (route: Route, body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});

/** Stubs: prices, 1Click (quotes, the deposit notice, status) and the Tron API; everything else is aborted and kept. */
async function stubNetwork(page: Page, origin: string) {
  const seen = {unexpected: [] as string[], ...newTronSeen()};
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "coins.llama.fi") return json(route, {coins: {}});
      if (url.hostname === "api.coingecko.com") return json(route, {});
      if (await answerTronSwap(route, seen)) return;
      seen.unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  return seen;
}

test.beforeEach(({browserName: _browser}, info) => {
  test.skip(info.project.name !== "desktop", "one width: the wallet flow is the same at every width");
});

test("a Tron payer: QR without a wallet; with TronLink, the reviewed USDT deposit is signed once and broadcast", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const seen = await stubNetwork(page, origin);
  const {asked, answer} = await injectTronLink(page);

  await page.goto(`./#/?pay=${USDT_TRON}&receive=${USDC_BASE}&amount=25`);
  // No wallet: the QR stays, with an offer to connect TronLink instead.
  await expect(page.getByTestId("swap-refund-box")).toBeVisible();
  await expect(page.getByTestId("swap-review")).toHaveText("Enter the Tron refund address to swap");
  await page.waitForTimeout(1_000);
  expect(seen.tron, "the Tron API before a Tron wallet is connected").toEqual([]);

  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tron:org.tronlink.www").click();
  await expect(page.getByTestId("swap-wallet-pill-tron")).toBeVisible();
  await expect(page.getByTestId("swap-refund-box")).toHaveCount(0);
  await expect.poll(() => seen.tron.filter((p) => p === "/wallet/getaccount").length).toBeGreaterThan(0);

  await page.getByTestId("swap-recipient").fill(RECIPIENT);
  await expect(page.getByTestId("swap-route-near_intents")).toBeVisible({timeout: 20_000});
  await expect(page.getByTestId("swap-review")).toHaveText("Review via NEAR Intents", {timeout: 20_000});
  await page.getByTestId("swap-review").click();
  const confirm = page.getByTestId("swap-confirm");
  await expect(confirm).toBeEnabled({timeout: 20_000});
  await confirm.click();

  // TronLink is asked and hasn't answered: nothing is sent, and the sheet is still the review — never a status.
  await expect.poll(() => asked.length, {timeout: 20_000}).toBe(1);
  const review = page.getByTestId("swap-review-body");
  // Its confirmation is the open step, not green: "You confirmed the transaction" only once TronLink signs.
  await expect(review.getByTestId("swap-step-confirm-active")).toBeVisible();
  await expect(review.getByText("You confirmed the transaction")).toHaveCount(0);
  await expect(confirm).toBeDisabled();
  await expect(page.getByTestId("swap-status-view")).toHaveCount(0);
  expect(seen.broadcasts).toEqual([]);
  answer();

  await expect.poll(() => seen.broadcasts.length, {timeout: 20_000}).toBe(1);
  expect(asked).toHaveLength(1);
  const tx = seen.broadcasts[0]!;
  // transfer(deposit, 25 USDT) on the catalog's USDT contract, from the connected account, signed for this txID.
  expect(tx).toContain(`a9059cbb000000000000000000000000${DEPOSIT_HEX}${AMOUNT.toString(16).padStart(64, "0")}`);
  expect(tx).toContain("41a614f803b6fd780986a42c78ec9c7f77e6ded13c");
  expect(tx).toContain(`41${OWNER_HEX}`);
  const raw = Buffer.from(tx, "hex");
  const rawLen = raw[1]! & 0x80 ? (raw[1]! & 0x7f) | (raw[2]! << 7) : raw[1]!;
  const rawStart = raw[1]! & 0x80 ? 3 : 2;
  expect(sha(raw.subarray(rawStart, rawStart + rawLen)).toString("hex")).toBe(asked[0]);
  expect(seen.liveQuotes).toBeGreaterThan(0);
  await expect(page.getByTestId("swap-status")).toBeVisible({timeout: 10_000});

  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
});
