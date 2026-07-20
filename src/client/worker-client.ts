/**
 * Transport-agnostic core of the worker request/response + subscription protocol.
 *
 * Extracted from worker-api.ts so it can be exercised without booting a real
 * `Worker` (which needs `import.meta.url`, IndexedDB, MessageChannel, …). The
 * class owns everything that must stay resilient when the worker dies or drops a
 * reply: the `pending` request map, the ready/keyhive gates, the fatal-error
 * fan-out, and the query/presence/validation subscription registries.
 *
 * worker-api.ts wires a real `Worker`'s `onmessage`/`onerror`/`onmessageerror`
 * to `route()` / `fail()` and re-exports the client's operations verbatim, so the
 * on-the-wire protocol is unchanged.
 */
import type { WorkerToMain, ValidationError } from '../shared/worker-protocol';
import type { PresenceState, PeerState } from '@automerge/automerge-repo';

/** Minimal surface of a Worker we depend on (so tests can supply a fake). */
export interface WorkerLike {
  postMessage(message: any, transfer?: Transferable[]): void;
}

type QueryResultCb = (result: any, heads: string[], lastModified?: number) => void;
type QueryErrorCb = (error: string) => void;
type PresenceCb = (peers: Record<string, PeerState<PresenceState>>) => void;
type ValidationCb = (errors: ValidationError[]) => void;

interface PendingEntry {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  sent: number;
  type: string;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Operations that legitimately run for a long time — they have their own
 * engine-side timeout (e.g. the 120 s rendezvous wait) and would be wrongly
 * aborted by the generic request timeout backstop. Excluded from it.
 */
const NO_TIMEOUT_TYPES = new Set<string>(['kh-rdv-receive', 'kh-rdv-link-join']);

export interface WorkerClientOptions {
  /**
   * Backstop timeout (ms) for a request whose reply is lost — the worker is
   * alive but dropped a message. Generous by design: every legitimate op except
   * the excluded long-runners finishes well within it. The primary defence
   * against a *dead* worker is `fail()` (wired to onerror/onmessageerror), which
   * rejects everything immediately; this timeout only covers the rare lost-reply
   * case. Set to 0 to disable. `open-doc` and `query` never carry a timeout — a
   * large document can legitimately take a long time to load/decrypt.
   */
  requestTimeoutMs?: number;
  /** Logger for outbound messages (defaults to the `[main] → send` console log). */
  log?: (msg: { type: string } & Record<string, any>) => void;
}

export class WorkerClient {
  private worker: WorkerLike;
  private requestTimeoutMs: number;
  private logSend: (msg: { type: string } & Record<string, any>) => void;

  private nextId = 0;
  private nextSubId = 0;
  private pending = new Map<number, PendingEntry>();

  private queryCallbacks = new Map<number, { onResult: QueryResultCb; onError?: QueryErrorCb }>();
  private openDocProgressCallbacks = new Map<number, (pct: number, message: string) => void>();

  // Presence/validation are keyed in the worker by docId (one presence object per
  // doc). Re-key each *main-thread* subscriber by a unique subId and fan out to a
  // per-doc set, so a second subscriber can't clobber the first and unsubscribing
  // one doesn't stop the worker for the others (only the first subscribe / last
  // unsubscribe touches the worker).
  private presenceSubs = new Map<string, Map<number, PresenceCb>>();
  // Last worker emission per doc. The worker only emits on membership/state
  // transitions (steady-state heartbeats are silent), so a subscriber that
  // mounts later — e.g. an editor opened via in-app navigation — would
  // otherwise see nothing until the next transition. Replayed on subscribe.
  private lastPresence = new Map<string, Record<string, any>>();
  private validationSubs = new Map<string, Map<number, ValidationCb>>();

  // Lifecycle gates.
  readonly workerReady: Promise<void>;
  readonly keyhiveReady: Promise<void>;
  private resolveRepoReady!: () => void;
  private rejectRepoReady!: (err: Error) => void;
  private resolveKeyhiveReady!: () => void;
  private rejectKeyhiveReady!: (err: Error) => void;

  private workerPeerId = '';
  private workerDead = false;
  private fatalError: string | null = null;
  private errorListeners = new Set<(message: string) => void>();

  constructor(worker: WorkerLike, opts: WorkerClientOptions = {}) {
    this.worker = worker;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.logSend = opts.log ?? ((msg) => console.log('[main] → send', msg.type, msg));

    this.workerReady = new Promise<void>((resolve, reject) => {
      this.resolveRepoReady = resolve;
      this.rejectRepoReady = reject;
    });
    this.workerReady.catch(() => { }); // callers handle the rejection

    this.keyhiveReady = new Promise<void>((resolve, reject) => {
      this.resolveKeyhiveReady = resolve;
      this.rejectKeyhiveReady = reject;
    });
    this.keyhiveReady.catch(() => { });
  }

  // ── Fatal-error surface ────────────────────────────────────────────────────

  getWorkerError(): string | null { return this.fatalError; }
  getWorkerPeerId(): string { return this.workerPeerId; }
  isDead(): boolean { return this.workerDead; }
  /** Number of requests awaiting a reply. Exposed for leak assertions in tests. */
  pendingCount(): number { return this.pending.size; }

  onWorkerError(fn: (message: string) => void): () => void {
    this.errorListeners.add(fn);
    if (this.fatalError) fn(this.fatalError); // replay for late subscribers
    return () => { this.errorListeners.delete(fn); };
  }

  private notifyError(message: string): void {
    for (const fn of this.errorListeners) fn(message);
  }

  /**
   * The worker crashed / became unreadable (onerror / onmessageerror). Reject
   * everything in flight so no promise hangs forever, settle the ready gates
   * (no-op if already resolved) so request()-gated UI stops waiting, mark the
   * worker dead so future requests reject immediately instead of posting into the
   * void, and surface the message to the error banner. Idempotent.
   */
  fail(message: string): void {
    if (this.workerDead) return;
    this.workerDead = true;
    this.fatalError = message;

    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.openDocProgressCallbacks.clear();

    // Settle the gates so anything awaiting them (and request() itself) unblocks.
    this.rejectRepoReady(new Error(message));
    this.rejectKeyhiveReady(new Error(message));

    this.notifyError(message);
  }

  // ── Inbound message router ─────────────────────────────────────────────────

  /**
   * Handle the message types this client owns (lifecycle gates, request results,
   * and query/presence/validation subscription deliveries). Returns true if the
   * message was consumed; worker-api.ts handles the remaining app-level types.
   */
  route(msg: WorkerToMain): boolean {
    switch (msg.type) {
      case 'ready':
        this.workerPeerId = msg.peerId;
        this.resolveRepoReady();
        return true;
      case 'kh-ready':
        this.resolveKeyhiveReady();
        return true;
      case 'kh-error':
        console.error('Keyhive init failed:', msg.message);
        this.rejectKeyhiveReady(new Error(msg.message));
        return true;
      case 'error':
        // Fatal worker-init error (e.g. a dangling user-group). Settle the gates
        // so request()-gated UI stops hanging and surface a banner.
        console.error('Automerge worker error:', msg.message);
        this.fatalError = msg.message;
        this.rejectRepoReady(new Error(msg.message));
        this.rejectKeyhiveReady(new Error(msg.message));
        this.notifyError(msg.message);
        return true;
      case 'data-warning':
        // Non-fatal: the worker is up but local data has a problem. Banner only.
        console.warn('Worker data warning:', msg.message);
        this.fatalError = msg.message;
        this.notifyError(msg.message);
        return true;

      case 'result': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (p.timer) clearTimeout(p.timer);
          const elapsed = performance.now() - p.sent;
          if (elapsed > 100) console.log(`[main] ⏱ ${p.type} took ${Math.round(elapsed).toLocaleString()}ms`);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
        return true;
      }
      case 'query-result': {
        const cb = this.queryCallbacks.get(msg.subId);
        if (cb) {
          if (msg.error) {
            // Deliver the error so the UI can render an error/retry state instead
            // of looking like it is loading forever.
            if (cb.onError) cb.onError(msg.error);
            else console.warn('[worker-api] query-result error subId=%d:', msg.subId, msg.error);
          } else {
            cb.onResult(msg.result, msg.heads, msg.lastModified);
          }
        }
        return true;
      }
      case 'update-presence': {
        this.lastPresence.set(msg.docId, msg.peers);
        const subs = this.presenceSubs.get(msg.docId);
        if (subs) for (const cb of subs.values()) cb(msg.peers);
        return true;
      }
      case 'open-doc-progress': {
        const cb = this.openDocProgressCallbacks.get(msg.id);
        if (cb) cb(msg.pct, msg.message);
        return true;
      }
      case 'update-validation': {
        const subs = this.validationSubs.get(msg.docId);
        if (subs) for (const cb of subs.values()) cb(msg.errors);
        return true;
      }
    }
    return false;
  }

  // ── Request/response ───────────────────────────────────────────────────────

  request<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
    return this.workerReady.then(() => {
      if (this.workerDead) throw new Error(this.fatalError ?? 'The document engine is not available.');
      const id = ++this.nextId;
      return new Promise<T>((resolve, reject) => {
        const entry: PendingEntry = { resolve, reject, sent: performance.now(), type };
        this.pending.set(id, entry);
        if (this.requestTimeoutMs > 0 && !NO_TIMEOUT_TYPES.has(type)) {
          entry.timer = setTimeout(() => {
            // Only fire if still pending (the reply never came).
            if (this.pending.get(id) === entry) {
              this.pending.delete(id);
              reject(new Error(`The document engine did not respond to "${type}" within ${Math.round(this.requestTimeoutMs / 1000)}s.`));
            }
          }, this.requestTimeoutMs);
        }
        const msg = { type, id, ...payload };
        this.logSend(msg);
        try {
          this.worker.postMessage(msg);
        } catch (err) {
          // postMessage threw (e.g. a non-cloneable arg → DataCloneError) — the
          // reply will never come, so clean up the entry we just inserted.
          this.pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  fire(type: string, payload: Record<string, any> = {}): void {
    this.workerReady.then(() => {
      if (this.workerDead) return;
      const msg = { type, ...payload };
      this.logSend(msg);
      try {
        this.worker.postMessage(msg);
      } catch (err) {
        console.error('[worker-api] fire postMessage failed:', err);
      }
    }).catch(() => { }); // worker never became ready — nothing to send
  }

  /** Keyhive requests gate on keyhiveReady (which implies workerReady). */
  khRequest<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
    return this.keyhiveReady.then(() => this.request<T>(type, payload));
  }

  // ── Explicit doc open (own path: progress + no request-timeout) ────────────

  openDoc(
    docId: string,
    opts?: { onProgress?: (pct: number, message: string) => void },
  ): Promise<{ docId: string }> {
    const { onProgress } = opts ?? {};
    return this.workerReady.then(() => {
      if (this.workerDead) throw new Error(this.fatalError ?? 'The document engine is not available.');
      const id = ++this.nextId;
      if (onProgress) this.openDocProgressCallbacks.set(id, onProgress);
      return new Promise<{ docId: string }>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (v) => { this.openDocProgressCallbacks.delete(id); resolve(v); },
          reject: (e) => { this.openDocProgressCallbacks.delete(id); reject(e); },
          sent: performance.now(), type: 'open-doc',
        });
        const msg = { type: 'open-doc' as const, id, docId };
        this.logSend(msg);
        try {
          this.worker.postMessage(msg);
        } catch (err) {
          this.pending.delete(id);
          this.openDocProgressCallbacks.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  queryDoc(docId: string, filter: string): Promise<{ result: any; heads: string[] }> {
    return this.workerReady.then(() => {
      if (this.workerDead) throw new Error(this.fatalError ?? 'The document engine is not available.');
      const id = ++this.nextId;
      return new Promise<{ result: any; heads: string[] }>((resolve, reject) => {
        this.pending.set(id, { resolve, reject, sent: performance.now(), type: 'query' });
        const msg = { type: 'query' as const, id, docId, filter };
        this.logSend(msg);
        try {
          this.worker.postMessage(msg);
        } catch (err) {
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  subscribeQuery(
    docId: string,
    filter: string,
    onResult: QueryResultCb,
    onError?: QueryErrorCb,
  ): () => void {
    const subId = ++this.nextSubId;
    this.queryCallbacks.set(subId, { onResult, onError });
    this.fire('subscribe-query', { subId, docId, filter });
    return () => {
      this.queryCallbacks.delete(subId);
      this.fire('unsubscribe-query', { subId });
    };
  }

  subscribePresence(docId: string, onUpdate: PresenceCb): () => void {
    const subId = ++this.nextSubId;
    let subs = this.presenceSubs.get(docId);
    const first = !subs || subs.size === 0;
    if (!subs) { subs = new Map(); this.presenceSubs.set(docId, subs); }
    subs.set(subId, onUpdate);
    if (first) this.fire('subscribe-presence', { docId });
    const cached = this.lastPresence.get(docId);
    if (cached) {
      // Deliver asynchronously so the caller finishes wiring up first.
      queueMicrotask(() => { if (this.presenceSubs.get(docId)?.has(subId)) onUpdate(cached); });
    }
    return () => {
      const s = this.presenceSubs.get(docId);
      if (!s) return;
      s.delete(subId);
      if (s.size === 0) {
        this.presenceSubs.delete(docId);
        this.lastPresence.delete(docId); // presence stops; states go stale
        this.fire('unsubscribe-presence', { docId });
      }
    };
  }

  subscribeValidation(docId: string, onResult: ValidationCb): () => void {
    const subId = ++this.nextSubId;
    let subs = this.validationSubs.get(docId);
    const first = !subs || subs.size === 0;
    if (!subs) { subs = new Map(); this.validationSubs.set(docId, subs); }
    subs.set(subId, onResult);
    if (first) this.fire('subscribe-validation', { docId });
    return () => {
      const s = this.validationSubs.get(docId);
      if (!s) return;
      s.delete(subId);
      if (s.size === 0) {
        this.validationSubs.delete(docId);
        this.fire('unsubscribe-validation', { docId });
      }
    };
  }
}
