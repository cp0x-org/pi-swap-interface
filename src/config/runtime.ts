/**
 * The page's runtime config, loaded once at boot (main.tsx awaits it before
 * importing the app, so modules may read it at their top level). Layers, last
 * wins: built-in defaults → VITE_SWAP_CONFIG (JSON at build time) →
 * ./runtime-config.json next to index.html (optional, fetched no-store) →
 * the viewer's saved settings (localStorage, src/config/userSettings.ts) →
 * `?demo=1|0` in the hash query → the connection mode (D30: Custom's own RPCs
 * first in their lists; Standard's proxy slots). Changing it needs a reload:
 * providers are built once per page (D9). A cp0x API URL from any layer but
 * the last is dropped with a warning: only Standard's slots may add one.
 */
import type {ConnectionMode, ConnectionSettings, ProviderName, RuntimeConfig, RuntimeConfigInput, SavedOverrides, VenueKeys} from "../contracts/config";
import {
  CP0X_API,
  customOverlay,
  defaultConnectionMode,
  isCp0xApiUrl,
  readConnection,
  readVenueKeys,
  standardSlots,
  withoutCp0xApi,
  type StandardPlan,
} from "./connection";
import {DEFAULT_RUNTIME_CONFIG} from "./defaults";
import {demoFromLocation} from "./demo";
import {parseRuntimeConfig} from "./parse";
import {readUserSettings} from "./userSettings";

let current: RuntimeConfig = DEFAULT_RUNTIME_CONFIG;
let loaded = false;
const NO_OVERRIDES: SavedOverrides = {ignored: false, hosts: [], evmRpcChains: [], solanaRpc: false};
let overrides: SavedOverrides = NO_OVERRIDES;

/** This page's connection (D30), fixed at boot like the config. */
export interface PageConnection {
  mode: ConnectionMode;
  /** The cp0x API this build was made with (null: no Standard mode, D24). */
  api: string | null;
  /** Standard only (and never in demo mode): the proxy slots the page was built with. */
  plan: StandardPlan | null;
  /** Custom only: the viewer's venue keys, handed to the providers' constructors and nowhere else. */
  keys: VenueKeys;
}

const PUBLIC_PAGE: PageConnection = {mode: "public", api: null, plan: null, keys: {}};
let connection: PageConnection = PUBLIC_PAGE;

/** What the viewer's saved settings changed on this page (or that they were ignored). */
export const savedOverrides = (): SavedOverrides => overrides;

/** This page's connection mode, its Standard plan and its Custom keys (Public until loadRuntimeConfig ran). */
export const pageConnection = (): PageConnection => connection;

/** The viewer's venue keys in effect on this page: Custom mode only, {} otherwise. */
export const venueKeys = (): VenueKeys => connection.keys;

/**
 * A URL of cp0x's API (this build's origin, or a swap-web proxy path anywhere), in any mode: never handed to a wallet
 * (D30). Matched on the origin, not on Standard's plan, so nothing that points at cp0x can slip through in Public or
 * Custom either (the boot drops such URLs from every layer already; this is the wallet-side check).
 */
export const isProxyUrl = (url: string): boolean => isCp0xApiUrl(url, connection.api ?? CP0X_API);

/**
 * An IPFS path gateway (`https://gateway/ipfs/<cid>/`, `/ipns/<name>/`): every site on it shares one origin, so any
 * of them can write this origin's localStorage. Saved settings are not applied there (subdomain gateways and
 * ipfs:// give each CID its own origin).
 */
export const isSharedOriginPath = (pathname: string | undefined): boolean => /^\/ip[fn]s\//i.test(pathname ?? "");

const host = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** The trust-relevant differences the saved layer made (venue / price APIs, RPCs), in config-key order. */
function diffOverrides(before: RuntimeConfig, after: RuntimeConfig): SavedOverrides {
  const hosts: {key: string; host: string}[] = [];
  for (const [k, v] of Object.entries(after.api)) {
    const was = before.api[k as keyof RuntimeConfig["api"]];
    if (JSON.stringify(was) === JSON.stringify(v)) continue;
    for (const u of Array.isArray(v) ? v : [v]) hosts.push({key: `api.${k}`, host: host(u as string)});
  }
  for (const [k, v] of Object.entries(after.prices)) if (before.prices[k as keyof RuntimeConfig["prices"]] !== v) hosts.push({key: `prices.${k}`, host: host(v)});
  if (JSON.stringify(before.tronApi) !== JSON.stringify(after.tronApi)) for (const u of after.tronApi) hosts.push({key: "tronApi", host: host(u)});
  const evmRpcChains = Object.keys(after.evmRpc)
    .map(Number)
    .filter((id) => JSON.stringify(before.evmRpc[id]) !== JSON.stringify(after.evmRpc[id]));
  return {ignored: false, hosts, evmRpcChains, solanaRpc: JSON.stringify(before.solanaRpc) !== JSON.stringify(after.solanaRpc)};
}

/** Venues an operator layer (VITE_SWAP_CONFIG, runtime-config.json) explicitly switched off or on; later layers win. */
function operatorFlags(raw: unknown, off: Set<ProviderName>, on: Set<ProviderName>): void {
  const p = raw && typeof raw === "object" ? (raw as {providers?: unknown}).providers : undefined;
  if (!p || typeof p !== "object") return;
  for (const [k, v] of Object.entries(p)) {
    if (v === false) {
      off.add(k as ProviderName);
      on.delete(k as ProviderName);
    } else if (v === true) {
      off.delete(k as ProviderName);
      on.add(k as ProviderName);
    }
  }
}

/** The config in effect. Before loadRuntimeConfig() resolves (unit tests) this is the built-in default. */
export function getRuntimeConfig(): RuntimeConfig {
  return current;
}

/** Demo mode is on (decided at boot, D15). */
export const isDemo = (): boolean => current.demo;

/** True once loadRuntimeConfig() finished. */
export const runtimeConfigLoaded = (): boolean => loaded;

/** Tests only: put a config in effect without loading (and, optionally, what saved settings changed and the connection). */
export function setRuntimeConfig(next: RuntimeConfig, saved: SavedOverrides = NO_OVERRIDES, page: PageConnection = PUBLIC_PAGE): void {
  current = next;
  overrides = saved;
  connection = page;
}

export interface LoadOptions {
  /** Default: runtime-config.json resolved against document.baseURI (works under /ipfs/<cid>/). */
  url?: string;
  fetchImpl?: typeof fetch;
  /** Default: import.meta.env.VITE_SWAP_CONFIG. */
  buildTime?: string;
  /** Default: window.location (`pathname` decides whether saved settings may apply). */
  location?: Pick<Location, "hash" | "search"> & Partial<Pick<Location, "pathname">>;
  /** Default: readUserSettings() (the Settings sheet's saved overrides); null = none. */
  userSettings?: RuntimeConfigInput | null;
  /** Default: CP0X_API, the build's cp0x API origin (null: Standard does not exist). */
  api?: string | null;
  /** Default: readConnection(api) (the saved mode and Custom endpoints); null = nothing saved. */
  connection?: ConnectionSettings | null;
  /** Default: readVenueKeys() (read only in Custom mode). */
  venueKeys?: VenueKeys;
}

/** Load and merge every layer. Never throws: a missing or broken file leaves the defaults (warnings go to the console). */
export async function loadRuntimeConfig(opts: LoadOptions = {}): Promise<RuntimeConfig> {
  let config = DEFAULT_RUNTIME_CONFIG;
  const warnings: string[] = [];
  const off = new Set<ProviderName>();
  const on = new Set<ProviderName>();

  const buildTime = opts.buildTime ?? import.meta.env.VITE_SWAP_CONFIG;
  if (buildTime) {
    try {
      const raw: unknown = JSON.parse(buildTime);
      operatorFlags(raw, off, on);
      const parsed = parseRuntimeConfig(raw, config);
      config = parsed.config;
      warnings.push(...parsed.warnings);
    } catch {
      warnings.push("runtime-config: VITE_SWAP_CONFIG is not JSON — ignored");
    }
  }

  const fileUrl = opts.url ?? (typeof document !== "undefined" ? new URL("runtime-config.json", document.baseURI).href : null);
  const doFetch = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
  if (fileUrl && doFetch) {
    try {
      const res = await doFetch(fileUrl, {cache: "no-store", signal: AbortSignal.timeout(4_000)});
      // 404 = no file: the normal case for a plain static deploy. An SPA fallback (vite preview, many hosts)
      // answers 200 with index.html instead: that is "no file" too, not a broken one.
      const html = (res.headers.get("content-type") ?? "").includes("text/html");
      if (res.ok && !html) {
        const raw: unknown = await res.json();
        operatorFlags(raw, off, on);
        const parsed = parseRuntimeConfig(raw, config);
        config = parsed.config;
        warnings.push(...parsed.warnings);
      }
    } catch (e) {
      warnings.push(`runtime-config: ${fileUrl} could not be read (${e instanceof Error ? e.message : String(e)}) — using built-in defaults`);
    }
  }

  const loc = opts.location ?? (typeof window !== "undefined" ? window.location : undefined);
  const shared = isSharedOriginPath(loc?.pathname);
  // Omniston's HTLC secret lives in this origin's IndexedDB (stores.ts), which every site on a path gateway can read
  // or delete: there it is built only when this page's own operator layer turns it on (its default alone doesn't).
  if (shared && config.providers.omniston && !on.has("omniston")) {
    config = {...config, providers: {...config.providers, omniston: false}};
    warnings.push("runtime-config: omniston off — this page is on an IPFS path gateway, whose storage every site on it shares");
  }
  const api = opts.api === undefined ? CP0X_API : opts.api;
  // cp0x's API reaches the page only through Standard's slots, which follow the mode and the health answer (D30). A
  // URL of it in the operator's layers would contact cp0x in Public and Custom too, and reach wallets: dropped.
  const operatorClean = withoutCp0xApi(config, DEFAULT_RUNTIME_CONFIG, api);
  config = operatorClean.config;
  for (const k of operatorClean.dropped) warnings.push(`runtime-config: ${k} points at cp0x's API — ignored (only Standard mode reaches it, by itself)`);
  const user = opts.userSettings === undefined ? readUserSettings() : opts.userSettings;
  const saved = opts.connection === undefined ? readConnection(api) : opts.connection;
  const operator = config;
  overrides = NO_OVERRIDES;
  if ((user || saved) && shared) {
    // Any page on this gateway could have written them: never let one redirect the venues, prices or RPCs.
    overrides = {...NO_OVERRIDES, ignored: true};
    warnings.push("saved settings: ignored — this page is on an IPFS path gateway, whose origin every site on it shares");
  } else {
    if (user) {
      const parsed = parseRuntimeConfig(user, config);
      config = parsed.config;
      warnings.push(...parsed.warnings.map((w) => w.replace(/^runtime-config:/, "saved settings:")));
      // A viewer may switch a venue off, never back on after the operator switched it off (an emergency stop).
      const reenabled = [...off].filter((p) => config.providers[p]);
      if (reenabled.length) {
        config = {...config, providers: {...config.providers, ...Object.fromEntries(reenabled.map((p) => [p, false]))}};
        warnings.push(`saved settings: ${reenabled.join(", ")} stay off — the site's operator turned them off`);
      }
      // Previews: a viewer may switch them off, never on against the operator, and never loosen the operator's pacing.
      if (!operator.preview.enabled && config.preview.enabled) warnings.push("saved settings: preview prices stay off — the site's operator turned them off");
      config = {...config, preview: {...operator.preview, enabled: operator.preview.enabled && config.preview.enabled}};
    }
    // Custom mode's own RPCs go first in their lists (D30); like any saved RPC, the swap screen names them.
    if (saved?.mode === "custom") config = customOverlay(config, saved.custom);
    // A saved base or RPC pointing at cp0x (say, a proxy URL pasted from Settings' placeholder) is dropped the same way.
    const viewerClean = withoutCp0xApi(config, operator, api);
    config = viewerClean.config;
    for (const k of viewerClean.dropped) warnings.push(`saved settings: ${k} points at cp0x's API — ignored (only Standard mode reaches it, by itself)`);
    if (user || saved?.mode === "custom") overrides = diffOverrides(operator, config);
  }

  const demo = loc ? demoFromLocation(loc) : null;
  if (demo !== null) config = {...config, demo};

  // The connection (D30): a saved choice only where saved settings apply; Standard only in a build with a cp0x API.
  const mode = saved && !shared && (saved.mode !== "standard" || api) ? saved.mode : defaultConnectionMode(api);
  let plan: StandardPlan | null = null;
  if (mode === "standard" && api && !config.demo) {
    const slotted = standardSlots(config, api, operator);
    config = slotted.config;
    plan = slotted.plan;
  }
  const keys = mode === "custom" ? (opts.venueKeys ?? readVenueKeys()) : {};
  connection = {mode, api, plan, keys};

  for (const w of warnings) console.warn(w);
  current = config;
  loaded = true;
  return config;
}
