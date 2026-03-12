import { deepAssign } from '../shared/deep-assign';
import { syncToTarget } from '../shared/sync-to-target';
import { validateDocument } from '../shared/schemas';

export type MainToWorker =
  | { type: 'init'; wsUrl: string; port?: MessagePort }
  | { type: 'set-ws-url'; wsUrl: string }
  | { type: 'query'; id: number; docId: string; filter: string }
  // New worker-owned doc API
  | { type: 'create-doc'; id: number; initialJson: any }
  | { type: 'update-doc'; id: number; docId: string; fnSource: string; args: Record<string, unknown> }
  | { type: 'subscribe-query'; subId: number; docId: string; filter: string }
  | { type: 'unsubscribe-query'; subId: number }
  | { type: 'set-doc-version'; docId: string; version: number | null }
  | { type: 'get-doc-history'; id: number; docId: string }
  | { type: 'restore-doc-to-heads'; id: number; docId: string; heads: string[] }
  | { type: 'restore-doc-to-version'; id: number; docId: string; version: number }
  | { type: 'presence-subscribe'; docId: string }
  | { type: 'presence-unsubscribe'; docId: string }
  | { type: 'presence-set'; docId: string; state: any }
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
  | { type: 'kh-claim-invite'; id: number; inviteSeed: number[]; archiveBytes: number[]; automergeDocId: string }
  | { type: 'validate-subscribe'; docId: string }
  | { type: 'validate-unsubscribe'; docId: string };

export type ValidationError = { path: (string | number)[]; message: string; kind?: 'schema' | 'dependency' | 'warning' };

export type WorkerToMain =
  | { type: 'ready' }
  | { type: 'kh-ready' }
  | { type: 'error'; message: string }
  | { type: 'peer-connected'; peerCount: number; peers: string[] }
  | { type: 'peer-disconnected'; peerCount: number; peers: string[] }
  // New worker-owned doc API responses
  | { type: 'result'; id: number; result?: any; error?: string }
  | { type: 'sub-result'; subId: number; result: any; heads: string[]; error?: string }
  | { type: 'presence-update'; docId: string; peers: Record<string, any> }
  // Validation
  | { type: 'validation-result'; docId: string; errors: ValidationError[] }
  // Keyhive responses
  | { type: 'kh-result'; id: number; result?: any; error?: string };

// Queue messages that arrive while WASM is initializing
const pendingMessages: MessageEvent[] = [];
self.onmessage = (e: MessageEvent) => { pendingMessages.push(e); };

// Dynamic import so the queue handler above is registered BEFORE WASM top-level await runs
let Repo: any, IndexedDBStorageAdapter: any, Automerge: any;
let BrowserWebSocketClientAdapter: any;
let PresenceClass: any;
let toDocumentId: (sedimentreeId: any) => string;
let khBridge: typeof import('../lib/automerge-repo-keyhive/index') | null = null;
try {
  console.log('[worker] importing modules...');
  const repoModule: any = await import('@automerge/automerge-repo');
  Repo = repoModule.Repo;
  toDocumentId = repoModule.toDocumentId;
  PresenceClass = repoModule.Presence;
  console.log('[worker] Repo imported');
  ({ IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb'));
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

/** Look up an Agent from docMemberCapabilities by matching Identifier bytes (base64). */
async function findAgentByIdBytes(kh: any, doc: any, agentIdB64: string): Promise<any> {
  const targetBytes = base64ToBytes(agentIdB64);
  const members = await kh.docMemberCapabilities(doc.doc_id);
  for (const m of members) {
    const memberBytes: Uint8Array = m.who.id.toBytes();
    if (memberBytes.length === targetBytes.length && memberBytes.every((b: number, i: number) => b === targetBytes[i])) {
      return m.who;
    }
  }
  throw new Error('Member not found in document');
}

let repo: InstanceType<typeof Repo> | null = null;
let khIntegration: InstanceType<typeof khBridge.AutomergeRepoKeyhive> | null = null;
// Maps khDocId (base64) → keyhive Document object (needed for addMember's other_relevant_docs).
const khDocuments = new Map<string, any>();

// --- Doc registry for worker-owned subscriptions ---

interface DocEntry {
  handle: any;
  pinnedVersion: number | null; // null = live view
  subscriptions: Map<number, string>; // subId → jq filter
  presence: any | null; // PresenceClass instance
  validationSubscribed: boolean;
  changeListenerRegistered: boolean;
}
const docRegistry = new Map<string, DocEntry>();
// Maps subId → docId for O(1) unsubscribe lookup
const subIdToDocId = new Map<number, string>();

async function getOrLoadHandle(docId: string): Promise<any> {
  const existing = docRegistry.get(docId);
  if (existing) return existing.handle;
  if (!repo) throw new Error('Repo not initialized');
  const handle = await repo.find(docId as any);
  return handle;
}

function getOrCreateEntry(docId: string, handle: any): DocEntry {
  let entry = docRegistry.get(docId);
  if (!entry) {
    entry = { handle, pinnedVersion: null, subscriptions: new Map(), presence: null, validationSubscribed: false, changeListenerRegistered: false };
    docRegistry.set(docId, entry);
  }
  return entry;
}

async function runQuery(filter: string, doc: any): Promise<any> {
  const { one } = await import('../shared/jq');
  return one(filter, doc);
}

async function pushToSubscriptions(docId: string) {
  const entry = docRegistry.get(docId);
  if (!entry) return;

  const hasQuerySubs = entry.subscriptions.size > 0;
  const hasValidation = entry.validationSubscribed;
  if (!hasQuerySubs && !hasValidation) return;

  const handle = entry.handle;
  let activeDoc: any;
  if (entry.pinnedVersion !== null) {
    const history = Automerge.getHistory(handle.doc());
    activeDoc = history[entry.pinnedVersion]?.snapshot ?? handle.doc();
  } else {
    activeDoc = handle.doc();
  }
  const heads: string[] = handle.heads ? handle.heads() : [];

  for (const [subId, filter] of entry.subscriptions) {
    try {
      const result = await runQuery(filter, activeDoc);
      (self as any).postMessage({ type: 'sub-result', subId, result, heads } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'sub-result', subId, result: null, heads, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (hasValidation) {
    pushValidation(docId, activeDoc);
  }
}

function pushValidation(docId: string, doc: any) {
  const allErrors = validateDocument(doc);
  const errors = allErrors.slice(0, 100);
  (self as any).postMessage({ type: 'validation-result', docId, errors } satisfies WorkerToMain);
}

function postStatus() {
  const peers = repo ? repo.peers : [];
  const peerCount = peers.length;
  (self as any).postMessage({ type: peerCount > 0 ? 'peer-connected' : 'peer-disconnected', peerCount, peers } satisfies WorkerToMain);
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

      if (msg.port) {
        const { MessageChannelNetworkAdapter } = await import('@automerge/automerge-repo-network-messagechannel');
        repo.networkSubsystem.addNetworkAdapter(new MessageChannelNetworkAdapter(msg.port));
      }

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

  // --- New worker-owned doc API ---

  if (msg.type === 'create-doc') {
    try {
      if (!repo) throw new Error('Repo not initialized');
      const handle = repo.create(msg.initialJson);
      (self as any).postMessage({ type: 'result', id: msg.id, result: { docId: handle.documentId } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'subscribe-query') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const entry = getOrCreateEntry(msg.docId, handle);

      // Register change listener if not already registered
      if (!entry.changeListenerRegistered) {
        entry.changeListenerRegistered = true;
        handle.on('change', () => { pushToSubscriptions(msg.docId); });
      }

      entry.subscriptions.set(msg.subId, msg.filter);
      subIdToDocId.set(msg.subId, msg.docId);

      // Push immediately
      await pushToSubscriptions(msg.docId);
    } catch (err: any) {
      (self as any).postMessage({ type: 'sub-result', subId: msg.subId, result: null, heads: [], error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'unsubscribe-query') {
    const docId = subIdToDocId.get(msg.subId);
    if (docId) {
      subIdToDocId.delete(msg.subId);
      const entry = docRegistry.get(docId);
      if (entry) entry.subscriptions.delete(msg.subId);
    }
  }

  if (msg.type === 'validate-subscribe') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const entry = getOrCreateEntry(msg.docId, handle);
      entry.validationSubscribed = true;
      // Register change listener if not already registered
      if (!entry.changeListenerRegistered) {
        entry.changeListenerRegistered = true;
        handle.on('change', () => { pushToSubscriptions(msg.docId); });
      }
      // Push immediately
      await pushToSubscriptions(msg.docId);
    } catch (err: any) {
      (self as any).postMessage({ type: 'validation-result', docId: msg.docId, errors: [] } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'validate-unsubscribe') {
    const entry = docRegistry.get(msg.docId);
    if (entry) entry.validationSubscribed = false;
  }

  if (msg.type === 'set-doc-version') {
    const entry = docRegistry.get(msg.docId);
    if (!entry) return;
    entry.pinnedVersion = msg.version;
    await pushToSubscriptions(msg.docId);
  }

  if (msg.type === 'update-doc') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const { args } = msg;
      const argKeys = Object.keys(args);
      const argVals = Object.values(args);
      handle.change((d: any) => {
        const fn = new Function(...argKeys, 'deepAssign', 'd', `(${msg.fnSource})(d)`);
        fn(...argVals, deepAssign, d);
      });
      // Explicitly push subscription updates after local mutation
      // (the change event may not fire for local changes in all automerge-repo versions)
      await pushToSubscriptions(msg.docId);
      (self as any).postMessage({ type: 'result', id: msg.id, result: null } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[worker] update-doc failed:', errMsg(err));
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'get-doc-history') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const doc = handle.doc();
      if (!doc) throw new Error('Document not ready');
      const history = Automerge.getHistory(doc);
      const result = history.map((e: any, i: number) => ({ version: i, time: e.change.time }));
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'restore-doc-to-heads') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const targetDoc = handle.view(msg.heads as any).doc();
      if (!targetDoc) throw new Error('Could not view document at heads');
      handle.change((d: any) => syncToTarget(d, targetDoc));
      // Clear pinned version so subscriptions resume live
      const entry = docRegistry.get(msg.docId);
      if (entry) entry.pinnedVersion = null;
      await pushToSubscriptions(msg.docId);
      (self as any).postMessage({ type: 'result', id: msg.id, result: null } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'restore-doc-to-version') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const history = Automerge.getHistory(handle.doc());
      const snap = history[msg.version]?.snapshot;
      if (!snap) throw new Error(`Version ${msg.version} not found`);
      handle.change((d: any) => syncToTarget(d, snap));
      // Clear pinned version so subscriptions resume live
      const entry = docRegistry.get(msg.docId);
      if (entry) entry.pinnedVersion = null;
      await pushToSubscriptions(msg.docId);
      (self as any).postMessage({ type: 'result', id: msg.id, result: null } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'presence-subscribe') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const entry = getOrCreateEntry(msg.docId, handle);
      if (!entry.presence) {
        const presence = new PresenceClass({ handle });
        presence.start({ initialState: { viewing: true, focusedField: null }, heartbeatMs: 5000, peerTtlMs: 15000 });
        const sendPresence = () => {
          const peers = { ...presence.getPeerStates().value };
          (self as any).postMessage({ type: 'presence-update', docId: msg.docId, peers } satisfies WorkerToMain);
        };
        presence.on('update', sendPresence);
        presence.on('goodbye', sendPresence);
        presence.on('snapshot', sendPresence);
        entry.presence = presence;
      }
    } catch (err: any) {
      console.warn('[worker] presence-subscribe failed:', errMsg(err));
    }
  }

  if (msg.type === 'presence-unsubscribe') {
    const entry = docRegistry.get(msg.docId);
    if (entry?.presence) {
      entry.presence.stop();
      entry.presence = null;
    }
  }

  if (msg.type === 'presence-set') {
    const entry = docRegistry.get(msg.docId);
    if (entry?.presence) {
      for (const [key, value] of Object.entries(msg.state)) {
        entry.presence.broadcast(key, value);
      }
    }
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
        agentId: bytesToBase64(m.who.id.toBytes()),
        displayId: m.who.toString(),
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
      const agent = await findAgentByIdBytes(kh, doc, msg.agentId);
      await kh.revokeMember(agent, true, doc.toMembered());
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
      const agent = await findAgentByIdBytes(kh, doc, msg.agentId);
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
      // Send keyhive sync request so the server learns about our access
      khIntegration.networkAdapter.syncKeyhive();
      // Pre-request the automerge document so it starts syncing alongside keyhive
      if (msg.automergeDocId && repo) {
        repo.find(msg.automergeDocId as any);
      }
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { khDocId } } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[kh-claim-invite] failed:', err);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'query') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const doc = handle.doc();
      const heads: string[] = handle.heads ? handle.heads() : [];
      if (!doc) {
        (self as any).postMessage({ type: 'result', id: msg.id, error: 'Document not ready' } satisfies WorkerToMain);
        return;
      }
      const { compile } = await import('../shared/jq');
      const fn = compile(msg.filter);
      const result = fn(doc);
      (self as any).postMessage({ type: 'result', id: msg.id, result: { result, heads } } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[worker] query failed for', msg.docId, err);
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }
}

// Replace queue handler with real handler and drain
console.log('[worker] module loaded, queued messages:', pendingMessages.length);
self.onmessage = handleMessage;
for (const msg of pendingMessages) handleMessage(msg);
pendingMessages.length = 0;
