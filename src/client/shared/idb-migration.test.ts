/**
 * Tests for the v1→v2 IndexedDB key migration in idb-storage.ts.
 *
 * v1 used ad-hoc key names; v2 namespaces them by category (data:/data:auth:/cache:).
 * The migration must preserve data/auth values under their new keys, drop disposable
 * cache (`qc:*`), and drop the removed device-linking migration keys — without ever
 * losing `user-group-id` (the keyhive identity).
 */

import 'fake-indexeddb/auto';

import { idbGet, KEYS, closeDb } from './idb-storage';
import { LEGACY_IDB_KEYS } from '../../shared/storage-keys';

const DB_NAME = 'app-storage';
const STORE = 'keyval';

/** Create a v1 database (version 1) and seed the given key/value pairs. */
function seedV1(entries: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [k, v] of Object.entries(entries)) store.put(v, k);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    // Wait for actual completion (not onblocked) so the next seedV1 opens a truly
    // empty v1 DB. closeDb() above releases the cached connection so the delete proceeds.
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

beforeEach(async () => {
  closeDb(); // close the cached connection so deleteDatabase isn't blocked
  await deleteDb();
});

afterAll(() => closeDb());

it('renames legacy data/auth keys, preserving their values', async () => {
  await seedV1({
    'automerge-doc-ids': [{ id: 'doc1' }, { id: 'doc2' }],
    'contact-names': { agentA: 'Alice' },
    'known-contact-groups': ['groupA'],
    'user-group-id': 'my-group-id',
  });

  // First access opens at v2, triggering the migration in onupgradeneeded.
  // contact-names / known-contact-groups now land on their LEGACY_IDB_KEYS names,
  // from which the engine's one-time doc-migration later picks them up.
  expect(await idbGet(KEYS.docIds)).toEqual([{ id: 'doc1' }, { id: 'doc2' }]);
  expect(await idbGet(LEGACY_IDB_KEYS.friendNames)).toEqual({ agentA: 'Alice' });
  expect(await idbGet(LEGACY_IDB_KEYS.knownFriendGroups)).toEqual(['groupA']);
  expect(await idbGet(KEYS.userGroupId)).toBe('my-group-id');

  // Old keys are gone after the rename.
  expect(await idbGet('automerge-doc-ids')).toBeNull();
  expect(await idbGet('user-group-id')).toBeNull();
  expect(await idbGet('contact-names')).toBeNull();
  expect(await idbGet('known-contact-groups')).toBeNull();
});

it('deletes legacy cache (qc:*) and removed device-linking keys', async () => {
  await seedV1({
    'qc:doc1:abc': { result: 1 },
    'qc:doc1:validation': { result: [] },
    'linked-devices': ['deviceA'],
    'pending-group-adds': ['deviceB'],
    'user-group-id': 'keep-me',
  });

  // Migration runs on first access.
  expect(await idbGet('user-group-id')).toBeNull(); // renamed
  expect(await idbGet(KEYS.userGroupId)).toBe('keep-me');

  // Disposable / removed keys are dropped.
  expect(await idbGet('qc:doc1:abc')).toBeNull();
  expect(await idbGet('qc:doc1:validation')).toBeNull();
  expect(await idbGet('linked-devices')).toBeNull();
  expect(await idbGet('pending-group-adds')).toBeNull();
});

it('leaves settings:* keys untouched', async () => {
  await seedV1({ 'settings:debug-enable': true, 'user-group-id': 'x' });
  expect(await idbGet('settings:debug-enable')).toBe(true);
});

it('opens cleanly on a fresh database with nothing to migrate', async () => {
  // No seed: getDb creates the store at v2 (oldVersion 0, migration skipped).
  expect(await idbGet(KEYS.docIds)).toBeNull();
});
