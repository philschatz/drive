/**
 * In-memory automerge-repo StorageAdapter for tests (keys = path arrays).
 * `loadRange([])` / `removeRange([])` cover the whole store, like the IndexedDB
 * adapter — the NodeFS adapter throws on an empty prefix, which is why app code
 * must never rely on it (see `strictEmptyPrefix`).
 */
export type StorageKey = string[];

export interface MemStorage {
  store: Map<string, { key: StorageKey; data: Uint8Array }>;
  load(key: StorageKey): Promise<Uint8Array | undefined>;
  save(key: StorageKey, data: Uint8Array): Promise<void>;
  saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  loadRange(prefix: StorageKey): Promise<{ key: StorageKey; data: Uint8Array }[]>;
  removeRange(prefix: StorageKey): Promise<void>;
  /** Every stored key, joined with '|', sorted. */
  keys(): string[];
}

export function makeMemStorage(opts: { strictEmptyPrefix?: boolean } = {}): MemStorage {
  const store = new Map<string, { key: StorageKey; data: Uint8Array }>();
  const id = (k: StorageKey) => k.join('\x00');
  const under = (prefix: StorageKey, key: StorageKey) => prefix.every((p, i) => key[i] === p);
  const guard = (prefix: StorageKey) => {
    if (opts.strictEmptyPrefix && prefix.length === 0) throw new Error('empty key prefix (NodeFS would throw)');
  };
  return {
    store,
    async load(k) { return store.get(id(k))?.data; },
    async save(k, data) { store.set(id(k), { key: [...k], data }); },
    async saveBatch(entries) { for (const [k, data] of entries) store.set(id(k), { key: [...k], data }); },
    async remove(k) { store.delete(id(k)); },
    async loadRange(prefix) {
      guard(prefix);
      return [...store.values()].filter((e) => under(prefix, e.key)).map((e) => ({ key: [...e.key], data: e.data }));
    },
    async removeRange(prefix) {
      guard(prefix);
      for (const [k, e] of [...store]) if (under(prefix, e.key)) store.delete(k);
    },
    keys() { return [...store.values()].map((e) => e.key.join('|')).sort(); },
  };
}

/** In-memory KVStore (the engine's `host.kv` surface). */
export function makeMemKv(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  return {
    map,
    get: async <T,>(k: string): Promise<T | null> => (map.has(k) ? (structuredClone(map.get(k)) as T) : null),
    set: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
    del: async (k: string) => { map.delete(k); },
    delPrefix: async (prefix: string) => { for (const k of [...map.keys()]) if (k.startsWith(prefix)) map.delete(k); },
    entries: async (): Promise<[string, unknown][]> => [...map.entries()].map(([k, v]) => [k, structuredClone(v)]),
    settingGet: async (name: string) => (map.get(`settings:${name}`) ?? null) as any,
    settingSet: async (name: string, value: unknown) => { map.set(`settings:${name}`, structuredClone(value)); },
  };
}
