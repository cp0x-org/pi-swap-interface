/**
 * Address shapes and checks per family. `detectAddressFamily` / `shortAddress` are mobile lib/addressFormat.ts
 * verbatim and the TON helpers are mobile lib/dapp/ton.ts L46-95 verbatim (@756b115). `isAddressFor` /
 * `checkRecipient` are mobile lib/send/recipient.ts plus one web addition: the checksum each family carries is
 * verified (Bitcoin bech32/bech32m and base58check, Zcash and Tron base58check, TON CRC16, Solana = 32 bytes).
 * On the phone the chain account re-validates when it builds the transaction; here a typed refund or recipient
 * address goes straight to a venue, and a typo in a deposit payer's refund address loses the refund (D20).
 */
import {isAddress, sha256} from "viem";
import type {ChainFamily, Family, RecipientCheck} from "../contracts/domain";
import {base58ToBytes, base64ToBytes, bytesToBase64, bytesToHex} from "./bytes";

// ── mobile lib/addressFormat.ts (verbatim) ──────────────────────────────────────────────────────────────────────

/**
 * Which key family an address belongs to, by shape alone (no checksum or
 * network calls). Used for watch-only entry; a send re-validates per chain.
 */
export function detectAddressFamily(input: string): ChainFamily | null {
  const a = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "evm";
  if (/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a)) return "btc";
  if (/^t1[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return "zcash";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return "tron";
  if (/^[EU]Q[A-Za-z0-9_-]{46}$/.test(a) || /^-?\d:[0-9a-fA-F]{64}$/.test(a)) return "ton";
  if (/^[0-9a-f]{64}$/.test(a) || /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.near$/.test(a)) return "near";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "solana";
  return null;
}

/** 0x1234…abcd */
export function shortAddress(address: string, head = 6, tail = 4): string {
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;
}

// ── mobile lib/dapp/ton.ts L46-95 (verbatim) ────────────────────────────────────────────────────────────────────

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** User-friendly (EQ…/UQ…, base64 or base64url, checksum verified) or raw `wc:hex` → raw `wc:hex`. Null when invalid. */
export function toRawAddress(address: string): string | null {
  const a = address.trim();
  const raw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(a);
  if (raw) return `${Number(raw[1])}:${raw[2]!.toLowerCase()}`;
  if (a.length !== 48) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(a);
  } catch {
    return null;
  }
  if (bytes.length !== 36) return null;
  const crc = crc16(bytes.slice(0, 34));
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 0xff)) return null;
  const tag = bytes[0]! & 0x7f;
  if (tag !== 0x11 && tag !== 0x51) return null;
  const wc = bytes[1]! > 127 ? bytes[1]! - 256 : bytes[1]!;
  return `${wc}:${bytesToHex(bytes.slice(2, 34), false)}`;
}

/** Any valid form → user-friendly, non-bounceable (UQ…), url-safe. A friendly input is returned as given. Null when invalid. */
export function toFriendlyAddress(address: string): string | null {
  const raw = toRawAddress(address);
  if (!raw) return null;
  if (address.trim().length === 48) return address.trim();
  const [wc, hex] = raw.split(":") as [string, string];
  const bytes = new Uint8Array(36);
  bytes[0] = 0x51;
  bytes[1] = Number(wc) & 0xff;
  bytes.set(hex.match(/../g)!.map((h) => parseInt(h, 16)), 2);
  const crc = crc16(bytes.slice(0, 34));
  bytes[34] = crc >> 8;
  bytes[35] = crc & 0xff;
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

/** Two TON addresses in any form name the same account. */
export const sameTonAddress = (a: string, b: string): boolean => {
  const x = toRawAddress(a);
  return x !== null && x === toRawAddress(b);
};

// ── checksums (web) ─────────────────────────────────────────────────────────────────────────────────────────────

/** base58check payload (checksum stripped) or null when the string is not base58 or the double-SHA256 sum differs. */
function base58Check(a: string): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = base58ToBytes(a);
  } catch {
    return null;
  }
  if (bytes.length < 5) return null;
  const payload = bytes.slice(0, -4);
  const sum = sha256(sha256(payload, "bytes"), "bytes");
  for (let i = 0; i < 4; i++) if (bytes[bytes.length - 4 + i] !== sum[i]) return null;
  return payload;
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: readonly number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i]!;
  }
  return chk;
}

/** 5-bit groups → bytes, refusing non-zero padding (BIP-173 convertbits, pad = false). */
function fromWords(words: readonly number[]): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return out;
}

/** A mainnet segwit address (BIP-173 bech32 for v0, BIP-350 bech32m for v1+), lowercase. */
function segwitOk(a: string): boolean {
  if (a.length > 90 || !a.startsWith("bc1")) return false;
  const data = [...a.slice(3)].map((c) => BECH32.indexOf(c));
  if (data.length < 7 || data.some((d) => d < 0)) return false;
  const hrp = [3, 3, 0, 2, 3]; // "bc" expanded: high bits, 0, low bits
  const version = data[0]!;
  if (version > 16) return false;
  if (polymod([...hrp, ...data]) !== (version === 0 ? 1 : BECH32M_CONST)) return false;
  const program = fromWords(data.slice(1, -6));
  if (!program || program.length < 2 || program.length > 40) return false;
  return version !== 0 || program.length === 20 || program.length === 32;
}

/** base58check with a 20-byte hash behind the given version prefix. */
function versioned(a: string, prefixes: readonly (readonly number[])[]): boolean {
  const p = base58Check(a);
  return !!p && prefixes.some((v) => p.length === v.length + 20 && v.every((b, i) => p[i] === b));
}

function solanaKey(a: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  try {
    return base58ToBytes(a).length === 32;
  } catch {
    return false;
  }
}

/** The family's own checksum over an address whose shape already matched (`detectAddressFamily`). */
function checksumOk(family: ChainFamily, a: string): boolean {
  switch (family) {
    case "btc":
      return a.startsWith("bc1") ? segwitOk(a) : versioned(a, [[0x00], [0x05]]);
    case "zcash":
      return versioned(a, [[0x1c, 0xb8]]);
    case "tron":
      return versioned(a, [[0x41]]);
    case "ton":
      return toRawAddress(a) !== null;
    case "solana":
      return solanaKey(a);
    case "near":
    case "evm":
      return true;
  }
}

// ── mobile lib/send/recipient.ts (+ checksums, + extra families) ───────────────────────────────────────────────

const FAMILY_LABEL: Readonly<Record<Family, string>> = {
  evm: "EVM",
  solana: "Solana",
  ton: "TON",
  tron: "Tron",
  btc: "Bitcoin",
  near: "NEAR",
  zcash: "Zcash",
  ltc: "Litecoin",
  doge: "Dogecoin",
  xrp: "XRP",
  bch: "Bitcoin Cash",
  cosmos: "Cosmos",
  cardano: "Cardano",
  stellar: "Stellar",
  aptos: "Aptos",
  sui: "Sui",
};

const SHARED_FAMILIES: ReadonlySet<Family> = new Set<Family>(["evm", "solana", "ton", "tron", "btc", "near", "zcash"]);
const isShared = (f: Family): f is ChainFamily => SHARED_FAMILIES.has(f);
const article = (label: string) => (/^[AEIOU]/.test(label) || label === "XRP" ? "an" : "a");

/** A dotted name without spaces that is not itself an address: `vitalik.eth`, `alice.base.eth`, `x.cb.id`. */
function looksLikeName(s: string): boolean {
  return /^[^\s./]+(\.[^\s./]+)+$/.test(s) && !s.startsWith("0x");
}

/**
 * Does `address` belong to `family`, checksum included? EVM: viem strict (EIP-55 when mixed case). The
 * catalog-only families (LTC, XRP…) have no validator yet, so nothing passes for them — they stay behind
 * VITE_EXTRA_CHAINS until one exists.
 */
export function isAddressFor(family: Family, address: string): boolean {
  const a = address.trim();
  if (family === "evm") return isAddress(a, {strict: true});
  if (family === "solana") return solanaKey(a);
  if (!isShared(family)) return false;
  return detectAddressFamily(a) === family && checksumOk(family, a);
}

/** What a recipient / refund field holds for one family, with the reason in the user's words when it is not usable. */
export function checkRecipient(input: string, family: Family): RecipientCheck {
  let a = input.trim();
  if (!a) return {kind: "empty"};
  // BIP-173 allows an all-uppercase bech32 address (BIP-21 QR codes use it for compact encoding); mixed case is not
  // allowed and stays refused. The lowercase form is what is validated and handed on.
  if (family === "btc" && /^BC1[0-9A-Z]+$/.test(a)) a = a.toLowerCase();
  if (isAddressFor(family, a)) return {kind: "address", address: a};
  if (family === "evm" && /^0x[0-9a-fA-F]{40}$/.test(a)) return {kind: "invalid", reason: "Checksum mismatch — this address has a typo."};
  // NEAR named accounts (alice.near) are addresses; ENS names only stand in for EVM addresses.
  if (family === "evm" && looksLikeName(a)) return {kind: "name", name: a.toLowerCase()};
  const label = FAMILY_LABEL[family];
  if (!isShared(family)) return {kind: "invalid", reason: `${label} addresses can't be checked here yet.`};
  const other = detectAddressFamily(a);
  if (other === family && family !== "solana") return {kind: "invalid", reason: "Checksum mismatch — this address has a typo."};
  // Name another family only for a valid address of it: by shape alone any base58 run "looks like" Solana or Bitcoin.
  if (other && other !== family && isAddressFor(other, a)) {
    const o = FAMILY_LABEL[other];
    return {kind: "invalid", reason: `That's ${article(o)} ${o} address — this asset is on ${label}.`};
  }
  // Names (ENS) are refused for swaps, so the EVM text doesn't suggest one would do.
  return {kind: "invalid", reason: `Not ${article(label)} ${label} address.`};
}
