// Copied from cp0x-elysium apps/mobile/lib/dapp/bytes.ts @756b115 (verbatim + one eslint directive). Owner: catalog.
/**
 * Byte encodings the dapp bridges speak: hex (EVM), base64 (Solana wire
 * transactions, TON BoCs), base58 (Solana addresses and signatures). Pure —
 * no RN, no Buffer global; unit-tested in bytes.test.ts.
 */

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("Not a hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array, prefix = true): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return prefix ? `0x${s}` : s;
}

export const isHexString = (v: unknown): v is string => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v);

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

/** Standard or URL-safe base64, padding optional. Throws on anything else. */
export function base64ToBytes(b64: string): Uint8Array {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (s.length % 4 === 1) throw new Error("Not base64");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) throw new Error("Not base64");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export const isBase64 = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length === 0) return false;
  try {
    base64ToBytes(v);
    return true;
  } catch {
    return false;
  }
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

export function bytesToBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58ToBytes(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let n = 0n;
  for (const ch of s) {
    const v = B58_INDEX.get(ch);
    if (v === undefined) throw new Error("Not base58");
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...body]);
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Strict UTF-8 decode; null for invalid bytes. */
export function utf8Decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Text a person can read and judge: valid UTF-8 with no control characters
 * other than tab / LF / CR. Anything else is shown as hex with a warning —
 * decoded mojibake would mislead.
 */
export function readableText(bytes: Uint8Array): string | null {
  const s = utf8Decode(bytes);
  if (s === null) return null;
  // U+FFFD too: Hermes' TextDecoder polyfill ignores `fatal` and substitutes instead of throwing.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/.test(s) ? null : s;
}
