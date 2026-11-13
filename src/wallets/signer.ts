/**
 * getSigner(caip2): the only way execution gets a wallet (D11). EVM: switch
 * the wallet to the pay chain first (a prompt), bind a wallet client to it,
 * and refuse smart-contract accounts on that chain (D10). Solana: the
 * connected Wallet Standard account, which must sign without sending. Tron:
 * the connected wallet's TronWeb, still showing the connected account and not
 * on a test network. TON: the connected TON Connect wallet, on mainnet. NEAR:
 * the connected injected wallet and account (mainnet only). Every refusal is
 * an answered Error in the user's words: nothing was sent.
 */
import type {Address, Chain as ViemChain, PublicClient, WalletClient} from "viem";
import type {SourceSigner} from "../contracts/execution";
import {answered, isAnswered} from "./errors";
import {assertNotContract} from "./evm/account";
import type {EvmCurrent} from "./evm/runtime";
import {NEAR_MAINNET, SOLANA_MAINNET_CHAINS, TON_MAINNET, TRON_MAINNET_CHAINS, evmChainIdOf, familyOfCaip2} from "./family";
import type {NearCurrent} from "./near/runtime";
import type {SolanaCurrent} from "./solana/runtime";
import {signTransactionFeature} from "./solana/standard";
import type {TronCurrent} from "./tron/runtime";
import type {TonCurrent} from "./ton/runtime";

export interface SignerDeps {
  /** Resolves once the boot reconnect ended (capped), so a reload's persisted wallet is live. */
  ready(): Promise<void>;
  evm: {
    current(): EvmCurrent | null;
    switchTo(chainId: number): Promise<void>;
    walletClient(chainId: number, account: Address): Promise<WalletClient>;
  };
  solana: {current(): SolanaCurrent | null};
  tron: {current(): TronCurrent | null};
  ton: {ready(): Promise<void>; current(): TonCurrent | null};
  tonApiUrl(): string;
  near: {current(): NearCurrent | null};
  chainName(caip2: string): string;
  viemChain(chainId: number): ViemChain | undefined;
  publicClient(chainId: number): PublicClient;
  evmRpcUrls(chainId: number): readonly string[];
  solanaRpcUrls(): readonly string[];
  tronApiUrls(): readonly string[];
  nearRpcUrls(): readonly string[];
}

export const NOT_CONNECTED_TEXT = {
  evm: "Connect an EVM wallet first.",
  solana: "Connect a Solana wallet first.",
  tron: "Connect a Tron wallet first.",
  ton: "Connect a TON wallet first.",
  near: "Connect a NEAR wallet first.",
} as const;

export const switchText = (chainName: string): string => `Switch your wallet to ${chainName} to swap.`;

const isChainMismatch = (e: unknown): boolean =>
  (e as {name?: unknown} | null)?.name === "ConnectorChainMismatchError" || /chain mismatch|does not match the target chain/i.test(String((e as Error)?.message ?? ""));

export function createGetSigner(d: SignerDeps): (caip2: string) => Promise<SourceSigner> {
  async function evmSigner(caip2: string, name: string): Promise<SourceSigner> {
    const id = evmChainIdOf(caip2);
    const chain = id === null ? undefined : d.viemChain(id);
    if (!chain) throw answered(`${name} isn't supported here.`);
    await d.ready();
    const before = d.evm.current();
    if (!before) throw answered(NOT_CONNECTED_TEXT.evm);
    // Before the switch prompt: a Safe user should not be asked to switch only to be refused.
    const pub = d.publicClient(chain.id);
    await assertNotContract(pub, before.address, name);
    try {
      await d.evm.switchTo(chain.id);
    } catch (e) {
      throw isAnswered(e) ? e : answered(switchText(name), e);
    }
    // Read again: switching can also change the account in some wallets.
    const conn = d.evm.current();
    if (!conn) throw answered(NOT_CONNECTED_TEXT.evm);
    if (conn.address !== before.address) await assertNotContract(pub, conn.address, name);
    let wallet: WalletClient;
    try {
      wallet = await d.evm.walletClient(chain.id, conn.address);
    } catch (e) {
      if (isAnswered(e)) throw e;
      throw answered(isChainMismatch(e) ? switchText(name) : "Your wallet didn't answer — open it and try again.", e);
    }
    return {family: "evm", wallet, pub, chain, rpcUrls: d.evmRpcUrls(chain.id), owner: conn.address, transport: conn.transport};
  }

  function solanaSigner(caip2: string, name: string): SourceSigner {
    if (!SOLANA_MAINNET_CHAINS.includes(caip2)) throw answered(`${name} isn't supported here.`);
    const c = d.solana.current();
    if (!c) throw answered(NOT_CONNECTED_TEXT.solana);
    const sign = signTransactionFeature(c.wallet);
    if (typeof sign?.signTransaction !== "function" || !sign.supportedTransactionVersions?.includes(0))
      throw answered(`${c.wallet.name} can't sign a Solana transaction without sending it — connect another wallet.`);
    return {family: "solana", wallet: c.wallet, account: c.account, rpcUrls: d.solanaRpcUrls()};
  }

  function tronSigner(caip2: string, name: string): SourceSigner {
    if (!TRON_MAINNET_CHAINS.includes(caip2)) throw answered(`${name} isn't supported here.`);
    const c = d.tron.current();
    if (!c) throw answered(NOT_CONNECTED_TEXT.tron);
    if (c.network === "test") throw answered(`${c.wallet.name} is on a Tron test network — switch it to mainnet to swap.`);
    const tronWeb = c.wallet.tronWeb();
    if (!tronWeb) throw answered(`${c.wallet.name} isn't ready — unlock it and try again.`);
    // The account it would sign with now: a switch inside the wallet after connecting must not pay from another one.
    if (c.wallet.account() !== c.address) throw answered("Your wallet switched accounts — nothing was sent. Switch back to the account you connected.");
    return {family: "tron", tronWeb, owner: c.address, walletName: c.wallet.name, apiUrls: d.tronApiUrls()};
  }

  async function tonSigner(caip2: string, name: string): Promise<SourceSigner> {
    if (caip2 !== TON_MAINNET) throw answered(`${name} isn't supported here.`);
    await d.ton.ready();
    const c = d.ton.current();
    if (!c) throw answered(NOT_CONNECTED_TEXT.ton);
    return {family: "ton", address: c.address, rawAddress: c.rawAddress, walletName: c.walletName, sender: c.connector, tonApiUrl: d.tonApiUrl()};
  }

  function nearSigner(caip2: string, name: string): SourceSigner {
    if (caip2 !== NEAR_MAINNET) throw answered(`${name} isn't supported here.`);
    const c = d.near.current();
    if (!c) throw answered(NOT_CONNECTED_TEXT.near);
    return {family: "near", wallet: c.wallet, accountId: c.accountId, rpcUrls: d.nearRpcUrls()};
  }

  return async (caip2) => {
    const name = d.chainName(caip2);
    const family = familyOfCaip2(caip2);
    if (family === "evm") return evmSigner(caip2, name);
    if (family === "solana") return solanaSigner(caip2, name);
    if (family === "tron") return tronSigner(caip2, name);
    if (family === "ton") return tonSigner(caip2, name);
    if (family === "near") return nearSigner(caip2, name);
    throw answered(`No wallet signs on ${name} here — pay it from a deposit address instead.`);
  };
}
