/**
 * Minimal IndexedDB key-value wrapper.
 * Works in both main thread and web workers.
 *
 * A genuinely absent `indexedDB` (e.g. some test/SSR environments) is treated as an
 * intentional no-op. Real IndexedDB failures — failing to open the database or an
 * operation error — are NOT swallowed: they propagate to the caller so the failure
 * is visible and handled. Swallowing them silently dropped writes and turned failed
 * reads into empty results with no error to surface.
 */

const DB_NAME = 'app-storage';
const DB_VERSION = 2;
const STORE_NAME = 'keyval';

// Key registry, cache-key builders, settings schema, and hashStr live in the
// environment-agnostic src/shared/storage-keys.ts (shared with DriveEngine and
// the node KVStore). Imported for local use and re-exported so existing
// `./idb-storage` importers are unaffected — the key names stay a single source
// of truth.
import {
  KEYS, LEGACY_IDB_KEYS, CACHE_PREFIX, queryCacheKey, validationCacheKey, docCachePrefix,
  hashStr, SETTINGS_PREFIX, SETTINGS_DEFAULTS,
} from '../../shared/storage-keys';
import type { SettingsSchema, SettingName } from '../../shared/storage-keys';

export { KEYS, CACHE_PREFIX, queryCacheKey, validationCacheKey, docCachePrefix, hashStr };
export type { QueryCacheEntry } from '../../shared/storage-keys';

// One-time v1→v2 migration: legacy ad-hoc key names → category-prefixed names. Renamed
// data/auth keys preserve their values; legacy cache (`qc:*`) and the removed device-linking
// migration keys are dropped outright.
const V2_RENAMES: Record<string, string> = {
  'automerge-doc-ids':    KEYS.docIds,
  // contact-names / known-contact-groups now live in the DriveSettings doc, but the
  // v1→v2 rename still lands them on their `data:*` names so the engine's one-time
  // doc-migration (which reads LEGACY_IDB_KEYS) can pick them up on the next launch.
  'contact-names':        LEGACY_IDB_KEYS.friendNames,
  'known-contact-groups': LEGACY_IDB_KEYS.knownFriendGroups,
  'user-group-id':        KEYS.userGroupId,
};
const V2_DELETE_KEYS = ['linked-devices', 'pending-group-adds'];
const V2_DELETE_PREFIXES = ['qc:'];

/** Rename/drop legacy keys inside the versionchange transaction (runs once on upgrade). */
function migrateV1ToV2(store: IDBObjectStore): void {
  const req = store.openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    const key = cursor.key;
    if (typeof key === 'string') {
      const renamed = V2_RENAMES[key];
      if (renamed) {
        store.put(cursor.value, renamed);
        cursor.delete();
      } else if (V2_DELETE_KEYS.includes(key) || V2_DELETE_PREFIXES.some(p => key.startsWith(p))) {
        cursor.delete();
      }
    }
    cursor.continue();
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** True when IndexedDB is genuinely available in this environment. */
function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      // Rename legacy keys to their category-prefixed names. Only meaningful when an
      // existing v1 DB is being upgraded (a brand-new DB has nothing to migrate).
      if (event.oldVersion >= 1 && event.oldVersion < 2) {
        migrateV1ToV2(req.transaction!.objectStore(STORE_NAME));
      }
    };
    req.onblocked = () => console.warn('[idb] upgrade blocked by an open connection at an older version');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Don't cache a rejected open — a transient failure would otherwise poison every
  // later call. Clear the cache on failure so a subsequent call can retry.
  dbPromise = opening.catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

/**
 * Best-effort close of the cached connection so the database can be deleted (full-reset
 * flow). Fire-and-forget: never awaits the open promise (which may be pending/blocked on a
 * broken page and would hang the reset). deleteDatabase's own onblocked+timeout handles the
 * case where the connection is still closing.
 */
export function closeDb(): void {
  const p = dbPromise;
  dbPromise = null;
  if (p) p.then(db => db.close()).catch(() => { });
}

export async function idbGet<T>(key: string): Promise<T | null> {
  if (!idbAvailable()) return null;
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  if (!idbAvailable()) return;
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbDel(key: string): Promise<void> {
  if (!idbAvailable()) return;
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Delete all entries whose key starts with the given prefix. */
export async function idbDelPrefix(prefix: string): Promise<void> {
  if (!idbAvailable()) return;
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Read every key/value pair in the store (the full tier of a backup). */
export async function idbEntries(): Promise<[string, unknown][]> {
  if (!idbAvailable()) return [];
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).openCursor();
    const out: [string, unknown][] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      if (typeof cursor.key === 'string') out.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** Reset the cached connection (for tests). */
export function _resetConnectionForTest(): void {
  dbPromise = null;
}

// ── Settings registry ───────────────────────────────────────────────────────
//
// The settings schema + defaults live in ../shared/storage-keys.ts. IndexedDB is
// the source of truth (readable from both threads); localStorage holds only a
// synchronous read-mirror for main-thread call sites that need the value during render
// (web workers have no localStorage, so the worker hydrates its own copy from IDB).

/** Read a setting from IndexedDB (source of truth), falling back to its default. */
export async function settingGet<K extends SettingName>(name: K): Promise<SettingsSchema[K]> {
  const v = await idbGet<SettingsSchema[K]>(SETTINGS_PREFIX + name);
  return v ?? SETTINGS_DEFAULTS[name]; // ?? only fills null/undefined, so a stored `false` is kept
}

/** Persist a setting to IndexedDB (source of truth). */
export async function settingSet<K extends SettingName>(name: K, value: SettingsSchema[K]): Promise<void> {
  await idbSet(SETTINGS_PREFIX + name, value);
}

/** Read the synchronous localStorage mirror of a setting (main thread only). */
export function settingGetSync<K extends SettingName>(name: K): SettingsSchema[K] {
  if (typeof localStorage === 'undefined') return SETTINGS_DEFAULTS[name];
  const raw = localStorage.getItem(SETTINGS_PREFIX + name);
  if (raw === null) return SETTINGS_DEFAULTS[name];
  try { return JSON.parse(raw) as SettingsSchema[K]; } catch { return SETTINGS_DEFAULTS[name]; }
}

/** Write the synchronous localStorage mirror of a setting (main thread only). */
export function settingSetSync<K extends SettingName>(name: K, value: SettingsSchema[K]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SETTINGS_PREFIX + name, JSON.stringify(value));
}

/** Synchronous reader for the debug-mode toggle (e.g. the Settings UI). */
export function isDebugEnabled(): boolean { return settingGetSync('debug-enable'); }
