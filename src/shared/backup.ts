/**
 * Tiered backup envelope — the file format behind "Export documents & settings",
 * "Export full device backup", and the shared import path.
 *
 * The payload maps 1:1 onto the local persistence it captures:
 *   - `docs`     — one document per home-list doc. Every entry carries the
 *     lossless binary state (`bin`, an Automerge.save payload — the only form
 *     that preserves Peritext markup, e.g. a Sentences doc's marks and block
 *     markers). Non-rich-text docs also carry the plain-JSON projection
 *     (`doc`); Sentences docs carry a readable Markdown rendering (`markdown`)
 *     instead, since their flat JSON projection can't represent the rich
 *     structure. Import recreates from `bin` when present, else `doc`.
 *   - `settings` — the DriveSettings surface: friends, deviceNames, and the
 *     archived-doc tombstones.
 *   - `kv`       — the app-storage keyval pairs (data:*, data:auth:*, settings:*;
 *     disposable cache:* is excluded).
 *   - `storage`  — the automerge `documents` store chunks, which also covers
 *     keyhive's keyhive-db keys (keyhive writes through the same storage adapter).
 *
 * JSON-serializable by construction: binary storage chunks (and any stray
 * Uint8Array inside a kv value) are base64-encoded behind a sentinel, so the
 * whole payload round-trips through JSON.parse/JSON.stringify without touching
 * Automerge's binary chunk format.
 */
export type BackupTier = 'docs' | 'settings' | 'full';

export interface BackupDocEntry {
  /** Lossless binary state (Automerge.save). Always written for new exports;
   * import recreates from this when present. */
  bin?: Uint8Array;
  /** Materialized plain-JSON state. Excluded for Sentences (see `markdown`). */
  doc?: any;
  /** Sentences only: the rich content rendered as readable Markdown. */
  markdown?: string;
  /** Metadata re-applied when the doc is recreated (type/name). */
  metadata?: { type?: string; name?: string };
}

export interface BackupSettings {
  friends?: Record<string, string | null>;
  deviceNames?: Record<string, string>;
  archivedDocIds?: Record<string, { grantSigs: string[] }>;
}

export interface BackupKVEntry {
  key: string;
  value: unknown;
}

export interface BackupStorageEntry {
  /** The storage chunk key (array path segments), as automerge-repo uses. */
  key: string[];
  data: Uint8Array;
}

export interface BackupPayload {
  format: 'drive-backup';
  version: 1;
  kind: 'snapshot' | 'full';
  exportedAt: string;
  /** Snapshot tier: materialized doc states. */
  docs?: BackupDocEntry[];
  /** Snapshot tier: the DriveSettings surface. */
  settings?: BackupSettings;
  /** Full tier: app-storage keyval pairs (cache:* excluded). */
  kv?: BackupKVEntry[];
  /** Full tier: automerge documents-store chunks. */
  storage?: BackupStorageEntry[];
}

/** Result of an import, whatever the tier: how many docs were recreated, which
 * names were skipped (invalid docs, failed creation), and whether a reload is
 * required for the new state to be fully live. */
export interface BackupResult {
  imported: number;
  skipped: string[];
  reload: boolean;
}

export type ParsedBackup =
  | { kind: 'snapshot'; payload: BackupPayload }
  | { kind: 'full'; payload: BackupPayload }
  | { kind: 'invalid'; error: string };

const BIN = '__driveBin';

// Self-contained base64 (no keyhive dependency — this module is a pure file
// format, imported by the browser UI and Node alike). Chunked encode avoids the
// call-stack blowup String.fromCharCode(...huge) hits on multi-MB chunks.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isBinary(v: unknown): boolean {
  return (
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    (ArrayBuffer.isView(v) && !(v instanceof DataView))
  );
}

function toBytes(v: any): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** Deep-replace binary values with `{ __driveBin: base64 }` so JSON.stringify works. */
function binToJson(v: unknown): unknown {
  if (isBinary(v)) return { [BIN]: bytesToBase64(toBytes(v)) };
  if (Array.isArray(v)) return v.map(binToJson);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = binToJson(val);
    return out;
  }
  return v;
}

/** Deep-restore `{ __driveBin: base64 }` markers back into Uint8Array. */
function binFromJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(binFromJson);
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    if (typeof rec[BIN] === 'string') return base64ToBytes(rec[BIN]);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) out[k] = binFromJson(val);
    return out;
  }
  return v;
}

/** Serialize a payload to the on-disk JSON (base64 for binary). */
export function serializeBackup(payload: BackupPayload): string {
  return JSON.stringify(binToJson(payload), null, 2);
}

/**
 * Parse a backup file, auto-detecting the tier: the snapshot or full envelope.
 * Anything else is rejected — the legacy v1/v2 metadata format is no longer
 * importable.
 */
export function parseBackup(text: string): ParsedBackup {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid', error: 'Not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'invalid', error: 'Not a backup file.' };
  }

  if (parsed.format !== 'drive-backup') {
    return { kind: 'invalid', error: 'Not a backup file.' };
  }
  if (parsed.version !== 1) {
    return { kind: 'invalid', error: `Unsupported backup format version ${parsed.version}.` };
  }
  const payload = binFromJson(parsed) as BackupPayload;
  if (payload.kind !== 'snapshot' && payload.kind !== 'full') {
    return { kind: 'invalid', error: 'Unknown backup kind.' };
  }
  return { kind: payload.kind, payload };
}
