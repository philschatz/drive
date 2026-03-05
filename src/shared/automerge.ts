import { useState, useEffect, useRef } from 'preact/hooks';
import { Repo } from '@automerge/automerge-repo';
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb';
export * as Automerge from '@automerge/automerge';
export { Presence } from '@automerge/automerge-repo';
export type { DocHandle, DocumentId, PeerId } from '@automerge/automerge-repo';
export type { PeerState, PresenceState } from '@automerge/automerge-repo';

const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${location.host}`;

const PUBLIC_WS_KEY = 'amcal-public-ws-url';

export function getPublicWsUrl(): string {
  return localStorage.getItem(PUBLIC_WS_KEY) ?? '';
}

export function setPublicWsUrl(url: string) {
  const trimmed = url.trim();
  if (trimmed === '') {
    localStorage.removeItem(PUBLIC_WS_KEY);
  } else {
    localStorage.setItem(PUBLIC_WS_KEY, trimmed);
  }
}

const publicWsUrl = getPublicWsUrl();

const network = [new BrowserWebSocketClientAdapter(wsUrl)];
if (publicWsUrl) {
  network.push(new BrowserWebSocketClientAdapter(publicWsUrl));
}

export const repo = new Repo({
  network,
  storage: new IndexedDBStorageAdapter(),
});

/**
 * Load a document via findWithProgress, calling `onProgress(0-100)` as loading advances.
 * `onProgress` is called with `null` once the document is ready (caller should hide the bar).
 */
export async function findDocWithProgress<T>(
  docId: string,
  onProgress: (pct: number | null) => void,
): Promise<import('@automerge/automerge-repo').DocHandle<T>> {
  const progress = repo.findWithProgress<T>(docId as any);
  if ('subscribe' in progress) {
    if (progress.state === 'loading') onProgress(progress.progress ?? 0);
    return new Promise((resolve, reject) => {
      const unsub = progress.subscribe((p) => {
        if (p.state === 'loading') {
          onProgress(p.progress ?? 0);
        } else if (p.state === 'ready') {
          unsub();
          onProgress(null);
          resolve(p.handle);
        } else if (p.state === 'failed') {
          unsub();
          onProgress(null);
          reject((p as any).error ?? new Error('Load failed'));
        } else {
          unsub();
          onProgress(null);
          reject(new Error(`Document ${p.state}`));
        }
      });
    });
  } else {
    onProgress(null);
    if (progress.state === 'ready') return progress.handle;
    if (progress.state === 'failed') throw (progress as any).error ?? new Error('Load failed');
    throw new Error(`Document ${progress.state}`);
  }
}

/**
 * Returns true when the repo has at least one connected peer (i.e. the server).
 * Disconnection is debounced by 6 s (> the 5 s retry interval in the WS adapter)
 * so brief disconnect/reconnect cycles don't flash the indicator red.
 */
export function useConnectionStatus(): boolean {
  const [connected, setConnected] = useState(() => repo.peers.length > 0);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ns = repo.networkSubsystem;
    const onPeer = () => {
      if (disconnectTimer.current !== null) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
      setConnected(true);
    };
    const onDisconnect = () => {
      if (disconnectTimer.current !== null) return;
      disconnectTimer.current = setTimeout(() => {
        disconnectTimer.current = null;
        setConnected(repo.peers.length > 0);
      }, 6000);
    };
    ns.on('peer', onPeer);
    ns.on('peer-disconnected', onDisconnect);
    return () => {
      ns.off('peer', onPeer);
      ns.off('peer-disconnected', onDisconnect);
      if (disconnectTimer.current !== null) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
    };
  }, []);

  return connected;
}
