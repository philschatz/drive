/**
 * Pure storage key/namespace registry + cache-key builders + settings schema.
 *
 * Extracted from the browser-only idb-storage.ts so it can be shared by the
 * environment-agnostic DriveEngine (src/shared) and by both KVStore
 * implementations (browser IndexedDB, node JSON file) without pulling in any
 * `indexedDB`/`localStorage` reference. idb-storage.ts re-exports everything
 * here, so the key names stay a single source of truth.
 *
 * Key categories (deletion/restore semantics are explicit in the prefix):
 *   cache:*        deleting it changes nothing (regenerated on demand)
 *   settings:*     deleting it falls back to defaults; restoring it restores prefs
 *   data:*         required for a working app
 *   data:auth:*    identity/credential data (keyhive user-group)
 */

/** Source-of-truth keys for non-cache, non-settings persisted data. */
export const KEYS = {
  docIds:             'data:my-doc-ids',
  /**
   * Docs the user archived from the home page while their user-group still had
   * access (the self-revoke wasn't possible). Map of automerge docId →
   * { grantSigs }: the direct-grant signatures at archive time, so a later
   * grant with an unseen signature (a deliberate re-share) un-archives the doc.
   * reconcileHomeDocs skips these in its add-back pass.
   */
  archivedDocIds:     'data:archived-doc-ids',
  contactNames:       'data:contact-names',
  knownContactGroups: 'data:known-contact-groups',
  /**
   * Per-device seen state: automerge docId → the doc's heads (sorted) when a
   * viewing (non-peek) query last saw it. Missing entry = never viewed = the
   * home page shows the new-changes dot.
   */
  lastViewedHeads:    'data:last-viewed-heads',
  userGroupId:        'data:auth:user-group-id',
} as const;

/** Everything under this prefix is disposable cache (deletable with no effect). */
export const CACHE_PREFIX = 'cache:';
export const queryCacheKey = (docId: string, filter: string) =>
  `${CACHE_PREFIX}query:${docId}:${hashStr(filter)}`;
export const validationCacheKey = (docId: string) => `${CACHE_PREFIX}query:${docId}:validation`;
export const docCachePrefix = (docId: string) => `${CACHE_PREFIX}query:${docId}:`;

// ── Settings registry ───────────────────────────────────────────────────────

export const SETTINGS_PREFIX = 'settings:';

/** The single source of all app settings: their types and default values. */
export interface SettingsSchema {
  /** Debug mode: bypasses all caches AND traces keyhive/WASM calls (console + crash banner). */
  'debug-enable': boolean;
  /**
   * Full hash path (incl. rest path + query, e.g. `/d/<docId>/sheets/s1?anchor=r1:c2`)
   * of the last doc the user had open. Read at startup to reopen it when the app
   * launches on the bare base URL (PWA start_url has no hash).
   */
  'last-opened-doc': string | null;
  // future settings get one line here + a default below
}

export const SETTINGS_DEFAULTS: SettingsSchema = {
  'debug-enable': false,
  'last-opened-doc': null,
};

export type SettingName = keyof SettingsSchema;

// ── Shared utilities (used by both worker and main thread) ──────────────────

/** djb2 string hash → base-36. Used for query cache keys. */
export function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export interface QueryCacheEntry { result: any; json: string; lastModified?: number; heads: string[] }
