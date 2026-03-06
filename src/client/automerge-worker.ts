export type MainToWorker =
  | { type: 'init'; wsUrl: string; port: MessagePort }
  | { type: 'set-ws-url'; wsUrl: string }
  | { type: 'query'; id: number; docId: string; filter: string }
  | { type: 'subscribe-presence'; docIds: string[] }
  | { type: 'unsubscribe-presence' };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'peer-connected'; peerCount: number }
  | { type: 'peer-disconnected'; peerCount: number }
  | { type: 'query-result'; id: number; result: any[]; error?: string }
  | { type: 'presence-update'; peers: Record<string, { docId: string; peerId: string }[]> };

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
let mcPeerId: string | null = null;

// Presence tracking
let presenceInstances: { cleanup: () => void }[] = [];
let presenceTimer: ReturnType<typeof setInterval> | null = null;

function postStatus() {
  // Count only non-MessageChannel peers (i.e. WebSocket server connections)
  const peers = repo ? repo.peers.filter(id => id !== mcPeerId) : [];
  const peerCount = peers.length;
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
        // Wait for the WebSocket peer to actually connect (not just initialize).
        // Without this, when the main thread requests a remote document, the
        // worker's DocSynchronizer only has the main-thread peer (status "wants")
        // and immediately marks the document unavailable.
        await new Promise<void>(resolve => {
          const onPeer = () => { resolve(); ns.off('peer', onPeer); };
          ns.on('peer', onPeer);
          setTimeout(() => { ns.off('peer', onPeer); resolve(); }, 5000);
        });
      }

      // Track the MessageChannel peer so postStatus can exclude it
      ns.on('peer', (p: any) => {
        if (!mcPeerId) mcPeerId = p?.peerId ?? p;
      });
      repo.networkSubsystem.addNetworkAdapter(mcAdapter);

      (self as any).postMessage({ type: 'ready' } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'error', message: err?.message || 'Worker init failed' } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'set-ws-url') {
    setupWebSocket(msg.wsUrl);
  }

  if (msg.type === 'subscribe-presence') {
    // Clean up any existing subscriptions
    for (const inst of presenceInstances) inst.cleanup();
    presenceInstances = [];
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }

    if (!repo) return;
    const { Presence } = await import('@automerge/automerge-repo');
    const docIds = msg.docIds;

    const peersByDoc: Record<string, { docId: string; peerId: string }[]> = {};
    for (const docId of docIds) peersByDoc[docId] = [];

    const broadcastUpdate = () => {
      (self as any).postMessage({ type: 'presence-update', peers: { ...peersByDoc } } satisfies WorkerToMain);
    };

    for (const docId of docIds) {
      const handle = repo.handles[docId as any] as any;
      if (!handle) continue;

      const presence = new Presence({ handle });
      presence.start({ initialState: { viewing: true }, heartbeatMs: 5000, peerTtlMs: 15000 });

      const update = () => {
        const states = presence.getPeerStates().getStates();
        peersByDoc[docId] = Object.entries(states)
          .filter(([, s]: [string, any]) => s?.state?.viewing)
          .map(([peerId]) => ({ docId, peerId }));
        broadcastUpdate();
      };

      presence.on('update', update);
      presence.on('goodbye', update);
      presence.on('pruning', update);
      presence.on('snapshot', update);

      presenceInstances.push({
        cleanup() { presence.stop(); },
      });
    }

    // Initial broadcast
    broadcastUpdate();
  }

  if (msg.type === 'unsubscribe-presence') {
    for (const inst of presenceInstances) inst.cleanup();
    presenceInstances = [];
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  }

  if (msg.type === 'query') {
    try {
      if (!repo) throw new Error('Repo not initialized');
      const { compile } = await import('../shared/jq');
      const handle = repo.handles[msg.docId as any] as any;
      if (!handle?.isReady?.()) {
        (self as any).postMessage({ type: 'query-result', id: msg.id, result: [], error: 'Document not found or not ready' } satisfies WorkerToMain);
        return;
      }
      const doc = handle.doc();
      const fn = compile(msg.filter);
      const result = fn(doc);
      (self as any).postMessage({ type: 'query-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'query-result', id: msg.id, result: [], error: err?.message || 'Query failed' } satisfies WorkerToMain);
    }
  }
}

// Replace queue handler with real handler and drain
self.onmessage = handleMessage;
for (const msg of pendingMessages) handleMessage(msg);
pendingMessages.length = 0;
