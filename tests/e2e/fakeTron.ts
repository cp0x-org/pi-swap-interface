/**
 * A Tron payer's swap with nothing real contacted, shared by tron.spec.ts (the default build) and standard.spec.ts (the
 * Standard build's swap counter, D36): a fake TronLink whose TronWeb `trx.sign` hands the txID to the test process,
 * which signs it with a throwaway key made for this run, and stubs for 1Click (quotes, the deposit notice, status) and
 * the Tron API. USDT on Tron → USDC on Base through NEAR Intents: the live quote names a deposit address, the page
 * builds and broadcasts the USDT transfer to it.
 */
import {createHash, randomBytes} from "node:crypto";
import type {Page, Route} from "@playwright/test";
import {generatePrivateKey, privateKeyToAccount, sign} from "viem/accounts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

/** base58check of 0x41 ‖ 20 bytes: a Tron address. */
export function tronAddress(hex20: string): string {
  const body = Buffer.from(`41${hex20}`, "hex");
  const bytes = Buffer.concat([body, sha(sha(body)).subarray(0, 4)]);
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

const KEY = generatePrivateKey();
/** TronLink's account for this run. */
export const OWNER_HEX = privateKeyToAccount(KEY).address.slice(2).toLowerCase();
export const OWNER = tronAddress(OWNER_HEX);
/** The deposit address 1Click's live quote names. */
export const DEPOSIT_HEX = randomBytes(20).toString("hex");
export const DEPOSIT = tronAddress(DEPOSIT_HEX);
export const RECIPIENT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
export const USDT_TRON = "tron:tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t";
export const USDC_BASE = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const AMOUNT = 25_000_000n;
const TRON_HOSTS = new Set(["tron-rpc.publicnode.com", "api.trongrid.io"]);

/** What the stubs saw: Tron API paths, the transactions broadcast, 1Click's live (non-dry) quotes. */
export interface TronSeen {
  tron: string[];
  broadcasts: string[];
  liveQuotes: number;
}

export const newTronSeen = (): TronSeen => ({tron: [], broadcasts: [], liveQuotes: 0});

const json = (route: Route, body: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(body)});

/** Answer `route` when it is 1Click or the Tron API (true); false for anything else, the caller's to answer. */
export async function answerTronSwap(route: Route, seen: TronSeen): Promise<boolean> {
  const req = route.request();
  const url = new URL(req.url());
  if (url.hostname === "1click.chaindefuser.com") {
    if (url.pathname.endsWith("/quote")) {
      const body = req.postDataJSON() as {dry: boolean; amount: string};
      if (!body.dry) seen.liveQuotes++;
      await json(route, {
        quote: {
          ...(body.dry ? {} : {depositAddress: DEPOSIT}),
          amountIn: body.amount,
          amountOut: "24900000",
          minAmountOut: "24899000",
          amountInUsd: "25",
          amountOutUsd: "24.9",
          deadline: new Date(Date.now() + 3_600_000).toISOString(),
          timeEstimate: 60,
        },
      });
      return true;
    }
    if (url.pathname.endsWith("/deposit/submit")) {
      await json(route, {});
      return true;
    }
    if (url.pathname.endsWith("/status")) {
      await json(route, {status: "PENDING_DEPOSIT"});
      return true;
    }
  }
  if (TRON_HOSTS.has(url.hostname)) {
    seen.tron.push(url.pathname);
    const body = (req.postDataJSON() ?? {}) as {function_selector?: string; transaction?: string};
    switch (url.pathname) {
      case "/wallet/getaccount":
        await json(route, {address: OWNER, balance: 50_000_000});
        return true;
      case "/wallet/triggerconstantcontract":
        await json(route, {
          result: {result: true},
          constant_result: [body.function_selector === "balanceOf(address)" ? (100_000_000).toString(16).padStart(64, "0") : "1".padStart(64, "0")],
          energy_used: 29_631,
          transaction: {ret: [{}]},
        });
        return true;
      case "/wallet/getnowblock":
        await json(route, {blockID: `0000000005400000${randomBytes(24).toString("hex")}`, block_header: {raw_data: {number: 88_080_384, timestamp: Date.now()}}});
        return true;
      case "/wallet/broadcasthex":
        seen.broadcasts.push(body.transaction ?? "");
        await json(route, {result: true});
        return true;
      case "/wallet/gettransactioninfobyid":
        await json(route, {});
        return true;
    }
  }
  return false;
}

/**
 * TronLink as the page sees it: TIP-1193 `window.tron`, its TronWeb once this origin is authorized. A signature waits
 * until the test calls `answer()` — the prompt the user is still reading.
 */
export async function injectTronLink(page: Page) {
  const asked: string[] = [];
  let answer!: () => void;
  const answered = new Promise<void>((r) => (answer = r));
  await page.exposeFunction("__e2eTronSign", async (txID: string) => {
    asked.push(txID);
    await answered;
    return (await sign({hash: `0x${txID}`, privateKey: KEY, to: "hex"})).slice(2);
  });
  await page.addInitScript((address: string) => {
    const listeners: Record<string, ((v: unknown) => void)[]> = {};
    let authorized = false;
    const tronWeb = {
      defaultAddress: {
        get base58() {
          return authorized ? address : false;
        },
      },
      fullNode: {host: "https://api.trongrid.io"},
      trx: {
        async sign(tx: {txID: string}) {
          const sig = await (window as unknown as {__e2eTronSign(id: string): Promise<string>}).__e2eTronSign(tx.txID);
          return {...tx, signature: [sig]};
        },
      },
    };
    (window as unknown as {tron: unknown}).tron = {
      async request({method}: {method: string}) {
        if (method !== "eth_requestAccounts") throw Object.assign(new Error(`unsupported ${method}`), {code: 4200});
        authorized = true;
        return [address];
      },
      on(ev: string, l: (v: unknown) => void) {
        (listeners[ev] ??= []).push(l);
      },
      removeListener(ev: string, l: (v: unknown) => void) {
        listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== l);
      },
      get tronWeb() {
        return authorized ? tronWeb : false;
      },
    };
  }, OWNER);
  return {asked, answer};
}
