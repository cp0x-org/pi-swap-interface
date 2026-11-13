/**
 * The TON wallets the connect menu knows (D11). TON wallets connect through TON Connect UI's own modal and its
 * official wallet list (owner, 2026-11-13): the menu's one "TON Connect" entry opens it. The list is a self-hosted
 * snapshot of TON Connect's official one (config.ton.org/wallets-v2.json, never fetched: it would tell a third party
 * every visitor's IP), served as `tonconnect-wallets.json` beside index.html with each icon bundled
 * (.github/scripts/ton-wallets.mjs rebuilds both and `officialWallets.ts`). A wallet whose JS bridge is on this page
 * (`window[key].tonconnect`: its extension, or the page runs in its in-app browser) is listed too, as installed, and
 * connects straight through that bridge without the modal; cp0x's wallet, which is not in the official list, only so.
 */
import type {WalletOption} from "../../contracts/wallets";
import {OFFICIAL_TON_WALLETS} from "./officialWallets";

/** One TON Connect wallet: its app name (the option id's suffix), name and JS bridge key (absent: bridge only). */
export interface TonWalletInfo {
  appName: string;
  name: string;
  jsBridgeKey?: string;
}

/** cp0x's wallet: its in-app browser injects `window.cp0x.tonconnect` (apps/mobile/lib/dapp/ton.ts in cp0x-mobile). */
export const CP0X_TON_WALLET = {appName: "cp0x", name: "cp0x", jsBridgeKey: "cp0x"} as const satisfies TonWalletInfo;

/** A wallet TON Connect UI lists beside the official ones (its `UIWallet`, with a JS bridge). */
export interface TonUiWallet {
  appName: string;
  name: string;
  jsBridgeKey: string;
  imageUrl: string;
  aboutUrl: string;
  platforms: readonly ("ios" | "android")[];
}

/**
 * cp0x's wallet in TON Connect UI's modal, listed when its in-app browser injects the bridge: the bundled cp0x mark,
 * and this page as its "about" link — a cp0x host can't be in the bundle (guard-dist, D24). Relative URLs resolve
 * against the page, under a sub-path too.
 */
export const CP0X_TON_UI_WALLET: TonUiWallet = {...CP0X_TON_WALLET, imageUrl: "apple-touch-icon.png", aboutUrl: "./", platforms: ["ios", "android"]};

/** Every wallet the menu can find installed and the names a connected wallet is shown by: cp0x's, then the official list. */
export const TON_WALLETS: readonly TonWalletInfo[] = [CP0X_TON_WALLET, ...OFFICIAL_TON_WALLETS];

/**
 * An icon of the self-hosted list (`logos/ton-wallets/<app_name>.png`, relative). The list the SDK falls back to when
 * ours can't be read (its own bundled one) has only remote icons: a list with any other is not ours.
 */
export const isBundledTonIcon = (imageUrl: string): boolean => /^logos\/ton-wallets\/[^/]+\.png$/.test(imageUrl);

/** The entry that opens TON Connect UI's modal (contract: WalletOption.id). */
export const TONCONNECT_ID = "tonconnect";

/** An installed wallet's option id is `tonconnect:<appName>`, so it can never collide with an EVM rdns or a Solana wallet's name. */
export const TON_OPTION_PREFIX = "tonconnect:";

/** The installed wallet behind an option id (it has a JS bridge), or undefined — also for the modal's entry. */
export const tonWalletOf = (optionId: string): TonWalletInfo | undefined =>
  optionId.startsWith(TON_OPTION_PREFIX) ? TON_WALLETS.find((w) => w.jsBridgeKey && `${TON_OPTION_PREFIX}${w.appName}` === optionId) : undefined;

/** The wallet a connected session names (`device.appName`, matched as TON Connect UI does: app name or name, any case). */
export function tonWalletByApp(appName: string): TonWalletInfo | undefined {
  const a = appName.toLowerCase();
  return TON_WALLETS.find((w) => w.appName.toLowerCase() === a || w.name.toLowerCase() === a);
}

/** The page has that wallet's TON Connect JS bridge (its extension, or its in-app browser): TON Connect's own test. */
export function isTonInjected(key: string, win: unknown = globalThis): boolean {
  try {
    const w = (win as Record<string, unknown>)[key];
    return !!w && typeof w === "object" && typeof (w as {tonconnect?: unknown}).tonconnect === "object";
  } catch {
    return false;
  }
}

/** The modal's menu entry. No icon: the menu shows the bundled TON logo (no remote icon, D13). */
export const TONCONNECT_OPTION: WalletOption = {id: TONCONNECT_ID, family: "ton", name: "TON Connect", kind: "tonconnect"};

/** The TON menu entries: the wallets installed here (one per JS bridge key), then TON Connect's modal. */
export function tonOptions(injected: (key: string) => boolean = isTonInjected): WalletOption[] {
  const seen = new Set<string>();
  const out: WalletOption[] = [];
  for (const w of TON_WALLETS) {
    if (!w.jsBridgeKey || seen.has(w.jsBridgeKey) || !injected(w.jsBridgeKey)) continue;
    seen.add(w.jsBridgeKey);
    out.push({id: `${TON_OPTION_PREFIX}${w.appName}`, family: "ton", name: w.name, kind: "injected"});
  }
  return [...out, TONCONNECT_OPTION];
}
