/**
 * The Tron transaction a wallet signs, built here and nowhere else (D10, D20): a TRX send (`TransferContract`) or a
 * TRC-20 `transfer(address,uint256)` (`TriggerSmartContract`) — the only two a deposit route makes — encoded as the
 * exact protobuf `Transaction.raw` from the gate-checked transfer and a mainnet reference block. Also its JSON twin
 * (what TronLink shows and re-encodes), the txID (sha256 of the raw bytes), a strict decoder that holds a raw
 * transaction to the transfer it was built from, and the signature check: secp256k1 over the txID must recover the
 * payer. Nothing a wallet, a venue or the API hands back is used without one of these checks.
 *
 * Pure (viem's hashes and ABI codec) — tests/unit/execute/tron.test.ts runs it against node-built vectors.
 */
import {encodeFunctionData, erc20Abi, recoverAddress, sha256} from "viem";
import {bytesToHex, hexToBytes, tronAddressBytes} from "../catalog";

/** What a Tron deposit moves, as the gate consumed it. `memo` = the bytes `raw.data` carries. */
export type TronTransfer =
  | {kind: "trx"; owner: string; to: string; amount: bigint; memo?: Uint8Array}
  | {kind: "trc20"; owner: string; token: string; to: string; amount: bigint; memo?: Uint8Array; feeLimit: bigint};

/** The block a transaction is pinned to (TAPOS): valid only on the chain that has this block. */
export interface RefBlock {
  number: bigint;
  /** blockID, 64 hex chars. */
  id: string;
  /** Block time, unix ms. */
  timestamp: number;
}

/** A transaction in the node API's `visible: false` JSON form (hex addresses), as TronWeb and TronLink take it. */
export interface TronTx {
  visible: false;
  txID: string;
  raw_data: Record<string, unknown>;
  raw_data_hex: string;
}

const TRANSFER = {type: 1, name: "TransferContract"} as const;
const TRIGGER = {type: 31, name: "TriggerSmartContract"} as const;
const typeUrl = (name: string) => `type.googleapis.com/protocol.${name}`;

/** How long a built transaction stays valid after its reference block: time to read the wallet's prompt. */
export const TRON_TX_TTL_MS = 10 * 60_000;
/** The node refuses an expiration further than this past its head block. */
const MAX_EXPIRATION_MS = 24 * 3_600_000;

// ── protobuf, the subset Transaction.raw needs ───────────────────────────────────────────────────────────────────

function varint(n: bigint): number[] {
  if (n < 0n) throw new Error("tron: negative varint");
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
const key = (field: number, wire: 0 | 2) => varint(BigInt((field << 3) | wire));
const lenField = (field: number, bytes: Uint8Array | readonly number[]) => [...key(field, 2), ...varint(BigInt(bytes.length)), ...bytes];
/** A varint field; a zero value is left out, as protobuf serializers do (and TronWeb's re-encoding expects). */
const intField = (field: number, v: bigint) => (v === 0n ? [] : [...key(field, 0), ...varint(v)]);
const utf8 = (s: string) => new TextEncoder().encode(s);

/** A decoded field: varint value or length-delimited bytes. */
type Field = {field: number; int?: bigint; bytes?: Uint8Array};

/** Strict reader: wire types 0 and 2 only, no truncation, no trailing bytes. */
function readFields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const readVarint = (): bigint => {
    let n = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (i >= buf.length || shift > 63n) throw new Error("tron: bad varint");
      const b = buf[i++]!;
      n |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return n;
    }
  };
  while (i < buf.length) {
    const k = readVarint();
    const field = Number(k >> 3n);
    const wire = Number(k & 7n);
    if (wire === 0) out.push({field, int: readVarint()});
    else if (wire === 2) {
      const len = Number(readVarint());
      if (i + len > buf.length) throw new Error("tron: truncated field");
      out.push({field, bytes: buf.slice(i, i + len)});
      i += len;
    } else throw new Error(`tron: wire type ${wire}`);
  }
  return out;
}

/** Fields by number; refuses an unknown field, a repeated one and the wrong wire type. */
function fieldsOf(buf: Uint8Array, known: Readonly<Record<number, "int" | "bytes">>): Map<number, Field> {
  const map = new Map<number, Field>();
  for (const f of readFields(buf)) {
    const kind = known[f.field];
    if (!kind) throw new Error(`tron: unexpected field ${f.field}`);
    if ((kind === "int") !== (f.int !== undefined)) throw new Error(`tron: field ${f.field} has the wrong type`);
    if (map.has(f.field)) throw new Error(`tron: field ${f.field} repeated`);
    map.set(f.field, f);
  }
  return map;
}

// ── build ────────────────────────────────────────────────────────────────────────────────────────────────────────

const addr = (a: string, what: string): Uint8Array => {
  const b = tronAddressBytes(a);
  if (!b) throw new Error(`tron: ${what} is not a Tron address`);
  return b;
};

/** transfer(to, amount) calldata, the to-address as its 20 bytes (TRC-20 is the EVM ABI). */
export const trc20TransferData = (to: string, amount: bigint): Uint8Array =>
  hexToBytes(encodeFunctionData({abi: erc20Abi, functionName: "transfer", args: [bytesToHex(addr(to, "the recipient").slice(1)) as `0x${string}`, amount]}));

const safeNumber = (v: bigint, what: string): number => {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`tron: ${what} out of range`);
  return Number(v);
};

/** The contract message and its JSON value for a transfer. */
function contractOf(t: TronTransfer): {type: typeof TRANSFER | typeof TRIGGER; value: number[]; json: Record<string, unknown>} {
  const owner = addr(t.owner, "the payer");
  if (t.amount <= 0n) throw new Error("tron: the amount is not positive");
  if (t.kind === "trx") {
    const to = addr(t.to, "the recipient");
    return {
      type: TRANSFER,
      value: [...lenField(1, owner), ...lenField(2, to), ...intField(3, t.amount)],
      json: {owner_address: bytesToHex(owner, false), to_address: bytesToHex(to, false), amount: safeNumber(t.amount, "the amount")},
    };
  }
  const token = addr(t.token, "the token");
  const data = trc20TransferData(t.to, t.amount);
  return {
    type: TRIGGER,
    value: [...lenField(1, owner), ...lenField(2, token), ...lenField(4, data)],
    json: {owner_address: bytesToHex(owner, false), contract_address: bytesToHex(token, false), data: bytesToHex(data, false)},
  };
}

/** The reference block fields (TAPOS): the low 2 bytes of its number, bytes 8-16 of its id. */
function refOf(b: RefBlock): {bytes: Uint8Array; hash: Uint8Array} {
  if (!/^[0-9a-fA-F]{64}$/.test(b.id) || b.number <= 0n) throw new Error("tron: malformed reference block");
  const n = Number(b.number & 0xffffn);
  return {bytes: new Uint8Array([n >> 8, n & 0xff]), hash: hexToBytes(b.id.slice(16, 32))};
}

/** txID: sha256 of the raw bytes, 64 hex chars. */
export const tronTxId = (raw: Uint8Array): string => sha256(raw).slice(2);

/** The transaction for `t`, pinned to `ref`, expiring TRON_TX_TTL_MS after it; `now` stamps it. */
export function buildTronTx(t: TronTransfer, ref: RefBlock, now = Date.now()): TronTx {
  const c = contractOf(t);
  const r = refOf(ref);
  const expiration = BigInt(ref.timestamp + TRON_TX_TTL_MS);
  const contract = [...intField(1, BigInt(c.type.type)), ...lenField(2, [...lenField(1, utf8(typeUrl(c.type.name))), ...lenField(2, c.value)])];
  const feeLimit = t.kind === "trc20" ? t.feeLimit : 0n;
  if (t.kind === "trc20" && feeLimit <= 0n) throw new Error("tron: a TRC-20 transfer needs a fee limit");
  const raw = new Uint8Array([
    ...lenField(1, r.bytes),
    ...lenField(4, r.hash),
    ...intField(8, expiration),
    ...(t.memo?.length ? lenField(10, t.memo) : []),
    ...lenField(11, contract),
    ...intField(14, BigInt(now)),
    ...intField(18, feeLimit),
  ]);
  const rawData: Record<string, unknown> = {
    ref_block_bytes: bytesToHex(r.bytes, false),
    ref_block_hash: bytesToHex(r.hash, false),
    expiration: safeNumber(expiration, "the expiration"),
    ...(t.memo?.length ? {data: bytesToHex(t.memo, false)} : {}),
    contract: [{parameter: {value: c.json, type_url: typeUrl(c.type.name)}, type: c.type.name}],
    timestamp: now,
    ...(feeLimit ? {fee_limit: safeNumber(feeLimit, "the fee limit")} : {}),
  };
  return {visible: false, txID: tronTxId(raw), raw_data: rawData, raw_data_hex: bytesToHex(raw, false)};
}

// ── check ────────────────────────────────────────────────────────────────────────────────────────────────────────

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Why the raw transaction is not exactly `t` (one contract of the expected type, from the payer, to the reviewed
 * recipient or token, the reviewed amount and memo, a fee limit within `t.feeLimit`, no permission id, no extra
 * field, an expiration ahead of `now`), or null. Run on every transaction before the wallet is asked to sign it.
 */
export function checkTronRaw(rawHex: string, t: TronTransfer, now = Date.now()): string | null {
  try {
    const raw = fieldsOf(hexToBytes(rawHex), {1: "bytes", 4: "bytes", 8: "int", 10: "bytes", 11: "bytes", 14: "int", 18: "int"});
    if (raw.get(1)?.bytes?.length !== 2 || raw.get(4)?.bytes?.length !== 8) return "the reference block is malformed";
    const expiration = raw.get(8)?.int ?? 0n;
    if (expiration <= BigInt(now) || expiration > BigInt(now + MAX_EXPIRATION_MS)) return "the expiration is out of range";
    if (!sameBytes(raw.get(10)?.bytes ?? new Uint8Array(), t.memo ?? new Uint8Array())) return "the memo isn't the reviewed one";
    const contract = fieldsOf(raw.get(11)!.bytes!, {1: "int", 2: "bytes"});
    const any = fieldsOf(contract.get(2)?.bytes ?? new Uint8Array(), {1: "bytes", 2: "bytes"});
    const url = new TextDecoder().decode(any.get(1)?.bytes ?? new Uint8Array());
    const value = any.get(2)?.bytes ?? new Uint8Array();
    const fee = raw.get(18)?.int ?? 0n;
    const owner = tronAddressBytes(t.owner);
    if (t.kind === "trx") {
      if (contract.get(1)?.int !== BigInt(TRANSFER.type) || url !== typeUrl(TRANSFER.name)) return "it is not a TRX transfer";
      if (fee !== 0n) return "a TRX transfer with a fee limit";
      const v = fieldsOf(value, {1: "bytes", 2: "bytes", 3: "int"});
      if (!sameBytes(v.get(1)?.bytes, owner ?? undefined)) return "it pays from another account";
      if (!sameBytes(v.get(2)?.bytes, tronAddressBytes(t.to) ?? undefined)) return "it pays another address";
      if (v.get(3)?.int !== t.amount) return "it moves another amount";
      return null;
    }
    if (contract.get(1)?.int !== BigInt(TRIGGER.type) || url !== typeUrl(TRIGGER.name)) return "it is not a token transfer";
    if (fee <= 0n || fee > t.feeLimit) return "the fee limit is out of range";
    const v = fieldsOf(value, {1: "bytes", 2: "bytes", 3: "int", 4: "bytes"});
    if (!sameBytes(v.get(1)?.bytes, owner ?? undefined)) return "it pays from another account";
    if (!sameBytes(v.get(2)?.bytes, tronAddressBytes(t.token) ?? undefined)) return "it calls another token contract";
    if ((v.get(3)?.int ?? 0n) !== 0n) return "it attaches TRX to the token transfer";
    if (!sameBytes(v.get(4)?.bytes, trc20TransferData(t.to, t.amount))) return "the token transfer isn't the reviewed recipient and amount";
    return null;
  } catch (e) {
    return `it can't be read (${String((e as Error | null)?.message ?? e).slice(0, 80)})`;
  }
}

/**
 * The 65-byte signature (r ‖ s ‖ v; v 27/28, or 0/1 from a Ledger) a wallet returned, as hex, when it signs `txID`
 * for `owner`; null otherwise. The only thing taken from a signed transaction the wallet hands back.
 */
export async function verifiedSignature(txID: string, signature: unknown, owner: string): Promise<string | null> {
  if (typeof signature !== "string") return null;
  const sig = signature.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(sig) || !["00", "01", "1b", "1c"].includes(sig.slice(128).toLowerCase())) return null;
  const me = tronAddressBytes(owner);
  if (!me || !/^[0-9a-fA-F]{64}$/.test(txID)) return null;
  try {
    const signer = await recoverAddress({hash: `0x${txID}`, signature: `0x${sig}`});
    return signer.toLowerCase() === bytesToHex(me.slice(1)).toLowerCase() ? sig.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The signed `Transaction` protobuf (raw + one signature) as hex, for `/wallet/broadcasthex`: our bytes, never the wallet's. */
export const signedTxHex = (rawHex: string, sig: string): string => bytesToHex(new Uint8Array([...lenField(1, hexToBytes(rawHex)), ...lenField(2, hexToBytes(sig))]), false);
