/**
 * Regression test for multi-peer sync across refresh with noop subduction.
 *
 * Scenario: Alice creates a doc, Bob connects, both edit, Bob simulates a refresh
 * (new Repo with same storage), then both continue editing and verify sync.
 *
 * This exercises the pattern used by automerge-worker.ts:
 *  - noop subduction with loadingDocId-backed getBlobs
 *  - CollectionSynchronizer handles all peer-to-peer sync
 *  - Storage persists docs across a "refresh" (new Repo instance on same storage)
 */

const { Repo } = require('@automerge/automerge-repo');
const { MessageChannelNetworkAdapter } = require('@automerge/automerge-repo-network-messagechannel');

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

function makeSubduction(opts?: { repoRef: { current: any }; loadingDocIdRef: { current: string | null } }) {
  return {
    storage: {},
    removeSedimentree() {},
    connectDiscover() {},
    disconnectAll() {},
    disconnectFromPeer() {},
    syncAll() { return Promise.resolve({ entries() { return []; } }); },
    syncWithAllPeers() { return Promise.resolve(new Map()); },
    async getBlobs(_sedimentreeId: any) {
      if (!opts) return [];
      const { repoRef, loadingDocIdRef } = opts;
      const docId = loadingDocIdRef.current;
      if (!docId || !repoRef.current?.storageSubsystem) return [];
      const data: Uint8Array | null = await repoRef.current.storageSubsystem.loadDocData(docId);
      return data ? [data] : [];
    },
    addCommit() { return Promise.resolve(undefined); },
    addFragment() { return Promise.resolve(undefined); },
  };
}

function waitFor(fn: () => boolean, timeoutMs = 2000, pollMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`waitFor timeout: ${fn.toString()}`));
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

const repos: any[] = [];
afterAll(async () => { for (const r of repos) try { await r.shutdown(); } catch {} });

function makeRepo(storage: any, network: any[], peerId: string, loadingDocIdRef: { current: string | null }) {
  const repoRef: { current: any } = { current: null };
  const repo = new Repo({
    storage,
    network,
    subduction: makeSubduction({ repoRef, loadingDocIdRef }),
    peerId: peerId as any,
  } as any);
  repoRef.current = repo;
  repos.push(repo);
  return repo;
}

describe('multi-peer sync across refresh', () => {
  it('initial sync: Alice creates a doc, Bob finds it, both see each others edits', async () => {
    const ch = new MessageChannel();
    const aliceLoadingRef = { current: null as string | null };
    const bobLoadingRef = { current: null as string | null };

    const alice = makeRepo(
      inMemoryStorage(),
      [new MessageChannelNetworkAdapter(ch.port1)],
      'alice',
      aliceLoadingRef,
    );
    const bob = makeRepo(
      inMemoryStorage(),
      [new MessageChannelNetworkAdapter(ch.port2)],
      'bob',
      bobLoadingRef,
    );

    const aliceHandle = alice.create({ '@type': 'Calendar', name: 'Shared', events: {} });
    aliceHandle.change((d: any) => { d.name = 'Alice initial'; });
    const docId = aliceHandle.documentId;
    await alice.storageSubsystem!.saveDoc(docId, aliceHandle.doc());

    bobLoadingRef.current = docId;
    const bobHandle = await bob.find(docId);
    bobLoadingRef.current = null;
    await waitFor(() => (bobHandle.doc() as any)?.name === 'Alice initial');

    aliceHandle.change((d: any) => { d.events['a1'] = { title: 'From Alice' }; });
    bobHandle.change((d: any) => { d.events['b1'] = { title: 'From Bob' }; });
    await waitFor(() => {
      const a = aliceHandle.doc() as any;
      const b = bobHandle.doc() as any;
      return !!a.events.a1 && !!a.events.b1 && !!b.events.a1 && !!b.events.b1;
    });
  }, 10000);

  // REGRESSION: Reported issue where after Bob refreshes, neither peer sees
  // the other's subsequent edits. Currently fails (documents the bug).
  it.skip("REGRESSION: after Bob refreshes, new edits still sync in both directions", async () => {
    const ch1 = new MessageChannel();
    const aliceStorage = inMemoryStorage();
    const bobStorage = inMemoryStorage();
    const aliceLoadingRef = { current: null as string | null };
    const bobLoadingRef = { current: null as string | null };

    const alice = makeRepo(
      aliceStorage,
      [new MessageChannelNetworkAdapter(ch1.port1)],
      'alice',
      aliceLoadingRef,
    );
    const bob1 = makeRepo(
      bobStorage,
      [new MessageChannelNetworkAdapter(ch1.port2)],
      'bob',
      bobLoadingRef,
    );

    const aliceHandle = alice.create({ '@type': 'Calendar', name: 'Shared', events: {} });
    aliceHandle.change((d: any) => { d.name = 'Alice initial'; });
    const docId = aliceHandle.documentId;
    await alice.storageSubsystem!.saveDoc(docId, aliceHandle.doc());

    bobLoadingRef.current = docId;
    const bobHandle1 = await bob1.find(docId);
    bobLoadingRef.current = null;
    await waitFor(() => (bobHandle1.doc() as any)?.name === 'Alice initial');

    aliceHandle.change((d: any) => { d.events['a1'] = { title: 'From Alice' }; });
    bobHandle1.change((d: any) => { d.events['b1'] = { title: 'From Bob' }; });
    await waitFor(() => {
      const a = aliceHandle.doc() as any;
      const b = bobHandle1.doc() as any;
      return !!a.events.a1 && !!a.events.b1 && !!b.events.a1 && !!b.events.b1;
    });

    await bob1.storageSubsystem!.saveDoc(docId, bobHandle1.doc());

    // Bob refreshes: new Repo on same storage, new MessageChannel port
    const ch2 = new MessageChannel();
    alice.networkSubsystem.addNetworkAdapter(new MessageChannelNetworkAdapter(ch2.port1));

    const bob2 = makeRepo(
      bobStorage,
      [new MessageChannelNetworkAdapter(ch2.port2)],
      'bob',
      bobLoadingRef,
    );

    bobLoadingRef.current = docId;
    const bobHandle2 = await bob2.find(docId);
    bobLoadingRef.current = null;

    await waitFor(() => {
      const d = bobHandle2.doc() as any;
      return d?.events?.a1 && d?.events?.b1;
    });

    aliceHandle.change((d: any) => { d.events['a2'] = { title: 'Alice after refresh' }; });
    bobHandle2.change((d: any) => { d.events['b2'] = { title: 'Bob after refresh' }; });

    await waitFor(() => {
      const a = aliceHandle.doc() as any;
      const b = bobHandle2.doc() as any;
      return !!a.events.a2 && !!a.events.b2 && !!b.events.a2 && !!b.events.b2;
    }, 4000);
  }, 10000);
});
