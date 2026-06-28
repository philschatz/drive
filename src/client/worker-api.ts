/**
 * Single owner of the automerge web worker lifecycle.
 * Provides typed APIs for document operations and keyhive operations.
 * The full document is never sent to the main thread — query is the only read path.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import type { WorkerToMain } from './automerge-worker';
import type { ValidationError } from './automerge-worker';
import type { PresenceState, PeerState } from '@automerge/automerge-repo';
import { deepAssign } from '../shared/deep-assign';
import type { RendezvousStatus } from '../shared/rendezvous-protocol';
export type { RendezvousStatus } from '../shared/rendezvous-protocol';
import { idbDelPrefix, settingGet, settingSetSync, closeDb } from './idb-storage';
import { setContactNamesDispatch, applyContactNamesFromWorker } from './contact-names';
import { startWebRTCBridge } from './webrtc-bridge';

// Re-export for convenience
export { deepAssign };
export type { ValidationError };

// ── Doc list (the worker's IDB doc-id list is the single source of truth) ─────

export interface DocEntry {
  id: string;
  type?: 'Calendar' | 'TaskList' | 'DataGrid' | 'unknown';
  name?: string;
  /** Keyhive sharing group ID (base64-encoded). Needed to restore after reload. */
  sharingGroupId?: string;
}

type DocListListener = (list: DocEntry[]) => void;
const docListListeners = new Set<DocListListener>();

/** Subscribe to doc-list changes pushed by the worker (after add/remove/reconcile). */
export function onDocListUpdated(fn: DocListListener): () => void {
  docListListeners.add(fn);
  return () => { docListListeners.delete(fn); };
}

function emitDocList(list: DocEntry[]): void {
  for (const fn of docListListeners) fn(list);
}

/** Remove the current user from a doc (revokes own access + drops it from the list). */
export function removeDocId(docId: string): void {
  fire('remove-me-from-doc', { docId });
}

// Functions that the worker provides its own copy of. Callers pass the real ref;
// updateDoc detects it by identity and sends a marker the worker substitutes.
const WORKER_FNS = new Map<unknown, string>([[deepAssign, 'deepAssign']]);

// ── Worker setup ────────────────────────────────────────────────────────────

const worker = new Worker(
  new URL('./automerge-worker.ts', import.meta.url),
  { type: 'module' },
);

function logSend(msg: { type: string } & Record<string, any>): void {
  console.log('[main] → send', msg.type, msg);
}

// Wire up the contact-names dispatch hook (avoids a circular import with contact-names)
setContactNamesDispatch((type, agentId, name) =>
  // Route through request() so the caller can await persistence and a failed write
  // rejects (rather than being a silent fire-and-forget that drops the data).
  request<void>(type, { agentId, ...(name !== undefined ? { name } : {}) })
);

const initMsg = {
  type: 'init' as const,
};
console.log('[main] → send', initMsg.type, initMsg);
worker.postMessage(initMsg);

// Best-effort: heal the synchronous localStorage mirror of the cache-disabled setting from
// its IDB source of truth, in case localStorage was cleared but IDB still holds the flag.
settingGet('cache-disabled').then(v => settingSetSync('cache-disabled', v)).catch(() => { });

// ── Ready promises ──────────────────────────────────────────────────────────

let resolveRepoReady: () => void;
let rejectRepoReady!: (err: Error) => void;
export const workerReady = new Promise<void>((resolve, reject) => { resolveRepoReady = resolve; rejectRepoReady = reject; });
workerReady.catch(() => { }); // prevent unhandled rejection — callers handle the error

// Fatal worker-init error (e.g. a dangling user-group). Surfaced to the UI as a banner.
let workerFatalError: string | null = null;
const workerErrorListeners = new Set<(message: string) => void>();
export function getWorkerError(): string | null { return workerFatalError; }
export function onWorkerError(fn: (message: string) => void): () => void {
  workerErrorListeners.add(fn);
  if (workerFatalError) fn(workerFatalError); // replay for late subscribers
  return () => { workerErrorListeners.delete(fn); };
}

let resolveKeyhiveReady!: () => void;
let rejectKeyhiveReady!: (err: Error) => void;
export const keyhiveReady = new Promise<void>((resolve, reject) => { resolveKeyhiveReady = resolve; rejectKeyhiveReady = reject; });
keyhiveReady.catch(() => { }); // prevent unhandled rejection — callers handle the error

// ── WebRTC bridge (main thread owns RTCPeerConnection) ───────────────────────
// The repo's network adapter lives in the worker, but RTCPeerConnection is
// window-only. Wire a MessagePort between the worker's WebRTCRelayAdapter and the
// main-thread bridge that owns the peer connections + data channels.
{
  const channel = new MessageChannel();
  startWebRTCBridge(channel.port2);
  // Gate on workerReady so the adapter exists when the port arrives.
  workerReady.then(() => {
    worker.postMessage({ type: 'webrtc-port', port: channel.port1 }, [channel.port1]);
  }).catch(() => { /* worker never became ready — nothing to bridge */ });
}

// ── Worker peer ID ──────────────────────────────────────────────────────────

let _workerPeerId = '';
export function getWorkerPeerId(): string { return _workerPeerId; }

// This user's own user-group id (base64), cached for sync access so presence
// consumers can hide ALL of the local user's devices (not just the current one)
// and group remote peers by user. Best-effort: populated once keyhive is ready and
// refreshed whenever a group is (re)created via ensureUserGroup; null until then.
let _workerUserGroupId: string | null = null;
export function getWorkerUserGroupId(): string | null { return _workerUserGroupId; }
keyhiveReady
  .then(() => getIdentity())
  .then((id) => { _workerUserGroupId = id.userGroupId; })
  .catch(() => { /* never became ready — leave null */ });

// ── Connection status ───────────────────────────────────────────────────────

type ConnectionListener = (connected: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();
let workerPeerCount = 0;
let workerPeers: string[] = [];

type WsStatusListener = (connected: boolean) => void;
const wsStatusListeners = new Set<WsStatusListener>();
let wsConnected = false;

type PeerListListener = (peers: string[]) => void;
const peerListListeners = new Set<PeerListListener>();

// Per-peer sync transport: 'direct' once a WebRTC data channel is open, else 'relay'.
export type PeerTransport = 'direct' | 'relay';
type P2pStatusListener = (peerId: string, transport: PeerTransport) => void;
const p2pStatusListeners = new Set<P2pStatusListener>();
const peerTransports = new Map<string, PeerTransport>();

/** Current transport for a peer ('relay' if no direct channel is open). */
export function getPeerTransport(peerId: string): PeerTransport {
  return peerTransports.get(peerId) ?? 'relay';
}
/** All peers currently on a direct WebRTC channel. */
export function getDirectPeers(): string[] {
  return [...peerTransports.entries()].filter(([, t]) => t === 'direct').map(([p]) => p);
}
/** Subscribe to per-peer transport changes (direct ⇄ relay). */
export function onP2pStatus(fn: P2pStatusListener): () => void {
  p2pStatusListeners.add(fn);
  return () => { p2pStatusListeners.delete(fn); };
}

/** Reactive snapshot of every known peer's transport ('direct' | 'relay'). */
export function usePeerTransports(): Record<string, PeerTransport> {
  const [snapshot, setSnapshot] = useState<Record<string, PeerTransport>>(
    () => Object.fromEntries(peerTransports)
  );
  useEffect(() => onP2pStatus(() => setSnapshot(Object.fromEntries(peerTransports))), []);
  return snapshot;
}

// ── Request/response plumbing ────────────────────────────────────────────────

let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; sent: number; type: string }>();

const subscriptionCallbacks = new Map<number, (result: any, heads: string[], lastModified?: number) => void>();
const presenceCallbacks = new Map<string, (peers: Record<string, PeerState<PresenceState>>) => void>();
const validationCallbacks = new Map<string, (errors: ValidationError[]) => void>();
const openDocProgressCallbacks = new Map<number, (pct: number, message: string) => void>();

let nextSubId = 0;

function request<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
  return workerReady.then(() => {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject, sent: performance.now(), type });
      const msg = { type, id, ...payload };
      logSend(msg);
      worker.postMessage(msg);
    });
  });
}

function fire(type: string, payload: Record<string, any> = {}): void {
  workerReady.then(() => {
    const msg = { type, ...payload };
    logSend(msg);
    worker.postMessage(msg);
  }).catch(() => { }); // worker never became ready — nothing to send
}

/** Keyhive requests gate on keyhiveReady (which implies workerReady). */
function khRequest<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
  return keyhiveReady.then(() => request<T>(type, payload));
}

// ── Keyhive state change notifications ──────────────────────────────────────

const stateChangeListeners = new Set<() => void>();

/** Subscribe to keyhive state changes (membership/access may have changed). */
export function onKeyhiveStateChanged(fn: () => void): () => void {
  stateChangeListeners.add(fn);
  return () => { stateChangeListeners.delete(fn); };
}

// ── Rendezvous sharer-side events ───────────────────────────────────────────

export interface RendezvousEvent { rendezvousId: string; status: RendezvousStatus; message?: string }
type RendezvousEventListener = (e: RendezvousEvent) => void;
const rdvEventListeners = new Set<RendezvousEventListener>();

/** Subscribe to rendezvous sharer-side progress (payload sent to the peer / error). */
export function onRendezvousEvent(fn: RendezvousEventListener): () => void {
  rdvEventListeners.add(fn);
  return () => { rdvEventListeners.delete(fn); };
}

// ── Worker message router ───────────────────────────────────────────────────

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  // Skip routine traffic; keep diagnostically useful events.
  const quiet = msg.type === 'result'
    || msg.type === 'query-result'
    || msg.type === 'update-presence'
    || msg.type === 'open-doc-progress';
  if (!quiet) console.log('[main] ← recv', msg.type, msg);

  switch (msg.type) {
    // --- Lifecycle ---
    case 'ready':
      _workerPeerId = msg.peerId;
      resolveRepoReady();
      break;
    case 'kh-ready':
      resolveKeyhiveReady();
      break;
    case 'kh-error':
      console.error('Keyhive init failed:', msg.message);
      rejectKeyhiveReady(new Error(msg.message));
      break;
    case 'error':
      console.error('Automerge worker error:', msg.message);
      workerFatalError = msg.message;
      rejectRepoReady(new Error(msg.message)); // settle workerReady so request()-gated UI stops hanging
      rejectKeyhiveReady(new Error(msg.message)); // and keyhiveReady (no-op if already resolved)
      for (const fn of workerErrorListeners) fn(msg.message);
      break;
    case 'data-warning':
      // Non-fatal: the worker is up (ready/kh-ready still posted), but local data has a
      // problem (e.g. a dangling user-group). Surface a banner without blocking the app.
      console.warn('Worker data warning:', msg.message);
      workerFatalError = msg.message;
      for (const fn of workerErrorListeners) fn(msg.message);
      break;

    // --- Connectivity ---
    case 'peer-connected':
    case 'peer-disconnected':
      workerPeerCount = msg.peerCount;
      workerPeers = msg.peers;
      for (const fn of connectionListeners) fn(workerPeerCount > 0);
      for (const fn of peerListListeners) fn(workerPeers);
      break;
    case 'ws-status':
      wsConnected = msg.connected;
      for (const fn of wsStatusListeners) fn(msg.connected);
      break;
    case 'p2p-status':
      peerTransports.set(msg.peerId, msg.transport);
      for (const fn of p2pStatusListeners) fn(msg.peerId, msg.transport);
      break;

    // --- Doc storage / contact names ---
    case 'doc-list-updated':
      emitDocList(msg.list as any);
      break;
    case 'contact-names-updated':
      applyContactNamesFromWorker(msg.names);
      break;

    // --- Keyhive notifications ---
    case 'kh-state-changed':
      for (const fn of stateChangeListeners) fn();
      break;
    case 'kh-rdv-event':
      for (const fn of rdvEventListeners) fn(msg);
      break;

    // --- Request/response results (doc + keyhive share the same pending map) ---
    case 'result': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        const elapsed = performance.now() - p.sent;
        if (elapsed > 100) console.log(`[main] ⏱ ${p.type} took ${Math.round(elapsed).toLocaleString()}ms`);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
      break;
    }
    case 'query-result': {
      const cb = subscriptionCallbacks.get(msg.subId);
      if (cb) {
        if (msg.error) console.warn('[worker-api] query-result error subId=%d:', msg.subId, msg.error);
        else cb(msg.result, msg.heads, msg.lastModified);
      }
      break;
    }
    case 'update-presence': {
      const cb = presenceCallbacks.get(msg.docId);
      if (cb) cb(msg.peers);
      break;
    }
    case 'open-doc-progress': {
      const cb = openDocProgressCallbacks.get(msg.id);
      if (cb) cb(msg.pct, msg.message);
      break;
    }
    case 'update-validation': {
      const cb = validationCallbacks.get(msg.docId);
      if (cb) cb(msg.errors);
      break;
    }
  }
};

worker.onerror = (e) => {
  console.error('Automerge worker failed to load:', e.message);
};

// ── Connection status hooks ─────────────────────────────────────────────────

/**
 * Returns true when the worker repo has at least one connected peer (i.e. the server).
 * Disconnection is debounced by 6 s (> the 5 s retry interval in the WS adapter)
 * so brief disconnect/reconnect cycles don't flash the indicator red.
 */
export function useConnectionStatus(): boolean {
  const [connected, setConnected] = useState(() => workerPeerCount > 0);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const listener: ConnectionListener = (isConnected) => {
      if (isConnected) {
        if (disconnectTimer.current !== null) {
          clearTimeout(disconnectTimer.current);
          disconnectTimer.current = null;
        }
        setConnected(true);
      } else {
        if (disconnectTimer.current !== null) return;
        disconnectTimer.current = setTimeout(() => {
          disconnectTimer.current = null;
          setConnected(workerPeerCount > 0);
        }, 6000);
      }
    };
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
      if (disconnectTimer.current !== null) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
    };
  }, []);

  return connected;
}

/**
 * Returns WebSocket connection status for a specific document's repo.
 * Unlike useConnectionStatus (which tracks peers), this tracks the raw WS open/close state.
 */
export function useWsStatus(_docId: string): boolean {
  const [connected, setConnected] = useState(() => wsConnected);

  useEffect(() => {
    const listener: WsStatusListener = (isConnected) => {
      setConnected(isConnected);
    };
    wsStatusListeners.add(listener);
    return () => { wsStatusListeners.delete(listener); };
  }, []);

  return connected;
}

export function usePeerList(): string[] {
  const [peers, setPeers] = useState(() => workerPeers);

  useEffect(() => {
    const listener: PeerListListener = (p) => setPeers(p);
    peerListListeners.add(listener);
    return () => { peerListListeners.delete(listener); };
  }, []);

  return peers;
}

// ── jq filter constants ─────────────────────────────────────────────────────

export const HOME_SUMMARY_QUERY =
  '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then [.tasks[] | select(.progress != "completed" and .progress != "cancelled")] | length else 0 end), cellCount: (if .sheets then [.sheets[].cells // {} | length] | add else 0 end) }';

// ── Cache controls ───────────────────────────────────────────────────────────

/**
 * Enable/disable the worker's performance caches (jq/query-result/validation). Persists
 * the flag (IDB source of truth + the synchronous localStorage mirror), tells the worker
 * (which clears its caches when disabling), then reloads so the worker re-reads the flag.
 */
export async function setCacheDisabled(disabled: boolean): Promise<void> {
  settingSetSync('cache-disabled', disabled); // sync mirror, read on next load
  await request('set-cache-disabled', { disabled }); // worker persists IDB + clears if disabling
  window.location.reload();
}

/** Wipe the worker's performance caches (query/validation LRUs + IDB qc:*) and reload. */
export async function clearAllCaches(): Promise<void> {
  await request('clear-caches'); // worker clears its LRUs + idbDelPrefix('qc:')
  await idbDelPrefix('qc:'); // belt-and-suspenders in case the worker is unavailable
  window.location.reload();
}

/**
 * Nuclear reset: delete ALL local data — every IndexedDB database (automerge docs +
 * keyhive ops in 'automerge-secure', settings/doc-list/contacts in 'app-storage') and
 * localStorage — then reload. The worker is terminated first so it releases its open
 * IndexedDB connections (otherwise deleteDatabase blocks). Irreversible.
 */
export async function deleteAllData(): Promise<void> {
  // Terminate the worker so 'automerge-secure' (and its own idb connections) close,
  // then close the main thread's 'app-storage' connection. Both must be released before
  // deleteDatabase can complete (otherwise it blocks). closeDb is fire-and-forget so a
  // pending/blocked open can't hang the reset.
  worker.terminate();
  closeDb();

  const known = ['app-storage', 'automerge-secure'];
  let names = known;
  // Chromium exposes indexedDB.databases() to catch any extra/legacy DBs; Firefox doesn't.
  if (typeof (indexedDB as any).databases === 'function') {
    try {
      const dbs = await (indexedDB as any).databases();
      const found = dbs.map((d: any) => d.name).filter((n: any): n is string => !!n);
      names = [...new Set([...known, ...found])];
    } catch { /* fall back to the known list */ }
  }

  // Wait for each deletion to actually COMPLETE (onsuccess) before reloading — resolving
  // early on onblocked left the delete pending, which then raced the reload and could fire
  // against the fresh DB the new worker creates (corrupting it → init hangs). The worker is
  // terminated, so any block is transient (connection still closing) and clears into
  // onsuccess. A timeout is a safety net so we never hang the reset forever.
  await Promise.all(names.map(name => new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = finish;
    req.onerror = finish;
    // onblocked: don't resolve — wait for onsuccess once the terminated worker's
    // connection finishes closing. The timeout is the safety net.
    setTimeout(finish, 5000);
  })));

  localStorage.clear();
  window.location.reload();
}

/** Read the current doc list from the worker (the source of truth). */
export function getDocList(): Promise<DocEntry[]> {
  return request<DocEntry[]>('get-doc-list');
}

/** Pull the doc list from the worker and notify onDocListUpdated subscribers. */
export async function fetchDocList(): Promise<DocEntry[]> {
  const list = await getDocList();
  emitDocList(list);
  return list;
}

// ── Document mutations ──────────────────────────────────────────────────────

export function createDoc(initialJson: any, metadata?: Partial<DocEntry>): Promise<{ docId: string }> {
  return request<{ docId: string }>('create-doc', { initialJson, metadata });
}

/**
 * Explicitly open/load a document, reporting progress as it loads.
 * Resolves once the document data is available in the worker.
 */
export function openDoc(
  docId: string,
  opts?: { onProgress?: (pct: number, message: string) => void },
): Promise<{ docId: string }> {
  const { onProgress } = opts ?? {};
  return workerReady.then(() => {
    const id = ++nextId;
    if (onProgress) openDocProgressCallbacks.set(id, onProgress);
    return new Promise<{ docId: string }>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => { openDocProgressCallbacks.delete(id); resolve(v); },
        reject: (e) => { openDocProgressCallbacks.delete(id); reject(e); },
        sent: performance.now(), type: 'open-doc',
      });
      const msg = { type: 'open-doc' as const, id, docId };
      logSend(msg);
      worker.postMessage(msg);
    });
  });
}

/**
 * Apply a mutation to a document in the worker.
 * The function body is serialized and reconstructed in the worker via new Function().
 * All closed-over variables must be passed as extra arguments matching the callback params.
 * Worker-provided functions (like `deepAssign`) are detected and substituted automatically.
 *
 * @example
 * updateDoc(docId, (d, uid, data) => { d.events[uid] = data; }, uid, data);
 * updateDoc(docId, (d, deepAssign, uid, patch) => { deepAssign(d.events[uid], patch); }, deepAssign, uid, patch);
 * updateDoc(docId, (d, uid) => { delete d.tasks[uid]; }, uid);
 */
export function updateDoc(
  docId: string,
  fn: (d: any, ...args: any[]) => void,
  ...args: unknown[]
): Promise<void> {
  const serializedArgs = args.map(a =>
    WORKER_FNS.has(a) ? { __workerFn__: WORKER_FNS.get(a)! } : a
  );
  return request('update-doc', { docId, fnSource: fn.toString(), args: serializedArgs });
}

// ── Query subscriptions ─────────────────────────────────────────────────────

/**
 * Subscribe to live jq query results for a document.
 * The callback is called immediately with the current result, then on every change.
 * Returns a cleanup function.
 */
export function subscribeQuery(
  docId: string,
  filter: string,
  onResult: (result: any, heads: string[], lastModified?: number) => void,
): () => void {
  const subId = ++nextSubId;

  subscriptionCallbacks.set(subId, (result, heads, lastModified) => {
    onResult(result, heads, lastModified);
  });
  fire('subscribe-query', { subId, docId, filter });

  return () => {
    subscriptionCallbacks.delete(subId);
    fire('unsubscribe-query', { subId });
  };
}

// ── Validation subscriptions ────────────────────────────────────────────────

/**
 * Subscribe to validation results for a document.
 * The callback receives the first 100 errors (or empty array) on each doc change.
 * Returns a cleanup function.
 */
export function subscribeValidation(
  docId: string,
  onResult: (errors: ValidationError[]) => void,
): () => void {
  validationCallbacks.set(docId, onResult);
  fire('subscribe-validation', { docId });
  return () => {
    validationCallbacks.delete(docId);
    fire('unsubscribe-validation', { docId });
  };
}

/**
 * One-shot jq query against the live document.
 */
export function queryDoc(
  docId: string,
  filter: string,
): Promise<{ result: any; heads: string[] }> {
  return workerReady.then(() => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, sent: performance.now(), type: 'query' });
      const msg = { type: 'query' as const, id, docId, filter };
      logSend(msg);
      worker.postMessage(msg);
    });
  });
}

// ── History & undo ──────────────────────────────────────────────────────────

export function getDocHistory(docId: string): Promise<Array<{ version: number; time: number }>> {
  return request('get-doc-history', { docId });
}

export function debugGetVersionPatches(docId: string, version: number): Promise<any[]> {
  return request('debug-get-version-patches', { docId, version });
}

/**
 * Pin all subscriptions for a document to a historical version.
 * Pass null to resume live view. Worker immediately re-runs all subscriptions.
 */
export function setDocVersion(docId: string, version: number | null): void {
  fire('set-doc-version', { docId, version });
}

export function restoreDocToHeads(docId: string, heads: string[]): Promise<void> {
  return request('restore-doc-to-heads', { docId, heads });
}

/** Restore a document to a specific history version index. Clears pinned version after restore. */
export function restoreDocToVersion(docId: string, version: number): Promise<void> {
  return request('restore-doc-to-version', { docId, version });
}

// ── Presence ────────────────────────────────────────────────────────────────

export function subscribePresence(
  docId: string,
  onUpdate: (peers: Record<string, PeerState<PresenceState>>) => void,
): () => void {
  presenceCallbacks.set(docId, onUpdate);
  fire('subscribe-presence', { docId });
  return () => {
    presenceCallbacks.delete(docId);
    fire('unsubscribe-presence', { docId });
  };
}

export function setPresence(docId: string, state: Partial<PresenceState>): void {
  fire('set-presence', { docId, state });
}

// ── Keyhive types ───────────────────────────────────────────────────────────

export interface DeviceInfo {
  agentId: string;
  role: string;
  isMe?: boolean;
}

export interface IdentityInfo {
  deviceId: string;
  agentId: string;
  /** This user's personal Group id (base64), or null if not yet created. */
  userGroupId: string | null;
  devices?: DeviceInfo[];
}

import type { MemberInfo } from './shared/keyhive-types';
export type { MemberRole, IndividualMemberInfo, GroupMemberInfo, MemberInfo } from './shared/keyhive-types';

/** A contact card plus the sender's user-group id, for QR/URL linking & sharing. */
export interface LinkPayload {
  card: string;
  userGroupId: string | null;
}

// ── Keyhive API ─────────────────────────────────────────────────────────────

/** Get this device's identity and linked devices. */
export function getIdentity(): Promise<IdentityInfo> {
  return khRequest('kh-get-identity');
}

/** Generate a contact card (JSON string) for sharing with others. */
export function getContactCard(): Promise<string> {
  return khRequest('kh-get-contact-card');
}

/** Receive a contact card from another device/user. Returns the agent ID. */
export function receiveContactCard(
  cardJson: string,
  opts?: { isDevice?: boolean; userGroupId?: string | null },
): Promise<{ agentId: string; isOwnCard: boolean; userGroupId: string | null; alreadyKnown: boolean }> {
  return khRequest('kh-receive-contact-card', { cardJson, isDevice: opts?.isDevice, userGroupId: opts?.userGroupId });
}

/** Get known contacts across all documents, excluding members of a specific doc. */
export function getKnownContacts(excludeDocId: string): Promise<MemberInfo[]> {
  return khRequest('kh-get-known-contacts', { excludeDocId });
}

/** Ensure this device has a personal user-group; returns its id (base64). */
export async function ensureUserGroup(opts?: { create?: boolean; adoptGroupId?: string; waitForSync?: boolean }): Promise<{ userGroupId: string | null }> {
  const res = await khRequest<{ userGroupId: string | null }>('kh-ensure-user-group', { create: opts?.create, adoptGroupId: opts?.adoptGroupId, waitForSync: opts?.waitForSync });
  if (res.userGroupId) _workerUserGroupId = res.userGroupId;
  return res;
}

/** Link another device into this user's group (converges groups, adds the peer if admin). */
export function linkDevice(deviceAgentId: string, peerGroupId?: string | null): Promise<{ userGroupId: string | null; linked: boolean }> {
  return khRequest('kh-link-device', { deviceAgentId, peerGroupId });
}

/** Get this device's contact card plus user-group id, for building a link/share QR. */
export function getLinkPayload(): Promise<LinkPayload> {
  return khRequest('kh-get-link-payload');
}

/**
 * Stage our contact bundle for an encrypted relay rendezvous and get back the
 * tiny {rendezvousId, key} to put in a QR/link. The (large) bundle is sent —
 * encrypted under `key` — automatically once the receiver opens the link; listen
 * via onRendezvousEvent for the 'sent' confirmation.
 */
export function rendezvousCreateShare(displayName?: string): Promise<{ rendezvousId: string; key: string }> {
  return khRequest('kh-rdv-create-share', { displayName });
}

/** Receive a contact via rendezvous: subscribe, await the encrypted bundle, ingest it. */
export function rendezvousReceive(
  rendezvousId: string,
  key: string,
  displayName?: string,
): Promise<{ agentId: string; isOwnCard: boolean; userGroupId: string | null; displayName?: string; alreadyKnown: boolean }> {
  return khRequest('kh-rdv-receive', { rendezvousId, key, displayName });
}

/**
 * Device-link sharer (original/admin device): stage a bidirectional rendezvous and
 * get the tiny {id,key} for the QR. The new device's `rendezvousJoinDeviceLink`
 * completes the handshake; listen via onRendezvousEvent for status 'linked'.
 */
export function rendezvousCreateDeviceLink(): Promise<{ rendezvousId: string; key: string }> {
  return khRequest('kh-rdv-link-create');
}

/** Device-link joiner (new device): adopt the original device's group over the rendezvous. */
export function rendezvousJoinDeviceLink(rendezvousId: string, key: string): Promise<{ ok: boolean }> {
  return khRequest('kh-rdv-link-join', { rendezvousId, key });
}

/** Abandon a rendezvous (e.g. the sharer navigates away). Fire-and-forget. */
export function rendezvousCancel(rendezvousId: string): void {
  fire('kh-rdv-cancel', { rendezvousId });
}

/** Get all members and roles for a document. */
export function getDocMembers(docId: string): Promise<{ members: MemberInfo[] }> {
  return khRequest('kh-get-doc-members', { docId });
}

/** Get this device's access level for a document. */
export function getMyAccess(docId: string): Promise<string | null> {
  return khRequest('kh-get-my-access', { docId });
}

/** List all devices linked to this user's identity group. */
export function listDevices(): Promise<DeviceInfo[]> {
  return khRequest('kh-list-devices');
}

/** Remove a linked device by agent ID. */
export function removeDevice(agentId: string): Promise<void> {
  return khRequest('kh-remove-device', { agentId });
}

/** Add a member to a document with a specific role. */
export function addMember(agentId: string, docId: string, role: string): Promise<void> {
  return khRequest('kh-add-member', { agentId, docId, role });
}

/** Revoke a member from a document (triggers key rotation). */
export function revokeMember(agentId: string, docId: string): Promise<void> {
  return khRequest('kh-revoke-member', { agentId, docId });
}

/** Change a member's role (revoke + re-add, triggers key rotation). */
export function changeRole(agentId: string, docId: string, newRole: string): Promise<void> {
  return khRequest('kh-change-role', { agentId, docId, newRole });
}

// ── HyperFormula worker port ─────────────────────────────────────────────────

/** Transfer a MessagePort to the automerge worker for direct HF worker communication. */
export function sendHfPort(port: MessagePort): void {
  workerReady.then(() => {
    worker.postMessage({ type: 'hf-port', port }, [port]);
  });
}
