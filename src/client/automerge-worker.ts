import { Repo } from '@automerge/automerge-repo';
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb';
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { MessageChannelNetworkAdapter } from '@automerge/automerge-repo-network-messagechannel';

export type MainToWorker =
  | { type: 'init'; wsUrl: string; port: MessagePort }
  | { type: 'set-ws-url'; wsUrl: string };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'peer-connected'; peerCount: number }
  | { type: 'peer-disconnected'; peerCount: number };

let repo: Repo | null = null;
let wsAdapter: BrowserWebSocketClientAdapter | null = null;

function postStatus() {
  const peerCount = repo ? repo.peers.length : 0;
  (self as any).postMessage({ type: peerCount > 0 ? 'peer-connected' : 'peer-disconnected', peerCount } satisfies WorkerToMain);
}

function setupWebSocket(wsUrl: string) {
  if (wsAdapter) {
    wsAdapter.disconnect();
    wsAdapter = null;
  }
  if (!wsUrl || !repo) return;
  wsAdapter = new BrowserWebSocketClientAdapter(wsUrl);
  repo.networkSubsystem.addNetworkAdapter(wsAdapter);
}

self.onmessage = (e: MessageEvent<MainToWorker>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      const mcAdapter = new MessageChannelNetworkAdapter(msg.port);

      repo = new Repo({
        network: [mcAdapter],
        storage: new IndexedDBStorageAdapter(),
      });

      // Listen for peer events once on the networkSubsystem
      const ns = repo.networkSubsystem;
      ns.on('peer', postStatus);
      ns.on('peer-disconnected', postStatus);

      if (msg.wsUrl) {
        setupWebSocket(msg.wsUrl);
      }

      (self as any).postMessage({ type: 'ready' } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'error', message: err?.message || 'Worker init failed' } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'set-ws-url') {
    setupWebSocket(msg.wsUrl);
  }
};
