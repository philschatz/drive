export type DocSummary = {
  docId: string;
  type: string;
  name: string;
  count: number;
  lastModified: string | null;
  peers: string[];
};

export type MainToWorker =
  | { type: 'init'; wsUrl: string; port: MessagePort }
  | { type: 'set-ws-url'; wsUrl: string }
  | { type: 'query'; id: number; docId: string; filter: string }
  | { type: 'subscribe-home'; docIds: string[] }
  | { type: 'unsubscribe-home' }
  // Keyhive operations
  | { type: 'kh-get-identity'; id: number }
  | { type: 'kh-get-contact-card'; id: number }
  | { type: 'kh-receive-contact-card'; id: number; cardJson: string }
  | { type: 'kh-get-doc-members'; id: number; khDocId: string }
  | { type: 'kh-get-my-access'; id: number; khDocId: string }
  | { type: 'kh-add-member'; id: number; agentId: string; docId: string; role: string }
  | { type: 'kh-revoke-member'; id: number; agentId: string; docId: string }
  | { type: 'kh-change-role'; id: number; agentId: string; docId: string; newRole: string }
  | { type: 'kh-generate-invite'; id: number; docId: string; groupId: string; role: string }
  | { type: 'kh-list-devices'; id: number }
  | { type: 'kh-enable-sharing'; id: number; automergeDocId: string }
  | { type: 'kh-register-doc-mapping'; automergeDocId: string; khDocId: string }
  | { type: 'kh-register-sharing-group'; id: number; khDocId: string; groupId: string }
  | { type: 'kh-claim-invite'; id: number; inviteSeed: number[]; archiveBytes: number[]; automergeDocId: string };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'kh-ready' }
  | { type: 'error'; message: string }
  | { type: 'peer-connected'; peerCount: number; peers: string[] }
  | { type: 'peer-disconnected'; peerCount: number; peers: string[] }
  | { type: 'query-result'; id: number; result: any[]; error?: string }
  | { type: 'doc-summary'; summary: DocSummary }
  // Keyhive responses
  | { type: 'kh-result'; id: number; result?: any; error?: string };

// Queue messages that arrive while WASM is initializing
const pendingMessages: MessageEvent[] = [];
self.onmessage = (e: MessageEvent) => { pendingMessages.push(e); };

// Dynamic import so the queue handler above is registered BEFORE WASM top-level await runs
let Repo: any, IndexedDBStorageAdapter: any, MessageChannelNetworkAdapter: any, Automerge: any;
let BrowserWebSocketClientAdapter: any;
let toDocumentId: (sedimentreeId: any) => string;
let khBridge: typeof import('../lib/automerge-repo-keyhive/index') | null = null;
try {
  console.log('[worker] importing modules...');
  const repoModule: any = await import('@automerge/automerge-repo');
  Repo = repoModule.Repo;
  toDocumentId = repoModule.toDocumentId;
  console.log('[worker] Repo imported');
  ({ IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb'));
  ({ MessageChannelNetworkAdapter } = await import('@automerge/automerge-repo-network-messagechannel'));
  ({ BrowserWebSocketClientAdapter } = await import('@automerge/automerge-repo-network-websocket'));
  Automerge = await import('@automerge/automerge');
  console.log('[worker] importing keyhive bridge...');
  khBridge = await import('../lib/automerge-repo-keyhive/index');
  console.log('[worker] keyhive bridge imported, calling initKeyhiveWasm');
  khBridge.initKeyhiveWasm();
  console.log('[worker] initKeyhiveWasm done');
} catch (err: any) {
  console.error('[worker] Failed to load modules:', err);
  (self as any).postMessage({ type: 'error', message: `Module load failed: ${errMsg(err)}` });
  throw err;
}

function errMsg(err: any): string {
  if (!err) return 'Unknown error';
  if (typeof err.message === 'function') return err.message();
  return err.message || String(err);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let repo: InstanceType<typeof Repo> | null = null;
let khIntegration: InstanceType<typeof khBridge.AutomergeRepoKeyhive> | null = null;
// Maps khDocId (base64) → keyhive Document object (needed for addMember's other_relevant_docs).
const khDocuments = new Map<string, any>();
let mcPeerId: string | null = null;

function postStatus() {
  // Count only non-MessageChannel peers (i.e. WebSocket server connections)
  const peers = repo ? repo.peers.filter((id: string) => id !== mcPeerId) : [];
  const peerCount = peers.length;
  (self as any).postMessage({ type: peerCount > 0 ? 'peer-connected' : 'peer-disconnected', peerCount, peers } satisfies WorkerToMain);
}

// --- Home subscription: push doc summaries on change ---

let homeCleanups: (() => void)[] = [];

function docSummary(docId: string, doc: any, peerIds: string[]): DocSummary {
  const type = doc?.['@type'] || 'unknown';
  const name = doc?.name || '';
  let count = 0;
  if (type === 'Calendar') {
    count = doc?.events ? Object.keys(doc.events).length : 0;
  } else if (type === 'TaskList') {
    count = doc?.tasks ? Object.keys(doc.tasks).length : 0;
  } else if (type === 'DataGrid') {
    if (doc?.sheets) {
      for (const k of Object.keys(doc.sheets)) {
        const sheet = doc.sheets[k];
        if (sheet?.cells) count += Object.keys(sheet.cells).length;
      }
    } else if (doc?.cells) {
      count = Object.keys(doc.cells).length;
    }
  }
  let lastModified: string | null = null;
  try {
    const meta = Automerge.getChangesMetaSince(doc, []);
    let maxTime = 0;
    for (const m of meta) {
      if (m.time > maxTime) maxTime = m.time;
    }
    if (maxTime > 0) {
      lastModified = new Date(maxTime * 1000).toISOString();
    }
  } catch { /* fall back to null */ }
  return { docId, type, name, count, lastModified, peers: peerIds };
}

function cleanupHome() {
  for (const fn of homeCleanups) fn();
  homeCleanups = [];
}

async function setupHomeSubscription(docIds: string[]) {
  cleanupHome();
  if (!repo) return;

  const { Presence } = await import('@automerge/automerge-repo');

  for (const docId of docIds) {
    let handle = repo.handles[docId as any] as any;
    if (!handle) {
      try {
        handle = await Promise.race([
          repo.find(docId as any),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
      } catch {
        continue;
      }
    }
    if (!handle?.doc?.()) continue;

    const presence = new Presence({ handle });
    presence.start({ initialState: { viewing: true }, heartbeatMs: 5000, peerTtlMs: 15000 });

    const getPeerIds = (): string[] => {
      const states = presence.getPeerStates().value;
      return Object.entries(states)
        .filter(([, s]: [string, any]) => s?.value?.viewing)
        .map(([peerId]) => peerId);
    };

    const sendSummary = () => {
      const doc = handle.doc();
      if (!doc) return;
      (self as any).postMessage({ type: 'doc-summary', summary: docSummary(docId, doc, getPeerIds()) } satisfies WorkerToMain);
    };

    sendSummary();
    const onChange = () => sendSummary();
    handle.on('change', onChange);
    presence.on('update', sendSummary);
    presence.on('goodbye', sendSummary);
    presence.on('snapshot', sendSummary);

    homeCleanups.push(() => {
      handle.off('change', onChange);
      presence.stop();
    });
  }
}

// --- Helper: save keyhive state after mutations ---

async function persistKeyhive() {
  if (khIntegration) {
    await khIntegration.keyhiveStorage.saveKeyhiveWithHash(khIntegration.keyhive);
  }
}

// Trigger keyhive event sync after mutations (delegations, revocations, etc.)
function triggerKeyhiveSync() {
  if (khIntegration) {
    khIntegration.networkAdapter.syncKeyhive();
  }
}

// ---

async function handleMessage(e: MessageEvent<MainToWorker>) {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      console.log('[worker] init message received');
      if (!khBridge) throw new Error('Keyhive bridge not loaded');

      const mcAdapter = new MessageChannelNetworkAdapter(msg.port);
      const storageAdapter = new IndexedDBStorageAdapter();

      // Create a base WebSocket adapter (if sync URL is provided)
      const wsAdapter = msg.wsUrl
        ? new BrowserWebSocketClientAdapter(msg.wsUrl)
        : new BrowserWebSocketClientAdapter('ws://localhost:1'); // dummy, won't connect

      // Initialize keyhive + keyhive-aware network adapter
      khIntegration = await khBridge.initializeAutomergeRepoKeyhive({
        storage: storageAdapter,
        peerIdSuffix: 'drive',
        networkAdapter: wsAdapter,
        onlyShareWithHardcodedServerPeerId: false,
        periodicallyRequestSync: true,
        automaticArchiveIngestion: true,
        cacheHashes: false,
        syncRequestInterval: 2000,
      });

      // Create repo with keyhive-signed network + plain storage.
      // The subduction-tagged automerge-repo requires a subduction instance.
      // getBlobs() bridges the subduction load path to the IndexedDB storageSubsystem,
      // so repo.find() can load documents from local storage on the subscribe path.
      const noopSubduction = {
        storage: {},
        removeSedimentree() {},
        connectDiscover() {},
        disconnectAll() {},
        disconnectFromPeer() {},
        syncAll() { return Promise.resolve({ entries() { return []; } }); },
        getBlobs(sedimentreeId: any) {
          if (!repo?.storageSubsystem) return Promise.resolve([]);
          try {
            const docId = toDocumentId(sedimentreeId);
            return repo.storageSubsystem.loadDocData(docId)
              .then((data: Uint8Array | null) => data ? [data] : []);
          } catch {
            return Promise.resolve([]);
          }
        },
        addCommit() { return Promise.resolve(undefined); },
        addFragment() { return Promise.resolve(undefined); },
      };
      repo = new Repo({
        network: [khIntegration.networkAdapter],
        storage: storageAdapter,
        subduction: noopSubduction,
        peerId: khIntegration.peerId,
      } as any);

      khIntegration.linkRepo(repo);

      const ns = repo.networkSubsystem;
      ns.on('peer', postStatus);
      ns.on('peer-disconnected', postStatus);

      // Track the MessageChannel peer so postStatus can exclude it
      ns.on('peer', (p: any) => {
        const pid = p?.peerId ?? p;
        console.log('[worker] repo peer connected:', pid);
        if (!mcPeerId) mcPeerId = pid;
      });
      console.log('[worker] adding MessageChannel adapter');
      repo.networkSubsystem.addNetworkAdapter(mcAdapter);

      console.log('[worker] init complete, peerId:', khIntegration.peerId);
      (self as any).postMessage({ type: 'kh-ready' } satisfies WorkerToMain);
      (self as any).postMessage({ type: 'ready' } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[worker] init failed:', err);
      (self as any).postMessage({ type: 'error', message: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'set-ws-url') {
    // Reconnect WebSocket with new URL
    if (!repo || !khIntegration || !msg.wsUrl) return;
    const newWsAdapter = new BrowserWebSocketClientAdapter(msg.wsUrl);
    const newKhAdapter = khIntegration.createKeyhiveNetworkAdapter(
      newWsAdapter, false, true, 2000,
    );
    repo.networkSubsystem.addNetworkAdapter(newKhAdapter);
  }

  if (msg.type === 'subscribe-home') {
    await setupHomeSubscription(msg.docIds);
  }

  if (msg.type === 'unsubscribe-home') {
    cleanupHome();
  }

  // --- Keyhive operations ---

  if (msg.type === 'kh-get-identity') {
    try {
      if (!khIntegration) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { deviceId: kh.idString } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-contact-card') {
    try {
      if (!khIntegration) throw new Error('Keyhive not available');
      const card = await khIntegration.keyhive.contactCard();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: card.toJson() } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-receive-contact-card') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const card = khBridge.ContactCard.fromJson(msg.cardJson);
      const individual = await khIntegration.keyhive.receiveContactCard(card);
      await persistKeyhive();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { agentId: individual.id.toString() } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-doc-members') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const docId = new khBridge.DocumentId(base64ToBytes(msg.khDocId));
      const members = await khIntegration.keyhive.docMemberCapabilities(docId);
      const me = await khIntegration.keyhive.individual;
      const myAgentStr = me.toAgent().toString();
      const result = members.map((m: any) => ({
        agentId: m.who.toString(),
        role: m.can.toString(),
        isIndividual: m.who.isIndividual(),
        isGroup: m.who.isGroup(),
        isMe: m.who.toString() === myAgentStr,
      }));
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-my-access') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const docId = new khBridge.DocumentId(base64ToBytes(msg.khDocId));
      const id = new khBridge.Identifier(khIntegration.keyhive.id.bytes);
      const access = await khIntegration.keyhive.accessForDoc(id, docId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: access ? access.toString() : null } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-list-devices') {
    try {
      if (!khIntegration) throw new Error('Keyhive not available');
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: [] } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-register-doc-mapping') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const khDocId = new khBridge.DocumentId(base64ToBytes(msg.khDocId));
      khIntegration.networkAdapter.registerDoc(msg.automergeDocId, khDocId);
      console.log('[kh-register-doc-mapping] registered', msg.automergeDocId, '→', msg.khDocId);
    } catch (err: any) {
      console.warn('[kh-register-doc-mapping] failed:', errMsg(err));
    }
  }

  if (msg.type === 'kh-enable-sharing') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      const ref = new khBridge.ChangeId(new Uint8Array(32));
      const doc = await kh.generateDocument([], ref, []);
      const khDocId = bytesToBase64(doc.id.toBytes());
      khDocuments.set(khDocId, doc);
      // Register the automerge→keyhive doc mapping for access enforcement
      khIntegration.networkAdapter.registerDoc(msg.automergeDocId, doc.doc_id);
      await persistKeyhive();
      triggerKeyhiveSync();
      console.log('[kh-enable-sharing] doc created, khDocId:', khDocId, 'automergeDocId:', msg.automergeDocId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { khDocId, groupId: '' } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-generate-invite') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      const doc = khDocuments.get(msg.docId);
      if (!doc) throw new Error('Document not found. Re-enable sharing.');
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const inviteSigner = khBridge.Signer.memorySignerFromBytes(seed);
      const store = khBridge.CiphertextStore.newInMemory();
      const tempKh = await khBridge.Keyhive.init(inviteSigner, store, () => {});
      const inviteCard = await tempKh.contactCard();
      const inviteIndividual = await kh.receiveContactCard(inviteCard);
      const inviteAgent = inviteIndividual.toAgent();
      const access = khBridge.Access.tryFromString(msg.role);
      if (!access) throw new Error(`Invalid role: ${msg.role}`);
      await kh.addMember(inviteAgent, doc.toMembered(), access, []);
      const archive = await kh.toArchive();
      const archiveBytes = Array.from(archive.toBytes());
      await persistKeyhive();
      triggerKeyhiveSync();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { inviteKeyBytes: Array.from(seed), archiveBytes, groupId: '' } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-add-member') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      const doc = khDocuments.get(msg.docId);
      if (!doc) throw new Error('Document not found');
      const agentId = new khBridge.Identifier(base64ToBytes(msg.agentId));
      const individual = await kh.getIndividual(agentId as any);
      if (!individual) throw new Error('Unknown agent');
      const access = khBridge.Access.tryFromString(msg.role);
      if (!access) throw new Error(`Invalid role: ${msg.role}`);
      await kh.addMember(individual.toAgent(), doc.toMembered(), access, []);
      await persistKeyhive();
      triggerKeyhiveSync();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: true } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-revoke-member') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      const doc = khDocuments.get(msg.docId);
      if (!doc) throw new Error('Document not found');
      const agentId = new khBridge.Identifier(base64ToBytes(msg.agentId));
      const individual = await kh.getIndividual(agentId as any);
      if (!individual) throw new Error('Unknown agent');
      await kh.revokeMember(individual.toAgent(), true, doc.toMembered());
      await persistKeyhive();
      triggerKeyhiveSync();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: true } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-change-role') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      const doc = khDocuments.get(msg.docId);
      if (!doc) throw new Error('Document not found');
      const agentId = new khBridge.Identifier(base64ToBytes(msg.agentId));
      const individual = await kh.getIndividual(agentId as any);
      if (!individual) throw new Error('Unknown agent');
      const agent = individual.toAgent();
      await kh.revokeMember(agent, true, doc.toMembered());
      const access = khBridge.Access.tryFromString(msg.newRole);
      if (!access) throw new Error(`Invalid role: ${msg.newRole}`);
      await kh.addMember(agent, doc.toMembered(), access, []);
      await persistKeyhive();
      triggerKeyhiveSync();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: true } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-register-sharing-group') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      // Restore the keyhive Document object into our in-memory map after reload.
      if (!khDocuments.has(msg.khDocId)) {
        const docId = new khBridge.DocumentId(base64ToBytes(msg.khDocId));
        const doc = await kh.getDocument(docId);
        if (doc) {
          khDocuments.set(msg.khDocId, doc);
        }
      }
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: true } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-claim-invite') {
    try {
      if (!khIntegration || !khBridge) throw new Error('Keyhive not available');
      const kh = khIntegration.keyhive;
      const inviteSeed = new Uint8Array(msg.inviteSeed);
      const inviteSigner = khBridge.Signer.memorySignerFromBytes(inviteSeed);
      const tempStore = khBridge.CiphertextStore.newInMemory();
      // Use tryToKeyhive (not init + ingestArchive) to preserve CGKA state
      const inviterArchive = new khBridge.Archive(new Uint8Array(msg.archiveBytes));
      const inviteKh = await inviterArchive.tryToKeyhive(tempStore, inviteSigner, () => {});
      const ourCard = await kh.contactCard();
      const ourIndividualInInviteKh = await inviteKh.receiveContactCard(ourCard);
      const ourAgentInInviteKh = ourIndividualInInviteKh.toAgent();
      const reachable = await inviteKh.reachableDocs();
      if (reachable.length === 0) throw new Error('Invite has no document access');
      const docSummaryItem = reachable[0];
      const inviteDoc = docSummaryItem.doc;
      const inviteAccess = docSummaryItem.access;
      await inviteKh.addMember(ourAgentInInviteKh, inviteDoc.toMembered(), inviteAccess, []);
      const inviteArchiveOut = await inviteKh.toArchive();
      await kh.ingestArchive(inviteArchiveOut);
      const khDocId = bytesToBase64(inviteDoc.id.toBytes());
      const docFromOurKh = await kh.getDocument(inviteDoc.doc_id);
      if (docFromOurKh) {
        khDocuments.set(khDocId, docFromOurKh);
      }
      // Register the automerge→keyhive doc mapping for access enforcement
      if (msg.automergeDocId) {
        khIntegration.networkAdapter.registerDoc(msg.automergeDocId, inviteDoc.doc_id);
      }
      await persistKeyhive();
      triggerKeyhiveSync();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { khDocId } } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[kh-claim-invite] failed:', err);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'query') {
    try {
      if (!repo) throw new Error('Repo not initialized');
      const { compile } = await import('../shared/jq');
      const handle = repo.handles[msg.docId as any] as any;
      if (!handle) {
        const h = repo.find(msg.docId as any);
        const ready = await Promise.race([
          h.then((h: any) => h.doc() ? h : null),
          new Promise(r => setTimeout(() => r(null), 3000)),
        ]) as any;
        if (!ready?.doc()) {
          (self as any).postMessage({ type: 'query-result', id: msg.id, result: [], error: 'Document not found' } satisfies WorkerToMain);
          return;
        }
        const fn = compile(msg.filter);
        const result = fn(ready.doc());
        (self as any).postMessage({ type: 'query-result', id: msg.id, result } satisfies WorkerToMain);
        return;
      }
      const doc = handle.doc();
      if (!doc) {
        (self as any).postMessage({ type: 'query-result', id: msg.id, result: [], error: 'Document not ready' } satisfies WorkerToMain);
        return;
      }
      const fn = compile(msg.filter);
      const result = fn(doc);
      (self as any).postMessage({ type: 'query-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[worker] query failed for', msg.docId, err);
      (self as any).postMessage({ type: 'query-result', id: msg.id, result: [], error: errMsg(err) } satisfies WorkerToMain);
    }
  }
}

// Replace queue handler with real handler and drain
console.log('[worker] module loaded, queued messages:', pendingMessages.length);
self.onmessage = handleMessage;
for (const msg of pendingMessages) handleMessage(msg);
pendingMessages.length = 0;
