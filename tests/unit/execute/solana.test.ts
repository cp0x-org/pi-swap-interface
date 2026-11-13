/**
 * The Wallet Standard → SDK signer bridge with a throwaway ed25519 key standing in for the wallet (engine.md §6.2
 * probe): the signature verifies; a wallet that alters the message, signs with another key, or is asked outside a
 * gated write is refused; a rejection is answered.
 */
import {describe, expect, it} from "vitest";
import {privateKeySigner} from "@anywalletkit/core";
import {
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  address,
  type Address,
} from "@solana/kit";
import type {Wallet, WalletAccount} from "@wallet-standard/base";
import {gateAccount} from "../../../src/execute/accounts/gated";
import {signingWindow, walletStandardSigner} from "../../../src/execute/accounts/solana";
import {isWalletRejection, WALLET_DECLINED_TEXT} from "../../../src/execute/errors";
import {createSwapGate, SwapGateRefusal} from "../../../src/execute/gate";

const random32 = () => crypto.getRandomValues(new Uint8Array(32));

async function keypair() {
  const k = privateKeySigner("ed25519", random32());
  const publicKey = await k.getPublicKey();
  return {k, publicKey, address: getAddressDecoder().decode(publicKey)};
}

/** A compiled v0 message paid by `payer` (what WalletAccountSolana hands its signer). */
function messageFor(payer: Address, data = new Uint8Array([1, 2, 3])) {
  const msg = pipe(
    createTransactionMessage({version: 0}),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n}, m),
    (m) => appendTransactionMessageInstruction({programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data}, m),
  );
  return new Uint8Array(compileTransaction(msg).messageBytes);
}

type Behaviour = "honest" | "mutate" | "otherKey" | "reject" | "noSignature";

async function fakeWallet(behaviour: Behaviour = "honest", versions: readonly ("legacy" | 0)[] = ["legacy", 0]) {
  const me = await keypair();
  const other = await keypair();
  const account: WalletAccount = {address: me.address, publicKey: me.publicKey, chains: ["solana:mainnet"], features: ["solana:signTransaction"]};
  const asked: Uint8Array[] = [];
  const wallet = {
    version: "1.0.0",
    name: "Throwaway",
    icon: "data:image/svg+xml;base64,AA==",
    chains: ["solana:mainnet"],
    accounts: [account],
    features: {
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: versions,
        signTransaction: async ({transaction}: {transaction: Uint8Array}) => {
          asked.push(transaction);
          if (behaviour === "reject") throw Object.assign(new Error("User rejected the request."), {code: 4001});
          const tx = getTransactionDecoder().decode(transaction);
          let messageBytes = new Uint8Array(tx.messageBytes);
          if (behaviour === "mutate") {
            messageBytes = messageBytes.slice();
            messageBytes[messageBytes.length - 1] = messageBytes.at(-1)! ^ 0xff;
          }
          const key = behaviour === "otherKey" ? other.k : me.k;
          const sig = await key.sign(messageBytes, {scheme: "ed25519"});
          // Signature slots are positional: "no signature" is an empty (all-zero) slot for the account.
          const signatures = {[me.address]: behaviour === "noSignature" ? null : sig};
          const out = getTransactionEncoder().encode({messageBytes, signatures} as never);
          return [{signedTransaction: new Uint8Array(out)}];
        },
      },
    },
  } as unknown as Wallet;
  return {wallet, account, me, asked};
}

const sign = (s: ReturnType<typeof walletStandardSigner>, bytes: Uint8Array) => s.sign(bytes, {scheme: "ed25519", context: "solana-message"});

describe("walletStandardSigner", () => {
  it("signs inside an open window; the signature verifies over the SDK's own bytes", async () => {
    const {wallet, account, me, asked} = await fakeWallet();
    const window = signingWindow();
    const signer = walletStandardSigner(wallet, account, window);
    const bytes = messageFor(me.address);
    window.open();
    const sig = await sign(signer, bytes);
    expect(sig).toHaveLength(64);
    expect(asked).toHaveLength(1);
    // The wallet was handed a wire tx with one empty signature slot followed by exactly our message.
    const handed = getTransactionDecoder().decode(asked[0]!);
    expect(new Uint8Array(handed.messageBytes)).toEqual(bytes);
    expect(Object.keys(handed.signatures)).toEqual([me.address]);
  });

  it("refuses outside a gated write, and a second signature in the same window — the wallet is never asked", async () => {
    const {wallet, account, me, asked} = await fakeWallet();
    const window = signingWindow();
    const signer = walletStandardSigner(wallet, account, window);
    await expect(sign(signer, messageFor(me.address))).rejects.toThrow(/outside a reviewed transaction/);
    window.open();
    await sign(signer, messageFor(me.address));
    await expect(sign(signer, messageFor(me.address))).rejects.toThrow(/outside a reviewed transaction/);
    window.close();
    expect(asked).toHaveLength(1);
  });

  it("refuses a wallet that changed the transaction before signing", async () => {
    const {wallet, account, me} = await fakeWallet("mutate");
    const window = signingWindow();
    window.open();
    await expect(sign(walletStandardSigner(wallet, account, window), messageFor(me.address))).rejects.toThrow(/changed the transaction/);
  });

  it("refuses a signature by another key (the SDK verifies it)", async () => {
    const {wallet, account, me} = await fakeWallet("otherKey");
    const window = signingWindow();
    window.open();
    await expect(sign(walletStandardSigner(wallet, account, window), messageFor(me.address))).rejects.toThrow();
  });

  it("refuses a wallet that returns no signature for the account", async () => {
    const {wallet, account, me} = await fakeWallet("noSignature");
    const window = signingWindow();
    window.open();
    await expect(sign(walletStandardSigner(wallet, account, window), messageFor(me.address))).rejects.toThrow(/no signature/);
  });

  it("a rejection is answered and reads as declined", async () => {
    const {wallet, account, me} = await fakeWallet("reject");
    const window = signingWindow();
    window.open();
    const e = await sign(walletStandardSigner(wallet, account, window), messageFor(me.address)).catch((x: unknown) => x);
    expect(isWalletRejection(e)).toBe(true);
    expect((e as {answered?: boolean}).answered).toBe(true);
    expect((e as Error).message).toBe(WALLET_DECLINED_TEXT);
  });

  it("refuses off-chain messages, a switched account, wallets without signTransaction or v0", async () => {
    const {wallet, account, me} = await fakeWallet();
    const window = signingWindow();
    const signer = walletStandardSigner(wallet, account, window);
    window.open();
    await expect(signer.sign(messageFor(me.address), {scheme: "ed25519", context: "solana-offchain"})).rejects.toThrow(/Only swap transactions/);
    window.open();
    (wallet as unknown as {accounts: WalletAccount[]}).accounts = [];
    await expect(sign(signer, messageFor(me.address))).rejects.toThrow(/switched accounts/);
    const legacyOnly = await fakeWallet("honest", ["legacy"]);
    expect(() => walletStandardSigner(legacyOnly.wallet, legacyOnly.account, window)).toThrow(/v0/);
    const none = {...legacyOnly.wallet, features: {}} as unknown as Wallet;
    expect(() => walletStandardSigner(none, legacyOnly.account, window)).toThrow(/solana:signTransaction/);
  });

  it("only a write that passed the gate opens the window", async () => {
    const {wallet, account, me, asked} = await fakeWallet();
    const window = signingWindow();
    const signer = walletStandardSigner(wallet, account, window);
    // An engine-account stand-in whose serialized send signs once, like WalletAccountSolana.sendSerialized.
    const inner = {
      chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      getAddress: async () => me.address,
      sendSerializedTransaction: async () => ({hash: "sig", fee: 5000n, raw: await sign(signer, messageFor(me.address))}),
    };
    const gate = createSwapGate("solana:mainnet");
    const gated = gateAccount(inner, gate, window);
    expect(gated.chain).toBe(inner.chain);
    await expect(gated.sendSerializedTransaction()).rejects.toBeInstanceOf(SwapGateRefusal);
    gate.arm([{kind: "serialized", tx: "AQID"}]);
    await expect((gated.sendSerializedTransaction as (tx: string) => Promise<unknown>)("AQIE")).rejects.toBeInstanceOf(SwapGateRefusal);
    gate.arm([{kind: "serialized", tx: "AQID"}]);
    await (gated.sendSerializedTransaction as (tx: string) => Promise<unknown>)("AQID");
    expect(asked).toHaveLength(1);
    // The window closed with the write.
    await expect(sign(signer, messageFor(me.address))).rejects.toThrow(/outside a reviewed transaction/);
  });
});
