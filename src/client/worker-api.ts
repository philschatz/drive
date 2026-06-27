/**
 * Single owner of the automerge web worker lifecycle.
 * Provides typed APIs for document operations and keyhive operations.
 * The full document is never sent to the main thread — query is the only read path.
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import type { WorkerToMain } from './automerge-worker';
import type { ValidationError } from './automerge-worker';
import type { PresenceState, PeerState } from '@automerge/automerge-repo';
import type { InviteRecord } from './invite-storage';
import { deepAssign } from '../shared/deep-assign';
import type { RendezvousStatus } from '../shared/rendezvous-protocol';
export type { RendezvousStatus } from '../shared/rendezvous-protocol';
import { idbGet, hashStr, type QueryCacheEntry } from './idb-storage';
import { setDocListDispatch, applyDocListFromWorker } from './doc-storage';
import { setContactNamesDispatch, applyContactNamesFromWorker } from './contact-names';

// Re-export for convenience
export { deepAssign };
export type { ValidationError };

// Functions that the worker provides its own copy of. Callers pass the real ref;
// updateDoc detects it by identity and sends a marker the worker substitutes.
const WORKER_FNS = new Map<unknown, string>([[deepAssign, 'deepAssign']]);

// ── Worker setup ────────────────────────────────────────────────────────────

const worker = new Worker(
  new URL('./automerge-worker.ts', import.meta.url),
  { type: 'module' },
);

// Log only diagnostically useful outgoing messages (skip routine traffic).
function logSend(msg: { type: string } & Record<string, any>): void {
  const quiet = msg.type === 'query'
    || msg.type === 'subscribe-query'
    || msg.type === 'unsubscribe-query'
    || msg.type === 'subscribe-presence'
    || msg.type === 'unsubscribe-presence'
    || msg.type === 'set-presence'
    || msg.type === 'subscribe-validation'
    || msg.type === 'unsubscribe-validation'
    || msg.type === 'open-doc'
    || msg.type === 'kh-get-my-access'
    || msg.type === 'add-doc-to-list'
    || msg.type === 'remove-me-from-doc'
    || msg.type === 'set-contact-name'
    || msg.type === 'remove-contact-name';
  if (!quiet) console.log('[main] → send', msg.type, msg);
}

// Wire up dispatch hooks (avoids circular imports with doc-storage / contact-names)
setDocListDispatch((msgType, docId, metadata) => {
  const msg = { type: msgType, docId, metadata };
  logSend(msg);
  worker.postMessage(msg);
});
setContactNamesDispatch((type, agentId, name) =>
  // Route through request() so the caller can await persistence and a failed write
  // rejects (rather than being a silent fire-and-forget that drops the data).
  request<void>(type, { agentId, ...(name !== undefined ? { name } : {}) })
);

// Clean up legacy localStorage key from when insecure mode existed
localStorage.removeItem('showUnencrypted');

const initMsg = {
  type: 'init' as const,
  appBaseUrl: window.location.origin + window.location.pathname,
};
console.log('[main] → send', initMsg.type, initMsg);
worker.postMessage(initMsg);

// ── Ready promises ──────────────────────────────────────────────────────────

let resolveRepoReady: () => void;
export const workerReady = new Promise<void>(r => { resolveRepoReady = r; });

let resolveKeyhiveReady!: () => void;
let rejectKeyhiveReady!: (err: Error) => void;
export const keyhiveReady = new Promise<void>((resolve, reject) => { resolveKeyhiveReady = resolve; rejectKeyhiveReady = reject; });
keyhiveReady.catch(() => {}); // prevent unhandled rejection — callers handle the error

// ── Worker peer ID ──────────────────────────────────────────────────────────

let _workerPeerId = '';
export function getWorkerPeerId(): string { return _workerPeerId; }

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

// ── Relay message log ──────────────────────────────────────────────────────

export interface RelayLogEntry {
  id: number;
  ts: number;
  dir: 'sent' | 'recv';
  message: any;
}

const MAX_RELAY_LOG = 500;
let relayLogEntries: RelayLogEntry[] = [];
type RelayLogListener = (entries: RelayLogEntry[]) => void;
const relayLogListeners = new Set<RelayLogListener>();

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
  });
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
  const quiet = msg.type === 'relay-log'
    || msg.type === 'result'
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

    // --- Doc storage / contact names ---
    case 'doc-list-updated':
      applyDocListFromWorker(msg.list as any);
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
    case 'relay-log': {
      if (relayLogEntries.length >= MAX_RELAY_LOG) {
        relayLogEntries = relayLogEntries.slice(-(MAX_RELAY_LOG - 1));
      }
      relayLogEntries = [...relayLogEntries, msg.entry];
      for (const fn of relayLogListeners) fn(relayLogEntries);
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

// ── Relay log hook ─────────────────────────────────────────────────────────

export function useRelayLog(): [RelayLogEntry[], () => void] {
  const [entries, setEntries] = useState<RelayLogEntry[]>(() => relayLogEntries);

  useEffect(() => {
    const listener: RelayLogListener = (e) => setEntries(e);
    relayLogListeners.add(listener);
    return () => { relayLogListeners.delete(listener); };
  }, []);

  const clear = useCallback(() => {
    relayLogEntries = [];
    for (const fn of relayLogListeners) fn([]);
  }, []);

  return [entries, clear];
}

// ── jq filter constants ─────────────────────────────────────────────────────

export const HOME_SUMMARY_QUERY =
  '{ type: .["@type"], name: (.name // ""), eventCount: (if .events then (.events | length) else 0 end), taskCount: (if .tasks then [.tasks[] | select(.progress != "completed" and .progress != "cancelled")] | length else 0 end), cellCount: (if .sheets then [.sheets[].cells // {} | length] | add else 0 end) }';

// ── Document mutations ──────────────────────────────────────────────────────

export function createDoc(initialJson: any): Promise<{ docId: string }> {
  return request<{ docId: string }>('create-doc', { initialJson });
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
  let workerResponded = false;

  subscriptionCallbacks.set(subId, (result, heads, lastModified) => {
    workerResponded = true;
    onResult(result, heads, lastModified);
  });
  fire('subscribe-query', { subId, docId, filter });

  // Fast path: read from IDB on main thread while worker may be blocked
  // parsing a large document's WASM binary.
  const cacheKey = `qc:${docId}:${hashStr(filter)}`;
  idbGet<QueryCacheEntry>(cacheKey).then(cached => {
    if (cached && !workerResponded && subscriptionCallbacks.has(subId)) {
      onResult(cached.result, cached.heads, cached.lastModified);
    }
  });

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
export function ensureUserGroup(opts?: { create?: boolean; adoptGroupId?: string; waitForSync?: boolean }): Promise<{ userGroupId: string | null }> {
  return khRequest('kh-ensure-user-group', { create: opts?.create, adoptGroupId: opts?.adoptGroupId, waitForSync: opts?.waitForSync });
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

/** Get all members, roles, and invite records for a document. */
export function getDocMembers(docId: string): Promise<{ members: MemberInfo[]; invites: InviteRecord[] }> {
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

/** Generate an invite link for a document. The worker builds the URL and stores the invite record. */
export function generateInvite(docId: string, role: string, docType: string): Promise<{ inviteKeyBytes: number[]; groupId: string; inviteSignerAgentId: string; inviteUrl: string }> {
  return khRequest('kh-generate-invite', { docId, role, docType });
}

/** Dismiss (delete) an invite record by ID. Returns the remaining invites for the doc. */
export function dismissInvite(inviteId: string, docId: string): Promise<{ invites: InviteRecord[] }> {
  return khRequest('kh-dismiss-invite', { inviteId, docId });
}

/** Claim an invite by syncing keys from the relay using the invite seed. */
export function claimInvite(inviteSeed: number[], docId: string): Promise<void> {
  return khRequest('kh-claim-invite', { inviteSeed, docId });
}

// ── HyperFormula worker port ─────────────────────────────────────────────────

/** Transfer a MessagePort to the automerge worker for direct HF worker communication. */
export function sendHfPort(port: MessagePort): void {
  workerReady.then(() => {
    worker.postMessage({ type: 'hf-port', port }, [port]);
  });
}
