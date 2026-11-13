import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {IDBFactory, IDBKeyRange} from "fake-indexeddb";
import {STORAGE_BLOCKED, createProviderStores} from "../../../src/swap/stores";

const g = globalThis as {indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange};
const realIdb = g.indexedDB;

beforeEach(() => {
  // A fresh, empty database per test.
  g.indexedDB = new IDBFactory();
  g.IDBKeyRange = IDBKeyRange;
});
afterEach(() => {
  g.indexedDB = realIdb;
});

const keys = async (): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const r = g.indexedDB!.open("cp0x-swap", 1);
    r.onsuccess = () => {
      const req = r.result.transaction("kv").objectStore("kv").getAllKeys();
      req.onsuccess = () => {
        resolve(req.result as string[]);
        r.result.close();
      };
      req.onerror = () => reject(req.error);
    };
    r.onerror = () => reject(r.error);
  });

describe("Relay cleared-order store", () => {
  it("records an order until its deadline, ids case-insensitive", async () => {
    const s = createProviderStores();
    expect(await s.ready()).toBe(true);
    expect(await s.relayCleared.has("0xABC")).toBe(false);
    await s.relayCleared.add("0xABC", Date.now() + 60_000);
    expect(await s.relayCleared.has("0xabc")).toBe(true);
  });

  it("survives a reload (a new store over the same database)", async () => {
    await createProviderStores().relayCleared.add("0xorder", Date.now() + 60_000);
    expect(await createProviderStores().relayCleared.has("0xorder")).toBe(true);
  });

  it("an expired record no longer counts, and the sweep removes it", async () => {
    const s = createProviderStores();
    await s.relayCleared.add("0xold", Date.now() - 1);
    expect(await s.relayCleared.has("0xold")).toBe(false);
    // The first write of a fresh store sweeps (then at most once a minute).
    await createProviderStores().relayCleared.add("0xnew", Date.now() + 60_000);
    expect(await keys()).toEqual(["rc:0xnew"]);
  });
});

describe("fail-closed without storage", () => {
  it("no IndexedDB: ready() is false and Relay's store throws the storage refusal", async () => {
    delete g.indexedDB;
    const s = createProviderStores();
    expect(await s.ready()).toBe(false);
    await expect(s.relayCleared.has("0x1")).rejects.toThrow(STORAGE_BLOCKED);
    await expect(s.relayCleared.add("0x1", Date.now() + 1)).rejects.toThrow(STORAGE_BLOCKED);
  });

  it("an open that errors (storage blocked) behaves the same", async () => {
    g.indexedDB = {
      open: () => {
        const req = {error: new DOMException("blocked", "SecurityError")} as unknown as IDBOpenDBRequest;
        queueMicrotask(() => req.onerror?.(new Event("error")));
        return req;
      },
    } as unknown as IDBFactory;
    const s = createProviderStores();
    expect(await s.ready()).toBe(false);
    await expect(s.relayCleared.has("0x1")).rejects.toThrow(STORAGE_BLOCKED);
  });
});

describe("Omniston stores", () => {
  it("claim is atomic create-if-absent", async () => {
    const s = createProviderStores();
    expect(await s.omnistonQuotes.claim("q1", '{"a":1}')).toBe(true);
    expect(await s.omnistonQuotes.claim("q1", '{"a":2}')).toBe(false);
    expect(await s.omnistonQuotes.load("q1")).toBe('{"a":1}');
  });

  it("quotes and secrets are kept apart and cleared independently", async () => {
    const s = createProviderStores();
    await s.omnistonQuotes.save("q2", "{}");
    await s.omnistonSecrets.save("q2", ["aa", "bb"]);
    expect(await s.omnistonSecrets.load("q2")).toEqual(["aa", "bb"]);
    await s.omnistonQuotes.clear("q2");
    expect(await s.omnistonQuotes.load("q2")).toBeUndefined();
    expect(await s.omnistonSecrets.load("q2")).toEqual(["aa", "bb"]);
    await s.omnistonSecrets.clear("q2");
    expect(await s.omnistonSecrets.load("q2")).toBeUndefined();
  });
});
