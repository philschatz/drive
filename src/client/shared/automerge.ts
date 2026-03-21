import { useState, useEffect, useRef } from 'preact/hooks';
export type { Presence } from '@automerge/automerge-repo';
export type { DocHandle, DocumentId, PeerId } from '@automerge/automerge-repo';
export type { PeerState, PresenceState } from '@automerge/automerge-repo';
import type { WorkerToMain } from '../automerge-worker';
import { initKeyhiveApi, handleKeyhiveResponse, registerDocMapping } from './keyhive-api';
import { getDocEntry, getDocList, setDocListDispatch, applyDocListFromWorker } from '../doc-storage';
import { setContactNamesDispatch, applyContactNamesFromWorker } from '../contact-names';


// --- Worker setup ---

/** Extra message handlers registered at import time by worker-api.ts and other modules. */
const extraMessageHandlers: Array<(msg: any) => boolean> = [];

/** Register a handler that is called for every worker message. Return true if handled. */
export function registerWorkerMessageHandler(fn: (msg: any) => boolean): void {
  extraMessageHandlers.push(fn);
}

const worker = new Worker(
  new URL('../automerge-worker.ts', import.meta.url),
  { type: 'module' },
);

// Initialize keyhive API with worker reference
initKeyhiveApi(worker);

// --- Wire up dispatch hooks (avoids circular imports) ---
setDocListDispatch((type, docId, metadata) => {
  worker.postMessage({ type, docId, ...metadata });
});
setContactNamesDispatch((type, agentId, name) => {
  worker.postMessage({ type, agentId, ...(name !== undefined ? { name } : {}) });
});

worker.postMessage({
  type: 'init',
  appBaseUrl: window.location.origin + window.location.pathname,
});

// --- Worker ready promise ---
// Resolves when the worker sends the 'ready' message after repo initialization.

let resolveRepoReady: () => void;
export const workerReady = new Promise<void>(r => { resolveRepoReady = r; });

/** Access the underlying worker instance (used by worker-api.ts). */
export function _worker(): Worker { return worker; }

// Keyhive-specific ready promise — resolves when WASM + keyhive are fully initialized.
let resolveKeyhiveReady!: () => void;
let rejectKeyhiveReady!: (err: Error) => void;
export const keyhiveReady = new Promise<void>((resolve, reject) => { resolveKeyhiveReady = resolve; rejectKeyhiveReady = reject; });
keyhiveReady.catch(() => {}); // prevent unhandled rejection — callers handle the error

// --- Worker peer ID ---
// The actual peerId of the worker's primary repo (keyhive-derived or random).
// Set when the worker sends the 'ready' message.
let _workerPeerId = '';
export function getWorkerPeerId(): string { return _workerPeerId; }

// --- Connection status (listens to worker messages) ---

type ConnectionListener = (connected: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();
let workerPeerCount = 0;
let workerPeers: string[] = [];

// Per-repo WebSocket connection state (independent of peers)
type WsStatusListener = (repo: 'secure' | 'insecure', connected: boolean) => void;
const wsStatusListeners = new Set<WsStatusListener>();
let wsSecureConnected = false;
let wsInsecureConnected = false;

type PeerListListener = (peers: string[]) => void;
const peerListListeners = new Set<PeerListListener>();

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    _workerPeerId = msg.peerId;
    resolveRepoReady();
  } else if (msg.type === 'kh-ready') {
    // Register all known automerge→keyhive doc mappings so the docMap is populated
    // before any sync messages arrive (EditorTitleBar also registers on mount, but
    // that's too late for docs syncing in the background).
    for (const entry of getDocList()) {
      if (entry.khDocId) {
        registerDocMapping(entry.id, entry.khDocId);
      }
    }
    resolveKeyhiveReady();
  } else if (msg.type === 'kh-error') {
    console.error('Keyhive init failed:', msg.message);
    rejectKeyhiveReady(new Error(msg.message));
  } else if (msg.type === 'error') {
    console.error('Automerge worker error:', msg.message);
  } else if (msg.type === 'peer-connected' || msg.type === 'peer-disconnected') {
    workerPeerCount = msg.peerCount;
    workerPeers = msg.peers;
    const connected = workerPeerCount > 0;
    for (const fn of connectionListeners) fn(connected);
    for (const fn of peerListListeners) fn(workerPeers);
  } else if (msg.type === 'ws-status') {
    if (msg.repo === 'secure') wsSecureConnected = msg.connected;
    else wsInsecureConnected = msg.connected;
    for (const fn of wsStatusListeners) fn(msg.repo, msg.connected);
  } else if (msg.type === 'doc-list-updated') {
    applyDocListFromWorker(msg.list as any);
  } else if (msg.type === 'contact-names-updated') {
    applyContactNamesFromWorker(msg.names);
  } else if (msg.type === 'kh-result') {
    handleKeyhiveResponse(msg);
  } else {
    // Route to registered handlers (worker-api.ts etc.)
    for (const handler of extraMessageHandlers) {
      if (handler(msg)) break;
    }
  }
};

worker.onerror = (e) => {
  console.error('Automerge worker failed to load:', e.message);
};

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
export function useWsStatus(docId: string | undefined): boolean {
  const encrypted = docId ? getDocEntry(docId)?.encrypted : undefined;
  const [connected, setConnected] = useState(() => encrypted ? wsSecureConnected : wsInsecureConnected);

  useEffect(() => {
    const listener: WsStatusListener = (repo, isConnected) => {
      const relevant = encrypted ? repo === 'secure' : repo === 'insecure';
      if (relevant) setConnected(isConnected);
    };
    wsStatusListeners.add(listener);
    return () => { wsStatusListeners.delete(listener); };
  }, [encrypted]);

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
