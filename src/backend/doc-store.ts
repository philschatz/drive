import * as fs from 'fs';
import * as Automerge from '@automerge/automerge';
import { Repo, DocHandle, DocumentId } from '@automerge/automerge-repo';

/**
 * Scan the NodeFSStorageAdapter data directory and repo.find() each document
 * so it becomes available in repo.handles.
 */
export async function scanStorage(repo: Repo, dataDir: string): Promise<void> {
  if (!fs.existsSync(dataDir)) return;

  const prefixDirs = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.length === 2);

  for (const prefix of prefixDirs) {
    const children = fs.readdirSync(`${dataDir}/${prefix.name}`, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const child of children) {
      const documentId = prefix.name + child.name;
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`timeout loading '${documentId}'`)), 2000)
        );
        await Promise.race([
          repo.find(documentId as DocumentId),
          timeout,
        ]);
      } catch (err: any) {
        console.log(`skipping '${documentId}': ${err?.message || 'failed to load'}`);
      }
    }
  }
}

/**
 * List all documents whose @type matches the given type.
 */
export function listByType(repo: Repo, type: string): { documentId: string; doc: any }[] {
  return Object.values(repo.handles)
    .filter(h => h.isReady() && (h.doc() as any)?.['@type'] === type)
    .map(h => ({ documentId: h.documentId, doc: h.doc() }));
}

/**
 * List all ready documents in the repo.
 */
export function listAll(repo: Repo): { documentId: string; doc: any }[] {
  return Object.values(repo.handles)
    .filter(h => h.isReady() && h.doc())
    .map(h => ({ documentId: h.documentId, doc: h.doc() }));
}

/**
 * Get a DocHandle by ID, optionally filtering by @type.
 * Returns undefined if not found, not ready, or type mismatch.
 */
export function getHandle(repo: Repo, id: string, type?: string): DocHandle<any> | undefined {
  const handle = repo.handles[id as DocumentId] as DocHandle<any> | undefined;
  if (!handle?.isReady()) return undefined;
  if (type && (handle.doc() as any)?.['@type'] !== type) return undefined;
  return handle;
}

/**
 * Get the Automerge heads hash for a document (used as CalDAV sync token / etag).
 */
export function getHeadsHash(repo: Repo, id: string): string | undefined {
  const handle = getHandle(repo, id);
  if (!handle) return undefined;
  return Automerge.getHeads(handle.doc()).join('');
}