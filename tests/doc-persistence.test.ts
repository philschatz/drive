/**
 * Tests for document persistence across refresh.
 *
 * Historically the drive ran a noop Subduction and worked around three bugs
 * (late save-listener registration, getBlobs returning [], 32-byte id
 * truncation) with explicit saveDoc + a loadingDocId getBlobs shim.
 *
 * automerge-repo (subduction.37) builds Subduction internally, so the Repo
 * now persists created/edited documents and reloads them on its own — no
 * subduction option or workarounds required. These tests verify that real
 * behavior.
 */

const { Repo } = require('@automerge/automerge-repo');

// --- Helpers ---

type StorageKey = string[];

function inMemoryStorage() {
  const store = new Map<string, Uint8Array>();
  const key = (k: StorageKey) => k.join('\x00');
  return {
    store,
    async load(k: StorageKey) { return store.get(key(k)); },
    async save(k: StorageKey, data: Uint8Array) { store.set(key(k), data); },
    async remove(k: StorageKey) { store.delete(key(k)); },
    async loadRange(prefix: StorageKey) {
      const p = prefix.join('\x00');
      const out: { key: StorageKey; data: Uint8Array }[] = [];
      for (const [k, v] of store) {
        if (k === p || k.startsWith(p + '\x00')) out.push({ key: k.split('\x00'), data: v });
      }
      return out;
    },
    async removeRange(prefix: StorageKey) {
      const p = prefix.join('\x00');
      for (const k of store.keys()) if (k === p || k.startsWith(p + '\x00')) store.delete(k);
    },
  };
}

const initialDoc = { '@type': 'Calendar', name: 'Test', events: {} };

const repos: any[] = [];
afterAll(async () => { for (const r of repos) try { await r.shutdown(); } catch {} });

function makeRepo(storage: any, peerId: string) {
  const r = new Repo({ storage, peerId: peerId as any } as any);
  repos.push(r);
  return r;
}

// --- Tests ---

describe('document persistence with internal subduction (subduction.37)', () => {
  it('Repo.create() persists the initial doc', async () => {
    const repo = makeRepo(inMemoryStorage(), 'test-1');
    const handle = repo.create(initialDoc);
    await new Promise(r => setTimeout(r, 200));
    expect(await repo.storageSubsystem!.loadDocData(handle.documentId)).not.toBeNull();
  });

  it('edits after create are persisted', async () => {
    const repo = makeRepo(inMemoryStorage(), 'test-2');
    const handle = repo.create(initialDoc);
    handle.change((d: any) => { d.name = 'Edited'; });
    await new Promise(r => setTimeout(r, 200));
    expect(await repo.storageSubsystem!.loadDocData(handle.documentId)).not.toBeNull();
  });

  it('cross-session: a new Repo over the same storage reloads the saved doc', async () => {
    const storage = inMemoryStorage();

    // Session 1: create + edit
    const repo1 = makeRepo(storage, 'session-1');
    const handle = repo1.create(initialDoc);
    handle.change((d: any) => { d.name = 'Edited by Alice'; });
    const url = handle.url;
    await new Promise(r => setTimeout(r, 200));
    await repo1.shutdown();

    // Session 2: a fresh Repo over the same storage finds the document
    const repo2 = makeRepo(storage, 'session-2');
    const reloaded = await repo2.find(url);
    expect((reloaded.doc() as any).name).toBe('Edited by Alice');
  });
});
