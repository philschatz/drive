import * as Automerge from '@automerge/automerge';
import { Repo, DocHandle, DocumentId } from '@automerge/automerge-repo';

/**
 * List all documents whose @type matches the given type.
 */
export function listByType(repo: Repo, type: string): { documentId: string; doc: any }[] {
  return Object.values(repo.handles)
    .filter(h => h.isReady() && (h.doc() as any)?.['@type'] === type)
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