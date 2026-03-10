/**
 * MIGRATION: Unencrypted → Encrypted documents
 *
 * This module handles migrating existing unencrypted documents to keyhive-encrypted ones.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ REMOVE THIS FILE once all documents have been migrated.         │
 * │ Also remove:                                                     │
 * │   - "Enable encryption" button in Home.tsx                      │
 * │   - legacyDocId field in DocEntry (doc-storage.ts)              │
 * │   - isLegacyDoc() checks in routing                             │
 * │   - Migration banner in editor components                       │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * Migration flow:
 * 1. Admin clicks "Enable encryption" on an unencrypted doc
 * 2. Worker creates a keyhive Document + auth companion doc
 * 3. Current doc content is encrypted into a new envelope doc
 * 4. Local doc list is updated with the new IDs
 * 5. Old doc remains readable but shows a "migrated" banner
 */

import { getDocList, addDocId, updateDocCache } from '@/doc-storage';

/** Check if a document entry is a legacy (unencrypted) document. */
export function isLegacyDoc(entry: { encrypted?: boolean }): boolean {
  return !entry.encrypted;
}

/** Check if a document has already been migrated (has a legacy pointer). */
export function isMigratedDoc(entry: { legacyDocId?: string }): boolean {
  return !!entry.legacyDocId;
}

/**
 * Migrate a document to encryption.
 *
 * This is called from the main thread. It sends a message to the worker
 * which performs the actual keyhive + automerge operations.
 *
 * TODO: Implement the full worker-side migration:
 * 1. Create keyhive document (keyhiveApi.createProtectedDoc)
 * 2. Create auth companion Automerge doc
 * 3. Read current doc content, encrypt via keyhive.tryEncrypt
 * 4. Create new Automerge doc with encrypted content
 * 5. Return new doc IDs
 *
 * For now, this marks the document as encrypted in the local doc list
 * to establish the data model. The actual encryption will be wired up
 * when the encrypted sync layer is complete.
 */
export async function migrateDoc(docId: string): Promise<{ newDocId: string; authDocId: string }> {
  // Placeholder: in the full implementation, this calls the worker to:
  // 1. Read the unencrypted doc
  // 2. Create a keyhive Document + auth doc
  // 3. Encrypt the content
  // 4. Create new Automerge docs

  // For now, mark the existing doc as "encrypted" to test the UI flow
  updateDocCache(docId, { encrypted: true } as any);

  return { newDocId: docId, authDocId: '' };
}

/**
 * Get a list of documents that haven't been migrated yet.
 */
export function getUnmigratedDocs(): { id: string; name?: string; type?: string }[] {
  return getDocList().filter(e => !e.encrypted);
}
