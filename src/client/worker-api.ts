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
import { idbDelPrefix, settingGet, settingSetSync, closeDb, CACHE_PREFIX } from './idb-storage';
import { setFriendNamesDispatch, applyFriendNamesFromWorker } from './friend-names';
import { setDeviceNamesDispatch, applyDeviceNamesFromWorker } from './device-names';
import { generateDefaultDeviceName } from './lib/device-name';
import type { ArchiveDocResult } from '../shared/keyhive-types';
import { startWebRTCBridge } from './webrtc-bridge';
import { WorkerClient } from './worker-client';
import type { RichTextOp, RichTextSpan } from '../shared/rich-text-ops';

// Re-export for convenience
export { deepAssign };
export type { ValidationError };
export type { RichTextOp, RichTextSpan };

/**
 * Worker-substituted rich-text bridge: pass this ref as an updateDoc arg and the
 * worker swaps in its own `applyRichTextOps` (bound to the worker's Automerge —
 * Peritext functions can't run on the main thread, the doc lives in the worker):
 *
 *   updateDoc(docId, (d, richText, ops) => richText(d, ['content'], ops), richText, ops);
 */
export const richText: (d: any, path: (string | number)[], ops: RichTextOp[]) => void =
  () => { throw new Error('richText runs inside the worker — pass it as an updateDoc argument'); };

// ── Doc list (the worker's IDB doc-id list is the single source of truth) ─────

export interface DocEntry {
  id: string;
  /** The document's `@type` ('unknown' when absent); see src/client/doc-plugins. */
  type?: string;
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

// ── Unseen-changes push (worker-owned; absent docId = unknown, no dot) ───────

let unseenChanges: Record<string, boolean> = {};
const unseenListeners = new Set<(unseen: Record<string, boolean>) => void>();

/**
 * Subscribe to per-doc "new changes since last viewed" state. Replays the
 * current snapshot immediately. Returns a cleanup function.
 */
export function onUnseenChangesUpdated(fn: (unseen: Record<string, boolean>) => void): () => void {
  unseenListeners.add(fn);
  fn(unseenChanges);
  return () => { unseenListeners.delete(fn); };
}

/** Current per-doc "new changes since last viewed" snapshot. */
export function getUnseenChanges(): Record<string, boolean> {
  return { ...unseenChanges };
}

// ── Device-name push (cache lives in device-names.ts; this just notifies UI) ──
const deviceNamesListeners = new Set<() => void>();

/**
 * Subscribe to device-name changes (e.g. a peer's name learned during a device
 * link). The cache in device-names.ts is already updated when this fires; the
 * callback is just a re-render nudge. Returns a cleanup function.
 */
export function onDeviceNamesUpdated(fn: () => void): () => void {
  deviceNamesListeners.add(fn);
  return () => { deviceNamesListeners.delete(fn); };
}

// ── Friend-name push (cache lives in friend-names.ts; this just notifies UI) ─
const contactNamesListeners = new Set<() => void>();

/**
 * Subscribe to contact-name changes (e.g. a contact's name learned via QR
 * rendezvous). The cache in friend-names.ts is already updated when this fires;
 * the callback is just a re-render nudge. Returns a cleanup function.
 */
export function onFriendNamesUpdated(fn: () => void): () => void {
  contactNamesListeners.add(fn);
  return () => { contactNamesListeners.delete(fn); };
}

/**
 * Archive a doc: revoke the user's own access if possible, tombstone + purge it
 * locally either way. Resolves with whether access was truly 'revoked' (gone
 * from all devices once synced) or the doc was only archived on this device.
 */
export function archiveDoc(docId: string): Promise<{ status: ArchiveDocResult['status'] }> {
  return khRequest('archive-doc', { docId });
}

// Functions that the worker provides its own copy of. Callers pass the real ref;
// updateDoc detects it by identity and sends a marker the worker substitutes.
const WORKER_FNS = new Map<unknown, string>([[deepAssign, 'deepAssign'], [richText, 'richText']]);

// ── Worker setup ────────────────────────────────────────────────────────────

const worker = new Worker(
  new URL('./automerge-worker.ts', import.meta.url),
  { type: 'module' },
);

function logSend(msg: { type: string } & Record<string, any>): void {
  console.log('[main] → send', msg.type, msg);
}

// The resilient request/response + subscription core. Owns pending requests, the
// ready gates, the fatal-error fan-out, and query/presence/validation subs. The
// on-the-wire protocol is unchanged — worker-api just wires the real Worker to it.
const client = new WorkerClient(worker, { log: logSend });

// Wire up the contact-names dispatch hook (avoids a circular import with contact-names)
setFriendNamesDispatch((type, agentId, name) =>
  // Route through request() so the caller can await persistence and a failed write
  // rejects (rather than being a silent fire-and-forget that drops the data).
  request<void>(type, { agentId, ...(name !== undefined ? { name } : {}) })
);

// Same pattern for device names (keyed by device agentId).
setDeviceNamesDispatch((type, agentId, name) =>
  request<void>(type, { agentId, ...(name !== undefined ? { name } : {}) })
);

const initMsg = {
  type: 'init' as const,
};
console.log('[main] → send', initMsg.type, initMsg);
worker.postMessage(initMsg);

// Best-effort: heal the synchronous localStorage mirror of the debug-enable setting from
// its IDB source of truth, in case localStorage was cleared but IDB still holds the flag.
settingGet('debug-enable').then(v => settingSetSync('debug-enable', v)).catch(() => { });

// ── Ready promises + fatal-error surface (owned by the WorkerClient) ─────────

export const workerReady = client.workerReady;
export const keyhiveReady = client.keyhiveReady;

/** Latest fatal/data-warning message, or null. Surfaced to the UI as a banner. */
export function getWorkerError(): string | null { return client.getWorkerError(); }
export function onWorkerError(fn: (message: string) => void): () => void {
  return client.onWorkerError(fn);
}

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

export function getWorkerPeerId(): string { return client.getWorkerPeerId(); }

// This user's own user-group id (base64), cached for sync access so presence
// consumers can hide ALL of the local user's devices (not just the current one)
// and group remote peers by user. Best-effort: populated once keyhive is ready and
// refreshed whenever a group is (re)created via ensureUserGroup; null until then.
let _workerUserGroupId: string | null = null;
export function getWorkerUserGroupId(): string | null { return _workerUserGroupId; }
keyhiveReady
  .then(() => getIdentity())
  .then((id) => {
    _workerUserGroupId = id.userGroupId;
    // Seed this device's name once, at device creation: generate the default here
    // (the worker has no reliable `navigator`) and let the worker persist it
    // set-if-absent, so the device has a real, editable name instead of a live
    // placeholder. Fire-and-forget — must not block or fail identity hydration.
    if (typeof navigator !== 'undefined') {
      request('ensure-device-name', { agentId: id.agentId, name: generateDefaultDeviceName() })
        .catch((err) => console.warn('[worker-api] ensure-device-name failed:', err));
    }
  })
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
  useEffect(() => {
    // Peer-list changes prune the transport map (departed peers), so re-snapshot
    // on those too — not just on p2p-status flips.
    const refresh = () => setSnapshot(Object.fromEntries(peerTransports));
    const offP2p = onP2pStatus(refresh);
    peerListListeners.add(refresh);
    return () => { offP2p(); peerListListeners.delete(refresh); };
  }, []);
  return snapshot;
}

// ── Request/response plumbing (delegated to the WorkerClient core) ───────────

function request<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
  return client.request<T>(type, payload);
}

function fire(type: string, payload: Record<string, any> = {}): void {
  client.fire(type, payload);
}

/** Keyhive requests gate on keyhiveReady (which implies workerReady). */
function khRequest<T>(type: string, payload: Record<string, any> = {}): Promise<T> {
  return client.khRequest<T>(type, payload);
}

// ── Keyhive state change notifications ──────────────────────────────────────

const stateChangeListeners = new Set<() => void>();

/** Subscribe to keyhive state changes (membership/access may have changed). */
export function onKeyhiveStateChanged(fn: () => void): () => void {
  stateChangeListeners.add(fn);
  return () => { stateChangeListeners.delete(fn); };
}

// ── Rendezvous sharer-side events ───────────────────────────────────────────

export interface RendezvousEvent {
  rendezvousId: string;
  status: RendezvousStatus;
  message?: string;
  /** On the sharer's terminal 'received' event: the contact we just added back. */
  friendGroupId?: string;
  /** Whether that contact arrived with a display name (else the sharer must prompt for one). */
  friendHasName?: boolean;
}
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

  // Lifecycle gates, request results, and query/presence/validation deliveries
  // are owned by the WorkerClient core; everything else is app-level routing.
  if (client.route(msg)) return;

  switch (msg.type) {
    // --- Connectivity ---
    case 'peer-connected':
    case 'peer-disconnected': {
      workerPeerCount = msg.peerCount;
      workerPeers = msg.peers;
      // Drop transports for departed peers so a rejoining peer starts back at
      // 'relay' (hollow dot) instead of a stale 'direct'.
      const alivePeers = new Set(msg.peers);
      for (const peerId of [...peerTransports.keys()]) {
        if (!alivePeers.has(peerId)) peerTransports.delete(peerId);
      }
      for (const fn of connectionListeners) fn(workerPeerCount > 0);
      for (const fn of peerListListeners) fn(workerPeers);
      break;
    }
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
    case 'friend-names-updated':
      applyFriendNamesFromWorker(msg.names);
      for (const fn of contactNamesListeners) fn();
      break;
    case 'device-names-updated':
      applyDeviceNamesFromWorker(msg.names);
      for (const fn of deviceNamesListeners) fn();
      break;
    case 'unseen-changes-updated':
      unseenChanges = msg.unseen;
      for (const fn of unseenListeners) fn(unseenChanges);
      break;

    // --- Keyhive notifications ---
    case 'kh-state-changed':
      for (const fn of stateChangeListeners) fn();
      break;
    case 'kh-rdv-event':
      for (const fn of rdvEventListeners) fn(msg);
      break;
  }
};

// The worker crashed or sent an unreadable message (e.g. a hostile peer payload
// crashed it). Reject every in-flight request, settle the ready gates, mark the
// worker dead so future requests reject instead of hanging, and show the banner.
// `.message` is empty for cross-origin/module load failures, so fall back.
worker.onerror = (e) => {
  console.error('Automerge worker crashed:', e.message);
  client.fail(e.message
    ? `The document engine crashed: ${e.message}. Reload the page to reconnect.`
    : 'The document engine crashed unexpectedly. Reload the page to reconnect.');
};
worker.onmessageerror = () => {
  console.error('Automerge worker sent an unreadable message');
  client.fail('The document engine sent a message that could not be read (it may have crashed). Reload the page.');
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
export function useWsStatus(): boolean {
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

/**
 * Resolve once the relay WebSocket is open (immediately if already connected).
 * Imperative counterpart to useWsStatus, for non-component callers that must not
 * send a relay overlay frame (e.g. a rendezvous subscribe) before the socket is
 * up — otherwise the frame is dropped and never retried.
 */
export function whenWsConnected(): Promise<void> {
  if (wsConnected) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const listener: WsStatusListener = (isConnected) => {
      if (!isConnected) return;
      wsStatusListeners.delete(listener);
      resolve();
    };
    wsStatusListeners.add(listener);
  });
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

/** Snapshot of currently-connected peerIds (non-reactive; used by tests). */
export function getConnectedPeers(): string[] {
  return workerPeers;
}

// ── jq filter constants ─────────────────────────────────────────────────────

export const HOME_SUMMARY_QUERY =
  '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then [.tasks[] | select(.progress != "completed" and .progress != "cancelled")] | length else 0 end), cellCount: (if .sheets then [.sheets[].cells // {} | length] | add else 0 end) }';

// ── Cache controls ───────────────────────────────────────────────────────────

/**
 * Enable/disable debug mode: bypasses the worker's performance caches
 * (jq/query-result/validation) AND traces keyhive/WASM calls (console + crash banner).
 * Persists the flag (IDB source of truth + the synchronous localStorage mirror), tells
 * the worker (which clears its caches when enabling), then reloads so the worker re-reads it.
 */
export async function setDebugEnabled(enabled: boolean): Promise<void> {
  settingSetSync('debug-enable', enabled); // sync mirror, read on next load
  await request('set-debug-mode', { enabled }); // worker persists IDB + clears caches if enabling
  window.location.reload();
}

export type SettingsMode = 'local' | 'shared';

/**
 * Current settings storage mode: LOCAL (device-local JSON blob) or SHARED (synced
 * DriveSettings doc), plus whether a keyhive user-group exists (gates the opt-in).
 */
export async function getSettingsMode(): Promise<{ mode: SettingsMode; hasUserGroup: boolean }> {
  return request<{ mode: SettingsMode; hasUserGroup: boolean }>('get-settings-mode', {});
}

/**
 * One-way opt-in: migrate this device's local settings into a synced DriveSettings
 * doc and switch to SHARED mode (irreversible). Requires an existing user-group.
 * Does NOT reload — the caller decides (the Settings page reloads; the device-link
 * flow proceeds straight into the rendezvous so the new pointer is handed off).
 */
export async function enableSettingsSync(): Promise<void> {
  await request('enable-settings-sync', {});
}

/**
 * Read-only probe: the docId of an existing reachable DriveSettings doc this device
 * could adopt (already synced from another of the user's devices), or null. No
 * side effects — lets the Settings page decide whether enabling sync is a permanent
 * create (needs confirmation) or a frictionless reuse, BEFORE prompting.
 */
export async function getReachableSettingsDoc(): Promise<string | null> {
  return (await request('get-reachable-settings-doc', {})) as string | null;
}

/**
 * Test hook: override the worker's presence timing (stale window, heartbeat,
 * liveness-check interval). Takes effect on the next presence setup, so call it
 * before subscribing. No reload — used by the presence Playwright specs to run
 * a short stale window instead of sleeping past the 12s default.
 */
export async function setPresenceTiming(opts: {
  staleMs?: number;
  heartbeatMs?: number;
  livenessCheckMs?: number;
}): Promise<void> {
  await request('set-presence-timing', opts);
}

/** Wipe the worker's performance caches (query/validation LRUs + IDB cache:*) and reload. */
export async function clearAllCaches(): Promise<void> {
  await request('clear-caches'); // worker clears its LRUs + idbDelPrefix(CACHE_PREFIX)
  await idbDelPrefix(CACHE_PREFIX); // belt-and-suspenders in case the worker is unavailable
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
  return client.openDoc(docId, opts);
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

// ── Rich-text cursors ───────────────────────────────────────────────────────

/**
 * Automerge Cursors for flat-text positions in a Peritext field. Presence
 * shares carets as cursors (Peritext convention — a cursor keeps pointing at
 * the same character across concurrent edits); the doc lives in the worker,
 * so both conversions are worker requests.
 */
export function getTextCursors(
  docId: string,
  path: (string | number)[],
  positions: number[],
): Promise<string[]> {
  return request('text-cursors', { docId, path, positions });
}

/** Resolve peers' cursors back to positions; null for unresolvable cursors. */
export function getTextCursorPositions(
  docId: string,
  path: (string | number)[],
  cursors: string[],
): Promise<(number | null)[]> {
  return request('text-cursor-positions', { docId, path, cursors });
}

// ── Query subscriptions ─────────────────────────────────────────────────────

/**
 * Subscribe to live jq query results for a document.
 * The callback is called immediately with the current result, then on every change.
 * Returns a cleanup function.
 *
 * Pass `{ peek: true }` when the read is NOT the user viewing the document
 * (home-page summaries, source inspector/export, background tooling) — non-peek
 * subscriptions mark the doc's last-viewed heads, clearing its new-changes dot.
 */
export function subscribeQuery(
  docId: string,
  filter: string,
  onResult: (result: any, heads: string[], lastModified?: number, spans?: RichTextSpan[]) => void,
  onError?: (error: string) => void,
  opts?: { peek?: boolean; meta?: boolean; spansPath?: (string | number)[] },
): () => void {
  return client.subscribeQuery(docId, filter, onResult, onError, opts);
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
  return client.subscribeValidation(docId, onResult);
}

/**
 * One-shot jq query against the live document. Counts as the user viewing the
 * doc (clears its new-changes dot) unless `{ peek: true }` is passed.
 */
export function queryDoc(
  docId: string,
  filter: string,
  opts?: { peek?: boolean },
): Promise<{ result: any; heads: string[] }> {
  return client.queryDoc(docId, filter, opts);
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
  return client.subscribePresence(docId, onUpdate);
}

export function setPresence(docId: string, state: Partial<PresenceState>): void {
  fire('set-presence', { docId, state });
}

// ── Keyhive types ───────────────────────────────────────────────────────────

export interface DeviceInfo {
  agentId: string;
  role: MemberRole;
  isMe?: boolean;
  /**
   * Friendly device name. Main-thread-enriched (see use-devices.ts) from the
   * device-names cache — the worker's listGroupDevices does not populate it.
   */
  name?: string;
}

export interface IdentityInfo {
  deviceId: string;
  agentId: string;
  /** This user's personal Group id (base64), or null if not yet created. */
  userGroupId: string | null;
  devices?: DeviceInfo[];
}

import type { MemberInfo, MemberRole } from '../shared/keyhive-types';
export type { MemberRole, IndividualMemberInfo, GroupMemberInfo, MemberInfo } from '../shared/keyhive-types';

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
export function getKnownFriends(excludeDocId: string): Promise<MemberInfo[]> {
  return khRequest('kh-get-known-friends', { excludeDocId });
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
export function rendezvousCreateShare(displayName?: string): Promise<{ rendezvousId: string; key: string; payloadBytes: number }> {
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
export function rendezvousCreateDeviceLink(deviceName?: string): Promise<{ rendezvousId: string; key: string; payloadBytes: number }> {
  return khRequest('kh-rdv-link-create', { deviceName });
}

/** Device-link joiner (new device): adopt the original device's group over the rendezvous. */
export function rendezvousJoinDeviceLink(rendezvousId: string, key: string, deviceName?: string): Promise<{ ok: boolean }> {
  return khRequest('kh-rdv-link-join', { rendezvousId, key, deviceName });
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

/** Change a device's access level within the user-group (revoke + re-add). */
export function changeDeviceRole(agentId: string, newRole: string): Promise<void> {
  return khRequest('kh-change-device-role', { agentId, newRole });
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
