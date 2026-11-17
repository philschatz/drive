/**
 * A snapshot backup built straight from storage — no keyhive, no Repo.
 *
 * Used when the engine cannot boot keyhive (the stored keyhive state was
 * written by an older version; see keyhive-format.ts), and afterwards to export
 * the pre-upgrade documents a reset left on disk. A document's own chunks are
 * ordinary Automerge data under `[docId, 'snapshot' | 'incremental', hash]`, so
 * reading them needs nothing but Automerge.
 *
 * The result is a normal 'snapshot' BackupPayload, importable through the
 * usual restore. It is deliberately NOT tagged with a keyhive generation: the
 * friends and archive tombstones it carries are keyed by pre-reset ids, and
 * the import skips those for an untagged payload.
 */
import type { BackupDocEntry, BackupPayload, BackupSettings } from './backup';
import { spansToMarkdown } from './rich-text-markdown';

/** The slice of automerge-repo's StorageAdapter needed to read documents. */
export interface DocChunkStorage {
  loadRange(prefix: string[]): Promise<{ key: string[]; data: Uint8Array | undefined }[]>;
}

/**
 * One backup entry for a materialized document: the lossless binary, plus the
 * readable form (Markdown for Sentences, whose JSON projection is a flat string
 * that drops marks and block markers; plain JSON for everything else).
 */
export function buildBackupDocEntry(
  Automerge: any,
  doc: any,
  entry: { type?: string; name?: string },
): BackupDocEntry {
  const item: BackupDocEntry = {
    bin: Automerge.save(doc),
    metadata: entry.type || entry.name ? { type: entry.type, name: entry.name } : undefined,
  };
  if (doc['@type'] === 'Sentences') {
    item.markdown = spansToMarkdown(Automerge.spans(doc, ['content']));
  } else {
    item.doc = JSON.parse(JSON.stringify(doc));
  }
  return item;
}

/**
 * Rebuild a document from its storage chunks: every snapshot chunk, then every
 * incremental chunk (the order automerge-repo's own loader uses). Null when the
 * document has no chunks at all. Throws on undecodable data.
 */
export async function loadDocFromStorage(storage: DocChunkStorage, Automerge: any, docId: string): Promise<any | null> {
  const snapshots = await storage.loadRange([docId, 'snapshot']);
  const incrementals = await storage.loadRange([docId, 'incremental']);
  const chunks = [...snapshots, ...incrementals].map((c) => c.data).filter((d): d is Uint8Array => !!d);
  if (chunks.length === 0) return null;
  let doc = Automerge.init();
  for (const chunk of chunks) doc = Automerge.loadIncremental(doc, chunk);
  return doc;
}

const settingsSurfaceOf = (doc: any): BackupSettings => {
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return { friends: clone(doc.friends), deviceNames: clone(doc.deviceNames), archivedDocIds: clone(doc.archivedDocIds) };
};

export interface LegacyBackupSource {
  storage: DocChunkStorage;
  /** The `@automerge/automerge` namespace. */
  Automerge: any;
  /** The home list to export (KEYS.docIds, or the pre-reset record's copy). */
  docs: { id: string; type?: string; name?: string }[];
  /** The KEYS.driveSettings value: a settings-doc id (string), the local blob (object), or null. */
  settings: unknown;
}

/**
 * Assemble a snapshot backup (documents + settings) from storage. A document
 * that cannot be read is skipped and named in `unreadable` — never fatal: the
 * point is to save whatever can be saved.
 */
export async function buildLegacyBackup(src: LegacyBackupSource): Promise<{ payload: BackupPayload; unreadable: string[] }> {
  const { storage, Automerge } = src;
  const unreadable: string[] = [];
  const docs: BackupDocEntry[] = [];

  for (const entry of src.docs) {
    const label = entry.name || entry.id;
    try {
      const doc = await loadDocFromStorage(storage, Automerge, entry.id);
      if (!doc || Object.keys(doc).length === 0) { unreadable.push(label); continue; }
      docs.push(buildBackupDocEntry(Automerge, doc, entry));
    } catch {
      unreadable.push(label);
    }
  }

  let settings: BackupSettings | undefined;
  if (typeof src.settings === 'string') {
    try {
      const doc = await loadDocFromStorage(storage, Automerge, src.settings);
      if (doc) settings = settingsSurfaceOf(doc);
    } catch { /* settings are a nicety; the documents are the point */ }
  } else if (src.settings && typeof src.settings === 'object') {
    settings = settingsSurfaceOf(src.settings);
  }

  const payload: BackupPayload = {
    format: 'drive-backup',
    version: 1,
    kind: 'snapshot',
    exportedAt: new Date().toISOString(),
    docs,
    ...(settings ? { settings } : {}),
  };
  return { payload, unreadable };
}
