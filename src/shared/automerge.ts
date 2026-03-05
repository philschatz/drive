import { useState, useEffect, useRef } from 'preact/hooks';
import { Repo } from '@automerge/automerge-repo';
import { MessageChannelNetworkAdapter } from '@automerge/automerge-repo-network-messagechannel';
export * as Automerge from '@automerge/automerge';
export { Presence } from '@automerge/automerge-repo';
export type { DocHandle, DocumentId, PeerId } from '@automerge/automerge-repo';
export type { PeerState, PresenceState } from '@automerge/automerge-repo';
import type { WorkerToMain } from '../client/automerge-worker';

const REPO_WEBSOCKET_KEY = 'automerge-ws-url';

export function getWsUrl(): string {
  return localStorage.getItem(REPO_WEBSOCKET_KEY) ?? '';
}

// --- Worker setup ---

const worker = new Worker(
  new URL('../client/automerge-worker.ts', import.meta.url),
  { type: 'module' },
);

const channel = new MessageChannel();

// Main-thread repo: ephemeral, no storage, syncs with worker via MessageChannel
export const repo = new Repo({
  network: [new MessageChannelNetworkAdapter(channel.port1)],
  isEphemeral: true,
});

// Send the other port to the worker along with the websocket URL
worker.postMessage(
  { type: 'init', wsUrl: getWsUrl(), port: channel.port2 },
  [channel.port2],
);

export function setWsUrl(url: string) {
  const trimmed = url.trim();
  if (trimmed === '') {
    localStorage.removeItem(REPO_WEBSOCKET_KEY);
  } else {
    localStorage.setItem(REPO_WEBSOCKET_KEY, trimmed);
  }
  worker.postMessage({ type: 'set-ws-url', wsUrl: trimmed });
}

// --- Repo network ready promise (resolves when main-thread repo connects to worker peer) ---

let resolveRepoReady: () => void;
export const workerReady = new Promise<void>(r => { resolveRepoReady = r; });
const ns = repo.networkSubsystem;
ns.on('peer', (p: any) => {
  console.log('[repo] peer connected:', p?.peerId ?? p);
  console.log('[repo] total peers:', repo.peers);
  resolveRepoReady();
});
ns.on('peer-disconnected', (p: any) => {
  console.log('[repo] peer disconnected:', p?.peerId ?? p);
});
console.log('[repo] main-thread repo created, peerId:', repo.peerId);

/**
 * Load a document via findWithProgress, calling `onProgress(0-100)` as loading advances.
 * `onProgress` is called with `null` once the document is ready (caller should hide the bar).
 */
export async function findDocWithProgress<T>(
  docId: string,
  onProgress: (pct: number | null) => void,
): Promise<import('@automerge/automerge-repo').DocHandle<T>> {
  const short = docId.slice(0, 8);
  console.log(`[find] ${short} waiting for workerReady…`);
  await workerReady;
  console.log(`[find] ${short} workerReady resolved, calling repo.find()…`);
  try {
    const handle = await repo.find<T>(docId as any, { allowableStates: ['unavailable'] });
    console.log(`[find] ${short} find() resolved, state:`, (handle as any).state);
    if (!handle.isReady()) {
      console.log(`[find] ${short} waiting for whenReady()…`);
      await handle.whenReady();
      console.log(`[find] ${short} whenReady() resolved, state:`, (handle as any).state);
    }
    onProgress(null);
    return handle;
  } catch (err: any) {
    console.error(`[find] ${short} error:`, err?.message, err);
    throw err;
  }
}

// --- Connection status (listens to worker messages) ---

type ConnectionListener = (connected: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();
let workerPeerCount = 0;

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  console.log('[worker→main]', msg);
  if (msg.type === 'ready') {
    // Worker initialized — peer event on repo.networkSubsystem resolves workerReady
  } else if (msg.type === 'error') {
    console.error('Automerge worker error:', msg.message);
  } else if (msg.type === 'peer-connected' || msg.type === 'peer-disconnected') {
    workerPeerCount = msg.peerCount;
    const connected = workerPeerCount > 0;
    for (const fn of connectionListeners) fn(connected);
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
