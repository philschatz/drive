import { useState, useEffect, useRef } from 'preact/hooks';
import { Repo } from '@automerge/automerge-repo';
import { MessageChannelNetworkAdapter } from '@automerge/automerge-repo-network-messagechannel';
export * as Automerge from '@automerge/automerge';
export { Presence } from '@automerge/automerge-repo';
export type { DocHandle, DocumentId, PeerId } from '@automerge/automerge-repo';
export type { PeerState, PresenceState } from '@automerge/automerge-repo';
import type { WorkerToMain } from '../client/automerge-worker';

const SYNC_DISABLED_KEY = 'automerge-sync-disabled';

function defaultWsUrl(): string {
  if (typeof location === 'undefined') return '';
  return location.protocol === 'http:'
    ? `ws://${location.host}`
    : 'wss://sync.automerge.org';
}

export function isSyncEnabled(): boolean {
  return localStorage.getItem(SYNC_DISABLED_KEY) !== '1';
}

export function getWsUrl(): string {
  if (!isSyncEnabled()) return '';
  return defaultWsUrl();
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

export function setSyncEnabled(enabled: boolean) {
  if (enabled) {
    localStorage.removeItem(SYNC_DISABLED_KEY);
  } else {
    localStorage.setItem(SYNC_DISABLED_KEY, '1');
  }
  worker.postMessage({ type: 'set-ws-url', wsUrl: enabled ? defaultWsUrl() : '' });
}

// --- Repo network ready promise (resolves when main-thread repo connects to worker peer) ---

let resolveRepoReady: () => void;
export const workerReady = new Promise<void>(r => { resolveRepoReady = r; });
const ns = repo.networkSubsystem;
ns.on('peer', () => { resolveRepoReady(); });

/**
 * Load a document via findWithProgress, calling `onProgress(0-100)` as loading advances.
 * `onProgress` is called with `null` once the document is ready (caller should hide the bar).
 */
export async function findDocWithProgress<T>(
  docId: string,
  onProgress: (pct: number | null) => void,
): Promise<import('@automerge/automerge-repo').DocHandle<T>> {
  await workerReady;
  const handle = await repo.find<T>(docId as any);
  onProgress(null);
  return handle;
}

// --- Worker query API ---

let queryIdCounter = 0;
const pendingQueries = new Map<number, { resolve: (result: any[]) => void; reject: (err: Error) => void }>();

/**
 * Run a jq filter against a document in the worker without loading it into main-thread memory.
 */
export async function queryDoc(docId: string, filter: string): Promise<any[]> {
  await workerReady;
  const id = ++queryIdCounter;
  return new Promise((resolve, reject) => {
    pendingQueries.set(id, { resolve, reject });
    worker.postMessage({ type: 'query', id, docId, filter });
  });
}

// --- Home doc summary subscription ---

import type { DocSummary } from '../client/automerge-worker';
export type { DocSummary };

type HomeSummaryCallback = (summary: DocSummary) => void;
let homeSummaryCallback: HomeSummaryCallback | null = null;

export function subscribeHome(
  docIds: string[],
  callback: HomeSummaryCallback,
): () => void {
  homeSummaryCallback = callback;
  worker.postMessage({ type: 'subscribe-home', docIds });
  return () => {
    homeSummaryCallback = null;
    worker.postMessage({ type: 'unsubscribe-home' });
  };
}

// --- Connection status (listens to worker messages) ---

type ConnectionListener = (connected: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();
let workerPeerCount = 0;
let workerPeers: string[] = [];

type PeerListListener = (peers: string[]) => void;
const peerListListeners = new Set<PeerListListener>();

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    // Worker initialized — peer event on repo.networkSubsystem resolves workerReady
  } else if (msg.type === 'error') {
    console.error('Automerge worker error:', msg.message);
  } else if (msg.type === 'peer-connected' || msg.type === 'peer-disconnected') {
    workerPeerCount = msg.peerCount;
    workerPeers = msg.peers;
    const connected = workerPeerCount > 0;
    for (const fn of connectionListeners) fn(connected);
    for (const fn of peerListListeners) fn(workerPeers);
  } else if (msg.type === 'doc-summary') {
    if (homeSummaryCallback) homeSummaryCallback(msg.summary);
  } else if (msg.type === 'query-result') {
    const pending = pendingQueries.get(msg.id);
    if (pending) {
      pendingQueries.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
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

export function usePeerList(): string[] {
  const [peers, setPeers] = useState(() => workerPeers);

  useEffect(() => {
    const listener: PeerListListener = (p) => setPeers(p);
    peerListListeners.add(listener);
    return () => { peerListListeners.delete(listener); };
  }, []);

  return peers;
}
