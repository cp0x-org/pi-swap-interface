/**
 * TON in the real app (D11, D20): a fake Tonkeeper whose in-app browser runs the page (TON Connect's JS bridge,
 * `isWalletBrowser`) — it records every request and returns a signed-looking message, so nothing is ever broadcast.
 * The network is stubbed: prices, 1Click (NEAR Intents) and TonAPI answer; anything else is aborted and recorded.
 * - Before a TON wallet: TON pays by QR (the refund box), which also offers the wallet; nothing TON is contacted.
 * - The wallet the page runs in connects from our menu through its JS bridge, without TON Connect's modal: the swap's
 *   one TON Connect request is exactly the reviewed deposit — the 1Click deposit address, the reviewed amount,
 *   mainnet, from the connected account — and neither TON's remote wallets list, its analytics nor any bridge is
 *   contacted.
 * - "TON Connect" closes our menu and opens TON Connect UI's own modal (owner, 2026-11-13) over the self-hosted
 *   official list: every icon from this origin, nothing from TON's or GitHub's hosts, no CSP violation, nothing left
 *   in sessionStorage. The bridges of the list are contacted only after that pick (the accepted cost of its universal
 *   QR), and no more once the viewer closes it; TON stays disconnected and the menu usable.
 * - A "TON Connect" that can't start — our list unreadable (the SDK would fall back to its own: remote icons, other
 *   bridges), then TON Connect UI's chunk unreachable — opens no modal and reopens our menu with the reason.
 * - A TON contract call (D35): USDT on TON → USDC on Base through Symbiosis, its API answering with the SDK's recorded
 *   quote (tests/unit/execute/symbiosisTon.fixture.json, for the address it was built for). The one TON Connect request
 *   is the payer's USDT jetton wallet, the TON the venue attached, and the venue's exact BoC; an answer tampered after
 *   the review (the same jetton wallet, non-bounceable: the venue's own check reads only the raw address) is refused
 *   before the wallet is asked.
 */
import {readFileSync} from "node:fs";
import {Address, beginCell, storeMessage} from "@ton/core";
import {expect, test, type Page} from "@playwright/test";
import {isCp0xHost, isPhone, watchPage} from "./helpers";

const RAW = "0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3";
const FRIENDLY = Address.parseRaw(RAW).toString({urlSafe: true, bounceable: false});
const DEPOSIT = Address.parseRaw(`0:${"ab".repeat(32)}`).toString({urlSafe: true, bounceable: false});
const RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const USDC_BASE = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** What the fake wallet answers to sendTransaction: an external message to the connected wallet (never sent). */
const signedBy = (raw: string) =>
  beginCell()
    .store(storeMessage({info: {type: "external-in", dest: Address.parseRaw(raw), importFee: 0n}, init: null, body: beginCell().storeUint(1, 32).endCell()}))
    .endCell()
    .toBoc()
    .toString("base64");

/** Hosts this run answers; everything else off the page's origin is aborted and recorded. */
async function stubNetwork(page: Page, origin: string) {
  const unexpected: string[] = [];
  const tonapi: string[] = [];
  const quotes: {dry: boolean; refundTo: string; recipient: string}[] = [];
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});
      if (url.hostname === "coins.llama.fi") return json({coins: {}});
      if (url.hostname === "api.coingecko.com") return json({});
      if (url.hostname === "1click.chaindefuser.com") {
        if (url.pathname.endsWith("/quote")) {
          const body = JSON.parse(route.request().postData() ?? "{}") as {dry: boolean; amount: string; refundTo: string; recipient: string};
          quotes.push({dry: body.dry, refundTo: body.refundTo, recipient: body.recipient});
          return json({
            quote: {
              ...(body.dry ? {} : {depositAddress: DEPOSIT}),
              amountIn: body.amount,
              amountOut: "15000000",
              minAmountOut: "15000000",
              amountInUsd: "15",
              amountOutUsd: "15",
              deadline: new Date(Date.now() + 3_600_000).toISOString(),
              timeEstimate: 60,
            },
          });
        }
        if (url.pathname.endsWith("/status")) return json({status: "PENDING_DEPOSIT"});
        return json({});
      }
      if (url.hostname === "tonapi.io") {
        tonapi.push(url.pathname);
        if (url.pathname.endsWith("/jettons")) return json({balances: []});
        return route.fulfill({status: 200, contentType: "application/json", body: `{"address":"${RAW}","balance":10000000000,"status":"active"}`});
      }
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  return {unexpected, tonapi, quotes};
}

/** Hosts TON Connect could reach but must not: its remote list and analytics, GitHub's assets, the 3D diamond's host. */
const TON_HOSTS = ["config.ton.org", "analytics.ton.org", "raw.githubusercontent.com", "s.ton-connect.io"];
/** The SSE bridges of the self-hosted official list (the modal's universal QR listens on all of them). */
const BRIDGE_HOSTS = new Set(
  (JSON.parse(readFileSync("public/tonconnect-wallets.json", "utf8")) as {bridge: {type: string; url?: string}[]}[]).flatMap((w) =>
    w.bridge.flatMap((b) => (b.type === "sse" && b.url ? [new URL(b.url).hostname] : [])),
  ),
);
const toBridge = (url: string) => BRIDGE_HOSTS.has(new URL(url).hostname);

/** Tonkeeper's in-app browser stand-in: TON Connect's JS bridge (window.tonkeeper.tonconnect) with isWalletBrowser. */
async function injectFakeTonkeeper(page: Page, raw = RAW) {
  await page.addInitScript(
    ({raw, signed}) => {
      const device = {platform: "iphone", appName: "Tonkeeper", appVersion: "4.0.0", maxProtocolVersion: 2, features: ["SendTransaction", {name: "SendTransaction", maxMessages: 4}]};
      const w = window as unknown as {__tonSent: unknown[]; tonkeeper: unknown};
      w.__tonSent = [];
      w.tonkeeper = {
        tonconnect: {
          deviceInfo: device,
          walletInfo: {name: "Tonkeeper", app_name: "tonkeeper", image: "", about_url: "", tondns: "", platforms: ["ios", "android"]},
          protocolVersion: 2,
          isWalletBrowser: true,
          connect: async () => ({event: "connect", id: 1, payload: {items: [{name: "ton_addr", address: raw, network: "-239", publicKey: "00".repeat(32), walletStateInit: ""}], device}}),
          restoreConnection: async () => ({event: "connect_error", id: 1, payload: {code: 0, message: "no session"}}),
          send: async (message: {id: string}) => {
            w.__tonSent.push(message);
            return {result: signed, id: message.id};
          },
          listen: () => () => undefined,
        },
      };
    },
    {raw, signed: signedBy(raw)},
  );
}

test("TON: pays by QR until the wallet the page runs in connects, without the modal; then signs exactly the reviewed deposit, contacting nothing TON-side but TonAPI", async ({page, baseURL}) => {
  test.setTimeout(60_000);
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin);
  await injectFakeTonkeeper(page);

  await page.goto(`./#/?pay=ton:native&receive=${USDC_BASE}&amount=5`);
  // No TON wallet yet: the QR payment with its refund address, and the wallet offered beside it.
  await expect(page.getByTestId("swap-refund-box")).toBeVisible();
  await expect(page.getByTestId("swap-review")).toHaveText(/refund address/i);
  expect(net.tonapi, "TonAPI before a TON wallet").toEqual([]);

  await page.getByTestId("swap-refund-connect").click();
  await expect(page.getByTestId("swap-connect-tonconnect:tonkeeper")).toContainText("Installed");
  await expect(page.getByTestId("swap-connect-tonconnect")).toBeVisible();
  await page.getByTestId("swap-connect-tonconnect:tonkeeper").click();
  await expect(page.getByTestId("swap-wallet-pill-ton")).toBeVisible();
  await expect(page.getByTestId("swap-refund-box")).toHaveCount(0);
  // Straight through the bridge: TON Connect UI was never built.
  await expect(page.locator("#tc-widget-root")).toHaveCount(0);

  // A TON wallet pays now; the payout goes to a typed Base address (no EVM wallet here).
  await page.getByTestId("swap-recipient").fill(RECIPIENT);
  await expect(page.getByTestId("swap-review")).toHaveText("Review via NEAR Intents", {timeout: 20_000});
  await page.getByTestId("swap-review").click();
  await expect(page.getByTestId("swap-confirm")).toBeEnabled({timeout: 20_000});
  await page.getByTestId("swap-confirm").click();

  await expect.poll(() => page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent.length), {timeout: 20_000}).toBe(1);
  const [sent] = (await page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent)) as {method: string; params: string[]}[];
  expect(sent!.method).toBe("sendTransaction");
  const tx = JSON.parse(sent!.params[0]!) as {valid_until: number; network: string; from: string; messages: {address: string; amount: string; payload?: string}[]};
  expect(tx).toMatchObject({network: "-239", from: RAW});
  expect(tx.messages).toHaveLength(1);
  expect(tx.messages[0]).toMatchObject({address: DEPOSIT, amount: "5000000000"});
  expect(tx.messages[0]!.payload).toBeUndefined();
  expect(tx.valid_until - Date.now() / 1000).toBeLessThanOrEqual(300);
  // The live quote was asked with the connected wallet as the refund address and the typed recipient.
  expect(net.quotes.filter((q) => !q.dry).at(-1)).toEqual({dry: false, refundTo: FRIENDLY, recipient: RECIPIENT});

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(toBridge), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  // Venues that don't serve TON are blocked here on purpose and log "Failed to load resource"; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: TON Connect closes our menu and opens the official modal, icons from this origin; its bridges only after the pick, until it closes", async ({page, baseURL}, info) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  const net = await stubNetwork(page, origin);

  await page.goto(`./#/?pay=ton:native&receive=${USDC_BASE}&amount=5`);
  await page.getByTestId("swap-refund-connect").click();
  await expect(page.getByTestId("swap-connect-tonconnect")).toContainText("Tonkeeper, MyTonWallet and other TON wallets");
  await page.waitForTimeout(500);
  expect(watch.requests.filter(toBridge), "a TON bridge before the pick").toEqual([]);
  expect(watch.requests.filter((u) => u.includes("tonconnect-wallets.json")), "the wallets list before the pick").toEqual([]);

  await page.getByTestId("swap-connect-tonconnect").click();
  // Our menu is gone first (a modal dialog: it would trap focus and block the pointer), then the official modal opens.
  await expect(page.getByTestId("swap-connect")).toHaveCount(0);
  const modal = page.locator("[data-tc-wallets-modal-container]");
  await expect(modal).toBeVisible({timeout: 10_000});
  await expect(modal.locator("[data-tc-wallet-item]").first()).toBeVisible();
  expect(await modal.locator("[data-tc-wallet-item]").count()).toBeGreaterThanOrEqual(3);
  // Its icons are the bundled copies (rendered once loaded): every image on the page from this origin.
  await expect(modal.locator("img[src*='logos/ton-wallets/']").first()).toBeVisible();
  const srcs = await page.locator("#tc-widget-root img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(srcs.length).toBeGreaterThan(0);
  expect(srcs.filter((u) => !u.startsWith(`${origin}/`)), "an icon from another origin").toEqual([]);
  expect(watch.requests.filter((u) => u.includes("tonconnect-wallets.json")).every((u) => u.startsWith(`${origin}/`))).toBe(true);
  // Loading it copied the page's hash query into sessionStorage as Telegram launch params; that is gone.
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ton-connect")))).toEqual([]);
  // The wide modal shows its universal QR at once, which listens on every bridge in the list (the phone's on a tap).
  if (!isPhone(info)) await expect.poll(() => net.unexpected.filter(toBridge).length, {timeout: 10_000}).toBeGreaterThan(0);

  // The viewer closes it: TON stays disconnected, the bridges it listened on stop being contacted, the menu works.
  await page.locator("#tc-widget-root [data-tc-modal] button[data-tc-icon-button]").first().click();
  await expect(modal).toBeHidden();
  await page.waitForTimeout(500);
  const bridgeTries = () => net.unexpected.filter(toBridge).length;
  const tries = bridgeTries();
  await page.waitForTimeout(4_500);
  expect(bridgeTries(), "bridge requests after the modal closed").toBe(tries);
  await expect(page.getByTestId("swap-wallet-pill-ton")).toHaveCount(0);
  await expect(page.getByTestId("swap-refund-box")).toBeVisible();
  await page.getByTestId("swap-refund-connect").click();
  await expect(page.getByTestId("swap-connect-tonconnect")).toBeEnabled();
  await expect(page.getByTestId("swap-connect-error")).toHaveCount(0);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(watch.errors.filter((e) => /CSP violation/.test(e)), "CSP violations").toEqual([]);
  // The bridges are blocked here on purpose: their failed connections may log; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource|TON_CONNECT|EventSource|bridge/i.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: a TON Connect that can't start opens no modal and reopens our menu with the reason — our list unreadable, then its chunk", async ({page, baseURL}) => {
  const watch = watchPage(page);
  const origin = new URL(baseURL!).origin;
  await stubNetwork(page, origin);
  // A gateway that lost the list (the SDK alone would show its own bundled list: remote icons, other bridges).
  await page.route(`${origin}/tonconnect-wallets.json`, (route) => route.fulfill({status: 404, body: "not found"}));

  await page.goto(`./#/?pay=ton:native&receive=${USDC_BASE}&amount=5`);
  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tonconnect").click();
  // No click more: the menu is back, on TON, with the reason.
  await expect(page.getByTestId("swap-connect-error")).toHaveText("TON Connect's wallet list didn't load — check your connection and try again.", {timeout: 10_000});
  await expect(page.locator("section[aria-label='TON wallets'] [data-testid='swap-connect-tonconnect']")).toBeEnabled();
  await expect(page.locator("#tc-widget-root")).toHaveCount(0);

  // The list is back but TON Connect UI's chunk can't be fetched (a redeploy replaced it, the network dropped).
  await page.unroute(`${origin}/tonconnect-wallets.json`);
  await page.route(`${origin}/assets/*.js`, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    if (body.includes("data-tc-wallets-modal-container")) return route.abort("failed");
    return route.fulfill({response: res, body});
  });
  await page.getByTestId("swap-connect-tonconnect").click();
  await expect(page.getByTestId("swap-connect-error")).toHaveText("TON Connect didn't load — check your connection and try again.", {timeout: 10_000});
  await expect(page.locator("#tc-widget-root")).toHaveCount(0);
  await expect(page.getByTestId("swap-wallet-pill-ton")).toHaveCount(0);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  // Any bridge, ours or the SDK's own list's: TON Connect listens at <bridge>/events.
  expect(watch.requests.filter((u) => toBridge(u) || new URL(u).pathname.endsWith("/events")), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  expect(watch.errors.filter((e) => /CSP violation/.test(e)), "CSP violations").toEqual([]);
  // The 404, the aborted chunk and the SDK's note on the list log; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource|TON_CONNECT/i.test(e)), "page errors / console errors").toEqual([]);
});

// ── a TON contract call: Symbiosis paid in USDT (D35) ───────────────────────────────────────────────────────────────

/** The SDK's recorded Symbiosis quote: 50 USDT on TON → USDC on Base, built for the module's TON placeholder. */
const SYM = (JSON.parse(readFileSync("tests/unit/execute/symbiosisTon.fixture.json", "utf8")) as {sdk: SymbiosisRecording}).sdk;
interface SymbiosisRecording {
  params: {destAddress: string};
  limits: unknown[];
  response: {tx: {validUntil: number; messages: {address: string; amount: string; payload: string}[]}};
  quote: {tonTo: string; tonValue: string; tonBody: string};
}
/** The sender it was built for, and its USDT jetton wallet (computed from the pinned wallet code). */
const SYM_RAW = "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8";
const SYM_JW = "0:2f2f33ae6dd9c0b6fee08cef597eb00a9d5925152ff8c46ee2417ceb7f296598";
const USDT_RAW = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";
const USDT_TON = "ton:eqcxe6mutqjkfngfarotkot1lzbdiix1kcixrv7nw2id_sds";

/**
 * Prices, TonAPI (the payer's TON and USDT, its USDT jetton wallet and that wallet's state) and Symbiosis' API (its
 * limits, the recorded quote with a fresh expiry; `tamper` rewrites the message it carries); anything else off the
 * page's origin is aborted and recorded.
 */
async function stubSymbiosis(page: Page, origin: string) {
  const unexpected: string[] = [];
  const quotes: number[] = [];
  const state: {tamper?: (m: {address: string; amount: string}) => void} = {};
  await page.route(
    (url) => url.origin !== origin,
    async (route) => {
      const url = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});
      if (url.hostname === "coins.llama.fi") return json({coins: {}});
      if (url.hostname === "api.coingecko.com") return json({});
      if (url.hostname === "tonapi.io") {
        if (url.pathname.endsWith("/methods/get_wallet_address")) return json({success: true, decoded: {jetton_wallet_address: SYM_JW}});
        if (url.pathname.endsWith("/methods/get_wallet_data")) return json({success: true, decoded: {balance: "100000000", owner: SYM_RAW, jetton: USDT_RAW}});
        if (url.pathname.endsWith("/jettons")) return json({balances: [{balance: "100000000", jetton: {address: USDT_RAW}}]});
        return route.fulfill({status: 200, contentType: "application/json", body: `{"address":"${SYM_RAW}","balance":10000000000,"status":"active"}`});
      }
      if (url.hostname === "api.symbiosis.finance") {
        if (url.pathname.endsWith("/v1/swap-limits")) return json(SYM.limits);
        if (url.pathname.endsWith("/v2/quote")) {
          quotes.push(Date.now());
          const answer = structuredClone(SYM.response);
          answer.tx.validUntil = Math.floor(Date.now() / 1000) + 600;
          state.tamper?.(answer.tx.messages[0]!);
          return json(answer);
        }
      }
      unexpected.push(url.href);
      return route.abort("blockedbyclient");
    },
  );
  return {unexpected, quotes, state};
}

/** Pay 50 USDT from the fake Tonkeeper (the recording's sender) for USDC on Base to its recipient at 1 %; open the review. */
async function reviewSymbiosis(page: Page) {
  await page.goto(`./#/?pay=${USDT_TON}&receive=${USDC_BASE}&amount=50`);
  await page.getByTestId("swap-refund-connect").click();
  await page.getByTestId("swap-connect-tonconnect:tonkeeper").click();
  await expect(page.getByTestId("swap-wallet-pill-ton")).toBeVisible();
  // The recording was asked with 1 % slippage: its minimum is under the floor the 0.3 % default would ask for.
  await page.getByTestId("swap-slippage").click();
  const sheet = page.getByRole("dialog", {name: "Max slippage"});
  await sheet.getByRole("group", {name: "Slippage presets"}).getByRole("button", {name: "1%", exact: true}).click();
  await expect(sheet).toBeHidden();
  await page.getByTestId("swap-recipient").fill(SYM.params.destAddress);
  await expect(page.getByTestId("swap-review")).toHaveText("Review via Symbiosis", {timeout: 30_000});
  await page.getByTestId("swap-review").click();
  await expect(page.getByTestId("swap-confirm")).toBeEnabled({timeout: 30_000});
}

const tonSent = (page: Page) => page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent.length);

test("TON: Symbiosis from a TON wallet signs one jetton transfer — the payer's USDT jetton wallet, the TON it attaches, the venue's exact BoC", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubSymbiosis(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, SYM_RAW);
  await reviewSymbiosis(page);
  await page.getByTestId("swap-confirm").click();

  await expect.poll(() => tonSent(page), {timeout: 30_000}).toBe(1);
  const [sent] = (await page.evaluate(() => (window as unknown as {__tonSent: unknown[]}).__tonSent)) as {method: string; params: string[]}[];
  expect(sent!.method).toBe("sendTransaction");
  const tx = JSON.parse(sent!.params[0]!) as {valid_until: number; network: string; from: string; messages: {address: string; amount: string; payload?: string; stateInit?: string}[]};
  expect(tx).toMatchObject({network: "-239", from: SYM_RAW});
  expect(tx.messages).toEqual([{address: SYM.quote.tonTo, amount: SYM.quote.tonValue, payload: SYM.quote.tonBody}]);
  expect(Address.parse(tx.messages[0]!.address).toRawString()).toBe(SYM_JW);
  expect(Address.parseFriendly(tx.messages[0]!.address).isBounceable).toBe(true);
  expect(tx.messages[0]!.amount).toBe("200000000");
  expect(tx.valid_until - Date.now() / 1000).toBeLessThanOrEqual(300);
  expect(net.quotes.length, "Symbiosis quotes").toBeGreaterThan(0);

  const hosts = new Set(watch.requests.map((u) => new URL(u).hostname));
  for (const h of TON_HOSTS) expect(hosts.has(h), h).toBe(false);
  expect(watch.requests.filter(toBridge), "a TON Connect bridge").toEqual([]);
  expect(watch.requests.filter(isCp0xHost), "requests to a cp0x domain").toEqual([]);
  // Venues that don't serve this pair are blocked here on purpose and log "Failed to load resource"; nothing else may.
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});

test("TON: a Symbiosis answer tampered after the review is refused before the wallet is asked", async ({page, baseURL}) => {
  test.setTimeout(90_000);
  const watch = watchPage(page);
  const net = await stubSymbiosis(page, new URL(baseURL!).origin);
  await injectFakeTonkeeper(page, SYM_RAW);
  await reviewSymbiosis(page);
  // From now on the API names the payer's own jetton wallet non-bounceable (a failed transfer would keep the TON).
  net.state.tamper = (m) => void (m.address = Address.parseRaw(SYM_JW).toString({urlSafe: true, bounceable: false}));
  const asked = net.quotes.length;
  await page.getByTestId("swap-confirm").click();

  await expect(page.getByTestId("swap-error")).toContainText("isn't sent bounceable", {timeout: 30_000});
  await expect(page.getByTestId("swap-error")).toContainText("nothing was signed");
  expect(net.quotes.length, "the live quote after Confirm").toBeGreaterThan(asked);
  expect(await tonSent(page)).toBe(0);
  expect(watch.errors.filter((e) => !/Failed to load resource/.test(e)), "page errors / console errors").toEqual([]);
});
