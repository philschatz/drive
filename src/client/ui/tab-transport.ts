/**
 * Chooses how this tab reaches the device's single engine.
 *
 * Exactly one Worker may exist per device (see tab-channel.ts). The tab that wins the
 * `drive-tab-leader` Web Lock boots it and runs `tab-router.ts`; every other tab
 * forwards the same worker protocol to that router over a `BroadcastChannel`. Either
 * way the result satisfies `WorkerLike`, so `WorkerClient` — and therefore every
 * caller in worker-api.ts — is unchanged.
 *
 * Leadership is resolved asynchronously but worker-api.ts posts at module scope, so
 * outbound messages are **buffered until a sink exists**. That costs nothing:
 * WorkerClient already gates every send on `workerReady`, which only resolves once
 * the real worker emits `ready`.
 *
 * A dedicated Worker cannot outlive its tab and the Web Lock releases exactly when
 * the tab dies, so two engines can never be live at once — the property that makes
 * this safe for keyhive.
 *
 * v1 limitation: **a change of leader reloads the other tabs.** A follower's in-flight
 * request ids and live subscriptions are registered inside the leader's router; when
 * that router disappears there is nothing to re-bind them to. Reloading is correct and
 * cheap (the hash URL and IndexedDB survive) where silently continuing would strand
 * every subscription. Only closing the *leader* tab does this — closing a follower
 * costs nothing.
 */
import { watchTabLeadership } from './multi-tab';
import { startTabRouter, type RouterWorker, type TabRouter } from './tab-router';
import {
  TAB_CHANNEL_NAME,
  TAB_HEARTBEAT_MS,
  TAB_HEARTBEAT_TIMEOUT_MS,
  tabNonce,
  type ClientId,
  type TabBus,
  type TabEnvelope,
} from '../shared/tab-channel';
import type { WorkerToMain } from '../../shared/worker-protocol';
import { createLogger } from '../../shared/logger';

const log = createLogger('tab');

/** Whether this tab owns the engine, routes through another tab, or hasn't settled yet. */
export type TabRole = 'unknown' | 'leader' | 'follower';

export interface WorkerTransport {
  /** Satisfies `WorkerLike` — buffers until this tab's channel to the engine is live. */
  postMessage(msg: any, transfer?: Transferable[]): void;
  onMessage(cb: (msg: WorkerToMain) => void): void;
  onFatal(cb: (message: string) => void): void;
  /**
   * Runs once this tab owns the engine. `post` reaches the Worker directly, which is
   * what the WebRTC bridge needs — `RTCPeerConnection` is window-only and its
   * MessagePort cannot cross a BroadcastChannel, so only the leader bridges P2P.
   */
  onLeader(cb: (post: (msg: any, transfer?: Transferable[]) => void) => void): void;
  /** Terminate the engine's Worker so it releases its IndexedDB connections. */
  shutdown(): Promise<void>;
  /** Tell sibling tabs local data is being deleted; they must close their IDB handles. */
  broadcastWipe(): void;
  /** Tell sibling tabs the delete finished and they may reload. */
  broadcastWiped(): void;
  /** Called in a sibling tab when some other tab starts/finishes wiping local data. */
  onWipe(cb: (phase: 'begin' | 'done') => void): void;
  /** Observe this tab's engine role. Fires immediately with the current value. */
  onRole(cb: (role: TabRole) => void): () => void;
}

export function makeWorkerTransport(): WorkerTransport {
  const nonce = tabNonce();

  let messageCb: ((msg: WorkerToMain) => void) | null = null;
  let fatalCb: ((message: string) => void) | null = null;
  const leaderCbs = new Set<(post: (msg: any, transfer?: Transferable[]) => void) => void>();
  let wipeCb: ((phase: 'begin' | 'done') => void) | null = null;

  /** Where outbound messages go once we know how this tab reaches the engine. */
  let sink: ((msg: any, transfer?: Transferable[]) => void) | null = null;
  const outbox: { msg: any; transfer?: Transferable[] }[] = [];

  let router: TabRouter | null = null;
  let clientId: ClientId | null = null;
  /** The epoch of the leader we are bound to; a different one means our router died. */
  let boundEpoch: string | null = null;
  let role: TabRole = 'unknown';
  let reloading = false;

  const roleCbs = new Set<(role: TabRole) => void>();
  const setRole = (next: TabRole) => { role = next; for (const cb of roleCbs) cb(next); };

  const deliver = (msg: WorkerToMain) => { messageCb?.(msg); };

  const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(TAB_CHANNEL_NAME)
    : null;

  const post = (env: TabEnvelope) => { try { channel?.postMessage(env); } catch { /* closed */ } };

  function setSink(next: (msg: any, transfer?: Transferable[]) => void): void {
    sink = next;
    while (outbox.length) {
      const q = outbox.shift()!;
      try { next(q.msg, q.transfer); } catch (err) { log.error('flush failed:', err); }
    }
  }

  /**
   * Our router is gone (the leader tab closed) or we were promoted after already
   * binding to one. Everything in flight belongs to a dead router, so reload.
   */
  function reloadForLeaderChange(why: string): void {
    if (reloading) return;
    reloading = true;
    log.info(`leader changed (${why}) — reloading to rebind`);
    try { channel?.close(); } catch { /* already closed */ }
    window.location.reload();
  }

  // ── Leader half ────────────────────────────────────────────────────────────

  /**
   * The router needs `bus.onmessage`, but so does this module, and a second
   * BroadcastChannel on the same name would echo our own envelopes back at us. Hand
   * the router a facade over the one channel and fan inbound envelopes to both.
   */
  let routerHandler: ((e: { data: TabEnvelope }) => void) | null = null;
  const routerBus: TabBus = {
    postMessage: (m) => post(m),
    get onmessage() { return routerHandler; },
    set onmessage(h) { routerHandler = h; },
    close: () => { routerHandler = null; },
  };

  function becomeLeader(): void {
    if (role === 'leader') return;
    // We had already bound to another tab's router — our ids live there, not here.
    if (role === 'follower') { reloadForLeaderChange('promoted from follower'); return; }
    setRole('leader');

    const worker = new Worker(
      new URL('../worker/automerge-worker.ts', import.meta.url),
      { type: 'module' },
    ) as unknown as RouterWorker;

    router = startTabRouter({
      worker,
      bus: routerBus,
      onLocal: deliver,
      onFatal: (message) => fatalCb?.(message),
    });
    boundEpoch = router.epoch;
    setSink((msg, transfer) => router!.postLocal(msg, transfer));
    for (const cb of leaderCbs) cb((msg, transfer) => router!.postLocal(msg, transfer));
  }

  // ── Follower half ──────────────────────────────────────────────────────────

  let beatTimer: ReturnType<typeof setInterval> | null = null;
  let lastLeaderBeat = 0;

  function becomeFollower(id: ClientId, epoch: string | null, replay: WorkerToMain[]): void {
    if (role !== 'unknown') return;
    setRole('follower');
    clientId = id;
    boundEpoch = epoch;
    lastLeaderBeat = Date.now();
    setSink((msg) => post({ kind: 'req', clientId: id, msg }));
    // Sticky lifecycle state the worker only emits on transitions — without this a
    // tab joining a warm leader would hang on `workerReady` and show "disconnected".
    for (const msg of replay) deliver(msg);
    beatTimer = setInterval(() => {
      post({ kind: 'beat', clientId: id });
      // A silent leader may have been replaced while we missed its announcement.
      if (Date.now() - lastLeaderBeat > TAB_HEARTBEAT_TIMEOUT_MS) post({ kind: 'hello', nonce });
    }, TAB_HEARTBEAT_MS);
  }

  // ── Bus wiring ─────────────────────────────────────────────────────────────

  if (channel) {
    channel.onmessage = (e: MessageEvent<TabEnvelope>) => {
      const env = e.data;
      switch (env.kind) {
        case 'welcome':
          if (env.nonce !== nonce) return;
          // Bind to the epoch the leader named, so a later leader change is
          // unambiguous even though we never saw this leader's `leader-up`.
          becomeFollower(env.clientId, env.epoch, env.replay);
          return;
        case 'res':
          if (env.clientId === clientId) deliver(env.msg);
          return;
        case 'bcast':
          if (role === 'follower') deliver(env.msg);
          return;
        case 'leader-up':
          // A leader we are not bound to is now serving.
          if (role === 'follower' && boundEpoch && boundEpoch !== env.epoch) {
            reloadForLeaderChange('new leader announced');
            return;
          }
          boundEpoch = env.epoch;
          if (role === 'unknown') post({ kind: 'hello', nonce });
          return;
        case 'leader-beat':
          if (boundEpoch && boundEpoch !== env.epoch) {
            if (role === 'follower') reloadForLeaderChange('leader epoch changed');
            return;
          }
          lastLeaderBeat = Date.now();
          return;
        case 'wipe':
          wipeCb?.('begin');
          return;
        case 'wiped':
          wipeCb?.('done');
          return;
      }
      // 'hello' / 'req' / 'beat' / 'bye' / 'shutdown' are the router's business.
      routerHandler?.(e as { data: TabEnvelope });
    };

    // Ask for a leader and race it against winning the lock — whichever answers
    // first decides this tab's role. Two tabs opening together can both see the lock
    // unheld and so neither is told it is secondary, which is why we never wait to
    // be told: we always ask.
    post({ kind: 'hello', nonce });

    window.addEventListener('pagehide', () => {
      if (role === 'follower' && clientId !== null) post({ kind: 'bye', clientId });
    });
  }

  // `onChange(false)` means this tab now holds the lock. `onChange(true)` (already
  // held elsewhere) needs no action — the `hello` above is what binds us.
  watchTabLeadership((secondary) => { if (!secondary) becomeLeader(); });

  // No BroadcastChannel (very old browser): behave exactly as before this feature —
  // one worker in this tab. The Web Lock still keeps a second tab from syncing.
  if (!channel) becomeLeader();

  return {
    postMessage(msg, transfer) {
      if (sink) sink(msg, transfer);
      else outbox.push({ msg, transfer });
    },
    onMessage(cb) { messageCb = cb; },
    onFatal(cb) { fatalCb = cb; },
    onLeader(cb) {
      leaderCbs.add(cb);
      if (role === 'leader' && router) cb((msg, transfer) => router!.postLocal(msg, transfer));
    },
    async shutdown() {
      if (beatTimer) clearInterval(beatTimer);
      if (router) { router.shutdownWorker(); return; }
      if (clientId !== null) post({ kind: 'shutdown', clientId });
      // Give the leader a moment to terminate its worker so `deleteDatabase` isn't
      // blocked by connections that are still closing.
      await new Promise((r) => setTimeout(r, 300));
    },
    broadcastWipe() { post({ kind: 'wipe' }); },
    broadcastWiped() { post({ kind: 'wiped' }); },
    onWipe(cb) { wipeCb = cb; },
    onRole(cb) {
      roleCbs.add(cb);
      cb(role);
      return () => { roleCbs.delete(cb); };
    },
  };
}
