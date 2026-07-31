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
  docIds: 'data:my-doc-ids',
  userGroupId: 'data:auth:user-group-id',
  /**
   * The single home of this user's settings, whose *value type* selects the storage mode:
   *   - a **string** = the Automerge docId of the synced, keyhive-private DriveSettings
   *     document ⇒ SHARED mode (contacts + names, device names, and archived-doc
   *     tombstones sync across the user's devices);
   *   - an **object** = the same settings shape held as a device-local JSON blob
   *     (`{'@type':'DriveSettings', …}`) ⇒ LOCAL mode (no sync, no user-group minted);
   *   - **absent** ⇒ LOCAL (a fresh blob is seeded).
   * The docId half is TRUSTED state — only ever set from local creation, the one-way
   * "sync settings" opt-in, or the device-link rendezvous; never by scanning synced docs
   * for `@type:'DriveSettings'` (a contact could share a spoof). Opting into SHARED
   * overwrites the blob with the docId string and is irreversible. See
   * src/client/settings/schema.ts and ensureDriveSettingsDoc/ensureLocalSettings in
   * drive-engine.ts.
   */
  driveSettings: 'data:auth:drive-settings-doc-id',
  /**
   * Per-device seen state: automerge docId → the doc's heads (sorted) when a
   * viewing (non-peek) query last saw it. Missing entry = never viewed = the home
   * page shows the new-changes dot. Deliberately device-local (never synced into
   * the DriveSettings doc): it changes on every doc edit, and syncing that churn
   * would bloat keyhive on every change.
   */
  lastViewedHeads: 'data:last-viewed-heads',
} as const;

/**
 * Legacy `data:*` IDB keys whose data now lives in the synced DriveSettings
 * document (contacts + names merged into one `contacts` map; device names and
 * archived-doc tombstones moved verbatim). Read once by the engine's one-time
 * migration (which seeds the doc, then deletes them) and still referenced by the
 * idb v1→v2 rename map so an even older profile lands on these names first. No
 * live code writes them. (Seen state, `data:last-viewed-heads`, was NOT moved —
 * it stays device-local; see KEYS.lastViewedHeads.)
 */
// The string VALUES are frozen — they are on real users' disks. Only the
// property names follow the Contact → Friend rename.
export const LEGACY_IDB_KEYS = {
  friendNames: 'data:contact-names',
  deviceNames: 'data:device-names',
  knownFriendGroups: 'data:known-contact-groups',
  archivedDocIds: 'data:archived-doc-ids',
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
