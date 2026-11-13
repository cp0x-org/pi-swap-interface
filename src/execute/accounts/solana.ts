/**
 * The Solana engine account (engine.md §6.2, ARCHITECTURE.md D18): the SDK's own WalletAccountSolana with the
 * Wallet Standard wallet as its external signer. The SDK builds the bytes, runs the serialized-tx guard
 * (`sendSerialized` → checkSerialized, bridgeOut included), simulates, enforces the 0.05 SOL fee cap and
 * broadcasts through the runtime RPC list; the wallet only signs (`solana:signTransaction`, never
 * signAndSend), and a signature over bytes the wallet altered fails the SDK's verification.
 *
 * The signer answers only inside an open signing window, which only a gated write opens (gated.ts): no other path
 * in the app can obtain a Solana signature from the wallet.
 */
import {externalSigner, UserRejectedError, type Signer, type TokenInfo} from "@anywalletkit/core";
import {
  serializedGuardFromExecution,
  WalletAccountSolana,
  type SerializedExecutionInput,
} from "@anywalletkit/wallet-solana";
import {getCompiledTransactionMessageDecoder, getTransactionDecoder, getTransactionEncoder, type Address} from "@solana/kit";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import {SolanaSignTransaction, type SolanaSignTransactionFeature} from "@solana/wallet-standard-features";
import type {SolanaSourceSigner} from "../../contracts/execution";
import {answered, isWalletRejection, refusal, WALLET_DECLINED_TEXT} from "../errors";

/** 0.05 SOL — the most a swap's Solana transaction may pay in fees (mobile send/gate FEE_CEILING.solana). */
export const SOLANA_FEE_CEILING = 50_000_000n;

/**
 * Open only while a gated write runs, and good for one signature per write: nothing else can make the wallet
 * sign, and one reviewed write never turns into two signatures.
 */
export function signingWindow() {
  let budget = 0;
  return {
    open: (): void => {
      budget = 1;
    },
    close: (): void => {
      budget = 0;
    },
    /** Spend the window's one signature, or refuse. */
    take: (): void => {
      if (budget <= 0) throw refusal("A signature was requested outside a reviewed transaction — nothing was signed.");
      budget -= 1;
    },
  };
}

/** One execution's signing window (signingWindow). */
export type SigningWindow = ReturnType<typeof signingWindow>;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The Wallet Standard wallet as an SDK Signer: wraps the compiled message the SDK built into an unsigned wire
 * transaction, asks `solana:signTransaction`, and returns the account's signature only when the wallet signed the
 * exact same message. externalSigner then verifies it against the public key over those bytes.
 */
export function walletStandardSigner(wallet: Wallet, account: WalletAccount, window: SigningWindow): Signer {
  const feature = (wallet.features as Partial<SolanaSignTransactionFeature>)[SolanaSignTransaction];
  if (!feature) throw refusal("This wallet can't sign without sending (solana:signTransaction) — use another wallet.");
  if (!feature.supportedTransactionVersions.includes(0)) throw refusal("This wallet can't sign v0 transactions — use another wallet.");
  return externalSigner({
    curve: "ed25519",
    publicKey: new Uint8Array(account.publicKey),
    async sign(messageBytes, {context}) {
      // The engine never asks for an off-chain message; only transactions are signed here.
      if (context !== "solana-message") throw refusal("Only swap transactions are signed here — nothing was signed.");
      window.take();
      if (!wallet.accounts.some((a) => a.address === account.address))
        throw refusal("Your wallet switched accounts — nothing was sent. Switch back to the account you reviewed.");
      const msg = getCompiledTransactionMessageDecoder().decode(messageBytes);
      if (msg.version !== 0 && msg.version !== "legacy") throw refusal("This transaction version can't be signed here — nothing was sent.");
      const signers = msg.staticAccounts.slice(0, msg.header.numSignerAccounts);
      // Empty signature slots in the message's signer order, as solana:signTransaction expects a wire transaction.
      const unsigned = getTransactionEncoder().encode({
        messageBytes,
        signatures: Object.fromEntries(signers.map((a) => [a, null])),
      } as unknown as Parameters<ReturnType<typeof getTransactionEncoder>["encode"]>[0]);
      let signedBytes: Uint8Array;
      try {
        const [out] = await feature.signTransaction({account, transaction: new Uint8Array(unsigned), chain: "solana:mainnet"});
        if (!out) throw new Error("The wallet returned nothing.");
        signedBytes = out.signedTransaction;
      } catch (e) {
        // signTransaction never broadcasts: whatever went wrong, nothing was sent.
        if (isWalletRejection(e)) throw answered(Object.assign(new UserRejectedError(WALLET_DECLINED_TEXT), {cause: e}));
        throw refusal(`Your wallet couldn't sign the transaction (${String((e as Error | null)?.message ?? e).slice(0, 120)}) — nothing was sent.`, e);
      }
      let signed: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
      try {
        signed = getTransactionDecoder().decode(signedBytes);
      } catch (e) {
        throw refusal("The wallet returned a transaction that can't be read — nothing was sent.", e);
      }
      if (!sameBytes(new Uint8Array(signed.messageBytes), new Uint8Array(messageBytes)))
        throw refusal("The wallet changed the transaction before signing it — nothing was sent.");
      const sig = signed.signatures[account.address as Address];
      if (!sig) throw refusal("The wallet returned no signature — nothing was sent.");
      return new Uint8Array(sig);
    },
  });
}

/** Every member the engine touches on a Solana account (engine.md §5.2). */
export interface SolanaEngineAccount {
  /** "solana:5eykt…" — the engine aliases it to solana:mainnet for its chain check. */
  chain: string;
  getAddress(): Promise<string>;
  getBalance(): Promise<bigint>;
  getTokenInfo(token: string): Promise<TokenInfo>;
  sendTransaction(tx: {to: string; value: bigint}): Promise<{hash: string; fee: bigint}>;
  transfer(t: {token: string; recipient: string; amount: bigint}): Promise<{hash: string; fee: bigint}>;
  sendSerializedTransaction(tx: string, expect: SerializedExecutionInput): Promise<{hash: string; fee: bigint}>;
}

const only = (o: object, keys: readonly string[], what: string) => {
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !keys.includes(k)) throw refusal(`This ${what} carries a field (${k}) the swap never sends — nothing was sent.`);
};

/** Adapt a connected Wallet Standard account to the engine account (SDK account + wallet as external signer). */
export function solanaEngineAccount(signer: SolanaSourceSigner, window: SigningWindow): SolanaEngineAccount {
  const publicKey = new Uint8Array(signer.account.publicKey);
  const sol = new WalletAccountSolana(walletStandardSigner(signer.wallet, signer.account, window), publicKey, "external", {
    provider: [...signer.rpcUrls], // failover list; a send is never re-signed, only re-sent
    transactionMaxFee: SOLANA_FEE_CEILING, // sendTransaction + sendSerialized
    transferMaxFee: SOLANA_FEE_CEILING, // transfer
  });
  if (sol.address !== signer.account.address) throw refusal("The wallet's account doesn't match its public key — nothing was sent.");
  return {
    chain: sol.chain,
    getAddress: () => sol.getAddress(),
    getBalance: () => sol.getBalance(),
    getTokenInfo: (t) => sol.getTokenInfo(t),
    async sendTransaction(tx) {
      only(tx, ["to", "value"], "transaction");
      const r = await sol.sendTransaction({to: tx.to, value: tx.value}); // a SOL deposit
      return {hash: r.hash, fee: r.fee};
    },
    async transfer(t) {
      only(t, ["token", "recipient", "amount"], "transfer");
      const r = await sol.transfer({token: t.token, recipient: t.recipient, amount: t.amount}); // an SPL deposit (+ATA)
      return {hash: r.hash, fee: r.fee};
    },
    async sendSerializedTransaction(tx, expect) {
      // Only through serializedGuardFromExecution: a hand mapping that drops bridgeOut checks a bridge against the SOL ceiling only.
      const r = await sol.sendSerialized(tx, serializedGuardFromExecution(expect));
      return {hash: r.hash, fee: r.fee};
    },
  };
}
