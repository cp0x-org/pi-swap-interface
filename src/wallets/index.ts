/**
 * The wallets' public entry (contract: WalletsModule in src/contracts/modules.ts).
 * EVM through wagmi (EIP-6963 injected wallets, WalletConnect on demand),
 * Solana through Wallet Standard, Tron through injected wallets (TronLink:
 * TIP-6963 / window.tron), TON through TON Connect and NEAR through NEAR
 * Connect's injected wallets. The rest of the app sees connections as
 * WalletsState and gets a wallet only from `walletsPort.getSigner` (D11).
 */
export {walletsPort} from "./port";
export {familyOfCaip2} from "./family";
export {useConnectOptions} from "./useConnectOptions";
export {connectOptionGroups, WALLETCONNECT_ID, type ConnectOptionGroups} from "./options";
