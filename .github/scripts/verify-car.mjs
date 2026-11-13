#!/usr/bin/env node
/**
 * Checks an IPFS CAR against the dist/ it claims to hold, without the tool that packed it (ipfs-car resolves its
 * dependency tree fresh from npm at release time, so its output is not trusted on its own). Plain Node, no
 * dependencies:
 * - the CAR's single root is the expected CID;
 * - every block's bytes hash (sha-256) to the digest its CID names;
 * - walking UnixFS from the root (dag-pb directories and files, raw leaves) gives exactly the files of the
 *   manifest — same paths, same sha-256 — and nothing else.
 * Sharded (HAMT) directories, other hash functions and other codecs are refused: fail closed.
 *
 *   node .github/scripts/verify-car.mjs <file.car> <root CID> <dist.files.sha256> [dist]
 * The manifest is `sha256sum` output over `./path` names, as the release workflow writes it from inside dist/.
 */
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const DAG_PB = 0x70;
const RAW = 0x55;
const SHA2_256 = 0x12;

/** @param {Uint8Array} b @param {number} at @returns {[number, number]} value, next offset */
function varint(b, at) {
  let v = 0;
  let shift = 0;
  for (let i = at; i < b.length; i++) {
    v += (b[i] & 0x7f) * 2 ** shift;
    if (!(b[i] & 0x80)) return [v, i + 1];
    shift += 7;
    if (shift > 49) break;
  }
  throw new Error("bad varint");
}

/** A CID at `at`: v0 (bare sha-256 multihash = dag-pb) or v1. @returns {{codec: number, digest: Uint8Array, bytes: Uint8Array, end: number}} */
function readCid(b, at) {
  if (b[at] === SHA2_256 && b[at + 1] === 0x20) {
    return {codec: DAG_PB, digest: b.subarray(at + 2, at + 34), bytes: b.subarray(at, at + 34), end: at + 34};
  }
  let [version, i] = varint(b, at);
  if (version !== 1) throw new Error(`CID version ${version}`);
  let codec;
  [codec, i] = varint(b, i);
  let hash;
  [hash, i] = varint(b, i);
  let len;
  [len, i] = varint(b, i);
  if (hash !== SHA2_256 || len !== 32) throw new Error(`unsupported multihash 0x${hash.toString(16)}/${len}`);
  return {codec, digest: b.subarray(i, i + len), bytes: b.subarray(at, i + len), end: i + len};
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Multibase base32 (lower, no padding): the "bafy…" text form of a CIDv1. */
export function cidText(bytes) {
  let out = "b";
  let acc = 0;
  let bits = 0;
  for (const x of bytes) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/** Minimal CBOR for the CAR v1 header {roots: [tag 42 bytes], version: 1}. @returns {[unknown, number]} */
function cbor(b, at) {
  const major = b[at] >> 5;
  const info = b[at] & 31;
  let i = at + 1;
  let n = info;
  if (info === 24) n = b[i++];
  else if (info === 25) (n = (b[i] << 8) | b[i + 1]), (i += 2);
  else if (info === 26) (n = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]), (i += 4);
  else if (info > 26) throw new Error("unsupported CBOR length");
  switch (major) {
    case 0:
      return [n, i];
    case 2:
      return [b.subarray(i, i + n), i + n];
    case 3:
      return [Buffer.from(b.subarray(i, i + n)).toString("utf8"), i + n];
    case 4: {
      const arr = [];
      for (let k = 0; k < n; k++) {
        let v;
        [v, i] = cbor(b, i);
        arr.push(v);
      }
      return [arr, i];
    }
    case 5: {
      const obj = {};
      for (let k = 0; k < n; k++) {
        let key;
        let v;
        [key, i] = cbor(b, i);
        [v, i] = cbor(b, i);
        obj[String(key)] = v;
      }
      return [obj, i];
    }
    case 6: {
      const [v, j] = cbor(b, i);
      return [{tag: n, value: v}, j];
    }
    default:
      throw new Error(`unsupported CBOR major type ${major}`);
  }
}

/** Protobuf fields of one message: [field number, wire type, value (number | bytes)]. */
function* fields(b) {
  let i = 0;
  while (i < b.length) {
    let key;
    [key, i] = varint(b, i);
    const wire = key & 7;
    const no = Math.floor(key / 8);
    if (wire === 0) {
      let v;
      [v, i] = varint(b, i);
      yield [no, wire, v];
    } else if (wire === 2) {
      let len;
      [len, i] = varint(b, i);
      yield [no, wire, b.subarray(i, i + len)];
      i += len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

/** dag-pb PBNode → {links: [{cid bytes, name}], data} */
function pbNode(bytes) {
  const links = [];
  let data = new Uint8Array();
  for (const [no, , v] of fields(bytes)) {
    if (no === 1) data = v;
    else if (no === 2) {
      let hash = null;
      let name = "";
      for (const [lno, , lv] of fields(v)) {
        if (lno === 1) hash = lv;
        else if (lno === 2) name = Buffer.from(lv).toString("utf8");
      }
      if (!hash) throw new Error("dag-pb link without a hash");
      links.push({hash, name});
    }
  }
  return {links, data};
}

/** UnixFS Data → {type, data} */
function unixfs(bytes) {
  let type = -1;
  let data = new Uint8Array();
  for (const [no, , v] of fields(bytes)) {
    if (no === 1) type = v;
    else if (no === 2) data = v;
  }
  return {type, data};
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hex = (b) => Buffer.from(b).toString("hex");

/**
 * Verify `car` (bytes) against the root `cid` and a manifest Map(path → sha256 hex). Throws with the first problem.
 * @param {Uint8Array} car @param {string} cid @param {Map<string, string>} manifest
 * @returns {{files: number, blocks: number}}
 */
export function verifyCar(car, cid, manifest) {
  const [hlen, h0] = varint(car, 0);
  const [header] = cbor(car.subarray(h0, h0 + hlen), 0);
  if (!header || header.version !== 1 || !Array.isArray(header.roots) || header.roots.length !== 1) throw new Error("not a single-root CAR v1");
  const rootTag = header.roots[0];
  if (rootTag?.tag !== 42 || !(rootTag.value instanceof Uint8Array) || rootTag.value[0] !== 0) throw new Error("malformed root CID");
  const rootBytes = rootTag.value.subarray(1);
  if (cidText(rootBytes) !== cid) throw new Error(`root is ${cidText(rootBytes)}, expected ${cid}`);

  /** digest hex → {codec, data} */
  const blocks = new Map();
  for (let i = h0 + hlen; i < car.length; ) {
    const [len, start] = varint(car, i);
    const c = readCid(car, start);
    const data = car.subarray(c.end, start + len);
    if (sha256(data) !== hex(c.digest)) throw new Error(`block ${cidText(c.bytes)} does not hash to its CID`);
    blocks.set(hex(c.digest), {codec: c.codec, data});
    i = start + len;
  }

  const found = new Map();
  const block = (cidBytes) => {
    const c = readCid(cidBytes, 0);
    const b = blocks.get(hex(c.digest));
    if (!b) throw new Error(`block ${cidText(c.bytes)} is missing`);
    if (b.codec !== c.codec) throw new Error(`block ${cidText(c.bytes)} codec mismatch`);
    return b;
  };
  /** A file's bytes: raw leaf, or a dag-pb File with inline data and/or children in order. */
  const fileBytes = (cidBytes) => {
    const b = block(cidBytes);
    if (b.codec === RAW) return [b.data];
    if (b.codec !== DAG_PB) throw new Error("unsupported codec in a file");
    const n = pbNode(b.data);
    const u = unixfs(n.data);
    if (u.type !== 2 && u.type !== 0) throw new Error(`expected a file node, got UnixFS type ${u.type}`);
    return [u.data, ...n.links.flatMap((l) => fileBytes(l.hash))];
  };
  const walk = (cidBytes, path) => {
    const b = block(cidBytes);
    if (b.codec === RAW) return void found.set(path, sha256(b.data));
    if (b.codec !== DAG_PB) throw new Error(`unsupported codec 0x${b.codec.toString(16)}`);
    const n = pbNode(b.data);
    const u = unixfs(n.data);
    if (u.type === 1) {
      for (const l of n.links) {
        if (!l.name || l.name.includes("/") || l.name === "." || l.name === "..") throw new Error(`bad entry name "${l.name}"`);
        walk(l.hash, `${path}/${l.name}`);
      }
    } else if (u.type === 2 || u.type === 0) {
      const h = createHash("sha256");
      for (const part of fileBytes(cidBytes)) h.update(part);
      found.set(path, h.digest("hex"));
    } else throw new Error(`unsupported UnixFS type ${u.type} at ${path || "/"} (sharded directories are refused)`);
  };
  walk(rootBytes, ".");

  for (const [path, sum] of manifest) {
    if (!found.has(path)) throw new Error(`${path} is in dist but not in the CAR`);
    if (found.get(path) !== sum) throw new Error(`${path} differs between dist and the CAR`);
  }
  for (const path of found.keys()) if (!manifest.has(path)) throw new Error(`${path} is in the CAR but not in dist`);
  return {files: found.size, blocks: blocks.size};
}

/** `sha256sum` lines ("<hex>  ./path") → Map(path → hex). */
export function readManifest(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](\.\/.+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [carPath, cid, manifestPath] = process.argv.slice(2);
  if (!carPath || !cid || !manifestPath) {
    console.error("usage: verify-car.mjs <file.car> <root CID> <dist.files.sha256> [dist]");
    process.exit(2);
  }
  try {
    const manifest = readManifest(readFileSync(manifestPath, "utf8"));
    if (!manifest.size) throw new Error("the manifest lists no files");
    const r = verifyCar(new Uint8Array(readFileSync(carPath)), cid, manifest);
    console.log(`OK: ${cid} holds exactly the ${r.files} files of dist (${r.blocks} blocks, every hash checked)`);
  } catch (e) {
    console.error(`CAR verification failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
