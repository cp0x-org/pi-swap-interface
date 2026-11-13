/**
 * NEAR wallets in the real app (D11): a fake extension injected into the page answers NEAR Connect's
 * `near-selector-ready` with a `near-wallet-injected` wallet. Connecting it turns NEAR from a deposit-address payer
 * (refund box, QR) into a wallet payer; a reload reconnects it silently with `getAccounts`; disconnecting brings the
 * QR back. The fake never sends anything and records every call; the network is stubbed like real.spec.ts, and the
 * only requests a NEAR connection may add are its balance reads to the NEAR RPC.
 */
import {expect, test, type Page} from "@playwright/test";
import {expectNoHorizontalScroll, isCp0xHost, watchPage} from "./helpers";

const PRICE_STUBS: readonly {host: string; body: string}[] = [
  {host: "coins.llama.fi", body: JSON.stringify({coins: {}})},
  {host: "api.coingecko.com", body: "{}"},
];
const NEAR_RPC = "rpc.mainnet.fastnear.com";

/** Stub prices, abort and record every other request off the page's origin. */
async function stubNetwork(page: Page, origin: string): Promise<string[]> {
  const unexpected: string[] = [];
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

/** The fake extension: remembers a sign-in in localStorage (as a wallet remembers a site) and never sends. */
async function injectFakeNearWallet(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {__near: {signIns: number; getAccounts: number; sends: number; signOuts: number}};
    w.__near = {signIns: 0, getAccounts: 0, sends: 0, signOuts: 0};
    const KEY = "e2e.fakeNearWallet";
    const accounts = () => (localStorage.getItem(KEY) ? [{accountId: "alice.near"}] : []);
    const wallet = {
      manifest: {id: "e2e-near", name: "E2E NEAR", icon: "data:image/svg+xml;base64,PHN2Zy8+", features: {signAndSendTransaction: true, signInWithoutAddKey: true}},
      async signIn() {
        w.__near.signIns++;
        localStorage.setItem(KEY, "1");
        return accounts();
      },
      async signOut() {
        w.__near.signOuts++;
        localStorage.removeItem(KEY);
      },
      async getAccounts() {
        w.__near.getAccounts++;
        return accounts();
      },
      async signAndSendTransaction() {
        w.__near.sends++;
        throw new Error("the e2e wallet never sends");
      },
    };
    window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", {detail: wallet})));
  });
}

const counts = (page: Page) => page.evaluate(() => (window as unknown as {__near: Record<string, number>}).__near);

test("a NEAR extension wallet pays NEAR instead of the deposit address, reconnects silently, and gives the QR back", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const unexpected = await stubNetwork(page, origin);
  await injectFakeNearWallet(page);

  await page.goto("./#/?pay=near:native&receive=base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  await expect(page.getByTestId("swap-amount")).toBeVisible();
  // No NEAR wallet yet: NEAR pays from a deposit address, so the refund box asks for a NEAR address.
  await expect(page.getByTestId("swap-refund-box")).toBeVisible();
  expect(unexpected, "requests before a NEAR wallet is connected").toEqual([]);

  await page.getByTestId("swap-connect-open").click();
  await expect(page.getByTestId("swap-connect")).toBeVisible();
  await page.getByTestId("swap-connect-near:e2e-near").click();
  await expect(page.getByTestId("swap-wallet-near")).toContainText("E2E NEAR");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("swap-connect")).toBeHidden();
  await expect(page.getByTestId("swap-wallet-pill-near")).toBeVisible();
  // NEAR now pays from the wallet: no refund box.
  await expect(page.getByTestId("swap-refund-box")).toHaveCount(0);
  expect(await counts(page)).toMatchObject({signIns: 1, sends: 0});
  await expectNoHorizontalScroll(page);

  // A reload reconnects without a sign-in prompt.
  await page.reload();
  await expect(page.getByTestId("swap-wallet-pill-near")).toBeVisible();
  await expect(page.getByTestId("swap-refund-box")).toHaveCount(0);
  expect(await counts(page)).toMatchObject({signIns: 0, sends: 0});
  expect((await counts(page)).getAccounts).toBeGreaterThan(0);

  // Disconnecting from the header's dropdown signs out of the wallet and brings the deposit address back; it was the
  // only wallet, so the dropdown closes and the header offers "Connect wallet" again.
  await page.getByTestId("swap-wallet-pill").click();
  await expect(page.getByTestId("swap-wallet-row-near")).toContainText("E2E NEAR");
  await page.getByTestId("swap-wallet-disconnect-near").click();
  await expect(page.getByTestId("swap-wallets-menu")).toBeHidden();
  await expect(page.getByTestId("swap-connect-open")).toHaveText("Connect wallet");
  await expect(page.getByTestId("swap-refund-box")).toBeVisible();
  expect(await counts(page)).toMatchObject({signOuts: 1, sends: 0});

  // The aborted balance reads log "Failed to load resource" (blocked here on purpose); nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(unexpected.filter((u) => new URL(u).hostname !== NEAR_RPC), "requests other than prices and NEAR balance reads").toEqual([]);
});
