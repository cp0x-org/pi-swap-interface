/**
 * The NEAR engine account (ARCHITECTURE.md D10, D11): what swap2-core's engine calls for a NEAR source, over an
 * injected NEAR wallet. A NEAR wallet builds, signs and broadcasts in one call (`signAndSendTransaction`: receiver +
 * actions), so there are no signed bytes to check afterwards. The transaction is therefore built HERE from the gated
 * write, held to it once more (checkNearTransaction: the exact receiver, token contract, amount and memo, and
 * nothing else), frozen, and only then handed to the wallet.
 *
 * NEAR Intents is the one NEAR venue: its deposit is a NEAR transfer to the quote's deposit address, or a NEP-141
 * `ft_transfer` to it (1 yoctoNEAR, 30 Tgas), preceded by the token's `storage_deposit` for that address when it is
 * not registered yet (the amount the token asks, at most 0.0125 NEAR) — what @anywalletkit/wallet-near sends.
 *
 * Before the wallet is asked, the account must hold the NEAR the transaction can cost (deposits + gas): a wallet error
 * before inclusion would otherwise read as "maybe sent". The wallet is reached only inside the signing window a gated
 * write opens (gated.ts), once per write. Its answer is checked too: a transaction hash, and the transaction it
 * reports — from the reviewed account, to the built receiver, with the built actions — not failed.
 */
import {UserRejectedError} from "@anywalletkit/core";
import {Swap2InsufficientGasError} from "@anywalletkit/protocol-swap2-core/errors";
import type {NearSourceSigner} from "../../contracts/execution";
import {base58ToBytes, base64ToBytes, isNearAccountId, nearAccount, nearView} from "../../catalog";
import {answered, isWalletRejection, refusal, WALLET_DECLINED_TEXT} from "../errors";
import {stableJson, SwapGateRefusal} from "../gate";
import type {SigningWindow} from "./solana";

const NEAR_MAINNET = "near:mainnet";
export const TGAS = 10n ** 12n;
/** Gas attached to `ft_transfer` (wallet-near FT_TRANSFER_GAS; ~12 Tgas used on mainnet). */
export const FT_TRANSFER_GAS = 30n * TGAS;
/** Gas attached to a NEP-145 `storage_deposit` (wallet-near STORAGE_DEPOSIT_GAS). */
export const STORAGE_DEPOSIT_GAS = 10n * TGAS;
/** The most a token may ask to register the deposit address: 0.0125 NEAR (wallet-near MAX_STORAGE_DEPOSIT). */
export const MAX_STORAGE_DEPOSIT = 12_500_000_000_000_000_000_000n;
/** What a token that names no `storage_balance_bounds` gets: 0.00125 NEAR, the common minimum. */
const DEFAULT_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;
/** Gas price the fee allowance assumes: 2.5× the protocol's floor of 10^8 yoctoNEAR per gas, where mainnet sits. */
const FEE_GAS_PRICE = 250_000_000n;
/** Gas on top of the attached gas for the transaction's own action fees (a Transfer burns under 0.5 Tgas). */
const TX_OVERHEAD_GAS = 5n * TGAS;

/** One write the engine asked for, as this account sends it. */
export type NearWrite =
  | {kind: "native"; to: string; amount: bigint}
  | {kind: "token"; token: string; recipient: string; amount: bigint; memo?: string};

/** The action shapes NEAR Connect's injected wallets take. */
export type NearAction =
  | {type: "Transfer"; params: {deposit: string}}
  | {type: "FunctionCall"; params: {methodName: string; args: Record<string, unknown>; gas: string; deposit: string}};

/** The transaction handed to the wallet (it adds the signer, nonce and block hash itself). */
export interface NearTx {
  receiverId: string;
  actions: NearAction[];
}

/** The chain reads the account makes: its NEAR, a token's NEP-145 storage registration. Injectable for tests. */
export interface NearReads {
  /** `view_account`: what the account can spend (catalog nearAccount); null = it doesn't exist. */
  account(accountId: string): Promise<{available: bigint} | null>;
  /** `storage_balance_of(account_id)`: null = not registered. */
  storageBalanceOf(token: string, accountId: string): Promise<unknown>;
  /** `storage_balance_bounds()`: `{min, max}`. */
  storageBalanceBounds(token: string): Promise<unknown>;
}

/** The reads over the NEAR RPCs the signer carries. */
export const nearReads = (urls: readonly string[]): NearReads => ({
  account: (accountId) => nearAccount(accountId, urls),
  storageBalanceOf: (token, accountId) => nearView(token, "storage_balance_of", {account_id: accountId}, urls),
  storageBalanceBounds: (token) => nearView(token, "storage_balance_bounds", {}, urls),
});

const DIGITS = /^\d{1,40}$/;

/** What the token asks to register an account, within MAX_STORAGE_DEPOSIT. */
async function storageDeposit(token: string, reads: NearReads): Promise<bigint> {
  let bounds: unknown;
  try {
    bounds = await reads.storageBalanceBounds(token);
  } catch (e) {
    throw refusal("Couldn't read what the token asks to register the deposit address — nothing was sent. Try again in a moment.", e);
  }
  const min = (bounds as {min?: unknown} | null)?.min;
  if (min === undefined) return DEFAULT_STORAGE_DEPOSIT;
  if (typeof min !== "string" || !DIGITS.test(min)) throw refusal("The token answered its registration price in a way that can't be read — nothing was sent.");
  const v = BigInt(min);
  if (v > MAX_STORAGE_DEPOSIT) throw refusal("The token asks more than 0.0125 NEAR to register the deposit address — nothing was sent.");
  return v;
}

/** The one transaction a write becomes: a NEAR transfer, or [storage_deposit when needed,] ft_transfer. */
export async function nearTransactionFor(w: NearWrite, reads: NearReads): Promise<NearTx> {
  if (w.kind === "native") return {receiverId: w.to, actions: [{type: "Transfer", params: {deposit: w.amount.toString()}}]};
  let registered: unknown;
  try {
    registered = await reads.storageBalanceOf(w.token, w.recipient);
  } catch (e) {
    throw refusal("Couldn't check the deposit address on the token — nothing was sent. Try again in a moment.", e);
  }
  const actions: NearAction[] = [];
  if (registered === null) {
    const deposit = await storageDeposit(w.token, reads);
    actions.push({
      type: "FunctionCall",
      params: {methodName: "storage_deposit", args: {account_id: w.recipient, registration_only: true}, gas: STORAGE_DEPOSIT_GAS.toString(), deposit: deposit.toString()},
    });
  } else if (!registered || typeof registered !== "object") {
    throw refusal("The token answered the deposit address's registration in a way that can't be read — nothing was sent.");
  }
  actions.push({
    type: "FunctionCall",
    params: {
      methodName: "ft_transfer",
      args: {receiver_id: w.recipient, amount: w.amount.toString(), ...(w.memo !== undefined ? {memo: w.memo} : {})},
      gas: FT_TRANSFER_GAS.toString(),
      deposit: "1",
    },
  });
  return {receiverId: w.token, actions};
}

const keysAre = (o: object, keys: readonly string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

/** A FunctionCall with exactly `method`, `args`, `gas`; its deposit, or null when the action is anything else. */
function callDeposit(a: NearAction | undefined, method: string, args: Record<string, unknown>, gas: bigint): string | null {
  if (!a || a.type !== "FunctionCall" || !keysAre(a, ["type", "params"]) || !keysAre(a.params, ["methodName", "args", "gas", "deposit"])) return null;
  const p = a.params;
  if (p.methodName !== method || p.gas !== gas.toString() || stableJson(p.args) !== stableJson(args)) return null;
  return typeof p.deposit === "string" && DIGITS.test(p.deposit) ? p.deposit : null;
}

/**
 * The gate's last word for NEAR: why `tx` is not exactly the reviewed `w`, or null. Native: one Transfer of the
 * amount to the deposit address. Token: a call to the token contract — `ft_transfer` of the amount to the deposit
 * address with the reviewed memo (none) and 1 yoctoNEAR, optionally preceded by `storage_deposit` registering that
 * same address for at most MAX_STORAGE_DEPOSIT. Nothing else, in that order.
 */
export function checkNearTransaction(tx: NearTx, w: NearWrite): string | null {
  if (!keysAre(tx, ["receiverId", "actions"]) || !Array.isArray(tx.actions)) return "the transaction is malformed";
  if (w.kind === "native") {
    if (tx.receiverId !== w.to) return "the transfer goes to another account";
    const [a, ...rest] = tx.actions;
    if (rest.length || !a || a.type !== "Transfer" || !keysAre(a, ["type", "params"]) || !keysAre(a.params, ["deposit"])) return "the transaction carries more than the transfer";
    return a.params.deposit === w.amount.toString() ? null : "the transfer is not the reviewed amount";
  }
  if (tx.receiverId !== w.token) return "the transfer is for another token";
  if (tx.actions.length < 1 || tx.actions.length > 2) return "the transaction carries more than the deposit";
  const ft = callDeposit(tx.actions.at(-1), "ft_transfer", {receiver_id: w.recipient, amount: w.amount.toString(), ...(w.memo !== undefined ? {memo: w.memo} : {})}, FT_TRANSFER_GAS);
  if (ft !== "1") return "the token transfer is not the reviewed one";
  if (tx.actions.length === 2) {
    const reg = callDeposit(tx.actions[0], "storage_deposit", {account_id: w.recipient, registration_only: true}, STORAGE_DEPOSIT_GAS);
    if (reg === null || BigInt(reg) > MAX_STORAGE_DEPOSIT) return "the transaction registers another account or pays too much for it";
  }
  return null;
}

/**
 * The most `tx` can take from the account: every attached deposit, plus the attached gas and TX_OVERHEAD_GAS at
 * FEE_GAS_PRICE — about 0.00125 NEAR on a Transfer, 0.011 NEAR on a token deposit that registers the address (MAX
 * keeps 0.05 NEAR back, swap/math.ts gasReserve).
 */
export function nearTxCost(tx: NearTx): bigint {
  let gas = TX_OVERHEAD_GAS;
  let deposits = 0n;
  for (const a of tx.actions) {
    deposits += BigInt(a.params.deposit);
    if (a.type === "FunctionCall") gas += BigInt(a.params.gas);
  }
  return deposits + gas * FEE_GAS_PRICE;
}

/** The account holds what `tx` can cost, or an answered refusal: nothing is handed to the wallet. */
async function assertFunds(tx: NearTx, accountId: string, reads: NearReads): Promise<void> {
  let funds: {available: bigint} | null;
  try {
    funds = await reads.account(accountId);
  } catch (e) {
    throw refusal("Couldn't read your NEAR balance — nothing was sent. Try again in a moment.", e);
  }
  if (!funds || funds.available < nearTxCost(tx))
    throw answered(new Swap2InsufficientGasError("Not enough NEAR for this deposit and its network fee — nothing was sent."));
}

/** A deep, frozen copy: nothing can change the transaction between the check and the wallet. */
function frozen<T>(v: T): T {
  const freeze = (x: unknown): void => {
    if (x && typeof x === "object" && !Object.isFrozen(x)) {
      Object.freeze(x);
      for (const k of Object.keys(x)) freeze((x as Record<string, unknown>)[k]);
    }
  };
  const copy = structuredClone(v);
  freeze(copy);
  return copy;
}

/** NEAR wallets' own words for "the user said no" (on top of the shared isWalletRejection). */
const REJECTED = /user (rejected|denied|declined|cancell?ed|closed)|rejected by (the )?user|cancell?ed by (the )?user/i;
const rejected = (e: unknown): boolean => isWalletRejection(e) || REJECTED.test(String((e as Error | null)?.message ?? e));

const short = (e: unknown): string => String((e as Error | null)?.message ?? e).slice(0, 120);

/** Something may have been broadcast: the engine tracks it (with the hash when there is one) and never retries. */
const maybeSentError = (message: string, cause?: unknown, hash?: string): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : {cause}), {maybeSent: true, ...(hash ? {hash} : {})});

const isTxHash = (h: unknown): h is string => {
  if (typeof h !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(h)) return false;
  try {
    return base58ToBytes(h).length === 32;
  } catch {
    return false;
  }
};

/**
 * An action as the RPC reports it (`{Transfer: {deposit}}`, `{FunctionCall: {method_name, args: base64 JSON, gas,
 * deposit}}`) in the shape built here; null for anything else.
 */
function fromRpcAction(a: unknown): NearAction | null {
  if (!a || typeof a !== "object" || Object.keys(a).length !== 1) return null;
  const {Transfer: t, FunctionCall: f} = a as {
    Transfer?: {deposit?: unknown} | null;
    FunctionCall?: {method_name?: unknown; args?: unknown; gas?: unknown; deposit?: unknown} | null;
  };
  if (t) return typeof t.deposit === "string" ? {type: "Transfer", params: {deposit: t.deposit}} : null;
  if (!f || typeof f.method_name !== "string" || typeof f.args !== "string" || typeof f.deposit !== "string") return null;
  const gas = typeof f.gas === "number" && Number.isSafeInteger(f.gas) ? String(f.gas) : f.gas;
  if (typeof gas !== "string") return null;
  try {
    const args: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(base64ToBytes(f.args)));
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    return {type: "FunctionCall", params: {methodName: f.method_name, args: args as Record<string, unknown>, gas, deposit: f.deposit}};
  } catch {
    return null;
  }
}

/**
 * The hash of what the wallet sent, from its answer (a FinalExecutionOutcome, or NEAR Connect's `{transactions: [it]}`),
 * once the answer is held to the reviewed transaction: sent by `signerId`, exactly `tx` (receiver and actions), and
 * not failed. An answer that doesn't show the signer, receiver and actions is unverified: tracked by its hash as maybe
 * sent, never reported to the venue as the reviewed deposit.
 */
export function sentHash(answer: unknown, signerId: string, tx: NearTx): string {
  const list = (answer as {transactions?: unknown} | null)?.transactions;
  const out = (Array.isArray(list) && list.length === 1 ? list[0] : answer) as {
    status?: unknown;
    transaction?: {hash?: unknown; signer_id?: unknown; receiver_id?: unknown; actions?: unknown} | null;
    transaction_outcome?: {id?: unknown} | null;
  } | null;
  const hash = [out?.transaction?.hash, out?.transaction_outcome?.id].find(isTxHash);
  if (!hash) throw maybeSentError("Your wallet didn't say which transaction it sent — it may still go through. Check your wallet before trying again.");
  const t = out?.transaction;
  if (!t || typeof t.signer_id !== "string" || typeof t.receiver_id !== "string" || !Array.isArray(t.actions))
    throw maybeSentError("Your wallet didn't show what it sent — it may still go through. Check your wallet before trying again.", undefined, hash);
  const actions = t.actions.map(fromRpcAction);
  if (t.signer_id !== signerId || actions.includes(null) || stableJson({receiverId: t.receiver_id, actions}) !== stableJson(tx))
    throw maybeSentError("Your wallet sent a transaction other than the reviewed one — check it in your wallet and don't try again.", undefined, hash);
  const status = out?.status;
  if (status && typeof status === "object" && "Failure" in status)
    throw refusal(`The NEAR transaction failed on chain (${short(JSON.stringify((status as {Failure: unknown}).Failure))}) — nothing reached the venue.`);
  return hash;
}

/** The wallet still lists the reviewed account (its injected API has no account events). Runs before each prompt. */
export async function assertNearAccount(signer: Pick<NearSourceSigner, "wallet" | "accountId">): Promise<void> {
  let answer: unknown;
  try {
    answer = await signer.wallet.getAccounts({network: "mainnet"});
  } catch (e) {
    throw refusal("Couldn't read your wallet's account — nothing was sent. Reconnect it and try again.", e);
  }
  const ids = Array.isArray(answer) ? answer.map((a) => (a as {accountId?: unknown} | null)?.accountId) : [];
  if (!ids.includes(signer.accountId)) throw refusal("Your wallet switched accounts — nothing was sent. Switch back to the account you reviewed.");
}

/** Every member the engine touches on a NEAR account (engine.md §5.2). */
export interface NearEngineAccount {
  /** "near:mainnet": the engine's account-chain check. */
  chain: string;
  getAddress(): Promise<string>;
  sendTransaction(tx: {to: string; value: bigint}): Promise<{hash: string}>;
  transfer(t: {token: string; recipient: string; amount: bigint; memo?: string}): Promise<{hash: string}>;
}

const only = (o: object, keys: readonly string[], what: string) => {
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !keys.includes(k)) throw refusal(`This ${what} carries a field (${k}) the swap never sends — nothing was sent.`);
};

/** Adapt a connected injected NEAR wallet to the engine account. `reads` defaults to the signer's NEAR RPCs. */
export function nearEngineAccount(signer: NearSourceSigner, window: SigningWindow, opts: {reads?: NearReads} = {}): NearEngineAccount {
  const accountId = signer.accountId;
  if (!isNearAccountId(accountId)) throw refusal("The wallet's account isn't a NEAR account id — nothing was sent.");
  const reads = opts.reads ?? nearReads(signer.rpcUrls);

  async function send(w: NearWrite): Promise<{hash: string}> {
    window.take();
    const target = w.kind === "native" ? w.to : w.recipient;
    if (!isNearAccountId(target) || (w.kind === "token" && !isNearAccountId(w.token)) || typeof w.amount !== "bigint" || w.amount <= 0n)
      throw refusal("This deposit has no valid target or amount — nothing was sent.");
    if (target === accountId) throw refusal("This deposit would pay your own account — nothing was sent.");
    if (w.kind === "token" && w.memo !== undefined && typeof w.memo !== "string") throw refusal("This deposit's memo is malformed — nothing was sent.");
    await assertNearAccount(signer);
    const tx = frozen(await nearTransactionFor(w, reads));
    const why = checkNearTransaction(tx, w);
    if (why) throw new SwapGateRefusal(`The NEAR transaction didn't match the reviewed route (${why}) — it was refused before signing.`);
    await assertFunds(tx, accountId, reads);
    let answer: unknown;
    try {
      answer = await signer.wallet.signAndSendTransaction({network: "mainnet", signerId: accountId, receiverId: tx.receiverId, actions: tx.actions});
    } catch (e) {
      if (rejected(e)) throw answered(Object.assign(new UserRejectedError(WALLET_DECLINED_TEXT), {cause: e}));
      // The wallet broadcasts itself: an error after the user approved may come after the transaction left.
      throw maybeSentError(`Your wallet didn't confirm the transaction (${short(e)}) — it may still go through. Check your wallet before trying again.`, e);
    }
    return {hash: sentHash(answer, accountId, tx)};
  }

  return {
    chain: NEAR_MAINNET,
    getAddress: async () => accountId,
    async sendTransaction(tx) {
      // A native NEAR transfer carries no memo: one the engine passes would be dropped, so it is refused here.
      only(tx, ["to", "value"], "transaction");
      return send({kind: "native", to: tx.to, amount: tx.value});
    },
    async transfer(t) {
      only(t, ["token", "recipient", "amount", "memo"], "transfer");
      return send({kind: "token", token: t.token, recipient: t.recipient, amount: t.amount, ...(t.memo !== undefined ? {memo: t.memo} : {})});
    },
  };
}
