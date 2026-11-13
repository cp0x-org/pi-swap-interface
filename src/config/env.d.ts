/// <reference types="vite/client" />

/** Build-time env the app reads (all optional, all public). */
interface ImportMetaEnv {
  /** JSON RuntimeConfigInput merged over the defaults at build time. */
  readonly VITE_SWAP_CONFIG?: string;
  /** package.json version, injected by vite.config.ts (display only). */
  readonly VITE_APP_VERSION?: string;
  /** "1" lists the catalog-only chains (LTC, DOGE, XRP…) — phase 1.5, off by default. */
  readonly VITE_EXTRA_CHAINS?: string;
  /**
   * The cp0x API origin of the hosted build ("https://cp0x-api.vercel.app"), checked and normalised by
   * vite.config.ts ("" when unset). Set: the Standard connection mode exists and is the default (D30). Unset (IPFS,
   * npx, Docker, a plain `pnpm build`): the bundle holds no cp0x host and the app never contacts one (D24).
   */
  readonly VITE_CP0X_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
