/**
 * The small rules around document sync, each in isolation:
 *
 * - the interceptor guard: an unprotected document is never stored for sync,
 *   and a commit that cannot be read yet is one to retry, never one to drop;
 * - the document policy: who is served, and whose changes are taken;
 * - the member scope: a document is offered only to the peers that are in it,
 *   and presence is taken only when it is what the link proved it to be;
 * - the storage guard: compaction may not delete what a document still needs;
 * - the keyhive-only adapter: no classic message crosses, in either direction.
 *
 * Keyhive and subduction are stand-ins here; the same rules against the real
 * ones are tests/e2ee-*.test.ts.
 */
import { EventEmitter } from 'events';
import { Encoder } from 'cbor-x';
import { isUnprotectedDoc } from '@automerge/automerge-repo-keyhive';
import { stringifyAutomergeUrl } from '@automerge/automerge-repo';
import { makeGuardedInterceptor, isUnprotectedDocId, PENDING_DECRYPT_TTL_MS } from '../src/shared/subduction-interceptor';
import { makeDocPolicy } from '../src/shared/subduction-policy';
import { scopeSubductionToMembers, acceptEphemeral, PACE_BYTES_PER_SECOND } from '../src/shared/subduction-scope';
import { guardSubductionStorage, type DocShape } from '../src/shared/subduction-storage-guard';
import { makeKeyhiveOnlyAdapter } from '../src/shared/keyhive-only-adapter';
import { makeMemStorage } from './support/mem-storage';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const id = (b: Uint8Array) => ({ toBytes: () => b });
const PROTECTED = bytes(32, 5);
const UNPROTECTED = (() => { const b = new Uint8Array(32); b.fill(9, 0, 16); return b; })();

describe('the interceptor guard', () => {
  const inner = () => ({
    transformOutgoing: jest.fn(async (_d: string, _c: string, _p: string[], blob: Uint8Array) => Uint8Array.from([...blob, 1])),
    transformIncoming: jest.fn(async (_d: string, _c: string, blob: Uint8Array): Promise<Uint8Array | null> => blob),
  });
  const guard = (i: ReturnType<typeof inner>, extra: Record<string, unknown> = {}) => makeGuardedInterceptor({
    inner: Promise.resolve(i as any),
    docIdBytes: (documentId) => (documentId === 'plain' ? UNPROTECTED : documentId === 'short' ? bytes(16) : PROTECTED),
    ...extra,
  });

  it('agrees with the bridge on what an unprotected id is', () => {
    for (const b of [PROTECTED, UNPROTECTED, bytes(16), bytes(32, 0), (() => { const x = new Uint8Array(32); x[31] = 1; return x; })()]) {
      expect(isUnprotectedDocId(b)).toBe(isUnprotectedDoc(stringifyAutomergeUrl(b as any)));
    }
  });

  it('never stores or accepts an unprotected document, and does not ask the bridge', async () => {
    const i = inner();
    const g = guard(i);
    for (const doc of ['plain', 'short']) {
      expect(await g.transformOutgoing(doc, 'c1', [], bytes(4), async () => null)).toBeNull();
      expect(await g.transformIncoming(doc, 'c1', bytes(4), async () => null)).toBeNull();
    }
    expect(i.transformOutgoing).not.toHaveBeenCalled();
    expect(i.transformIncoming).not.toHaveBeenCalled();
    expect(g.hasPendingDecrypts()).toBe(false);
  });

  it('passes a protected document through the bridge', async () => {
    const i = inner();
    const g = guard(i);
    expect(await g.transformOutgoing('doc', 'c1', [], bytes(2), async () => null)).toEqual(Uint8Array.from([7, 7, 1]));
    expect(await g.transformIncoming('doc', 'c1', bytes(2), async () => null)).toEqual(bytes(2));
  });

  it('treats a commit that cannot be read — returned as such, or thrown — as pending, until it can', async () => {
    const i = inner();
    const onPendingDecrypt = jest.fn();
    const g = guard(i, { onPendingDecrypt });

    i.transformIncoming.mockResolvedValueOnce(null);
    expect(await g.transformIncoming('doc', 'c1', bytes(2), async () => null)).toBeNull();
    i.transformIncoming.mockRejectedValueOnce(new Error('keyhive said no'));
    expect(await g.transformIncoming('doc', 'c2', bytes(2), async () => null)).toBeNull();
    expect(g.hasPendingDecrypts()).toBe(true);
    expect(onPendingDecrypt).toHaveBeenCalledTimes(2);

    // Retried and still unreadable: not a new event.
    i.transformIncoming.mockResolvedValueOnce(null);
    await g.transformIncoming('doc', 'c1', bytes(2), async () => null);
    expect(onPendingDecrypt).toHaveBeenCalledTimes(2);

    await g.transformIncoming('doc', 'c1', bytes(2), async () => null);
    await g.transformIncoming('doc', 'c2', bytes(2), async () => null);
    expect(g.hasPendingDecrypts()).toBe(false);
  });

  it('stops counting a commit as pending once it has been unreadable too long to be waiting for a key', async () => {
    const i = inner();
    let now = 1_000;
    const g = guard(i, { now: () => now });
    i.transformIncoming.mockResolvedValueOnce(null);
    await g.transformIncoming('doc', 'c1', bytes(2), async () => null);
    now += PENDING_DECRYPT_TTL_MS - 1;
    expect(g.hasPendingDecrypts()).toBe(true);
    now += 2;
    expect(g.hasPendingDecrypts()).toBe(false);
  });

  it('skips a change it cannot encrypt rather than letting the error through', async () => {
    const i = inner();
    i.transformOutgoing.mockRejectedValueOnce(new Error('Failed to make app secret'));
    expect(await guard(i).transformOutgoing('doc', 'c1', [], bytes(2), async () => null)).toBeNull();
  });
});

describe('the document policy', () => {
  const READER = bytes(32, 1); const EDITOR = bytes(32, 2); const NOBODY = bytes(32, 3);
  const access = (key: Uint8Array) => (key[0] === 1 ? 'relay' : key[0] === 2 ? 'edit' : null);
  const make = () => {
    const hasAccess = jest.fn(async (key: Uint8Array, _doc: Uint8Array, level: 'relay' | 'edit') =>
      (access(key) === 'edit' || (access(key) === 'relay' && level === 'relay')));
    const mayConnect = jest.fn(async (key: Uint8Array) => key[0] !== 3);
    return { policy: makeDocPolicy({ hasAccess, mayConnect }), hasAccess, mayConnect };
  };

  it('serves a document to anyone with access, and to nobody without', async () => {
    const { policy } = make();
    await expect(policy.authorizeFetch(id(READER), id(PROTECTED))).resolves.toBeUndefined();
    await expect(policy.authorizeFetch(id(EDITOR), id(PROTECTED))).resolves.toBeUndefined();
    await expect(policy.authorizeFetch(id(NOBODY), id(PROTECTED))).rejects.toThrow();
    const ids = [id(PROTECTED), id(UNPROTECTED)];
    expect(await policy.filterAuthorizedFetch(id(READER), ids)).toEqual([ids[0]]);
    expect(await policy.filterAuthorizedFetch(id(NOBODY), ids)).toEqual([]);
  });

  it('takes a commit if its author may edit, or the peer handing it over may', async () => {
    const { policy } = make();
    await expect(policy.authorizePut(id(READER), id(EDITOR), id(PROTECTED))).resolves.toBeUndefined(); // a reader relays an editor's work
    await expect(policy.authorizePut(id(EDITOR), id(NOBODY), id(PROTECTED))).resolves.toBeUndefined(); // an editor relays a removed author's work
    await expect(policy.authorizePut(id(READER), id(READER), id(PROTECTED))).rejects.toThrow();        // a reader's own
    await expect(policy.authorizePut(id(READER), id(NOBODY), id(PROTECTED))).rejects.toThrow();
  });

  it('refuses an unprotected document outright, without asking keyhive', async () => {
    const { policy, hasAccess } = make();
    await expect(policy.authorizeFetch(id(EDITOR), id(UNPROTECTED))).rejects.toThrow();
    await expect(policy.authorizePut(id(EDITOR), id(EDITOR), id(UNPROTECTED))).rejects.toThrow();
    expect(hasAccess).not.toHaveBeenCalled();
  });

  it('refuses a connection that is not wanted', async () => {
    const { policy } = make();
    await expect(policy.authorizeConnect(id(EDITOR))).resolves.toBeUndefined();
    await expect(policy.authorizeConnect(id(NOBODY))).rejects.toThrow();
  });

  it('asks keyhive once per question until told its state changed, and denies when the question fails', async () => {
    const { policy, hasAccess } = make();
    for (let i = 0; i < 5; i++) await policy.authorizeFetch(id(READER), id(PROTECTED));
    expect(hasAccess).toHaveBeenCalledTimes(1);
    policy.invalidate();
    await policy.authorizeFetch(id(READER), id(PROTECTED));
    expect(hasAccess).toHaveBeenCalledTimes(2);

    policy.invalidate();
    hasAccess.mockRejectedValueOnce(new Error('keyhive trapped'));
    expect(await policy.allows(READER, PROTECTED, 'relay')).toBe(false);
  });
});

describe('the member scope', () => {
  const member = { peerId: 'member', deviceKey: bytes(32, 1), subductionPeerId: { name: 'member' } };
  const friend = { peerId: 'friend', deviceKey: bytes(32, 2), subductionPeerId: { name: 'friend' } };
  const make = (extra: Record<string, unknown> = {}) => {
    let sent = 0;
    const datagrams: [string, Uint8Array][] = [];
    const subduction: any = {
      syncWithAllPeers: jest.fn(),
      syncWithPeer: jest.fn(async (peer: any) => ({ success: true, stats: { commitsReceived: 1, fragmentsReceived: 0 }, peer })),
      subscribeEphemeral: jest.fn(), unsubscribeEphemeral: jest.fn(), publishEphemeral: jest.fn(),
    };
    const stock = { ...subduction };
    const scope = scopeSubductionToMembers(subduction, {
      links: {
        linked: () => [member, friend],
        sendDatagram: (peerId: string, payload: Uint8Array) => { datagrams.push([peerId, payload]); return true; },
        bytesSent: () => sent,
      },
      policy: { allows: async (key: Uint8Array) => key[0] === 1 },
      ...extra,
    });
    return { subduction, stock, scope, datagrams, cost: (n: number) => { sent += n; } };
  };
  const doc = { toBytes: () => PROTECTED, toString: () => 'doc-a' };

  it('syncs a document only with the linked peers that are in it, and never subscribes', async () => {
    const { subduction, stock } = make();
    const result = await subduction.syncWithAllPeers(doc, true, 1234);
    expect(stock.syncWithAllPeers).not.toHaveBeenCalled();
    expect(subduction.syncWithPeer.mock.calls).toEqual([[member.subductionPeerId, doc, false, 1234]]);
    expect(result.entries()).toHaveLength(1);
    expect(result.entries()[0].success).toBe(true);
  });

  it('reports a peer whose sync threw as a failed result, not as an exception', async () => {
    const { subduction } = make();
    subduction.syncWithPeer.mockRejectedValueOnce(new Error('link went away'));
    const result = await subduction.syncWithAllPeers(doc, true);
    expect(result.entries().map((r: any) => r.success)).toEqual([false]);
  });

  it('asks for one more round when a document\'s sync succeeds after having failed', async () => {
    const onRecovered = jest.fn();
    const { subduction, scope } = make({ onRecovered });
    await subduction.syncWithAllPeers(doc, true);
    await sleep(5);
    expect(onRecovered).not.toHaveBeenCalled(); // nothing had failed

    subduction.syncWithPeer.mockResolvedValueOnce({ success: false });
    await subduction.syncWithAllPeers(doc, true);
    await subduction.syncWithAllPeers(doc, true);
    await sleep(5);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered.mock.calls[0][0]).toEqual(PROTECTED);
    scope.stop();
  });

  it('spaces a document\'s rounds by what the last one cost, and only that document\'s', async () => {
    const { subduction, scope, cost } = make();
    subduction.syncWithPeer.mockImplementationOnce(async () => { cost(PACE_BYTES_PER_SECOND / 4); return { success: true }; });
    await subduction.syncWithAllPeers(doc, true); // cost: a quarter of a second's budget

    const t = Date.now();
    await subduction.syncWithAllPeers({ toBytes: () => PROTECTED, toString: () => 'doc-b' }, true);
    expect(Date.now() - t).toBeLessThan(100); // another document is not held
    await subduction.syncWithAllPeers(doc, true);
    expect(Date.now() - t).toBeGreaterThanOrEqual(200); // this one waited out the quarter second
    scope.stop();
  });

  it('releases rounds that are waiting when the Repo shuts down', async () => {
    const { subduction, scope, cost } = make();
    subduction.syncWithPeer.mockImplementationOnce(async () => { cost(PACE_BYTES_PER_SECOND * 4); return { success: true }; });
    await subduction.syncWithAllPeers(doc, true);
    const t = Date.now();
    const held = subduction.syncWithAllPeers(doc, true);
    scope.stop();
    await held;
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('subscribes to nothing, and publishes presence to members as link datagrams', async () => {
    const { subduction, stock, datagrams } = make();
    await subduction.subscribeEphemeral([{}]);
    await subduction.publishEphemeral({ toBytes: () => PROTECTED }, Uint8Array.from([1, 2, 3]));
    expect(stock.subscribeEphemeral).not.toHaveBeenCalled();
    expect(stock.publishEphemeral).not.toHaveBeenCalled();
    expect(datagrams.map(([peerId]) => peerId)).toEqual(['member']);
    expect(datagrams[0][1]).toEqual(Uint8Array.from([...PROTECTED, 1, 2, 3]));
  });

  describe('presence arriving', () => {
    const cbor = new Encoder({ tagUint8Array: false, useRecords: false });
    const peer = { peerId: 'peer-1', deviceKey: bytes(32, 1), subductionPeerId: {} };
    const datagram = (message: Record<string, unknown>, topic = PROTECTED) =>
      Uint8Array.from([...topic, ...(cbor.encode(message) as Uint8Array)]);
    const good = { type: 'ephemeral', senderId: 'peer-1', targetId: 'me', documentId: 'doc-1', data: Uint8Array.from([1]) };
    const run = async (bytesIn: Uint8Array, over: Record<string, unknown> = {}) => {
      const deliver = jest.fn();
      await acceptEphemeral(peer, bytesIn, {
        policy: { allows: async () => true },
        isOpen: () => true,
        docIdBytes: () => PROTECTED,
        deliver,
        ...over,
      } as any);
      return deliver;
    };

    it('is handed to the Repo when it is what the link proved it to be', async () => {
      const deliver = await run(datagram(good));
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0][0]).toMatchObject({ type: 'ephemeral', senderId: 'peer-1', documentId: 'doc-1' });
    });

    it.each([
      ['it names a sender other than the peer on the link', datagram({ ...good, senderId: 'someone-else' }), {}],
      ['it is not an ephemeral message', datagram({ ...good, type: 'sync' }), {}],
      ['its topic is another document\'s', datagram(good, bytes(32, 8)), {}],
      ['the document is not open here', datagram(good), { isOpen: () => false }],
      ['the peer is not in the document', datagram(good), { policy: { allows: async () => false } }],
      ['it is not a message at all', Uint8Array.from([...PROTECTED, 0xff, 0xff]), {}],
      ['it is too short to carry one', PROTECTED, {}],
    ])('is dropped when %s', async (_why, bytesIn, over) => {
      expect(await run(bytesIn as Uint8Array, over as Record<string, unknown>)).not.toHaveBeenCalled();
    });
  });
});

describe('the storage guard', () => {
  const SID = 'ab'.repeat(32);
  const key = (kind: string, hash: string) => ['subduction-interceptor', kind, SID, hash];
  const make = async (shape: Partial<DocShape> | undefined, storedFragments: string[] = []) => {
    const mem = makeMemStorage();
    for (const head of storedFragments) await mem.save(key('fragments', head), bytes(1));
    for (const hash of ['c1', 'c2']) { await mem.save(key('commits', hash), bytes(1)); await mem.save(key('blobs', hash), bytes(1)); }
    const guarded = guardSubductionStorage(mem, {
      shape: () => (shape === undefined ? undefined : {
        has: () => true, looseCommits: new Set<string>(), fragments: new Set<string>(), ...shape,
      }),
    });
    return { mem, guarded };
  };

  it('refuses to delete a record that has not been applied to its document yet', async () => {
    const { mem, guarded } = await make({ has: (hash) => hash !== 'c1' });
    await expect(guarded.remove(key('commits', 'c1'))).rejects.toThrow(/not been applied/);
    await expect(guarded.remove(key('blobs', 'c1'))).rejects.toThrow(/not been applied/);
    expect(await mem.load(key('commits', 'c1'))).toBeDefined();
  });

  it('refuses to delete a record that is part of its document — the list it came from is out of date', async () => {
    const { guarded } = await make({ looseCommits: new Set(['c1']), fragments: new Set(['f1']) }, ['f1']);
    await expect(guarded.remove(key('commits', 'c1'))).rejects.toThrow(/part of its document/);
    await expect(guarded.remove(key('fragments', 'f1'))).rejects.toThrow(/part of its document/);
    await expect(guarded.remove(key('fragment-blobs', 'f1'))).rejects.toThrow(/part of its document/);
  });

  it('refuses to delete an absorbed commit while a fragment of the document is not in the store', async () => {
    const { mem, guarded } = await make({ fragments: new Set(['f1', 'f2']) }, ['f1']);
    await expect(guarded.remove(key('commits', 'c1'))).rejects.toThrow(/not in the store yet/);

    // The missing fragment is saved (through the guard, as the Repo would): now the commit may go.
    await guarded.saveBatch!([[key('fragments', 'f2'), bytes(1)]]);
    await guarded.remove(key('commits', 'c1'));
    expect(await mem.load(key('commits', 'c1'))).toBeUndefined();
  });

  it('lets an absorbed record go when every fragment of the document is stored', async () => {
    const { mem, guarded } = await make({ fragments: new Set(['f2']) }, ['f1', 'f2']);
    await guarded.remove(key('commits', 'c2'));
    await guarded.remove(key('fragments', 'f1')); // absorbed into a higher fragment
    expect(await mem.load(key('commits', 'c2'))).toBeUndefined();
    expect(await mem.load(key('fragments', 'f1'))).toBeUndefined();
  });

  it('stays out of the way of everything else', async () => {
    const { mem, guarded } = await make(undefined);
    await guarded.remove(key('commits', 'c1'));            // the document is not open here
    expect(await mem.load(key('commits', 'c1'))).toBeUndefined();
    await guarded.save(['some-doc', 'snapshot', 'x'], bytes(3));
    expect(await guarded.load(['some-doc', 'snapshot', 'x'])).toEqual(bytes(3));
    await guarded.remove(['some-doc', 'snapshot', 'x']);
    expect((await guarded.loadRange(['some-doc'])).length).toBe(0);
    await guarded.removeRange(['subduction-interceptor']);
    expect((await guarded.loadRange(['subduction-interceptor'])).length).toBe(0);
  });
});

describe('the keyhive-only adapter', () => {
  class FakeBase extends EventEmitter { peerId?: string; peerMetadata?: unknown }
  const make = () => {
    const channel = new EventEmitter() as any;
    channel.send = jest.fn(); channel.connect = jest.fn(); channel.disconnect = jest.fn();
    channel.isReady = () => true; channel.whenReady = () => Promise.resolve(); channel.state = () => ({ value: 'ready' });
    const adapter = makeKeyhiveOnlyAdapter(FakeBase as any, channel) as any;
    const seen: any[] = [];
    adapter.on('message', (m: any) => seen.push(m.type));
    return { channel, adapter, seen };
  };

  it('sends keyhive\'s own messages and nothing classic', () => {
    const { channel, adapter } = make();
    for (const type of ['keyhive-sync-request', 'sync', 'request', 'ephemeral', 'doc-unavailable', 'remote-heads-changed']) {
      adapter.send({ type, senderId: 'me', targetId: 'peer', data: bytes(1) });
    }
    expect(channel.send.mock.calls.map(([m]: any) => m.type)).toEqual(['keyhive-sync-request']);
  });

  it('hears keyhive\'s own messages and nothing classic, and leaves link frames to the links', () => {
    const { channel, seen } = make();
    for (const type of ['keyhive-sync-ops', 'sync', 'request', 'ephemeral', 'subduction-connection']) {
      channel.emit('message', { type, senderId: 'peer', targetId: 'me', data: bytes(1) });
    }
    expect(seen).toEqual(['keyhive-sync-ops']);
  });

  it('passes peers coming and going, and connects the channel under it', () => {
    const { channel, adapter } = make();
    const events: string[] = [];
    adapter.on('peer-candidate', (p: any) => events.push(`+${p.peerId}`));
    adapter.on('peer-disconnected', (p: any) => events.push(`-${p.peerId}`));
    adapter.on('close', () => events.push('close'));
    channel.emit('peer-candidate', { peerId: 'peer', peerMetadata: {} });
    channel.emit('peer-disconnected', { peerId: 'peer' });
    channel.emit('close');
    expect(events).toEqual(['+peer', '-peer', 'close']);
    adapter.connect('me');
    expect(channel.connect).toHaveBeenCalledWith('me', undefined);
  });
});
