/**
 * The TON DEX contracts an Omniston swap between TON and USDT may pay from a TON wallet (D35 part C), compiled in:
 * canonical mainnet addresses from each DEX's own sources, each read once on chain when it was pinned (2026-11-13,
 * read-only) — never a code interface TonAPI labels, an indexer's answer or Omniston's. A label can't say which
 * instance a contract is: STON.fi v2 routers are deployed by anyone with the genuine code (an admin then controls a
 * 7-day code upgrade), DeDust CPMM v2 pools are permissionless with a creator's own fees and resolvers. Raw form
 * (lowercase); tests/unit/execute/omnistonSwap.test.ts holds each to its friendly form, the routers' USDT wallets to
 * the address the pinned USDT wallet code derives (tonGate.ts `pinnedJettonWallet`), and every recording to them.
 *
 * Pinned: STON.fi v1 (its one router), STON.fi v2 (the one router holding the liquid TON/USDT pool) and DeDust v1 (its
 * vaults and its TON/USDT pool, as its factory derives them). Not pinned, so never paid: STON.fi's other v2 routers
 * (50 listed on 2026-11-13, 20 of them open to new pools; STON.fi publishes no fixed list and tells integrators to take
 * the router from a simulation), DeDust CPMM v2 (no address list or factory names the canonical TON/USDT pool; the one
 * Omniston uses is vouched for only by its code), TONCO and swap.coffee (no decoder in the package), any other jetton.
 *
 * Refreshed by hand at a release, never at run time: the routers API, each pTON wallet's get_wallet_data (owner = its
 * router, master = its pTON), DeDust's factory getters, the USDT master's get_wallet_address against the derivation,
 * the code hashes below; a router a DEX adds later is refused until it is pinned here.
 *
 * Strings only (the main bundle): tonSwap.ts reads a swap against them, omnistonSwap.ts holds the package's legs to them.
 */

/** USDT's jetton master on TON (raw): the one jetton whose wallet code the app pins (tonGate.ts PINNED_JETTON_CODE). */
export const TON_USDT = "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe";

/** A STON.fi router, and its own wallets: where native TON enters and leaves (its pTON wallet), and its USDT wallet. */
export interface StonfiPin {
  dex: "stonfi";
  version: 1 | 2;
  /** Omniston's name for it (SwapChunk.protocol; the package's TON_SWAP_PROTOCOL_LAYOUTS). */
  protocol: "StonFiV1" | "StonFiV2";
  router: string;
  /** The router's pTON wallet: a TON input pays it, a TON output is asked of it. */
  ptonWallet: string;
  /** The router's USDT wallet: a USDT output is asked of it. */
  usdtWallet: string;
}

/** DeDust v1: its vaults (where each asset enters) and the pool that trades TON against USDT. */
export interface DedustPin {
  dex: "dedust";
  version: 1;
  protocol: "DeDust";
  nativeVault: string;
  usdtVault: string;
  pool: string;
}

export type TonDexPin = StonfiPin | DedustPin;

/**
 * STON.fi v1 — the router EQB3ncyB… (ston-fi/sdk packages/sdk/src/contracts/dex/v1/constants.ts; api.ston.fi/v1/routers,
 * v1.0, code 276f7c20…2faf). Its pTON v1 wallet EQARULUY… (the routers API's `pton_wallet_address`; on chain owner =
 * the router, master = pTON v1 EQCM3B12…, ston-fi/sdk pTON/v1/PtonV1.ts; code 8836d2f4…d303); its USDT wallet derived.
 * https://github.com/ston-fi/sdk/blob/main/packages/sdk/src/contracts/dex/v1/constants.ts
 * https://api.ston.fi/v1/routers
 */
export const STONFI_V1: StonfiPin = Object.freeze({
  dex: "stonfi",
  version: 1,
  protocol: "StonFiV1",
  router: "0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e",
  ptonWallet: "0:1150b518b2626ad51899f98887f8824b70065456455f7fe2813f012699a4061f",
  usdtWallet: "0:4eec921b9d4d56a0d94676016d49c26b39b1d7901a7e153e66033f146a0886f4",
});

/**
 * STON.fi v2 — the router EQCS4UEa… (api.ston.fi/v1/routers: v2.2 ConstantProduct, pTON 2.1; code a7e2f92c…1182), the
 * router of the one liquid TON/USDT v2 pool (EQCGScrZ…, about $4.6M on 2026-11-13; api.ston.fi/v1/pools/by_market).
 * Its pTON v2 wallet EQCSIMGB… (the routers API; on chain owner = the router, master = pTON v2 EQBnGWMC…, the
 * package's DEFAULT_OMNISTON_TON_PROXY_TON_MASTERS; code ed91066a…421b); its USDT wallet derived.
 * https://api.ston.fi/v1/routers · https://docs.ston.fi/developer-section/dex/smart-contracts/v2/router
 */
export const STONFI_V2: StonfiPin = Object.freeze({
  dex: "stonfi",
  version: 2,
  protocol: "StonFiV2",
  router: "0:92e1411ae546892f33b2c8a89ea90390d8ff4cfbb917a643b91e73f706fdb9d1",
  ptonWallet: "0:9220c181a6cfeacd11b7b8f62138df1bb9cc82b6ed2661d2f5faee204b3efb20",
  usdtWallet: "0:922d627d7d8edbd00e4e23bdb0c54a76ee5e1f46573a1af4417857fa3e23e91f",
});

/**
 * DeDust v1 — derived by its factory EQBfBWT7… (docs.dedust.io/reference/factory; dedust-io/sdk src/constants.ts):
 * `get_vault_address(native)` EQDa4VOn… (code 875fac5e…e75c), `get_vault_address(USDT)` EQAYqo4u… (code a30f0486…306f),
 * `get_pool_address(volatile, native, USDT)` EQA-X_yo… (code 1275095b…27c1; api.dedust.io/v2/pools).
 * https://docs.dedust.io/reference/factory · https://github.com/dedust-io/sdk/blob/main/src/constants.ts
 */
export const DEDUST_V1: DedustPin = Object.freeze({
  dex: "dedust",
  version: 1,
  protocol: "DeDust",
  nativeVault: "0:dae153a74d894bbc32748198cd626e4f5df4a69ad2fa56ce80fc2644b5708d20",
  usdtVault: "0:18aa8e2eed51747dae033c079b93883d941cad8f65459f2ee9cd7474b6b8ed5d",
  pool: "0:3e5ffca8ddfcf36c36c9ff46f31562aab51b9914845ad6c26cbde649d58a5588",
});

/** Every DEX an Omniston TON ↔ USDT swap may go through. */
export const TON_DEXES: readonly TonDexPin[] = Object.freeze([STONFI_V1, STONFI_V2, DEDUST_V1]);

/**
 * A USDT source: the contract the payer's jetton transfer pays (the router; DeDust: its USDT vault), each with the
 * least TON every recording forwards there (2026-10-22's SDK recordings, 2026-11-13's dry builds: STON.fi v1 0.135,
 * v2 0.21, DeDust 0.1 TON). Less and the contract can't pay for the swap: the USDT would sit with it.
 */
export const TON_DEX_JETTON_IN: ReadonlyMap<string, bigint> = new Map([
  [STONFI_V1.router, 135_000_000n],
  [STONFI_V2.router, 210_000_000n],
  [DEDUST_V1.usdtVault, 100_000_000n],
]);

/**
 * A TON source: the contract the message itself pays (the router's pTON wallet; DeDust: its native vault), each with
 * the least TON every recording attaches beyond the input (STON.fi v1 0.1, v2 0.22, DeDust 0.1 TON).
 */
export const TON_DEX_NATIVE_IN: ReadonlyMap<string, bigint> = new Map([
  [STONFI_V1.ptonWallet, 100_000_000n],
  [STONFI_V2.ptonWallet, 220_000_000n],
  [DEDUST_V1.nativeVault, 100_000_000n],
]);

/** The DEX one of whose contracts (raw) the message pays — its entry contract for that source — or undefined. */
export function tonDexAt(contract: string, nativeSource: boolean): TonDexPin | undefined {
  return TON_DEXES.find((d) =>
    d.dex === "stonfi" ? contract === (nativeSource ? d.ptonWallet : d.router) : contract === (nativeSource ? d.nativeVault : d.usdtVault),
  );
}
