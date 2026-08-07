/**
 * Leader-side cross-tab router.
 *
 * The tab holding the `drive-tab-leader` Web Lock owns the one dedicated Worker for
 * the device (see tab-channel.ts for why there may only ever be one engine). This
 * router sits between *every* WorkerClient — its own tab's, as client 0, and each
 * follower tab's over the `BroadcastChannel` — and that single Worker.
 *
 * Nothing in the engine or the worker protocol knows tabs exist. The router earns
 * that by fixing up the two things that are per-client:
 *
 *  - **ids.** Every WorkerClient mints request ids and subscription ids from 1
 *    (worker-client.ts), so two tabs both send `id: 1`. The router rewrites them to
 *    globally-unique ids on the way in and restores each client's own id on the way
 *    out. This also fixes a latent same-tab collision: the HyperFormula worker used
 *    to mint its own `subId` from 1 into the engine's single flat `subIdToDocId`.
 *  - **doc-scoped subscriptions.** `subscribe-presence` / `subscribe-validation` /
 *    `subscribe-cursors` are keyed by docId and carry no id, so the router refcounts
 *    them across clients — forwarding only the first subscribe and last unsubscribe,
 *    and fanning deliveries back out to every subscribed tab.
 *
 * Known v1 limitation: `set-doc-version` pins `DocEntry.pinnedVersion`, which is
 * engine state, so a history-pinned view in one tab pins that doc in all of them.
 */
import type { WorkerToMain } from '../../shared/worker-protocol';
import {
  LEADER_CLIENT_ID,
  TAB_HEARTBEAT_TIMEOUT_MS,
  tabNonce,
  type ClientId,
  type TabBus,
  type TabEnvelope,
} from '../shared/tab-channel';

/** Minimal Worker surface the router drives (injectable so tests need no real Worker). */
export interface RouterWorker {
  postMessage(msg: any, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onmessageerror: ((e: any) => void) | null;
}

/** Replies that answer exactly one request id. */
const BY_REQUEST_ID = new Set(['result', 'open-doc-progress']);
/** Deliveries that belong to one subscription id. */
const BY_SUB_ID = new Set(['query-result']);
/** Deliveries fanned out to every client subscribed to that docId. */
const BY_DOC_SUB = new Set(['update-presence', 'update-validation']);
/**
 * Broadcasts where only the newest matters, replayed to a tab that joins a warm
 * leader. Without this a follower shows "disconnected" and hangs on `workerReady`
 * until the next transition, because the worker only emits these on change.
 */
const STICKY = new Set([
  'ready', 'kh-ready', 'kh-error', 'error', 'data-warning',
  'ws-status', 'peer-connected', 'peer-disconnected',
  'doc-list-updated', 'unseen-changes-updated',
  'friend-names-updated', 'device-names-updated',
]);
/**
 * Sticky slot for a message type. `peer-connected` / `peer-disconnected` carry the
 * same whole `peers` list and must share one slot: kept apart, a
 * connect→disconnect→connect sequence would replay them in first-seen order and
 * leave a joining tab reading the stale disconnect as the newest state.
 */
function stickyKey(type: string): string {
  return type === 'peer-connected' || type === 'peer-disconnected' ? 'peers' : type;
}
/** Sticky, but one entry per peer rather than one overall. */
const STICKY_BY_PEER = 'p2p-status';
/** Requests whose result names a rendezvous the follow-up events must route back to. */
const RDV_CREATORS = new Set(['kh-rdv-create-share', 'kh-rdv-link-create']);

/**
 * Refcounts doc-scoped subscriptions across clients: forward to the worker only on
 * the first subscribe and the last unsubscribe. One instance per subscription kind.
 */
class DocSubRefcount {
  private byDoc = new Map<string, Set<ClientId>>();

  /** True when this is the doc's first subscriber — the caller forwards the subscribe. */
  add(docId: string, clientId: ClientId): boolean {
    let s = this.byDoc.get(docId);
    if (!s) { s = new Set(); this.byDoc.set(docId, s); }
    const first = s.size === 0;
    s.add(clientId);
    return first;
  }

  /** True when the last subscriber left — the caller forwards the unsubscribe. */
  remove(docId: string, clientId: ClientId): boolean {
    const s = this.byDoc.get(docId);
    if (!s || !s.delete(clientId)) return false;
    if (s.size > 0) return false;
    this.byDoc.delete(docId);
    return true;
  }

  clients(docId: string): ClientId[] { return [...(this.byDoc.get(docId) ?? [])]; }

  /** Drop a departed client; returns the docIds that just lost their last subscriber. */
  dropClient(clientId: ClientId): string[] {
    const emptied: string[] = [];
    for (const docId of [...this.byDoc.keys()]) {
      if (this.remove(docId, clientId)) emptied.push(docId);
    }
    return emptied;
  }
}

interface ClientRec {
  id: ClientId;
  send: (msg: WorkerToMain) => void;
  lastBeat: number;
  /** globalSubId → localSubId, and the reverse for unsubscribe lookups. */
  globalToLocalSub: Map<number, number>;
  localToGlobalSub: Map<number, number>;
  /** Global request ids awaiting a reply, so a departing client's entries are freed. */
  reqs: Set<number>;
}

export interface TabRouter {
  /** This tab's own epoch id, broadcast so followers can detect a leader change. */
  readonly epoch: string;
  /** Post a message from the leader tab's own WorkerClient. */
  postLocal(msg: any, transfer?: Transferable[]): void;
  /** Terminate the Worker so it releases its IndexedDB connections. */
  shutdownWorker(): void;
  stop(): void;
}

export interface TabRouterOptions {
  worker: RouterWorker;
  bus: TabBus;
  /** Deliver a message addressed to the leader tab's own WorkerClient. */
  onLocal: (msg: WorkerToMain) => void;
  /** The Worker died — the leader tab's own fatal-error surface. */
  onFatal: (message: string) => void;
  /** Injectable clock so tests can drive heartbeat pruning without waiting. */
  now?: () => number;
}

export function startTabRouter(opts: TabRouterOptions): TabRouter {
  const { worker, bus, onLocal, onFatal } = opts;
  const now = opts.now ?? (() => Date.now());
  const epoch = tabNonce();

  const clients = new Map<ClientId, ClientRec>();
  let nextClientId = LEADER_CLIENT_ID + 1;
  /** One counter for both request and subscription ids — they share the engine's maps. */
  let nextGlobalId = 0;

  const reqOwners = new Map<number, { clientId: ClientId; localId: number; type: string }>();
  const subOwners = new Map<number, { clientId: ClientId; localId: number }>();
  const rdvOwners = new Map<string, ClientId>();

  const presence = new DocSubRefcount();
  const validation = new DocSubRefcount();
  /** docId → stableKey(path) → { path, byClient: clientId → tokens }. */
  const cursors = new Map<string, Map<string, { path: (string | number)[]; byClient: Map<ClientId, string[]> }>>();

  const sticky = new Map<string, WorkerToMain>();
  const stickyPeers = new Map<string, WorkerToMain>();
  /**
   * Newest presence/validation delivery per doc.
   *
   * A second tab opening a doc the first already watches gets its `subscribe-*`
   * swallowed by the refcount, so the engine — which only re-announces on a
   * subscribe it actually sees — would never push to it, and that tab would show no
   * peers and no validation errors until the next unrelated transition. Replaying the
   * cached delivery to the joining client closes that window.
   */
  const lastByDoc = { presence: new Map<string, WorkerToMain>(), validation: new Map<string, WorkerToMain>() };

  clients.set(LEADER_CLIENT_ID, {
    id: LEADER_CLIENT_ID,
    send: onLocal,
    lastBeat: Number.MAX_SAFE_INTEGER, // the local client is never pruned
    globalToLocalSub: new Map(),
    localToGlobalSub: new Map(),
    reqs: new Set(),
  });

  const post = (env: TabEnvelope) => { try { bus.postMessage(env); } catch { /* bus closed */ } };
  const sendTo = (clientId: ClientId, msg: WorkerToMain) => {
    const rec = clients.get(clientId);
    if (rec) rec.send(msg);
  };
  const broadcast = (msg: WorkerToMain) => {
    onLocal(msg);
    post({ kind: 'bcast', msg });
  };

  // ── Worker → clients ───────────────────────────────────────────────────────

  worker.onmessage = (e: any) => {
    const msg = e.data as WorkerToMain;

    if (STICKY.has(msg.type)) sticky.set(stickyKey(msg.type), msg);
    else if (msg.type === STICKY_BY_PEER) stickyPeers.set((msg as any).peerId, msg);

    if (BY_REQUEST_ID.has(msg.type)) {
      const id = (msg as any).id as number;
      const owner = reqOwners.get(id);
      if (!owner) return; // the requesting tab is gone
      // Progress messages keep the entry alive; only the result retires it.
      if (msg.type === 'result') {
        reqOwners.delete(id);
        clients.get(owner.clientId)?.reqs.delete(id);
        if (RDV_CREATORS.has(owner.type)) {
          const rdvId = (msg as any).result?.rendezvousId;
          if (typeof rdvId === 'string') rdvOwners.set(rdvId, owner.clientId);
        }
      }
      sendTo(owner.clientId, { ...msg, id: owner.localId } as WorkerToMain);
      return;
    }

    if (BY_SUB_ID.has(msg.type)) {
      const subId = (msg as any).subId as number;
      const owner = subOwners.get(subId);
      if (!owner) return;
      sendTo(owner.clientId, { ...msg, subId: owner.localId } as WorkerToMain);
      return;
    }

    if (BY_DOC_SUB.has(msg.type)) {
      const docId = (msg as any).docId as string;
      const isPresence = msg.type === 'update-presence';
      const table = isPresence ? presence : validation;
      (isPresence ? lastByDoc.presence : lastByDoc.validation).set(docId, msg);
      for (const clientId of table.clients(docId)) sendTo(clientId, msg);
      return;
    }

    if (msg.type === 'kh-rdv-event') {
      const owner = rdvOwners.get((msg as any).rendezvousId);
      // Unknown rendezvous (e.g. a receiver-side flow): broadcast rather than drop.
      if (owner === undefined) broadcast(msg);
      else sendTo(owner, msg);
      return;
    }

    broadcast(msg);
  };

  const fatal = (message: string) => {
    onFatal(message);
    // Followers have no Worker to hear onerror from, so surface it over the bus.
    // `route()`'s 'error' case settles their ready gates and raises the banner.
    post({ kind: 'bcast', msg: { type: 'error', message } as WorkerToMain });
  };
  worker.onerror = (e: any) => {
    fatal(e?.message
      ? `The document engine crashed: ${e.message}. Reload the page to reconnect.`
      : 'The document engine crashed unexpectedly. Reload the page to reconnect.');
  };
  worker.onmessageerror = () => {
    fatal('The document engine sent a message that could not be read (it may have crashed). Reload the page.');
  };

  // ── Clients → worker ───────────────────────────────────────────────────────

  const pathKey = (path: (string | number)[]) => JSON.stringify(path);

  /** Hand a joining subscriber the doc's most recent delivery, asynchronously so the
   *  caller finishes wiring up first (mirrors WorkerClient's own presence replay). */
  function replayDocSub(kind: 'presence' | 'validation', docId: string, clientId: ClientId): void {
    const cached = lastByDoc[kind].get(docId);
    if (cached) queueMicrotask(() => sendTo(clientId, cached));
  }

  /** Re-send the union of every client's cursor tokens for one docId+path. */
  function flushCursors(docId: string, key: string): void {
    const entry = cursors.get(docId)?.get(key);
    if (!entry) return;
    const union = new Set<string>();
    for (const tokens of entry.byClient.values()) for (const t of tokens) union.add(t);
    worker.postMessage({ type: 'subscribe-cursors', docId, path: entry.path, tokens: [...union] });
  }

  function fromClient(clientId: ClientId, msg: any): void {
    const rec = clients.get(clientId);
    if (!rec) return; // pruned or never welcomed
    rec.lastBeat = clientId === LEADER_CLIENT_ID ? rec.lastBeat : now();

    switch (msg.type) {
      // Engine boot is the leader's business; a second `init` must not reach it.
      case 'init':
        if (clientId !== LEADER_CLIENT_ID) return;
        break;

      // Transferables never cross the bus, and only the leader owns
      // RTCPeerConnections (the adapter has a single port slot).
      case 'webrtc-port':
        if (clientId !== LEADER_CLIENT_ID) return;
        worker.postMessage(msg, [msg.port]);
        return;

      case 'subscribe-query': {
        const globalSubId = ++nextGlobalId;
        subOwners.set(globalSubId, { clientId, localId: msg.subId });
        rec.globalToLocalSub.set(globalSubId, msg.subId);
        rec.localToGlobalSub.set(msg.subId, globalSubId);
        worker.postMessage({ ...msg, subId: globalSubId });
        return;
      }
      case 'unsubscribe-query': {
        const globalSubId = rec.localToGlobalSub.get(msg.subId);
        if (globalSubId === undefined) return;
        rec.localToGlobalSub.delete(msg.subId);
        rec.globalToLocalSub.delete(globalSubId);
        subOwners.delete(globalSubId);
        worker.postMessage({ ...msg, subId: globalSubId });
        return;
      }

      // The engine re-announces only on a subscribe it actually receives, so a
      // subscriber that arrives second is caught up from the cache instead.
      case 'subscribe-presence':
        if (presence.add(msg.docId, clientId)) worker.postMessage(msg);
        else replayDocSub('presence', msg.docId, clientId);
        return;
      case 'unsubscribe-presence':
        if (presence.remove(msg.docId, clientId)) {
          worker.postMessage(msg);
          lastByDoc.presence.delete(msg.docId); // presence stops; states go stale
        }
        return;
      case 'subscribe-validation':
        if (validation.add(msg.docId, clientId)) worker.postMessage(msg);
        else replayDocSub('validation', msg.docId, clientId);
        return;
      case 'unsubscribe-validation':
        if (validation.remove(msg.docId, clientId)) {
          worker.postMessage(msg);
          lastByDoc.validation.delete(msg.docId);
        }
        return;

      case 'subscribe-cursors': {
        // The engine stores tokens wholesale per docId+path, so a second tab on the
        // same rich-text doc would otherwise erase the first tab's caret token.
        // Forward the union; each client ignores tokens it doesn't own.
        const key = pathKey(msg.path);
        let byPath = cursors.get(msg.docId);
        if (!byPath) { byPath = new Map(); cursors.set(msg.docId, byPath); }
        let entry = byPath.get(key);
        if (!entry) { entry = { path: msg.path, byClient: new Map() }; byPath.set(key, entry); }
        entry.byClient.set(clientId, msg.tokens ?? []);
        flushCursors(msg.docId, key);
        return;
      }
    }

    if (typeof msg.id === 'number') {
      const globalId = ++nextGlobalId;
      reqOwners.set(globalId, { clientId, localId: msg.id, type: msg.type });
      rec.reqs.add(globalId);
      worker.postMessage({ ...msg, id: globalId });
      return;
    }

    worker.postMessage(msg);
  }

  /** Release everything a departed tab held so the engine stops working for it. */
  function dropClient(clientId: ClientId): void {
    const rec = clients.get(clientId);
    if (!rec || clientId === LEADER_CLIENT_ID) return;
    clients.delete(clientId);

    for (const globalSubId of rec.globalToLocalSub.keys()) {
      subOwners.delete(globalSubId);
      worker.postMessage({ type: 'unsubscribe-query', subId: globalSubId });
    }
    for (const id of rec.reqs) reqOwners.delete(id);
    for (const docId of presence.dropClient(clientId)) {
      worker.postMessage({ type: 'unsubscribe-presence', docId });
      lastByDoc.presence.delete(docId);
    }
    for (const docId of validation.dropClient(clientId)) {
      worker.postMessage({ type: 'unsubscribe-validation', docId });
      lastByDoc.validation.delete(docId);
    }
    for (const [docId, byPath] of cursors) {
      for (const [key, entry] of byPath) {
        if (entry.byClient.delete(clientId)) {
          if (entry.byClient.size === 0) byPath.delete(key);
          else flushCursors(docId, key);
        }
      }
      if (byPath.size === 0) cursors.delete(docId);
    }
    for (const [rdvId, owner] of rdvOwners) if (owner === clientId) rdvOwners.delete(rdvId);
  }

  // ── Bus ────────────────────────────────────────────────────────────────────

  bus.onmessage = (e: { data: TabEnvelope }) => {
    const env = e.data;
    switch (env.kind) {
      case 'hello': {
        const clientId = nextClientId++;
        clients.set(clientId, {
          id: clientId,
          send: (msg) => post({ kind: 'res', clientId, msg }),
          lastBeat: now(),
          globalToLocalSub: new Map(),
          localToGlobalSub: new Map(),
          reqs: new Set(),
        });
        const replay = [...sticky.values(), ...stickyPeers.values()];
        post({ kind: 'welcome', nonce: env.nonce, clientId, epoch, replay });
        return;
      }
      case 'req':
        fromClient(env.clientId, env.msg);
        return;
      case 'beat': {
        const rec = clients.get(env.clientId);
        if (rec) rec.lastBeat = now();
        return;
      }
      case 'bye':
        dropClient(env.clientId);
        return;
      case 'shutdown':
        worker.terminate();
        return;
    }
  };

  post({ kind: 'leader-up', epoch });
  const beat: any = setInterval(() => {
    post({ kind: 'leader-beat', epoch });
    const cutoff = now() - TAB_HEARTBEAT_TIMEOUT_MS;
    for (const rec of [...clients.values()]) {
      if (rec.id !== LEADER_CLIENT_ID && rec.lastBeat < cutoff) dropClient(rec.id);
    }
  }, TAB_HEARTBEAT_TIMEOUT_MS / 3);
  // Browser-only in production, but the router is unit-tested under node, where an
  // un-unref'd interval holds the event loop open past the test run.
  if (typeof beat?.unref === 'function') beat.unref();

  return {
    epoch,
    postLocal: (msg, transfer) => {
      if (transfer?.length) { worker.postMessage(msg, transfer); return; }
      fromClient(LEADER_CLIENT_ID, msg);
    },
    shutdownWorker: () => { worker.terminate(); },
    stop: () => {
      clearInterval(beat);
      worker.onmessage = null;
      bus.onmessage = null;
    },
  };
}
