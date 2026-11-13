/**
 * The Tron engine account (ARCHITECTURE.md D11, D20): a deposit route paid from an injected Tron wallet (TronLink).
 * It is reached only through gateAccount (gated.ts), so the TRX send or TRC-20 transfer it gets has already consumed
 * the armed write the reviewed plan made. From that transfer and a mainnet reference block it builds the exact
 * transaction itself (tronTx.ts) — the wallet and the API build nothing — holds the bytes to the transfer once more
 * (checkTronRaw), asks the wallet for one signature (`trx.sign`, which never broadcasts), keeps only that signature
 * and only if it recovers the payer over this txID, and broadcasts its own bytes through the runtime Tron API.
 *
 * This file and evm.ts / solana.ts are the only places in the app allowed to ask a wallet to sign (ESLint, D10).
 */
import {UserRejectedError} from "@anywalletkit/core";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {TronSourceSigner} from "../../contracts/execution";
import {TronApiError, bytesToHex, hexToBytes, tronAddressBytes, tronPost, tronPostTo} from "../../catalog";
import {answered, isWalletRejection, refusal, WALLET_DECLINED_TEXT} from "../errors";
import {FEE_CEILING, type MemoEncoding} from "../gate";
import {buildTronTx, checkTronRaw, signedTxHex, trc20TransferData, verifiedSignature, type RefBlock, type TronTransfer, type TronTx} from "../tronTx";

/** The Tron chain the catalog and the engine name. */
export const TRON_CHAIN = "tron:728126428";
/** A TRC-20 transfer may burn at most this much TRX for energy (`fee_limit`): the review's Tron fee ceiling, 60 TRX. */
export const TRON_FEE_LIMIT = FEE_CEILING.tron!;
/** The longest memo a payment carries (a Chainflip note is about 100 bytes). */
const MAX_MEMO_BYTES = 512;

/** Every member the engine touches on a Tron account. */
export interface TronEngineAccount {
  chain: string;
  getAddress(): Promise<string>;
  getBalance(): Promise<bigint>;
  /** A TRX deposit (+ memo). */
  sendTransaction(tx: {to: string; value: bigint; memo?: string; memoEncoding?: MemoEncoding}): Promise<{hash: string; fee: bigint}>;
  /** A TRC-20 deposit (+ memo). */
  transfer(t: {token: string; recipient: string; amount: bigint; memo?: string; memoEncoding?: MemoEncoding}): Promise<{hash: string; fee: bigint}>;
}

/** The node API calls the account makes, injectable for tests (default: the runtime Tron API, host by host). */
export interface TronApi {
  post<T>(path: string, body: unknown): Promise<T>;
  /** One host, for the broadcast: every host's answer counts there. */
  postTo<T>(base: string, path: string, body: unknown): Promise<T>;
}

const defaultApi = (urls: readonly string[]): TronApi => ({
  post: (path, body) => tronPost(path, body, urls),
  postTo: (base, path, body) => tronPostTo(base, path, body),
});

const only = (o: object, keys: readonly string[], what: string) => {
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !keys.includes(k)) throw refusal(`This ${what} carries a field (${k}) the swap never sends — nothing was sent.`);
};

/** The bytes a memo puts in `raw_data.data`. */
function memoBytes(memo: unknown, encoding: unknown): Uint8Array | undefined {
  if (memo === undefined) {
    if (encoding !== undefined) throw refusal("This payment names a memo encoding without a memo — nothing was sent.");
    return undefined;
  }
  if (typeof memo !== "string" || !memo) throw refusal("This payment's memo is malformed — nothing was sent.");
  let bytes: Uint8Array;
  if (encoding === "hex") {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(memo)) throw refusal("This payment's memo is malformed — nothing was sent.");
    bytes = hexToBytes(memo);
  } else if (encoding === undefined || encoding === "utf8") bytes = new TextEncoder().encode(memo);
  else throw refusal("This payment's memo encoding is unknown — nothing was sent.");
  if (bytes.length > MAX_MEMO_BYTES) throw refusal("This payment's memo is too long — nothing was sent.");
  return bytes;
}

/** The node's latest block as a reference block, checked for shape. */
async function refBlock(api: TronApi): Promise<RefBlock> {
  let b: {blockID?: unknown; block_header?: {raw_data?: {number?: unknown; timestamp?: unknown}}};
  try {
    b = await api.post("/wallet/getnowblock", {});
  } catch (e) {
    throw refusal("Couldn't reach the Tron network to build the payment — nothing was sent. Try again in a moment.", e);
  }
  const n = b.block_header?.raw_data?.number;
  const ts = b.block_header?.raw_data?.timestamp;
  if (typeof b.blockID !== "string" || !/^[0-9a-f]{64}$/i.test(b.blockID) || typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0 || typeof ts !== "number" || !Number.isSafeInteger(ts))
    throw refusal("The Tron API answered with a malformed block — nothing was sent.");
  // A reference block from the past would expire the payment before it lands; from the future, the node refuses it.
  if (Math.abs(ts - Date.now()) > 5 * 60_000) throw refusal("The Tron API's latest block is out of date — nothing was sent. Try again in a moment.");
  return {number: BigInt(n), id: b.blockID.toLowerCase(), timestamp: ts};
}

/** Answers that mean this node took no copy of the transaction (it neither stored nor relayed it). */
const REFUSED = new Set([
  "SIGERROR",
  "CONTRACT_VALIDATE_ERROR",
  "CONTRACT_EXE_ERROR",
  "BANDWITH_ERROR",
  "TAPOS_ERROR",
  "TOO_BIG_TRANSACTION_ERROR",
  "TRANSACTION_EXPIRATION_ERROR",
  "SERVER_BUSY",
  "NO_CONNECTION",
  "NOT_ENOUGH_EFFECTIVE_CONNECTION",
  "BLOCK_UNSOLIDIFIED",
]);

/** The node's message, which java-tron sends hex-encoded. */
function nodeMessage(m: unknown): string {
  if (typeof m !== "string") return "";
  if (/^(?:[0-9a-fA-F]{2})+$/.test(m)) {
    try {
      return new TextDecoder("utf-8", {fatal: true}).decode(hexToBytes(m));
    } catch {
      return m;
    }
  }
  return m;
}

/**
 * Broadcast our signed bytes to each Tron API host in turn until one takes them. Every host refusing them is a
 * definitive "not sent"; any answer we didn't get (a network error, a 5xx) means it may be on its way — the engine then
 * tracks the hash and never offers a retry.
 */
async function broadcast(api: TronApi, urls: readonly string[], tx: TronTx, sig: string): Promise<void> {
  const body = {transaction: signedTxHex(tx.raw_data_hex, sig)};
  let unknown: unknown = null;
  const refused: string[] = [];
  for (const base of urls) {
    let res: {result?: unknown; code?: unknown; message?: unknown};
    try {
      res = await api.postTo(base, "/wallet/broadcasthex", body);
    } catch (e) {
      // A 4xx without the node's JSON is a gateway in front of it refusing the request (403, 429): nothing was taken.
      if (e instanceof TronApiError && e.status >= 400 && e.status < 500) refused.push(`HTTP ${e.status}`);
      else unknown = e;
      continue;
    }
    if (res.result === true || res.code === "DUP_TRANSACTION_ERROR") return;
    const code = typeof res.code === "string" ? res.code : "";
    if (!REFUSED.has(code)) {
      unknown = new Error(`broadcast answered ${code || "without a result"}`);
      continue;
    }
    const why = nodeMessage(res.message);
    refused.push(`${code}${why ? `: ${why.slice(0, 120)}` : ""}`);
  }
  if (unknown !== null)
    throw Object.assign(new Error(`tron: the broadcast of ${tx.txID} wasn't confirmed (${String((unknown as Error | null)?.message ?? unknown).slice(0, 120)})`, {cause: unknown}), {
      maybeSent: true,
      hash: tx.txID,
    });
  throw refusal(`The Tron network refused the transaction (${refused.join("; ") || "no Tron API is configured"}) — nothing was sent.`);
}

/** Adapt a connected Tron wallet to the engine account. `api` defaults to the signer's Tron API hosts. */
export function tronEngineAccount(signer: TronSourceSigner, opts: {api?: TronApi} = {}): TronEngineAccount {
  const owner = signer.owner;
  if (!tronAddressBytes(owner)) throw refusal("The wallet's account isn't a Tron address — nothing was sent.");
  const api = opts.api ?? defaultApi(signer.apiUrls);

  /** Still the reviewed account, and a TronWeb that can sign: read again right before every prompt. */
  function signerFn(): (tx: TronTx) => Promise<unknown> {
    const tw = signer.tronWeb;
    if (tw.defaultAddress?.base58 !== owner) throw refusal("Your wallet switched accounts — nothing was sent. Switch back to the account you reviewed.");
    const trx = tw.trx;
    const sign = trx?.sign;
    if (typeof sign !== "function") throw refusal(`${signer.walletName} can't sign a Tron transaction here — nothing was sent.`);
    return (tx) => (sign as (t: TronTx) => Promise<unknown>).apply(trx, [tx]);
  }

  /** The wallet's dry run of a TRC-20 transfer: a revert (no balance, a frozen account) is refused before the prompt. */
  async function simulate(t: Extract<TronTransfer, {kind: "trc20"}>): Promise<void> {
    let r: {result?: {result?: unknown; message?: unknown}; transaction?: {ret?: {ret?: unknown}[]}};
    try {
      r = await api.post("/wallet/triggerconstantcontract", {
        owner_address: t.owner,
        contract_address: t.token,
        function_selector: "transfer(address,uint256)",
        parameter: bytesToHex(trc20TransferData(t.to, t.amount).slice(4), false),
        visible: true,
      });
    } catch {
      return; // A transport failure is not a refusal: the chain still checks it (parity with the EVM account).
    }
    if (r.result?.result === false || r.transaction?.ret?.[0]?.ret === "FAILED") {
      const why = nodeMessage(r.result?.message) || "it reverts";
      throw refusal(`The transfer would fail on-chain (${why.slice(0, 120)}) — nothing was sent.`);
    }
  }

  async function pay(t: TronTransfer): Promise<{hash: string; fee: bigint}> {
    signerFn(); // the account and the wallet's signing are checked before anything is fetched
    if (t.kind === "trc20") await simulate(t);
    const tx = buildTronTx(t, await refBlock(api));
    const why = checkTronRaw(tx.raw_data_hex, t);
    if (why) throw refusal(`The built transaction isn't the reviewed one (${why}) — nothing was sent.`);
    const sign = signerFn(); // and again right before the prompt
    let signed: unknown;
    try {
      // A copy: the wallet may annotate what it gets; the bytes we broadcast are ours.
      signed = await sign(structuredClone(tx));
    } catch (e) {
      // trx.sign never broadcasts: whatever went wrong, nothing was sent.
      if (isWalletRejection(e)) throw answered(Object.assign(new UserRejectedError(WALLET_DECLINED_TEXT), {cause: e}));
      throw refusal(`Your wallet couldn't sign the transaction (${String((e as Error | null)?.message ?? e).slice(0, 120)}) — nothing was sent.`, e);
    }
    const s = signed as {txID?: unknown; signature?: unknown} | null;
    if (!s || typeof s !== "object" || (s.txID !== undefined && s.txID !== tx.txID)) throw refusal("The wallet changed the transaction before signing it — nothing was sent.");
    if (!Array.isArray(s.signature) || s.signature.length !== 1) throw refusal("The wallet returned no single signature — nothing was sent.");
    const sig = await verifiedSignature(tx.txID, s.signature[0], owner);
    if (!sig) throw refusal("The wallet's signature isn't the reviewed account's over this transaction — nothing was sent.");
    await broadcast(api, signer.apiUrls, tx, sig);
    return {hash: tx.txID, fee: 0n};
  }

  return {
    chain: TRON_CHAIN,
    getAddress: async () => owner,
    async getBalance() {
      const a = await api.post<{balance?: unknown}>("/wallet/getaccount", {address: owner, visible: true});
      const sun = a.balance ?? 0;
      if (typeof sun !== "number" || !Number.isSafeInteger(sun) || sun < 0) throw new Error("tron: malformed balance");
      return BigInt(sun);
    },
    async sendTransaction(tx) {
      only(tx, ["to", "value", "memo", "memoEncoding"], "transaction");
      if (typeof tx.value !== "bigint" || tx.value <= 0n) throw refusal("This payment's amount is malformed — nothing was sent.");
      if (!tronAddressBytes(tx.to)) throw refusal("This payment's deposit address isn't a Tron address — nothing was sent.");
      const memo = memoBytes(tx.memo, tx.memoEncoding);
      return pay({kind: "trx", owner, to: tx.to, amount: tx.value, ...(memo ? {memo} : {})});
    },
    async transfer(t) {
      only(t, ["token", "recipient", "amount", "memo", "memoEncoding"], "transfer");
      if (typeof t.amount !== "bigint" || t.amount <= 0n) throw refusal("This payment's amount is malformed — nothing was sent.");
      if (!tronAddressBytes(t.recipient)) throw refusal("This payment's deposit address isn't a Tron address — nothing was sent.");
      // The token contract the catalog pins for Tron (USDT: TR7NH…): never one a venue named.
      if (!tronAddressBytes(t.token) || ccAssetByToken(TRON_CHAIN, t.token)?.contract !== t.token)
        throw refusal("This payment is for a token the app doesn't list on Tron — nothing was sent.");
      const memo = memoBytes(t.memo, t.memoEncoding);
      return pay({kind: "trc20", owner, token: t.token, to: t.recipient, amount: t.amount, feeLimit: TRON_FEE_LIMIT, ...(memo ? {memo} : {})});
    },
  };
}
