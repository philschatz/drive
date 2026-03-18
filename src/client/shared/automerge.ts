import '@automerge/automerge-subduction'; // Initialize subduction WASM before Repo construction
import { useState, useEffect, useRef } from 'preact/hooks';
import { Repo } from '@automerge/automerge-repo';
import { MessageChannelNetworkAdapter } from '@automerge/automerge-repo-network-messagechannel';
export * as Automerge from '@automerge/automerge';
export { Presence } from '@automerge/automerge-repo';
export type { DocHandle, DocumentId, PeerId } from '@automerge/automerge-repo';
export type { PeerState, PresenceState } from '@automerge/automerge-repo';
import type { WorkerToMain } from '../automerge-worker';
import { initKeyhiveApi, handleKeyhiveResponse, getMyAccess, registerDocMapping } from './keyhive-api';
import { getDocEntry, getDocList } from '../doc-storage';

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

const channel = new MessageChannel();

// Main-thread repo: ephemeral, no storage, syncs with worker via MessageChannel.
// The subduction-tagged automerge-repo requires a subduction instance — provide a no-op stub.
const noopSubduction = {
  storage: {},
  removeSedimentree() {},
  connectDiscover() {},
  disconnectAll() {},
  disconnectFromPeer() {},
  syncAll() { return Promise.resolve({ entries() { return []; } }); },
  getBlobs() { return Promise.resolve([]); },
  addCommit() { return Promise.resolve(undefined); },
  addFragment() { return Promise.resolve(undefined); },
};
export const repo = new Repo({
  network: [new MessageChannelNetworkAdapter(channel.port1)],
  isEphemeral: true,
  subduction: noopSubduction,
} as any);

// Initialize keyhive API with worker reference
initKeyhiveApi(worker);

// Send the other port to the worker along with doc list
worker.postMessage(
  {
    type: 'init',
    docList: getDocList().map(e => ({ id: e.id, encrypted: e.encrypted })),
    port: channel.port2,
  },
  [channel.port2],
);

// --- Repo network ready promise ---
// Resolves either when the worker sends 'ready' OR when the MessageChannel peer connects.

let resolveRepoReady: () => void;
export const workerReady = new Promise<void>(r => { resolveRepoReady = r; });
const ns = repo.networkSubsystem;
ns.on('peer', (p: any) => { console.log('[automerge] workerReady: peer event, peerId=', p?.peerId ?? p); resolveRepoReady(); });

/** Access the underlying worker instance (used by worker-api.ts). */
export function _worker(): Worker { return worker; }

// Keyhive-specific ready promise — resolves when WASM + keyhive are fully initialized.
let resolveKeyhiveReady!: () => void;
export const keyhiveReady = new Promise<void>(r => { resolveKeyhiveReady = r; });

// --- Worker peer ID ---
// The actual peerId of the worker's primary repo (keyhive-derived or random).
// Set when the worker sends the 'ready' message.
let _workerPeerId = '';
export function getWorkerPeerId(): string { return _workerPeerId; }

// --- Read-only enforcement ---
// Documents where the current user has read-only access.
// handle.change() is blocked for these documents.
const readOnlyDocs = new Set<string>();

export function isDocReadOnly(docId: string): boolean {
  return readOnlyDocs.has(docId);
}

/** Mark a document as read-only and guard its handle against changes. */
export function markDocReadOnly(docId: string) {
  readOnlyDocs.add(docId);
  // Guard the existing handle if it's already loaded
  const handle = (repo as any).handles?.[docId];
  if (handle && !(handle as any).__readOnlyGuarded) {
    guardHandle(handle, docId);
  }
}

function guardHandle(handle: any, docId: string) {
  if (handle.__readOnlyGuarded) return;
  handle.__readOnlyGuarded = true;
  // Use defineProperty to intercept change() via the prototype chain.
  // handle.change may not exist yet (set lazily), so we install a getter
  // that wraps the original method on first access.
  let wrapped: ((...a: any[]) => any) | null = null;
  const proto = Object.getPrototypeOf(handle);
  Object.defineProperty(handle, 'change', {
    configurable: true,
    enumerable: true,
    get() {
      const orig = proto.change;
      if (!orig) return orig;
      if (!wrapped) {
        wrapped = (...args: any[]) => {
          if (readOnlyDocs.has(docId)) {
            console.log('!!!!!! oooh, you are being malicious because you only have read access. let us see what happens with the other peers')
          }
          return orig.apply(handle, args);
        };
      }
      return wrapped;
    },
    set() {
      // Ignore attempts to overwrite — keep our guard in place
    },
  });
}

// Wrap repo.find() so every handle gets a dynamic read-only guard
const origRepoFind = repo.find.bind(repo);
(repo as any).find = async (docId: any, ...rest: any[]) => {
  const handle = await origRepoFind(docId, ...rest);
  guardHandle(handle, String(docId));
  return handle;
};

/**
 * Load a document via findWithProgress, calling `onProgress(0-100)` as loading advances.
 * `onProgress` is called with `null` once the document is ready (caller should hide the bar).
 */
export async function findDocWithProgress<T>(
  docId: string,
  onProgress: (pct: number | null) => void,
): Promise<import('@automerge/automerge-repo').DocHandle<T>> {
  console.log('[automerge] findDocWithProgress: waiting for workerReady, docId=', docId);
  await workerReady;
  console.log('[automerge] findDocWithProgress: workerReady resolved, calling repo.find');
  const handle = await repo.find<T>(docId as any);
  console.log('[automerge] findDocWithProgress: repo.find resolved, handle state=', (handle as any).state);
  onProgress(null);

  // Check access level for keyhive-shared documents
  const entry = getDocEntry(docId);
  if (entry?.khDocId) {
    await keyhiveReady;
    const access = await getMyAccess(entry.khDocId);
    if (access && access.toLowerCase() !== 'admin' && access.toLowerCase() !== 'write') {
      console.log(`[automerge] Document ${docId} is read-only (access: ${access})`);
      readOnlyDocs.add(docId);
    }
  }

  return handle;
}

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
    // Resolve workerReady now — this will also be resolved by the MessageChannel peer event,
    // but resolving twice is a no-op. Resolving here ensures it works after MessageChannel removal.
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
