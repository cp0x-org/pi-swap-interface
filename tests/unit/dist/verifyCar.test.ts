// @vitest-environment node
// The IPFS release's independent CAR check (.github/scripts/verify-car.mjs): a tiny UnixFS CAR is built here by hand
// (raw leaves, a chunked dag-pb file, a sub-directory), so the reader is tested against the format, not against the
// tool it double-checks.
import {createHash} from "node:crypto";
import {describe, expect, it} from "vitest";
import {cidText, readManifest, verifyCar} from "../../../.github/scripts/verify-car.mjs";

const enc = new TextEncoder();
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const hexSum = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const cat = (...parts: (Uint8Array | number[])[]) => new Uint8Array(parts.flatMap((p) => [...p]));
const cid = (codec: number, data: Uint8Array) => cat([1], varint(codec), [0x12, 0x20], sha(data));
const field = (no: number, bytes: Uint8Array) => cat(varint(no * 8 + 2), varint(bytes.length), bytes);
const vfield = (no: number, v: number) => cat(varint(no * 8), varint(v));
const unixfs = (type: number, data?: Uint8Array) => cat(vfield(1, type), data ? field(2, data) : []);
const pbNode = (links: {cid: Uint8Array; name?: string}[], data: Uint8Array) =>
  cat(...links.map((l) => field(2, cat(field(1, l.cid), l.name !== undefined ? field(2, enc.encode(l.name)) : []))), field(1, data));

interface Block {
  cid: Uint8Array;
  data: Uint8Array;
}
const raw = (text: string): Block => {
  const data = enc.encode(text);
  return {cid: cid(0x55, data), data};
};
const pb = (data: Uint8Array): Block => ({cid: cid(0x70, data), data});

/** CAR v1: varint(header) CBOR {roots: [tag42(0x00 ‖ cid)], version: 1}, then varint(len) cid ‖ data per block. */
function car(root: Uint8Array, blocks: Block[]): Uint8Array {
  const rootField = cat([0xd8, 42], [0x58, root.length + 1], [0], root);
  const header = cat([0xa2], [0x65], enc.encode("roots"), [0x81], rootField, [0x67], enc.encode("version"), [0x01]);
  return cat(varint(header.length), header, ...blocks.map((b) => cat(varint(b.cid.length + b.data.length), b.cid, b.data)));
}

function site() {
  const index = raw("<!doctype html><title>cp0x</title>");
  const partA = raw("console.log('a');");
  const partB = raw("console.log('b');");
  const app = pb(pbNode([{cid: partA.cid}, {cid: partB.cid}], unixfs(2)));
  const assets = pb(pbNode([{cid: app.cid, name: "app.js"}], unixfs(1)));
  const root = pb(pbNode([{cid: assets.cid, name: "assets"}, {cid: index.cid, name: "index.html"}], unixfs(1)));
  const manifest = new Map([
    ["./index.html", hexSum(index.data)],
    ["./assets/app.js", hexSum(cat(partA.data, partB.data))],
  ]);
  return {root, blocks: [root, assets, app, partA, partB, index], manifest, index};
}

describe("verify-car (IPFS release)", () => {
  it("accepts a CAR whose tree is exactly the manifest", () => {
    const s = site();
    expect(verifyCar(car(s.root.cid, s.blocks), cidText(s.root.cid), s.manifest)).toEqual({files: 2, blocks: 6});
    expect(cidText(s.root.cid)).toMatch(/^bafy/);
  });

  it("refuses another root, a tampered block, a changed file, an extra or a missing file", () => {
    const s = site();
    const good = car(s.root.cid, s.blocks);
    expect(() => verifyCar(good, "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", s.manifest)).toThrow(/root is/);
    const tampered = good.slice();
    tampered[tampered.length - 3] = tampered[tampered.length - 3]! ^ 1; // a byte of index.html
    expect(() => verifyCar(tampered, cidText(s.root.cid), s.manifest)).toThrow(/does not hash to its CID/);
    expect(() => verifyCar(good, cidText(s.root.cid), new Map([...s.manifest, ["./index.html", "0".repeat(64)]]))).toThrow(/index.html differs/);
    expect(() => verifyCar(good, cidText(s.root.cid), new Map([["./index.html", s.manifest.get("./index.html")!]]))).toThrow(/assets\/app.js is in the CAR but not in dist/);
    expect(() => verifyCar(good, cidText(s.root.cid), new Map([...s.manifest, ["./robots.txt", "0".repeat(64)]]))).toThrow(/robots.txt is in dist but not in the CAR/);
    expect(() => verifyCar(car(s.root.cid, s.blocks.filter((b) => b !== s.index)), cidText(s.root.cid), s.manifest)).toThrow(/is missing/);
  });

  it("refuses a sharded directory (fail closed)", () => {
    const leaf = raw("x");
    const hamt = pb(pbNode([{cid: leaf.cid, name: "00x"}], unixfs(5)));
    expect(() => verifyCar(car(hamt.cid, [hamt, leaf]), cidText(hamt.cid), new Map([["./x", hexSum(leaf.data)]]))).toThrow(/sharded directories are refused/);
  });

  it("reads sha256sum output", () => {
    expect(readManifest(`${"a".repeat(64)}  ./index.html\n${"b".repeat(64)}  ./assets/x y.js\n`)).toEqual(
      new Map([
        ["./index.html", "a".repeat(64)],
        ["./assets/x y.js", "b".repeat(64)],
      ]),
    );
  });
});
