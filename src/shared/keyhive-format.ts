/**
 * Which generation of keyhive wrote the state in a storage adapter — and the
 * deliberate reset for state the current keyhive cannot read.
 *
 * keyhive >= 0.6 replaced serde/bincode with its own framed byte formats and
 * rebuilt membership on a new engine. Nothing written before that is readable:
 * archives, stored events, prekey-secret exports. The bridge's boot path does
 * not cope with it — an undecodable archive falls through to `Keyhive.init`,
 * then an un-guarded `importPrekeySecrets(oldBlob)` either throws (boot fails)
 * or, were it to pass, a fresh empty keyhive is saved over the old state. So
 * old state has to be recognised BEFORE the bridge is handed the storage
 * (`ensureKeyhiveStorageUsable`, called first thing by `createKeyhiveRepo`),
 * and removing it is an explicit user action (`resetKeyhiveState`).
 *
 * Detection is a marker chunk in the SAME storage adapter as `keyhive-db` (so
 * it travels with a data-dir copy or a full backup, and exists for hosts with
 * no kv store), with the archive's magic bytes as the fallback for a profile
 * that has no marker yet.
 *
 * No automerge or keyhive import: this runs before either is initialised.
 */
import type { KVStore } from './engine-host';
import { KEYS, CACHE_PREFIX } from './storage-keys';
import { DRIVE_SETTINGS_TYPE } from './schemas/drive-settings';

/**
 * Generation of the on-disk keyhive state.
 *   1 — alpha.58 and earlier: bincode. Never marked (the marker postdates it).
 *   2 — keyhive >= 0.6: framed formats; an archive starts `KHIV` + format byte.
 * Bump when a keyhive upgrade again cannot read what the previous one wrote.
 */
export const KEYHIVE_STORAGE_GENERATION = 2;

/** Marker chunk: one byte, the generation. Outside `keyhive-db`, which the bridge owns. */
export const KEYHIVE_FORMAT_MARKER_KEY = ['drive-format', 'keyhive'];

const KEYHIVE_DB = 'keyhive-db';
const ARCHIVES = '/archives/';
/** "KHIV" — the first four bytes of a framed keyhive archive. */
const ARCHIVE_MAGIC = [0x4b, 0x48, 0x49, 0x56];

/** The slice of automerge-repo's StorageAdapter this module needs. */
/** automerge-repo's subduction stores: without a blob interceptor, and with one (subduction/storage.ts). */
const SYNC_STORE_PREFIXES = ['subduction', 'subduction-interceptor'];

export interface KeyhiveFormatStorage {
  load(key: string[]): Promise<Uint8Array | undefined>;
  save(key: string[], data: Uint8Array): Promise<void>;
  loadRange(prefix: string[]): Promise<{ key: string[]; data: Uint8Array | undefined }[]>;
  removeRange(prefix: string[]): Promise<void>;
}

export type KeyhiveStorageState =
  /** No keyhive state at all (a new profile, or one already reset). */
  | { kind: 'fresh' }
  /** Readable by this build. `marked: false` = recognised by its archives, not yet marked. */
  | { kind: 'current'; marked: boolean }
  /** Written by an older keyhive this build cannot read. */
  | { kind: 'legacy'; reason: LegacyReason }
  /** Marked by a LATER generation than this build knows (an old build on new data). */
  | { kind: 'newer'; found: number };

/**
 * Why state reads as legacy:
 *   'archive-format' — an archive that is not in the framed format;
 *   'no-archive'     — keyhive-db chunks but no archive, unmarked: an old profile
 *                      caught half-way through a reset (or otherwise damaged);
 *   'marker'         — marked with an older generation than this build's.
 */
export type LegacyReason = 'archive-format' | 'no-archive' | 'marker';

/** Thrown by the guard when the storage holds keyhive state this build cannot read. */
export class KeyhiveResetRequiredError extends Error {
  readonly reason: LegacyReason;
  constructor(reason: LegacyReason) {
    super(`keyhive state was written by an older version and cannot be read (${reason}); a reset is required`);
    this.name = 'KeyhiveResetRequiredError';
    this.reason = reason;
  }
}

const isFramedArchive = (data: Uint8Array | undefined): boolean =>
  !!data && data.length > ARCHIVE_MAGIC.length && ARCHIVE_MAGIC.every((b, i) => data[i] === b);

/**
 * Classify the keyhive state in `storage`. Read-only. Once a profile is marked
 * this is a single small `load`; the range read only happens for an unmarked
 * profile (first boot of this build, or a fresh one).
 *
 * Never reads with an empty prefix — the NodeFS adapter throws on one.
 */
export async function inspectKeyhiveStorage(storage: KeyhiveFormatStorage): Promise<KeyhiveStorageState> {
  const marker = await storage.load(KEYHIVE_FORMAT_MARKER_KEY);
  if (marker && marker.length > 0) {
    const found = marker[0];
    if (found === KEYHIVE_STORAGE_GENERATION) return { kind: 'current', marked: true };
    if (found > KEYHIVE_STORAGE_GENERATION) return { kind: 'newer', found };
    return { kind: 'legacy', reason: 'marker' };
  }

  const chunks = await storage.loadRange([KEYHIVE_DB]);
  if (chunks.length === 0) return { kind: 'fresh' };
  // Compare with the slashes stripped: the bridge's key segment is the literal
  // '/archives/', which IndexedDB returns as-is but the NodeFS adapter maps to
  // a directory and hands back as 'archives'.
  const segment = (k: string | undefined) => (k ?? '').replace(/\//g, '');
  const archives = chunks.filter((c) => segment(c.key[1]) === segment(ARCHIVES));
  // The old bridge ends every boot by saving an archive, so a booted old
  // profile always has one; keyhive chunks WITHOUT an archive and without a
  // marker are a half-finished reset of such a profile.
  if (archives.length === 0) return { kind: 'legacy', reason: 'no-archive' };
  return archives.every((c) => isFramedArchive(c.data))
    ? { kind: 'current', marked: false }
    : { kind: 'legacy', reason: 'archive-format' };
}

/** Record that the keyhive state in `storage` is this build's generation. */
export async function markKeyhiveFormat(storage: KeyhiveFormatStorage): Promise<void> {
  await storage.save(KEYHIVE_FORMAT_MARKER_KEY, Uint8Array.of(KEYHIVE_STORAGE_GENERATION));
}

/**
 * The guard in front of the bridge. Returns normally when the bridge may be
 * given `storage`; throws `KeyhiveResetRequiredError` for old-format state, or
 * a plain Error for state from a later generation. Never deletes anything.
 *
 * A fresh profile is marked HERE, before the bridge writes its first byte, so a
 * crash between "prekey secrets saved" and "first archive saved" cannot leave a
 * new profile looking like a half-reset old one.
 */
export async function ensureKeyhiveStorageUsable(storage: KeyhiveFormatStorage): Promise<void> {
  const state = await inspectKeyhiveStorage(storage);
  switch (state.kind) {
    case 'legacy':
      throw new KeyhiveResetRequiredError(state.reason);
    case 'newer':
      throw new Error(
        `This data was written by a newer version of the app (keyhive storage generation ${state.found}, ` +
        `this build reads ${KEYHIVE_STORAGE_GENERATION}). Reload to pick up the update.`,
      );
    case 'fresh':
      await markKeyhiveFormat(storage);
      return;
    case 'current':
      if (!state.marked) await markKeyhiveFormat(storage);
      return;
  }
}

/** What `resetKeyhiveState` records before clearing it (KEYS.preResetState). */
export interface PreResetState {
  /** The home list as it was: the ids of the documents whose chunks are still on disk. */
  docs: { id: string; type?: string; name?: string }[];
  /** The KEYS.driveSettings value as it was: a settings-doc id (string) or the local blob. */
  settings: unknown;
  userGroupId: string | null;
  /** ISO time of the first reset attempt. */
  resetAt: string;
}

/**
 * Remove keyhive state this build cannot read, and the pointers into it.
 *
 * Deleted: every `keyhive-db` chunk; the user-group id; a synced-settings
 * pointer; the home list; seen-state and caches (all keyed by ids that are
 * about to be meaningless).
 *
 * Kept: the device key (`active-key-pair-2` — same device, same agentId, so
 * device names still match) and EVERY document chunk. Documents are never
 * deleted here: their ids are recorded in KEYS.preResetState so they can still
 * be exported afterwards. A device-local settings blob keeps its device names
 * and loses its friends and archive tombstones, which are keyed by user-group
 * and document ids that no longer exist.
 *
 * Each step is idempotent and the order makes a crash recoverable: the record
 * is written first (and never overwritten by a re-run), the storage delete
 * comes after the kv half, and the marker is written last — so an interrupted
 * reset still reads as legacy and simply runs again.
 *
 * Refuses unless the state is legacy (`force` is for tests and tooling).
 */
export async function resetKeyhiveState(
  storage: KeyhiveFormatStorage,
  kv?: KVStore,
  opts: { force?: boolean } = {},
): Promise<void> {
  const state = await inspectKeyhiveStorage(storage);
  if (state.kind !== 'legacy' && !opts.force) {
    throw new Error(`refusing to reset: keyhive state is not old-format (it is ${state.kind})`);
  }

  if (kv) {
    const settings = await kv.get<unknown>(KEYS.driveSettings);
    if (!(await kv.get<PreResetState>(KEYS.preResetState))) {
      const record: PreResetState = {
        docs: (await kv.get<PreResetState['docs']>(KEYS.docIds)) ?? [],
        settings,
        userGroupId: await kv.get<string>(KEYS.userGroupId),
        resetAt: new Date().toISOString(),
      };
      await kv.set(KEYS.preResetState, record);
    }

    await kv.del(KEYS.userGroupId);
    if (settings && typeof settings === 'object') {
      const blob = settings as { deviceNames?: Record<string, string> };
      await kv.set(KEYS.driveSettings, {
        '@type': DRIVE_SETTINGS_TYPE, friends: {}, deviceNames: blob.deviceNames ?? {}, archivedDocIds: {},
      });
    } else {
      await kv.del(KEYS.driveSettings);
    }
    await kv.set(KEYS.docIds, []);
    await kv.del(KEYS.lastViewedHeads);
    await kv.delPrefix(CACHE_PREFIX);
    await kv.settingSet('last-opened-doc', null);
  }

  await storage.removeRange([KEYHIVE_DB]);
  // The Repo's sync stores go with the keys. The encrypted one
  // (subduction-interceptor) holds commits sealed under keys that have just been
  // deleted: nothing can read them again, and a document that still found them
  // there would wait on them forever. The plain one (subduction) was written by
  // builds from before documents were encrypted for sync and is never read by
  // this one. Neither is what a backup or the reset screen's export reads —
  // that is each document's own chunks, under its id, which stay.
  for (const prefix of SYNC_STORE_PREFIXES) await storage.removeRange([prefix]);
  await markKeyhiveFormat(storage);
}
