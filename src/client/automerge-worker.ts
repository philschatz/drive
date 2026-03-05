export type MainToWorker =
  | { type: 'init'; wsUrl: string; port: MessagePort }
  | { type: 'set-ws-url'; wsUrl: string };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'peer-connected'; peerCount: number }
  | { type: 'peer-disconnected'; peerCount: number };

// Queue messages that arrive while WASM is initializing
const pendingMessages: MessageEvent[] = [];
self.onmessage = (e: MessageEvent) => { pendingMessages.push(e); };

// Dynamic import so the queue handler above is registered BEFORE WASM top-level await runs
const { Repo } = await import('@automerge/automerge-repo');
const { IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb');
const { BrowserWebSocketClientAdapter } = await import('@automerge/automerge-repo-network-websocket');
const { MessageChannelNetworkAdapter } = await import('@automerge/automerge-repo-network-messagechannel');

let repo: InstanceType<typeof Repo> | null = null;
let wsAdapter: InstanceType<typeof BrowserWebSocketClientAdapter> | null = null;

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

async function handleMessage(e: MessageEvent<MainToWorker>) {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      const mcAdapter = new MessageChannelNetworkAdapter(msg.port);

      // Create repo with storage but WITHOUT the MessageChannel adapter.
      // This lets IndexedDB load all documents before the peer handshake,
      // preventing the worker from responding "doc-unavailable" for documents
      // that are still loading from storage.
      repo = new Repo({
        network: [],
        storage: new IndexedDBStorageAdapter(),
      });

      const ns = repo.networkSubsystem;
      ns.on('peer', postStatus);
      ns.on('peer-disconnected', postStatus);

      if (msg.wsUrl) {
        setupWebSocket(msg.wsUrl);
      }

      // Wait for storage to finish loading before connecting to main thread.
      // NetworkSubsystem.whenReady() resolves once initial network setup is done;
      // by that point IndexedDB has also had time to load stored documents.
      await repo.networkSubsystem.whenReady();

      // Now add the MessageChannel adapter — the peer handshake will happen
      // after all stored documents are available.
      repo.networkSubsystem.addNetworkAdapter(mcAdapter);

      (self as any).postMessage({ type: 'ready' } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'error', message: err?.message || 'Worker init failed' } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'set-ws-url') {
    setupWebSocket(msg.wsUrl);
  }
}

// Replace queue handler with real handler and drain
self.onmessage = handleMessage;
for (const msg of pendingMessages) handleMessage(msg);
pendingMessages.length = 0;
