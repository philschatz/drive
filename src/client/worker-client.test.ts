/**
 * Resilience tests for the WorkerClient — the request/response + subscription core
 * behind worker-api.ts. Drives it with a fake Worker so no real Web Worker
 * (import.meta.url / IndexedDB / MessageChannel) is needed.
 *
 * Covers Group G:
 *  - H7: a worker crash (fail) rejects every in-flight request + fires error
 *    listeners; a lost reply times out; a post to a dead worker rejects instead
 *    of hanging; a throwing postMessage leaves no orphaned pending entry.
 *  - M11: presence/validation subscriptions are refcounted per-doc (two
 *    subscribers both receive; unsubscribing one keeps the other and does NOT
 *    tell the worker to stop); a query-result error reaches the subscriber.
 */
import { WorkerClient, type WorkerLike } from './worker-client';
import type { WorkerToMain } from '../shared/worker-protocol';

class FakeWorker implements WorkerLike {
  sent: any[] = [];
  throwOnPost = false;
  postMessage(msg: any): void {
    if (this.throwOnPost) throw new Error('DataCloneError: could not clone message');
    this.sent.push(msg);
  }
  sentOfType(type: string): any[] { return this.sent.filter(m => m.type === type); }
}

/** Flush pending microtasks + timers-of-zero so `fire`/`request` bodies run. */
const flush = () => new Promise(r => setTimeout(r, 0));

function ready(client: WorkerClient, worker: FakeWorker) {
  client.route({ type: 'ready', peerId: 'peer-1' } as WorkerToMain);
  client.route({ type: 'kh-ready' } as WorkerToMain);
}

describe('WorkerClient lifecycle', () => {
  it('routes ready/kh-ready to resolve the gates and captures peerId', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker);
    ready(client, worker);
    await expect(client.workerReady).resolves.toBeUndefined();
    await expect(client.keyhiveReady).resolves.toBeUndefined();
    expect(client.getWorkerPeerId()).toBe('peer-1');
  });

  it("a fatal 'error' message settles the gates and notifies error listeners", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker);
    const seen: string[] = [];
    client.onWorkerError(m => seen.push(m));
    client.route({ type: 'error', message: 'init blew up' } as WorkerToMain);
    await expect(client.workerReady).rejects.toThrow('init blew up');
    await expect(client.keyhiveReady).rejects.toThrow('init blew up');
    expect(seen).toEqual(['init blew up']);
    expect(client.getWorkerError()).toBe('init blew up');
  });

  it("a non-fatal 'data-warning' notifies listeners but does NOT settle the gates", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker);
    const seen: string[] = [];
    client.onWorkerError(m => seen.push(m));
    client.route({ type: 'data-warning', message: 'dangling group' } as WorkerToMain);
    expect(seen).toEqual(['dangling group']);
    // Gate is still pending — resolve it and confirm it never rejected.
    ready(client, worker);
    await expect(client.workerReady).resolves.toBeUndefined();
  });

  it('replays the latest error to a late onWorkerError subscriber', () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker);
    client.route({ type: 'error', message: 'boom' } as WorkerToMain);
    const seen: string[] = [];
    client.onWorkerError(m => seen.push(m));
    expect(seen).toEqual(['boom']);
  });
});

describe('WorkerClient H7 — worker death / un-settled requests', () => {
  it('fail() rejects every in-flight request and fires error listeners', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 0 });
    ready(client, worker);
    const seen: string[] = [];
    client.onWorkerError(m => seen.push(m));

    const p1 = client.request('get-doc-list');
    const p2 = client.request('kh-get-identity');
    await flush(); // let the request bodies run and register in `pending`
    expect(client.pendingCount()).toBe(2);

    client.fail('worker crashed');

    await expect(p1).rejects.toThrow('worker crashed');
    await expect(p2).rejects.toThrow('worker crashed');
    expect(seen).toEqual(['worker crashed']);
    expect(client.pendingCount()).toBe(0);
    expect(client.isDead()).toBe(true);
  });

  it('rejects the ready gates if they had not resolved when the worker died', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 0 });
    // A request issued before `ready` gates on workerReady (never resolved).
    const p = client.request('get-doc-list');
    client.fail('died during init');
    await expect(client.workerReady).rejects.toThrow('died during init');
    await expect(client.keyhiveReady).rejects.toThrow('died during init');
    await expect(p).rejects.toThrow('died during init');
  });

  it('rejects new requests immediately after death instead of hanging', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 0 });
    ready(client, worker); // gates resolved before the crash
    client.fail('gone');
    await expect(client.request('get-doc-list')).rejects.toThrow('gone');
    // Nothing should have been posted to the dead worker for this request.
    expect(worker.sentOfType('get-doc-list')).toHaveLength(0);
  });

  it('times out a request whose reply never arrives (lost message backstop)', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 25 });
    ready(client, worker);
    await expect(client.request('get-doc-list')).rejects.toThrow(/did not respond/);
    expect(client.pendingCount()).toBe(0);
  });

  it('does NOT time out excluded long-running ops (rendezvous receive)', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 25 });
    ready(client, worker);
    let settled = false;
    const p = client.khRequest('kh-rdv-receive', {}).then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 60)); // well past the 25ms backstop
    expect(settled).toBe(false); // still waiting — not aborted
    // Now deliver a real reply so the promise settles and doesn't leak.
    const id = worker.sentOfType('kh-rdv-receive')[0].id;
    client.route({ type: 'result', id, result: { ok: true } } as WorkerToMain);
    await p;
    expect(settled).toBe(true);
  });

  it('a throwing postMessage rejects and leaves no orphaned pending entry', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 0 });
    ready(client, worker);
    worker.throwOnPost = true;
    const p = client.request('update-doc', { docId: 'd' });
    await expect(p).rejects.toThrow(/DataCloneError/);
    expect(client.pendingCount()).toBe(0);
  });

  it('a throwing postMessage on openDoc cleans up pending + progress callbacks', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 0 });
    ready(client, worker);
    worker.throwOnPost = true;
    await expect(client.openDoc('d', { onProgress: () => {} })).rejects.toThrow(/DataCloneError/);
    expect(client.pendingCount()).toBe(0);
  });

  it('resolves a normal request when its result arrives', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker, { requestTimeoutMs: 0 });
    ready(client, worker);
    const p = client.request<number[]>('get-doc-list');
    await flush();
    const id = worker.sentOfType('get-doc-list')[0].id;
    client.route({ type: 'result', id, result: [1, 2, 3] } as WorkerToMain);
    await expect(p).resolves.toEqual([1, 2, 3]);
  });
});

describe('WorkerClient M11 — presence subscription refcounting', () => {
  it('two subscribers to the same doc both receive; unsubscribe one keeps the other', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker);
    ready(client, worker);

    const got1: any[] = [];
    const got2: any[] = [];
    const un1 = client.subscribePresence('doc-1', p => got1.push(p));
    const un2 = client.subscribePresence('doc-1', p => got2.push(p));
    await flush();

    // Only the FIRST subscriber told the worker to start.
    expect(worker.sentOfType('subscribe-presence')).toHaveLength(1);

    client.route({ type: 'update-presence', docId: 'doc-1', peers: { a: 1 } } as any);
    expect(got1).toEqual([{ a: 1 }]);
    expect(got2).toEqual([{ a: 1 }]);

    // Unsubscribing one keeps the other and does NOT stop the worker.
    un1();
    await flush();
    expect(worker.sentOfType('unsubscribe-presence')).toHaveLength(0);

    client.route({ type: 'update-presence', docId: 'doc-1', peers: { b: 2 } } as any);
    expect(got1).toEqual([{ a: 1 }]);            // no longer receiving
    expect(got2).toEqual([{ a: 1 }, { b: 2 }]);  // still receiving

    // The last unsubscribe stops the worker.
    un2();
    await flush();
    expect(worker.sentOfType('unsubscribe-presence')).toHaveLength(1);
  });
});

describe('WorkerClient M11 — validation subscription refcounting', () => {
  it('two subscribers both receive; unsubscribe one keeps the other', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker);
    ready(client, worker);

    const got1: any[] = [];
    const got2: any[] = [];
    const un1 = client.subscribeValidation('doc-1', e => got1.push(e));
    client.subscribeValidation('doc-1', e => got2.push(e));
    await flush();
    expect(worker.sentOfType('subscribe-validation')).toHaveLength(1);

    const errs = [{ path: ['x'], message: 'bad' }];
    client.route({ type: 'update-validation', docId: 'doc-1', errors: errs } as any);
    expect(got1).toEqual([errs]);
    expect(got2).toEqual([errs]);

    un1();
    await flush();
    expect(worker.sentOfType('unsubscribe-validation')).toHaveLength(0);
    client.route({ type: 'update-validation', docId: 'doc-1', errors: [] } as any);
    expect(got2).toHaveLength(2);
  });
});

describe('WorkerClient M11 — query-result error delivery', () => {
  it('delivers a query-result error to the onError callback (not just console)', async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient(worker);
    ready(client, worker);

    const results: any[] = [];
    let errored: string | null = null;
    client.subscribeQuery('doc-1', '.', r => results.push(r), e => { errored = e; });
    await flush();
    const subId = worker.sentOfType('subscribe-query')[0].subId;

    client.route({ type: 'query-result', subId, result: null, heads: [], error: 'jq failed' } as WorkerToMain);
    expect(errored).toBe('jq failed');
    expect(results).toHaveLength(0);

    // A subsequent successful result still flows to onResult.
    client.route({ type: 'query-result', subId, result: { ok: true }, heads: ['h'] } as WorkerToMain);
    expect(results).toEqual([{ ok: true }]);
  });
});
