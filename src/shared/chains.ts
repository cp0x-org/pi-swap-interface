// Copied from cp0x-elysium packages/shared/src/chains.ts @756b115. Owner: catalog.
// Seeded in the contracts phase so every module can import "@cp0x/shared" from day one.
// Web patch (catalog.md §2.5): World Chain's dead tenderly fallback replaced by drpc + thirdweb.
/**
 * The one chain catalog. Every list of networks in the app and the API
 * (balances keys, RPCs, explorers, chain pickers, dapp chain switching) is
 * derived from CHAINS — never hand-maintain a second list.
 *
 * Coverage = the Any Wallet Kit: 30 EVM chains (the eip155 set of
 * @anywalletkit/swap2-assets) + Solana, TON, Tron, Bitcoin, NEAR, Zcash.
 * CAIP-2 ids match the SDK's asset catalog. RPCs are public fallbacks; the app
 * puts env/proxy endpoints in front of them.
 */

/** Key derivation family — matches @anywalletkit/keyring ChainKey. */
export type ChainFamily = "evm" | "solana" | "ton" | "tron" | "btc" | "near" | "zcash";

export interface ChainInfo {
  /** Stable slug: balances-API key, icon file name (`n-<slug>`), route param. */
  slug: string;
  caip2: string;
  name: string;
  family: ChainFamily;
  /** EVM chain id; undefined for non-EVM. */
  chainId?: number;
  native: {symbol: string; decimals: number};
  /** Public RPC fallbacks, best first. Empty when the SDK manager has its own defaults. */
  rpc: readonly string[];
  /** Human explorer base; `/tx/<hash>` and `/address/<a>` are appended. Undefined = not verified yet. */
  explorer?: string;
}

const ETH = {symbol: "ETH", decimals: 18} as const;

const evm = (
  slug: string,
  chainId: number,
  name: string,
  rpc: readonly string[],
  explorer?: string,
  native: {symbol: string; decimals: number} = ETH,
): ChainInfo => ({slug, caip2: `eip155:${chainId}`, name, family: "evm", chainId, native, rpc, explorer});

export const EVM_CHAINS: readonly ChainInfo[] = [
  evm("ethereum", 1, "Ethereum", ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"], "https://etherscan.io"),
  evm("arbitrum", 42161, "Arbitrum", ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"], "https://arbiscan.io"),
  evm("optimism", 10, "Optimism", ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io", "https://optimism.drpc.org"], "https://optimistic.etherscan.io"),
  evm("base", 8453, "Base", ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"], "https://basescan.org"),
  evm("polygon", 137, "Polygon", ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"], "https://polygonscan.com", {symbol: "POL", decimals: 18}),
  evm("bsc", 56, "BNB Chain", ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org", "https://bsc.drpc.org"], "https://bscscan.com", {symbol: "BNB", decimals: 18}),
  evm("avalanche", 43114, "Avalanche", ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc", "https://avalanche.drpc.org"], "https://snowscan.xyz", {symbol: "AVAX", decimals: 18}),
  evm("zksync", 324, "zkSync Era", ["https://mainnet.era.zksync.io", "https://zksync.drpc.org"], "https://explorer.zksync.io"),
  evm("linea", 59144, "Linea", ["https://rpc.linea.build", "https://linea-rpc.publicnode.com"], "https://lineascan.build"),
  evm("scroll", 534352, "Scroll", ["https://rpc.scroll.io", "https://scroll-rpc.publicnode.com"], "https://scrollscan.com"),
  evm("unichain", 130, "Unichain", ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"], "https://uniscan.xyz"),
  evm("monad", 143, "Monad", ["https://rpc.monad.xyz", "https://monad-mainnet.drpc.org"], "https://monadscan.com", {symbol: "MON", decimals: 18}),
  evm("hyperevm", 999, "HyperEVM", ["https://rpc.hyperliquid.xyz/evm", "https://hyperliquid.drpc.org"], "https://hyperevmscan.io", {symbol: "HYPE", decimals: 18}),
  evm("gnosis", 100, "Gnosis", ["https://rpc.gnosischain.com", "https://gnosis-rpc.publicnode.com"], "https://gnosisscan.io", {symbol: "XDAI", decimals: 18}),
  evm("sonic", 146, "Sonic", ["https://rpc.soniclabs.com", "https://sonic-rpc.publicnode.com"], "https://sonicscan.org", {symbol: "S", decimals: 18}),
  evm("berachain", 80094, "Berachain", ["https://rpc.berachain.com", "https://berachain-rpc.publicnode.com"], "https://berascan.com", {symbol: "BERA", decimals: 18}),
  evm("celo", 42220, "Celo", ["https://forno.celo.org", "https://celo.drpc.org"], "https://celoscan.io", {symbol: "CELO", decimals: 18}),
  evm("plasma", 9745, "Plasma", ["https://rpc.plasma.to", "https://plasma.gateway.tenderly.co"], "https://plasmascan.to", {symbol: "XPL", decimals: 18}),
  evm("megaeth", 4326, "MegaETH", ["https://mainnet.megaeth.com/rpc", "https://megaeth.drpc.org"], "https://mega.etherscan.io"),
  evm("robinhood", 4663, "Robinhood Chain", ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"], "https://robin.etherscan.io"),
  evm("worldchain", 480, "World Chain", ["https://worldchain-mainnet.g.alchemy.com/public", "https://worldchain.drpc.org", "https://480.rpc.thirdweb.com"], "https://worldscan.org"),
  evm("sei", 1329, "Sei", ["https://evm-rpc.sei-apis.com", "https://sei-evm-rpc.publicnode.com"], "https://seiscan.io", {symbol: "SEI", decimals: 18}),
  evm("ink", 57073, "Ink", ["https://rpc-gel.inkonchain.com", "https://ink-rpc.publicnode.com"], "https://explorer.inkonchain.com"),
  evm("plume", 98866, "Plume", ["https://rpc.plume.org", "https://98866.rpc.thirdweb.com"], "https://explorer.plume.org", {symbol: "PLUME", decimals: 18}),
  evm("xlayer", 196, "X Layer", ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"], "https://www.okx.com/web3/explorer/xlayer", {symbol: "OKB", decimals: 18}),
  evm("mantle", 5000, "Mantle", ["https://rpc.mantle.xyz", "https://mantle-rpc.publicnode.com"], "https://mantlescan.xyz", {symbol: "MNT", decimals: 18}),
  evm("katana", 747474, "Katana", ["https://rpc.katana.network", "https://katana.drpc.org"]),
  evm("morph", 2818, "Morph", ["https://rpc.morphl2.io", "https://rpc-quicknode.morphl2.io"], "https://explorer.morphl2.io"),
  evm("flare", 14, "Flare", ["https://flare-api.flare.network/ext/C/rpc", "https://flare.rpc.thirdweb.com"], "https://flare-explorer.flare.network", {symbol: "FLR", decimals: 18}),
  // Arc pays gas in USDC; its native balance is 18-decimal at the EVM level.
  evm("arc", 5042, "Arc", ["https://rpc.mainnet.arc.io", "https://arc-rpc.publicnode.com"], undefined, {symbol: "USDC", decimals: 18}),
  // Elysium by Kinetiq: an Arbitrum Orbit chain on HyperEVM, native HYPE (swap2-assets catalog, Relay, LI.FI). History: its Blockscout (history-evm).
  evm("elysium", 99901, "Elysium", ["https://rpc.elysium.kinetiq.xyz", "https://elysium-rpc.publicnode.com", "https://elysium.drpc.org"], "https://elysium.kinetiq.xyz", {symbol: "HYPE", decimals: 18}),
];

export const NON_EVM_CHAINS: readonly ChainInfo[] = [
  {slug: "solana", caip2: "solana:mainnet", name: "Solana", family: "solana", native: {symbol: "SOL", decimals: 9}, rpc: ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"], explorer: "https://solscan.io"},
  {slug: "ton", caip2: "ton:-239", name: "TON", family: "ton", native: {symbol: "TON", decimals: 9}, rpc: [], explorer: "https://tonviewer.com"},
  {slug: "tron", caip2: "tron:728126428", name: "Tron", family: "tron", native: {symbol: "TRX", decimals: 6}, rpc: ["https://api.trongrid.io"], explorer: "https://tronscan.org"},
  {slug: "bitcoin", caip2: "bitcoin:mainnet", name: "Bitcoin", family: "btc", native: {symbol: "BTC", decimals: 8}, rpc: [], explorer: "https://mempool.space"},
  {slug: "near", caip2: "near:mainnet", name: "NEAR", family: "near", native: {symbol: "NEAR", decimals: 24}, rpc: ["https://rpc.mainnet.fastnear.com"], explorer: "https://nearblocks.io"},
  {slug: "zcash", caip2: "zcash:mainnet", name: "Zcash", family: "zcash", native: {symbol: "ZEC", decimals: 8}, rpc: [], explorer: "https://blockchair.com/zcash"},
];

/** Display order: the majors first, then the long tail. */
export const CHAINS: readonly ChainInfo[] = [
  ...EVM_CHAINS.slice(0, 4),
  ...NON_EVM_CHAINS,
  ...EVM_CHAINS.slice(4),
];

const BY_SLUG = new Map(CHAINS.map((c) => [c.slug, c]));
const BY_CAIP2 = new Map(CHAINS.map((c) => [c.caip2, c]));
const BY_CHAIN_ID = new Map(EVM_CHAINS.map((c) => [c.chainId!, c]));

export const chainBySlug = (slug: string): ChainInfo | undefined => BY_SLUG.get(slug);
export const chainByCaip2 = (caip2: string): ChainInfo | undefined => BY_CAIP2.get(caip2);
export const chainById = (chainId: number): ChainInfo | undefined => BY_CHAIN_ID.get(chainId);

export function explorerTxUrl(chain: ChainInfo, hash: string): string | undefined {
  if (!chain.explorer) return undefined;
  // Tronscan has no /tx/ route: /tx/<hash> lands on an empty page; tonviewer answers /tx/<hash> with 404.
  if (chain.family === "tron") return `${chain.explorer}/transaction/${hash}/overview`;
  if (chain.family === "ton") return `${chain.explorer}/transaction/${hash}`;
  return `${chain.explorer}/tx/${hash}`;
}

export function explorerAddressUrl(chain: ChainInfo, address: string): string | undefined {
  if (!chain.explorer) return undefined;
  // tonviewer has no /address/ segment.
  return chain.family === "ton" ? `${chain.explorer}/${address}` : `${chain.explorer}/address/${address}`;
}
