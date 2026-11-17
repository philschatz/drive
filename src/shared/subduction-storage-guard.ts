/**
 * Keep automerge-repo's compaction from deleting records its document still
 * needs.
 *
 * The Repo's subduction source garbage-collects its store: after every save or
 * inbound batch it lists the stored commits and fragments that are not part of
 * the document's current shape — its loose commits and its fragments, as
 * Automerge reports them — and deletes them, on the reasoning that such a
 * record has been absorbed into a fragment. Two assumptions hide in that, and
 * with a blob interceptor neither holds:
 *
 * - *A stored record is already in the document.* Without an interceptor it is:
 *   inbound records are applied in the tick they are stored. With one, each is
 *   decrypted asynchronously first. A peer pushes twenty commits; the first few
 *   are applied; that starts a compaction pass; the pass sees sixteen stored
 *   commits the document does not have, and deletes them while their decryption
 *   is still in flight. The decrypted bytes are applied a moment later.
 * - *The list is still true when the deletes run.* The pass decides what is
 *   stale first and deletes afterwards, concurrently and bounded. A fragment
 *   that had arrived but not been applied when the list was made can be applied
 *   — and so be a live part of the document — by the time its delete runs.
 *
 * Either way the document ends up complete and the store this device syncs
 * from does not: the source remembers having seen those records and never
 * writes them back. Nothing looks wrong on this device. But a device that
 * later needs them from this one — a newly added member, when their author is
 * gone — gets a history with holes and can never finish loading the document.
 * (Both seen in tests/e2ee-coedit.test.ts, the co-editing soak — run it after
 * upgrading automerge-repo or subduction. The only built-in protection covers
 * records whose decryption *failed*.)
 *
 * The guard sits where the deletes land: the storage adapter handed to the
 * Repo. A delete of a stored commit or fragment goes through only if, at that
 * moment, the document contains the change, the record is no longer part of
 * the document's shape, and every fragment that is part of it is itself in the
 * store (so whatever absorbed the record can stand in for it). Otherwise it is
 * refused with an error, which the compaction pass treats as "try again next
 * time" — and next time the list is made afresh.
 */
import { createLogger } from './logger';

const log = createLogger('doc-sync');

/** The store prefix automerge-repo uses when a blob interceptor is set (subduction/storage.ts). */
export const SUBDUCTION_STORE_PREFIX = 'subduction-interceptor';
// Record kinds under it, keyed `[prefix, kind, sedimentreeId, changeHash]`.
const COMMIT_KINDS = new Set(['commits', 'blobs']);
const FRAGMENT_KINDS = new Set(['fragments', 'fragment-blobs']);
const FRAGMENT_INDEX_KIND = 'fragments';

/** What an open document currently consists of. */
export interface DocShape {
  /** Whether the document contains the change with this hash. */
  has(changeHash: string): boolean;
  /** The hashes of its loose commits (Automerge's level 0). */
  looseCommits: ReadonlySet<string>;
  /** The head hashes of its fragments (level 1 and up). */
  fragments: ReadonlySet<string>;
}

export interface StorageGuardDeps {
  /**
   * The shape of the document with this sedimentree id (hex of the 32-byte
   * document id), or `undefined` when the document is not open here — in which
   * case nothing is compacting it and the delete is someone else's (a purge).
   */
  shape: (sedimentreeIdHex: string) => DocShape | undefined;
}

type Key = string[];
interface Adapter {
  load(key: Key): Promise<Uint8Array | undefined>;
  save(key: Key, data: Uint8Array): Promise<void>;
  saveBatch?(entries: Array<[Key, Uint8Array]>): Promise<void>;
  remove(key: Key): Promise<void>;
  loadRange(prefix: Key): Promise<{ key: Key; data: Uint8Array | undefined }[]>;
  removeRange(prefix: Key): Promise<void>;
}

const isRecord = (key: Key, kinds: Set<string>) =>
  Array.isArray(key) && key.length === 4 && key[0] === SUBDUCTION_STORE_PREFIX && kinds.has(key[1]);

/**
 * `storage`, with deletes of records a document still needs refused. Every
 * other call goes straight through to the same adapter.
 */
export function guardSubductionStorage<S extends object>(storage: S, deps: StorageGuardDeps): S {
  const target = storage as unknown as Adapter;
  // Which fragments are in the store, per document: asked on every delete, so
  // kept here rather than read back. Seeded from storage on first need.
  const storedFragments = new Map<string, Promise<Set<string>>>();
  const fragmentsOf = (sid: string): Promise<Set<string>> => {
    let set = storedFragments.get(sid);
    if (!set) {
      set = target.loadRange([SUBDUCTION_STORE_PREFIX, FRAGMENT_INDEX_KIND, sid])
        .then((entries) => new Set(entries.map((e) => e.key[3])));
      storedFragments.set(sid, set);
    }
    return set;
  };
  const noteSaved = (key: Key) => {
    if (isRecord(key, FRAGMENT_KINDS) && key[1] === FRAGMENT_INDEX_KIND) {
      void fragmentsOf(key[2]).then((set) => set.add(key[3])).catch(() => {});
    }
  };

  /** Why this record must stay, or null if it may go. */
  async function whyKeep(key: Key): Promise<string | null> {
    const isFragment = isRecord(key, FRAGMENT_KINDS);
    if (!isFragment && !isRecord(key, COMMIT_KINDS)) return null;
    const [, , sid, hash] = key;
    const shape = deps.shape(sid);
    if (!shape) return null;
    if (!shape.has(hash)) return 'it has not been applied to its document yet';
    if ((isFragment ? shape.fragments : shape.looseCommits).has(hash)) return 'it is part of its document';
    const stored = await fragmentsOf(sid);
    for (const head of shape.fragments) {
      if (!stored.has(head)) return 'a fragment of its document is not in the store yet';
    }
    return null;
  }

  const guarded: Partial<Adapter> = {
    async remove(key) {
      const reason = await whyKeep(key);
      if (reason) {
        log.debug(`keeping ${key[1]}/${String(key[3]).slice(0, 8)}: ${reason}`);
        throw new Error(`not deleting a stored record: ${reason}`);
      }
      await target.remove(key);
      if (isRecord(key, FRAGMENT_KINDS) && key[1] === FRAGMENT_INDEX_KIND) {
        (await fragmentsOf(key[2])).delete(key[3]);
      }
    },
    async save(key, data) {
      await target.save(key, data);
      noteSaved(key);
    },
    async saveBatch(entries) {
      await target.saveBatch!(entries);
      for (const [key] of entries) noteSaved(key);
    },
    async removeRange(prefix) {
      await target.removeRange(prefix);
      // Whatever went, read the index back when it is next needed.
      storedFragments.clear();
    },
  };

  return new Proxy(storage, {
    get(obj, prop) {
      if (prop === 'saveBatch' && typeof (obj as any).saveBatch !== 'function') return undefined;
      const override = (guarded as any)[prop];
      if (override) return override;
      const value = (obj as any)[prop];
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}
