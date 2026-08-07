/**
 * Cross-tab router (src/client/ui/tab-router.ts).
 *
 * The router is what lets several tabs share one engine, and every guarantee it
 * makes is about *not confusing two clients for one*: ids are per-tab and both tabs
 * start at 1, doc-scoped subscriptions have no id at all, and a tab can vanish
 * mid-subscription. Those are exactly the cases below.
 *
 * Both halves are injected (a fake Worker, a fake bus), so no browser is involved.
 */
import { startTabRouter, type RouterWorker, type TabRouter } from '../src/client/ui/tab-router';
import { LEADER_CLIENT_ID, type TabEnvelope } from '../src/client/shared/tab-channel';
import type { WorkerToMain } from '../src/shared/worker-protocol';

/** A Worker stand-in that records what the router forwarded and can reply. */
function fakeWorker() {
  const sent: any[] = [];
  const w: RouterWorker = {
    postMessage: (msg: any) => { sent.push(msg); },
    terminate: jest.fn(),
    onmessage: null,
    onerror: null,
    onmessageerror: null,
  };
  return {
    worker: w,
    sent,
    /** Simulate the engine emitting a message. */
    emit: (msg: WorkerToMain) => w.onmessage?.({ data: msg }),
    /** Everything forwarded of one type. */
    ofType: (type: string) => sent.filter((m) => m.type === type),
    clear: () => { sent.length = 0; },
  };
}

/**
 * A BroadcastChannel stand-in. Real BroadcastChannel never echoes to the posting
 * object, which is why the router's own broadcasts are captured here rather than fed
 * back into it.
 */
function fakeBus() {
  const posted: TabEnvelope[] = [];
  let handler: ((e: { data: TabEnvelope }) => void) | null = null;
  return {
    bus: {
      postMessage: (m: TabEnvelope) => { posted.push(m); },
      get onmessage() { return handler; },
      set onmessage(h: ((e: { data: TabEnvelope }) => void) | null) { handler = h; },
      close: () => { handler = null; },
    },
    posted,
    /** A follower tab sends an envelope to the router. */
    deliver: (env: TabEnvelope) => handler?.({ data: env }),
    ofKind: <K extends TabEnvelope['kind']>(kind: K) =>
      posted.filter((e) => e.kind === kind) as Extract<TabEnvelope, { kind: K }>[],
    clear: () => { posted.length = 0; },
  };
}

function harness(now?: () => number) {
  const w = fakeWorker();
  const b = fakeBus();
  const local: WorkerToMain[] = [];
  const fatal: string[] = [];
  const router = startTabRouter({
    worker: w.worker,
    bus: b.bus,
    onLocal: (msg) => local.push(msg),
    onFatal: (msg) => fatal.push(msg),
    now,
  });
  return { w, b, local, fatal, router };
}

/** Register a follower tab and return its assigned clientId. */
function join(h: ReturnType<typeof harness>, nonce = 'n1'): number {
  h.b.deliver({ kind: 'hello', nonce });
  const welcome = h.b.ofKind('welcome').find((e) => e.nonce === nonce);
  if (!welcome) throw new Error('no welcome for ' + nonce);
  return welcome.clientId;
}

let routers: TabRouter[] = [];
afterEach(() => { for (const r of routers) r.stop(); routers = []; });
function track(h: ReturnType<typeof harness>) { routers.push(h.router); return h; }

describe('request id namespacing', () => {
  it('gives each client its own reply when both use id 1', () => {
    const h = track(harness());
    const b = join(h, 'b');

    // The leader tab and a follower both mint id 1 — WorkerClient starts there.
    h.router.postLocal({ type: 'get-doc-list', id: 1 });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'get-doc-list', id: 1 } });

    const forwarded = h.w.sent;
    expect(forwarded).toHaveLength(2);
    const [leaderId, followerId] = forwarded.map((m) => m.id);
    expect(leaderId).not.toBe(followerId);

    h.w.emit({ type: 'result', id: followerId, result: ['follower-doc'] } as any);
    h.w.emit({ type: 'result', id: leaderId, result: ['leader-doc'] } as any);

    // Each side sees its OWN id 1 back, carrying its own result.
    expect(h.local).toEqual([{ type: 'result', id: 1, result: ['leader-doc'] }]);
    expect(h.b.ofKind('res').map((e) => e.msg)).toEqual([
      { type: 'result', id: 1, result: ['follower-doc'] },
    ]);
  });

  it('routes open-doc progress to the requester and keeps the id alive until the result', () => {
    const h = track(harness());
    const b = join(h, 'b');
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'open-doc', id: 1, docId: 'd1' } });
    const gid = h.w.sent[0].id;

    h.w.emit({ type: 'open-doc-progress', id: gid, pct: 50, message: 'half' } as any);
    h.w.emit({ type: 'open-doc-progress', id: gid, pct: 90, message: 'nearly' } as any);
    h.w.emit({ type: 'result', id: gid, result: { docId: 'd1' } } as any);
    // Anything after the result has no owner and must not be delivered.
    h.w.emit({ type: 'result', id: gid, result: { docId: 'd1' } } as any);

    expect(h.b.ofKind('res').map((e) => e.msg)).toEqual([
      { type: 'open-doc-progress', id: 1, pct: 50, message: 'half' },
      { type: 'open-doc-progress', id: 1, pct: 90, message: 'nearly' },
      { type: 'result', id: 1, result: { docId: 'd1' } },
    ]);
    expect(h.local).toEqual([]);
  });
});

describe('query subscriptions', () => {
  it('keeps two clients\' subId 1 apart and unsubscribes the right one', () => {
    const h = track(harness());
    const b = join(h, 'b');

    h.router.postLocal({ type: 'subscribe-query', subId: 1, docId: 'd1', filter: '.' });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-query', subId: 1, docId: 'd1', filter: '.' } });
    const [leaderSub, followerSub] = h.w.ofType('subscribe-query').map((m) => m.subId);
    expect(leaderSub).not.toBe(followerSub);

    h.w.emit({ type: 'query-result', subId: followerSub, result: { n: 2 }, heads: [] } as any);
    expect(h.local).toEqual([]);
    expect(h.b.ofKind('res').map((e) => e.msg)).toEqual([
      { type: 'query-result', subId: 1, result: { n: 2 }, heads: [] },
    ]);

    // The follower unsubscribing must not cancel the leader's identically-numbered sub.
    h.w.clear();
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'unsubscribe-query', subId: 1 } });
    expect(h.w.ofType('unsubscribe-query')).toEqual([{ type: 'unsubscribe-query', subId: followerSub }]);

    h.w.emit({ type: 'query-result', subId: leaderSub, result: { n: 3 }, heads: [] } as any);
    expect(h.local).toEqual([{ type: 'query-result', subId: 1, result: { n: 3 }, heads: [] }]);
  });
});

describe('doc-scoped subscriptions', () => {
  it('forwards presence only on the first subscribe and the last unsubscribe', () => {
    const h = track(harness());
    const b = join(h, 'b');

    h.router.postLocal({ type: 'subscribe-presence', docId: 'd1' });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-presence', docId: 'd1' } });
    expect(h.w.ofType('subscribe-presence')).toHaveLength(1);

    // Both subscribers receive every update.
    h.w.emit({ type: 'update-presence', docId: 'd1', peers: { p: 1 } } as any);
    expect(h.local).toHaveLength(1);
    expect(h.b.ofKind('res')).toHaveLength(1);

    // First unsubscribe must NOT tear down presence for the tab still watching.
    h.router.postLocal({ type: 'unsubscribe-presence', docId: 'd1' });
    expect(h.w.ofType('unsubscribe-presence')).toHaveLength(0);
    h.w.emit({ type: 'update-presence', docId: 'd1', peers: { p: 2 } } as any);
    expect(h.local).toHaveLength(1);           // unsubscribed
    expect(h.b.ofKind('res')).toHaveLength(2); // still watching

    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'unsubscribe-presence', docId: 'd1' } });
    expect(h.w.ofType('unsubscribe-presence')).toEqual([{ type: 'unsubscribe-presence', docId: 'd1' }]);
  });

  it('catches up a tab that subscribes to a doc already being watched', async () => {
    const h = track(harness());
    h.router.postLocal({ type: 'subscribe-presence', docId: 'd1' });
    h.w.emit({ type: 'update-presence', docId: 'd1', peers: { p: 'here' } } as any);

    // The refcount swallows this subscribe, so the engine never re-announces — the
    // joining tab would otherwise see nothing until an unrelated transition.
    const b = join(h, 'b');
    h.b.clear();
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-presence', docId: 'd1' } });
    expect(h.w.ofType('subscribe-presence')).toHaveLength(1);

    await Promise.resolve(); // the replay is queued as a microtask
    expect(h.b.ofKind('res').map((e) => e.msg)).toEqual([
      { type: 'update-presence', docId: 'd1', peers: { p: 'here' } },
    ]);
  });

  it('drops the cached delivery once the last subscriber leaves', async () => {
    const h = track(harness());
    h.router.postLocal({ type: 'subscribe-presence', docId: 'd1' });
    h.w.emit({ type: 'update-presence', docId: 'd1', peers: { p: 'here' } } as any);
    h.router.postLocal({ type: 'unsubscribe-presence', docId: 'd1' });

    // Presence stopped, so those peer states are stale and must not be replayed.
    const b = join(h, 'b');
    h.b.clear();
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-presence', docId: 'd1' } });
    await Promise.resolve();
    expect(h.b.ofKind('res')).toHaveLength(0);
    expect(h.w.ofType('subscribe-presence')).toHaveLength(2); // re-established from scratch
  });

  it('refcounts validation independently of presence', () => {
    const h = track(harness());
    const b = join(h, 'b');
    h.router.postLocal({ type: 'subscribe-validation', docId: 'd1' });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-validation', docId: 'd1' } });
    expect(h.w.ofType('subscribe-validation')).toHaveLength(1);

    h.w.emit({ type: 'update-validation', docId: 'd1', errors: [] } as any);
    expect(h.local).toHaveLength(1);
    expect(h.b.ofKind('res')).toHaveLength(1);
  });

  it('forwards the union of every client\'s cursor tokens', () => {
    const h = track(harness());
    const b = join(h, 'b');
    const path = ['content'];

    h.router.postLocal({ type: 'subscribe-cursors', docId: 'd1', path, tokens: ['leader-caret'] });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-cursors', docId: 'd1', path, tokens: ['follower-caret'] } });

    // The engine stores tokens wholesale per docId+path, so the second tab must not
    // erase the first tab's caret.
    const last = h.w.ofType('subscribe-cursors').at(-1);
    expect(new Set(last.tokens)).toEqual(new Set(['leader-caret', 'follower-caret']));
  });
});

describe('broadcast vs unicast', () => {
  it('sends connectivity and doc-list pushes to every tab', () => {
    const h = track(harness());
    join(h, 'b');
    h.b.clear();

    h.w.emit({ type: 'ws-status', connected: true } as any);
    h.w.emit({ type: 'doc-list-updated', list: [] } as any);

    expect(h.local.map((m) => m.type)).toEqual(['ws-status', 'doc-list-updated']);
    expect(h.b.ofKind('bcast').map((e) => e.msg.type)).toEqual(['ws-status', 'doc-list-updated']);
  });

  it('routes rendezvous events to the tab that created the rendezvous', () => {
    const h = track(harness());
    const b = join(h, 'b');
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'kh-rdv-create-share', id: 1, docId: 'd1' } });
    const gid = h.w.sent[0].id;
    h.w.emit({ type: 'result', id: gid, result: { rendezvousId: 'rdv-1' } } as any);
    h.b.clear();

    h.w.emit({ type: 'kh-rdv-event', rendezvousId: 'rdv-1', status: 'received' } as any);

    // Only the sharing tab shows the "friend added" outcome.
    expect(h.b.ofKind('res').map((e) => e.msg.type)).toEqual(['kh-rdv-event']);
    expect(h.local).toEqual([]);

    // An unknown rendezvous (a receiver-side flow) is broadcast rather than dropped.
    h.w.emit({ type: 'kh-rdv-event', rendezvousId: 'rdv-other', status: 'error' } as any);
    expect(h.local.map((m) => m.type)).toEqual(['kh-rdv-event']);
  });

  it('relays a worker crash to followers as well as the local banner', () => {
    const h = track(harness());
    join(h, 'b');
    h.b.clear();

    h.w.worker.onerror?.({ message: 'boom' });

    expect(h.fatal[0]).toContain('boom');
    expect(h.b.ofKind('bcast').map((e) => e.msg)).toEqual([
      { type: 'error', message: expect.stringContaining('boom') },
    ]);
  });
});

describe('client lifecycle', () => {
  it('replays sticky lifecycle state to a tab that joins a warm leader', () => {
    const h = track(harness());
    h.w.emit({ type: 'ready', peerId: 'peer-1' } as any);
    h.w.emit({ type: 'kh-ready' } as any);
    h.w.emit({ type: 'ws-status', connected: true } as any);
    h.w.emit({ type: 'p2p-status', peerId: 'peer-2', transport: 'direct' } as any);
    // Superseded — only the newest of each type is replayed.
    h.w.emit({ type: 'ws-status', connected: false } as any);

    join(h, 'late');
    const replay = h.b.ofKind('welcome')[0].replay;
    expect(replay).toEqual(expect.arrayContaining([
      { type: 'ready', peerId: 'peer-1' },
      { type: 'kh-ready' },
      { type: 'ws-status', connected: false },
      { type: 'p2p-status', peerId: 'peer-2', transport: 'direct' },
    ]));
    expect(replay.filter((m) => m.type === 'ws-status')).toHaveLength(1);
  });

  it('replays the newest peer list, not a stale disconnect', () => {
    const h = track(harness());
    // connect → disconnect → connect. These are two message *types* carrying the same
    // whole list, so separate sticky slots would replay them in first-seen order and
    // leave the joining tab believing the disconnect was newest.
    h.w.emit({ type: 'peer-connected', peerCount: 1, peers: ['a'] } as any);
    h.w.emit({ type: 'peer-disconnected', peerCount: 0, peers: [] } as any);
    h.w.emit({ type: 'peer-connected', peerCount: 1, peers: ['a'] } as any);

    join(h, 'late');
    const peerMsgs = h.b.ofKind('welcome')[0].replay
      .filter((m) => m.type === 'peer-connected' || m.type === 'peer-disconnected');
    expect(peerMsgs).toEqual([{ type: 'peer-connected', peerCount: 1, peers: ['a'] }]);
  });

  it('releases a departed tab\'s subscriptions', () => {
    const h = track(harness());
    const b = join(h, 'b');
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-query', subId: 1, docId: 'd1', filter: '.' } });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-presence', docId: 'd1' } });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-validation', docId: 'd1' } });
    const gsub = h.w.ofType('subscribe-query')[0].subId;
    h.w.clear();

    h.b.deliver({ kind: 'bye', clientId: b });

    expect(h.w.ofType('unsubscribe-query')).toEqual([{ type: 'unsubscribe-query', subId: gsub }]);
    expect(h.w.ofType('unsubscribe-presence')).toEqual([{ type: 'unsubscribe-presence', docId: 'd1' }]);
    expect(h.w.ofType('unsubscribe-validation')).toEqual([{ type: 'unsubscribe-validation', docId: 'd1' }]);

    // A late reply for the departed tab must not be posted to a stale clientId.
    h.b.clear();
    h.w.emit({ type: 'query-result', subId: gsub, result: {}, heads: [] } as any);
    expect(h.b.ofKind('res')).toHaveLength(0);
  });

  it('prunes a tab that stops sending heartbeats', () => {
    // Fake timers must be installed before the router creates its sweep interval.
    jest.useFakeTimers();
    try {
      let clock = 1_000;
      const h = track(harness(() => clock));
      const b = join(h, 'b');
      h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'subscribe-presence', docId: 'd1' } });
      h.w.clear();

      // A brief silence must not evict a live tab — background timers get throttled.
      clock += 5_000;
      jest.advanceTimersByTime(5_000);
      expect(h.w.ofType('unsubscribe-presence')).toHaveLength(0);

      // Past the timeout the sweep releases what that tab was holding.
      clock += 60_000;
      jest.advanceTimersByTime(60_000);
      expect(h.w.ofType('unsubscribe-presence')).toEqual([{ type: 'unsubscribe-presence', docId: 'd1' }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops a second engine init from a follower', () => {
    const h = track(harness());
    const b = join(h, 'b');
    h.router.postLocal({ type: 'init' });
    h.b.deliver({ kind: 'req', clientId: b, msg: { type: 'init' } });
    expect(h.w.ofType('init')).toHaveLength(1);
  });

  it('ignores traffic from a clientId it never welcomed', () => {
    const h = track(harness());
    h.b.deliver({ kind: 'req', clientId: 99, msg: { type: 'get-doc-list', id: 1 } });
    expect(h.w.sent).toHaveLength(0);
  });

  it('terminates the worker when a follower asks to shut down', () => {
    const h = track(harness());
    const b = join(h, 'b');
    h.b.deliver({ kind: 'shutdown', clientId: b });
    expect(h.w.worker.terminate).toHaveBeenCalled();
  });

  it('names its epoch in the welcome, not only in the leader-up broadcast', () => {
    const h = track(harness());
    // A tab that opens after the leader started never sees `leader-up`, so the
    // welcome is its only chance to learn which router it is bound to — without it
    // a later leader change is indistinguishable from its own leader still serving.
    h.b.deliver({ kind: 'hello', nonce: 'late' });
    const welcome = h.b.ofKind('welcome')[0];
    expect(welcome.epoch).toBe(h.router.epoch);
    expect(welcome.epoch).toBeTruthy();
  });

  it('numbers the leader tab as client 0 and followers above it', () => {
    const h = track(harness());
    expect(join(h, 'x')).toBeGreaterThan(LEADER_CLIENT_ID);
    expect(join(h, 'y')).not.toBe(join(h, 'z'));
  });
});
