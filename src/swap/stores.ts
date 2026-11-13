/**
 * Durable provider state in the browser (providers.md §5, D16): one raw
 * IndexedDB database `cp0x-swap`, store `kv`, rows `{key, value, until}`.
 *
 * - Relay's cleared-order record `rc:<orderId>` (until the order deadline):
 *   one deposit per order across reloads. Fail-closed: when storage cannot be
 *   opened the store throws, so Relay refuses to sign rather than fall back to
 *   memory only.
 * - Omniston's quote rows `oq:<id>` and HTLC secret rows `os:<id>` (6 h). The
 *   browser is the only holder of the secret, so writes commit with
 *   durability "strict" before the order it locks is signed; a TON escrow is
 *   signed only once execute's gate read its secret back from here and found
 *   the escrow's hashlock is its hash (D35, execute/omnistonEscrow.ts).
 *
 * The database opens lazily on first use, so building providers stays
 * synchronous and a page that never signs never touches storage.
 */
import type {RelayClearedStore} from "@anywalletkit/protocol-swap2-relay/provider";
import type {HtlcSecretStore, OmnistonQuoteStore} from "@anywalletkit/protocol-swap2-omniston/provider";

export interface ProviderStores {
  relayCleared: RelayClearedStore;
  omnistonQuotes: OmnistonQuoteStore & {claim(quoteId: string, valueJson: string): Promise<boolean>};
  omnistonSecrets: HtlcSecretStore;
  /** True once IndexedDB is open; false when it cannot be (storage blocked, private mode…). Never rejects. */
  ready(): Promise<boolean>;
}

const DB_NAME = "cp0x-swap";
const DB_VERSION = 1;
const KV = "kv";
/** = the server's STATE_TTL_MS and Omniston's CACHE_TTL_MS: longer than any HTLC window (max 300 s). */
const OMNISTON_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60_000;

/** What a signature refused for lack of storage says (Relay surfaces the store's error as the refusal). */
export const STORAGE_BLOCKED = "Enable site storage to use Relay: this browser blocks it, so the one-deposit-per-order check can't be kept.";

interface Row {
  key: string;
  value: unknown;
  until: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available");
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(KV, {keyPath: "key"}).createIndex("until", "until");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB open failed"));
    r.onblocked = () => reject(new Error("cp0x-swap storage is blocked by another tab"));
  });
}

/** One transaction; resolves when it COMMITS (not when the request succeeds). */
function run<T>(db: IDBDatabase, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, mode, mode === "readwrite" ? {durability: "strict"} : undefined);
    let out: T | undefined;
    const req = body(tx.objectStore(KV));
    if (req) req.onsuccess = () => void (out = req.result);
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error ?? new Error("storage transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("storage transaction aborted"));
  });
}

/** Lazy, synchronous to create (buildProviders stays synchronous). */
export function createProviderStores(): ProviderStores {
  let dbp: Promise<IDBDatabase> | undefined;
  let lastSweep = 0;
  let persisted = false;
  const db = () => (dbp ??= openDb());

  const sweep = async (d: IDBDatabase) => {
    const now = Date.now();
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    await run(d, "readwrite", (s) => {
      const c = s.index("until").openCursor(IDBKeyRange.upperBound(now));
      c.onsuccess = () => {
        const cur = c.result;
        if (cur) {
          cur.delete();
          cur.continue();
        }
      };
    }).catch(() => {});
  };
  const get = async (key: string): Promise<Row | undefined> => (await run<Row>(await db(), "readonly", (s) => s.get(key))) ?? undefined;
  const put = async (row: Row) => {
    const d = await db();
    await run(d, "readwrite", (s) => s.put(row));
    await sweep(d);
  };
  const del = async (key: string) => {
    await run(await db(), "readwrite", (s) => s.delete(key));
  };

  const q = (id: string) => `oq:${id}`;
  const s = (id: string) => `os:${id}`;
  const r = (id: string) => `rc:${id.toLowerCase()}`;
  // Relay: any storage failure becomes the one refusal text (the SDK refuses the signature on a throwing store).
  const relay = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw new Error(STORAGE_BLOCKED, {cause: e});
    }
  };

  return {
    ready: () => db().then(
      () => true,
      () => false,
    ),
    relayCleared: {
      has: (orderId) =>
        relay(async () => {
          const row = await get(r(orderId));
          return !!row && row.until > Date.now();
        }),
      add: (orderId, expiresAtMs) => relay(() => put({key: r(orderId), value: 1, until: expiresAtMs})),
    },
    omnistonQuotes: {
      save: (id, json) => put({key: q(id), value: json, until: Date.now() + OMNISTON_TTL_MS}),
      load: async (id) => {
        const row = await get(q(id));
        return typeof row?.value === "string" ? row.value : undefined;
      },
      clear: (id) => del(q(id)),
      /** Atomic create-if-absent: IDB `add` fails with ConstraintError when the key exists. */
      async claim(id, json) {
        const d = await db();
        const ok = await new Promise<boolean>((resolve, reject) => {
          const tx = d.transaction(KV, "readwrite", {durability: "strict"});
          let created = true;
          const req = tx.objectStore(KV).add({key: q(id), value: json, until: Date.now() + OMNISTON_TTL_MS} satisfies Row);
          req.onerror = (e) => {
            if (req.error?.name === "ConstraintError") {
              created = false;
              e.preventDefault();
              e.stopPropagation();
            }
          };
          tx.oncomplete = () => resolve(created);
          tx.onerror = () => reject(tx.error ?? new Error("storage transaction failed"));
          tx.onabort = () => reject(tx.error ?? new Error("storage transaction aborted"));
        });
        await sweep(d);
        return ok;
      },
    },
    omnistonSecrets: {
      async save(id, secretsHex) {
        await put({key: s(id), value: [...secretsHex], until: Date.now() + OMNISTON_TTL_MS});
        // Ask once, and only when a secret exists (Firefox prompts for it): eviction would lose the only copy.
        if (!persisted) {
          persisted = true;
          if (typeof navigator !== "undefined") void navigator.storage?.persist?.().catch(() => {});
        }
      },
      load: async (id) => {
        const row = await get(s(id));
        return Array.isArray(row?.value) ? (row.value as string[]) : undefined;
      },
      clear: (id) => del(s(id)),
    },
  };
}
