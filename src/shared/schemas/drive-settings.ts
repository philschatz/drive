/**
 * Worker-safe schema for the per-user, keyhive-private `DriveSettings` document
 * (the synced source of truth for friends, device names, and archived-doc
 * tombstones). Registered in src/shared/schemas so
 * validation runs inside the automerge worker. Deliberately NOT registered in
 * src/client/doc-plugins — there is no editor View; the doc is inspected/edited
 * only through the universal source viewer. Must never import Preact/UI code.
 *
 * Unlike other doc types, edits to this document are validated *before* they are
 * committed (see `changeDriveSettings` in drive-engine.ts): any change that would
 * make the doc invalid is rejected rather than stored.
 */
import {
  type DocSchemaPlugin,
  str, obj, record, arr,
} from './core';

/**
 * Id string formats used as this doc's map keys/values, validated so a corrupt
 * sync or a bad hand-edit in the source inspector is rejected (edits are
 * enforced — see changeDriveSettings in drive-engine.ts).
 */
// base64 (btoa) of a 32-byte keyhive Identifier/GroupId — 43 data chars + one '=' pad.
export const KEYHIVE_ID_RE = /^[A-Za-z0-9+/]{43}=$/;
// automerge-repo DocumentId — bs58check-encoded (base58 alphabet, no 0/O/I/l).
export const AUTOMERGE_DOC_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

/** The DriveSettings `@type` discriminator — single source of truth for the engine's special-casing. */
export const DRIVE_SETTINGS_TYPE = 'DriveSettings' as const;

/** Seed document for a brand-new DriveSettings doc (empty roster, names, tombstones). */
export function createDriveSettingsDocJson(): DriveSettingsDocument {
  return { '@type': DRIVE_SETTINGS_TYPE, friends: {}, deviceNames: {}, archivedDocIds: {} };
}

/** Archive tombstone: the direct-grant signatures at archive time (re-share baseline). */
export interface ArchivedDocTombstone {
  grantSigs: string[];
}

export interface DriveSettingsDocument {
  '@type': typeof DRIVE_SETTINGS_TYPE;
  /**
   * The whole friend roster in one map, keyed by friend user-group id. The
   * value is the display name, or `null` when the friend is known but unnamed.
   * Also holds YOUR own name, keyed by your own user-group id. (Friends you
   * share a doc with are derived live from keyhive and are not stored here.)
   */
  friends: Record<string, string | null>;
  /** Friendly per-device names, keyed by device agentId. */
  deviceNames: Record<string, string>;
  /** Docs hidden from Home, keyed by automerge docId, with their re-share baseline. */
  archivedDocIds: Record<string, ArchivedDocTombstone>;
}

export const driveSettingsSchema = obj({
  '@type': str({ enum: [DRIVE_SETTINGS_TYPE] }),
  // Keyed by friend user-group id. `str({ optional: true })` is how the DSL
  // expresses "string or null": the validator accepts null/absent only where a
  // node is optional. So a friend value may be a name string or null
  // (known-but-unnamed); a number is rejected.
  friends: record(str({ optional: true }), { optional: true, keyPattern: KEYHIVE_ID_RE }),
  // Keyed by device agentId.
  deviceNames: record(str(), { optional: true, keyPattern: KEYHIVE_ID_RE }),
  // Keyed by automerge docId; value carries the re-share baseline signatures.
  archivedDocIds: record(obj({ grantSigs: arr(str()) }), { optional: true, keyPattern: AUTOMERGE_DOC_ID_RE }),
});

/** Worker-safe plugin core — registered in src/shared/schemas (validation only). */
export const driveSettingsSchemaPlugin: DocSchemaPlugin = {
  type: DRIVE_SETTINGS_TYPE,
  schema: driveSettingsSchema,
  checkDeps: () => {},
};
