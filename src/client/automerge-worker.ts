import { deepAssign } from '../shared/deep-assign';
import { syncToTarget } from '../shared/sync-to-target';
import { validateDocument } from '../shared/schemas';
import { KeyhiveOps, errMsg } from './keyhive-ops';
import { populateDocRepoMap, setDocRepo, repoFor as _repoFor } from './repo-routing';

export type MainToWorker =
  | { type: 'init'; appBaseUrl: string }
  | { type: 'query'; id: number; docId: string; filter: string }
  // New worker-owned doc API
  | { type: 'create-doc'; id: number; initialJson: any; secure: boolean }
  | { type: 'update-doc'; id: number; docId: string; fnSource: string; args: unknown[] }
  | { type: 'subscribe-query'; subId: number; docId: string; filter: string }
  | { type: 'unsubscribe-query'; subId: number }
  | { type: 'set-doc-version'; docId: string; version: number | null }
  | { type: 'get-doc-history'; id: number; docId: string }
  | { type: 'debug-get-version-patches'; id: number; docId: string; version: number }
  | { type: 'restore-doc-to-heads'; id: number; docId: string; heads: string[] }
  | { type: 'restore-doc-to-version'; id: number; docId: string; version: number }
  | { type: 'presence-subscribe'; docId: string }
  | { type: 'presence-unsubscribe'; docId: string }
  | { type: 'presence-set'; docId: string; state: any }
  // Doc list mutations (IDB-backed)
  | { type: 'add-doc-to-list'; docId: string; [key: string]: any }
  | { type: 'remove-doc-from-list'; docId: string }
  // Contact name mutations (IDB-backed)
  | { type: 'set-contact-name'; agentId: string; name: string }
  | { type: 'remove-contact-name'; agentId: string }
  // Keyhive operations
  | { type: 'kh-get-identity'; id: number }
  | { type: 'kh-get-contact-card'; id: number }
  | { type: 'kh-receive-contact-card'; id: number; cardJson: string; isDevice?: boolean }
  | { type: 'kh-get-doc-members'; id: number; khDocId: string }
  | { type: 'kh-get-my-access'; id: number; khDocId: string }
  | { type: 'kh-add-member'; id: number; agentId: string; docId: string; role: string }
  | { type: 'kh-revoke-member'; id: number; agentId: string; docId: string }
  | { type: 'kh-change-role'; id: number; agentId: string; docId: string; newRole: string }
  | { type: 'kh-generate-invite'; id: number; docId: string; groupId: string; role: string; automergeDocId: string; docType: string }
  | { type: 'kh-list-devices'; id: number }
  | { type: 'kh-remove-device'; id: number; agentId: string }
  | { type: 'kh-enable-sharing'; id: number; automergeDocId: string }
  | { type: 'kh-register-doc-mapping'; automergeDocId: string; khDocId: string }
  | { type: 'kh-register-sharing-group'; id: number; khDocId: string; groupId: string }
  | { type: 'kh-get-known-contacts'; id: number; excludeDocId?: string }
  | { type: 'kh-claim-invite'; id: number; inviteSeed: number[]; automergeDocId: string }
  | { type: 'kh-dismiss-invite'; id: number; inviteId: string; khDocId: string }
  | { type: 'open-doc'; id: number; docId: string; secure?: boolean }
  | { type: 'validate-subscribe'; docId: string }
  | { type: 'validate-unsubscribe'; docId: string };

export type ValidationError = { path: (string | number)[]; message: string; kind?: 'schema' | 'dependency' | 'warning' };

export type WorkerToMain =
  | { type: 'ready'; peerId: string }
  | { type: 'kh-ready' }
  | { type: 'kh-error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'peer-connected'; peerCount: number; peers: string[] }
  | { type: 'peer-disconnected'; peerCount: number; peers: string[] }
  | { type: 'ws-status'; repo: 'secure' | 'insecure'; connected: boolean }
  // New worker-owned doc API responses
  | { type: 'result'; id: number; result?: any; error?: string }
  | { type: 'sub-result'; subId: number; result: any; heads: string[]; lastModified?: number; error?: string }
  | { type: 'presence-update'; docId: string; peers: Record<string, any> }
  // Document loading progress
  | { type: 'open-doc-progress'; id: number; pct: number; message: string }
  // Validation
  | { type: 'validation-result'; docId: string; errors: ValidationError[] }
  // Doc list / contact names push
  | { type: 'doc-list-updated'; list: Array<{ id: string; type?: string; name?: string; encrypted?: boolean; khDocId?: string; sharingGroupId?: string }> }
  | { type: 'contact-names-updated'; names: Record<string, string> }
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
  await import('@automerge/automerge-subduction'); // Initialize subduction WASM before Repo construction
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
  console.log('[worker] keyhive bridge imported (initKeyhiveWasm deferred to init handler)');
} catch (err: any) {
  console.error('[worker] Failed to load modules:', err);
  (self as any).postMessage({ type: 'error', message: `Module load failed: ${errMsg(err)}` });
  throw err;
}

let secureRepo: InstanceType<typeof Repo> | null = null;
let insecureRepo: InstanceType<typeof Repo> | null = null;
let khIntegration: InstanceType<typeof khBridge.AutomergeRepoKeyhive> | null = null;
let khOps: KeyhiveOps | null = null;
let appBaseUrl = '';

/** Pick the correct repo for a given docId based on the docRepoMap. */
function getRepo(docId: string): InstanceType<typeof Repo> {
  return _repoFor(docId, secureRepo, insecureRepo);
}

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
  const r = getRepo(docId);
  const handle = await r.find(docId as any);
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
  if (handle.isReady && !handle.isReady()) return; // doc not yet loaded/decrypted — wait for change event
  const rawDoc = handle.doc();
  if (!rawDoc) return;
  const history = Automerge.getHistory(rawDoc);
  let activeDoc: any;
  if (entry.pinnedVersion !== null) {
    activeDoc = history[entry.pinnedVersion]?.snapshot ?? rawDoc;
  } else {
    activeDoc = rawDoc;
  }
  const heads: string[] = handle.heads ? handle.heads() : [];

  // Extract last-modified timestamp from the most recent change
  let lastModified: number | undefined;
  if (history.length > 0) {
    const ts = history[history.length - 1].change.time;
    if (ts) lastModified = ts;
  }

  for (const [subId, filter] of entry.subscriptions) {
    try {
      const result = await runQuery(filter, activeDoc);
      (self as any).postMessage({ type: 'sub-result', subId, result, heads, lastModified } satisfies WorkerToMain);
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
  const securePeers = secureRepo ? secureRepo.peers : [];
  const insecurePeers = insecureRepo ? insecureRepo.peers : [];
  const peers = [...securePeers, ...insecurePeers];
  const peerCount = peers.length;
  (self as any).postMessage({ type: peerCount > 0 ? 'peer-connected' : 'peer-disconnected', peerCount, peers } satisfies WorkerToMain);
}


async function handleMessage(e: MessageEvent<MainToWorker>) {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      console.log('[worker] init message received');

      // --- Always create insecure repo ---
      const insecureStorage = new IndexedDBStorageAdapter('automerge-insecure');
      const insecureWs = new BrowserWebSocketClientAdapter('wss://sync.automerge.org');
      const insecureSubduction = {
        storage: {},
        removeSedimentree() {},
        connectDiscover() {},
        disconnectAll() {},
        disconnectFromPeer() {},
        syncAll() { return Promise.resolve({ entries() { return []; } }); },
        syncWithAllPeers() { return Promise.resolve(new Map()); },
        getBlobs() { return Promise.resolve([]); },
        addCommit() { return Promise.resolve(undefined); },
        addFragment() { return Promise.resolve(undefined); },
      };
      insecureRepo = new Repo({
        network: [insecureWs],
        storage: insecureStorage,
        subduction: insecureSubduction,
        peerId: crypto.randomUUID() as any,
      } as any);
      const insecureNs = insecureRepo.networkSubsystem;
      insecureNs.on('peer', postStatus);
      insecureNs.on('peer-disconnected', postStatus);
      // Monitor WS open/close directly for connection status
      const origInsecureOpen = insecureWs.onOpen;
      const origInsecureClose = insecureWs.onClose;
      insecureWs.onOpen = () => { origInsecureOpen(); (self as any).postMessage({ type: 'ws-status', repo: 'insecure', connected: true } satisfies WorkerToMain); };
      insecureWs.onClose = () => { origInsecureClose(); (self as any).postMessage({ type: 'ws-status', repo: 'insecure', connected: false } satisfies WorkerToMain); };
      console.log('[worker] insecure repo created');

      // --- Create secure repo ---
      try {
        if (!khBridge) throw new Error('Keyhive bridge not loaded');

        await khBridge.initKeyhiveWasm();
        console.log('[worker] keyhive WASM initialized');

        const secureStorage = new IndexedDBStorageAdapter('automerge-secure');
        const secureWs = new BrowserWebSocketClientAdapter(
          self.location?.protocol === 'https:'
            ? 'wss://auto-relay-436046666a53.herokuapp.com'
            : `ws://${self.location?.hostname || 'localhost'}:${self.location?.port || 3000}`
        );

        khIntegration = await khBridge.initializeAutomergeRepoKeyhive({
          storage: secureStorage,
          peerIdSuffix: 'drive',
          networkAdapter: secureWs,
          onlyShareWithHardcodedServerPeerId: false,
          periodicallyRequestSync: true,
          automaticArchiveIngestion: true,
          cacheHashes: false,
          syncRequestInterval: 2000,
        });

        const noopSubduction = {
          storage: {},
          removeSedimentree() {},
          connectDiscover() {},
          disconnectAll() {},
          disconnectFromPeer() {},
          syncAll() { return Promise.resolve({ entries() { return []; } }); },
          syncWithAllPeers() { return Promise.resolve(new Map()); },
          getBlobs(sedimentreeId: any) {
            if (!secureRepo?.storageSubsystem) return Promise.resolve([]);
            try {
              const docId = toDocumentId(sedimentreeId);
              return secureRepo.storageSubsystem.loadDocData(docId)
                .then((data: Uint8Array | null) => data ? [data] : []);
            } catch {
              return Promise.resolve([]);
            }
          },
          addCommit() { return Promise.resolve(undefined); },
          addFragment() { return Promise.resolve(undefined); },
        };
        secureRepo = new Repo({
          network: [khIntegration.networkAdapter],
          storage: secureStorage,
          subduction: noopSubduction,
          peerId: khIntegration.peerId,
        } as any);

        khIntegration.linkRepo(secureRepo);

        khOps = new KeyhiveOps(khIntegration.keyhive, khBridge as any, {
          persist: () => khIntegration!.keyhiveStorage.saveKeyhiveWithHash(khIntegration!.keyhive),
          syncKeyhive: () => khIntegration!.networkAdapter.syncKeyhive(),
          registerDoc: (amDocId, khDocId) => khIntegration!.networkAdapter.registerDoc(amDocId, khDocId),
          forceResyncAllPeers: () => (khIntegration!.networkAdapter as any).forceResyncAllPeers(),
          findDoc: (docId) => secureRepo!.find(docId as any),
        });

        const secureNs = secureRepo.networkSubsystem;
        secureNs.on('peer', postStatus);
        secureNs.on('peer-disconnected', postStatus);
        // Monitor WS open/close directly for connection status
        const origSecureOpen = secureWs.onOpen;
        const origSecureClose = secureWs.onClose;
        secureWs.onOpen = () => { origSecureOpen(); (self as any).postMessage({ type: 'ws-status', repo: 'secure', connected: true } satisfies WorkerToMain); };
        secureWs.onClose = () => { origSecureClose(); (self as any).postMessage({ type: 'ws-status', repo: 'secure', connected: false } satisfies WorkerToMain); };

        console.log('[worker] secure repo created, peerId:', khIntegration.peerId);
        (self as any).postMessage({ type: 'kh-ready' } satisfies WorkerToMain);
      } catch (khErr: any) {
        console.error('[worker] keyhive init failed (continuing without encryption):', khErr);
        (self as any).postMessage({ type: 'kh-error', message: errMsg(khErr) } satisfies WorkerToMain);
      }

      // --- Store appBaseUrl ---
      appBaseUrl = msg.appBaseUrl;

      // --- Load doc list from IDB ---
      const { idbGet } = await import('./idb-storage');
      type StoredDocEntry = { id: string; type?: string; name?: string; encrypted?: boolean; khDocId?: string; sharingGroupId?: string };
      const docList = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
      populateDocRepoMap(docList);
      (self as any).postMessage({ type: 'doc-list-updated', list: docList } satisfies WorkerToMain);

      // Prune invite records for docs no longer in the list
      const { pruneInvitesNotIn } = await import('./invite-storage');
      const knownKhDocIds = new Set(docList.map(d => d.khDocId).filter(Boolean) as string[]);
      await pruneInvitesNotIn(knownKhDocIds);

      // --- Load and push contact names from IDB ---
      const contactNames = (await idbGet<Record<string, string>>('contact-names')) ?? {};
      (self as any).postMessage({ type: 'contact-names-updated', names: contactNames } satisfies WorkerToMain);

      const primaryRepo = secureRepo ?? insecureRepo;
      console.log('[worker] init complete');
      (self as any).postMessage({ type: 'ready', peerId: primaryRepo.peerId } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[worker] init failed:', err);
      (self as any).postMessage({ type: 'error', message: errMsg(err) } satisfies WorkerToMain);
    }
  }

  // --- New worker-owned doc API ---

  if (msg.type === 'create-doc') {
    try {
      let handle: any;
      let khDocId: string | undefined;
      if (msg.secure) {
        if (!secureRepo || !khOps) throw new Error('Secure repo not available');
        handle = secureRepo.create(msg.initialJson);
        const sharing = await khOps.enableSharing(handle.documentId);
        khDocId = sharing.khDocId;
      } else {
        if (!insecureRepo) throw new Error('Insecure repo not available');
        handle = insecureRepo.create(msg.initialJson);
      }
      const docId = handle.documentId;
      setDocRepo(docId, msg.secure ? 'secure' : 'insecure');
      (self as any).postMessage({ type: 'result', id: msg.id, result: { docId, khDocId } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'open-doc') {
    const post = self as any;
    const progress = (pct: number, message: string) =>
      post.postMessage({ type: 'open-doc-progress', id: msg.id, pct, message } satisfies WorkerToMain);
    try {
      // Record secure hint in docRepoMap if provided
      if (msg.secure !== undefined) {
        setDocRepo(msg.docId, msg.secure ? 'secure' : 'insecure');
      }
      progress(10, 'Finding document\u2026');
      const handle = await getOrLoadHandle(msg.docId);
      getOrCreateEntry(msg.docId, handle);
      progress(50, 'Loading document data\u2026');
      const isReady = handle.isReady ? handle.isReady() : false;
      if (isReady) {
        progress(100, 'Ready');
        post.postMessage({ type: 'result', id: msg.id, result: { docId: msg.docId } } satisfies WorkerToMain);
      } else {
        // Wait for doc data to arrive
        handle.whenReady().then(() => {
          progress(100, 'Ready');
          post.postMessage({ type: 'result', id: msg.id, result: { docId: msg.docId } } satisfies WorkerToMain);
        });
      }
    } catch (err: any) {
      post.postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
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

      // Push immediately if doc is ready, otherwise wait for it
      const isReady = handle.isReady ? handle.isReady() : false;
      if (isReady) {
        await pushToSubscriptions(msg.docId);
      } else {
        handle.whenReady().then(() => pushToSubscriptions(msg.docId));
      }
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
      // Worker-provided functions: callers pass the real ref, updateDoc replaces
      // with { __workerFn__: name }, and we substitute the worker-local implementation.
      const workerFns: Record<string, any> = { deepAssign };
      const argVals = (msg.args as any[]).map((a: any) =>
        a && typeof a === 'object' && '__workerFn__' in a ? workerFns[a.__workerFn__] : a
      );
      handle.change((d: any) => {
        const fn = new Function('return ' + msg.fnSource)();
        fn(d, ...argVals);
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

  if (msg.type === 'debug-get-version-patches') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const doc = handle.doc();
      if (!doc) throw new Error('Document not ready');
      const history = Automerge.getHistory(doc);
      if (msg.version < 0 || msg.version >= history.length) throw new Error('Version out of range');
      const afterHash = history[msg.version].change.hash;
      const beforeHeads = msg.version === 0 ? [] : [history[msg.version - 1].change.hash];
      const patches = Automerge.diff(doc, beforeHeads, [afterHash]);
      (self as any).postMessage({ type: 'result', id: msg.id, result: patches } satisfies WorkerToMain);
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

  // --- Doc list mutations (IDB-backed) ---

  if (msg.type === 'add-doc-to-list') {
    try {
      const { idbGet, idbSet } = await import('./idb-storage');
      type StoredDocEntry = { id: string; [key: string]: any };
      const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
      const { docId, type: _type, ...rest } = msg;
      const metadata = { ...rest };
      const idx = list.findIndex(e => e.id === docId);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...metadata, id: docId };
        list.unshift(list.splice(idx, 1)[0]);
      } else {
        list.unshift({ id: docId, ...metadata });
      }
      await idbSet('automerge-doc-ids', list);
      (self as any).postMessage({ type: 'doc-list-updated', list } satisfies WorkerToMain);
    } catch (err: any) {
      console.warn('[worker] add-doc-to-list failed:', errMsg(err));
    }
  }

  if (msg.type === 'remove-doc-from-list') {
    try {
      const { idbGet, idbSet } = await import('./idb-storage');
      type StoredDocEntry = { id: string; [key: string]: any };
      const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
      const removedEntry = list.find(e => e.id === msg.docId);
      const filtered = list.filter(e => e.id !== msg.docId);
      await idbSet('automerge-doc-ids', filtered);
      // Clean up active subscriptions for removed doc
      const entry = docRegistry.get(msg.docId);
      if (entry) {
        for (const subId of entry.subscriptions.keys()) subIdToDocId.delete(subId);
        if (entry.presence) entry.presence.stop();
        docRegistry.delete(msg.docId);
      }
      // Remove invite records for the deleted doc
      if (removedEntry?.khDocId) {
        const { removeInviteRecordsForDoc } = await import('./invite-storage');
        await removeInviteRecordsForDoc(removedEntry.khDocId);
      }
      (self as any).postMessage({ type: 'doc-list-updated', list: filtered } satisfies WorkerToMain);
    } catch (err: any) {
      console.warn('[worker] remove-doc-from-list failed:', errMsg(err));
    }
  }

  // --- Contact name mutations (IDB-backed) ---

  if (msg.type === 'set-contact-name') {
    try {
      const { idbGet, idbSet } = await import('./idb-storage');
      const names = (await idbGet<Record<string, string>>('contact-names')) ?? {};
      names[msg.agentId] = msg.name;
      await idbSet('contact-names', names);
      (self as any).postMessage({ type: 'contact-names-updated', names } satisfies WorkerToMain);
    } catch (err: any) {
      console.warn('[worker] set-contact-name failed:', errMsg(err));
    }
  }

  if (msg.type === 'remove-contact-name') {
    try {
      const { idbGet, idbSet } = await import('./idb-storage');
      const names = (await idbGet<Record<string, string>>('contact-names')) ?? {};
      delete names[msg.agentId];
      await idbSet('contact-names', names);
      (self as any).postMessage({ type: 'contact-names-updated', names } satisfies WorkerToMain);
    } catch (err: any) {
      console.warn('[worker] remove-contact-name failed:', errMsg(err));
    }
  }

  // --- Keyhive operations (delegated to KeyhiveOps) ---

  if (msg.type === 'kh-get-identity') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const identity = await khOps.getIdentity();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: identity } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-contact-card') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.getContactCard();
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-receive-contact-card') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.receiveContactCard(msg.cardJson);
      if (msg.isDevice && !result.isOwnCard) {
        const { idbGet, idbSet } = await import('./idb-storage');
        const devices = (await idbGet<string[]>('linked-devices')) ?? [];
        if (!devices.includes(result.agentId)) {
          devices.push(result.agentId);
          await idbSet('linked-devices', devices);
        }
      }
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-doc-members') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const members = await khOps.getDocMembers(msg.khDocId);
      const { getInviteRecords } = await import('./invite-storage');
      const invites = await getInviteRecords(msg.khDocId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { members, invites } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-my-access') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.getMyAccess(msg.khDocId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-known-contacts') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.getKnownContacts(msg.excludeDocId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-list-devices') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const { idbGet } = await import('./idb-storage');
      const linkedIds = (await idbGet<string[]>('linked-devices')) ?? [];
      const myId = khOps.getIdentity().deviceId;
      const devices: { agentId: string; role: string; isMe?: boolean }[] = [
        { agentId: myId, role: 'owner', isMe: true },
      ];
      for (const id of linkedIds) {
        devices.push({ agentId: id, role: 'linked', isMe: false });
      }
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: devices } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-remove-device') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const { idbGet, idbSet } = await import('./idb-storage');
      const devices = (await idbGet<string[]>('linked-devices')) ?? [];
      const updated = devices.filter(id => id !== msg.agentId);
      await idbSet('linked-devices', updated);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: undefined } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-register-doc-mapping') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      khOps.registerDocMapping(msg.automergeDocId, msg.khDocId);
      // Update IDB list entry with khDocId
      try {
        const { idbGet, idbSet } = await import('./idb-storage');
        type StoredDocEntry = { id: string; [key: string]: any };
        const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
        const entry = list.find(e => e.id === msg.automergeDocId);
        if (entry && !entry.khDocId) {
          entry.khDocId = msg.khDocId;
          await idbSet('automerge-doc-ids', list);
          (self as any).postMessage({ type: 'doc-list-updated', list } satisfies WorkerToMain);
        }
      } catch { /* non-critical */ }
    } catch (err: any) {
      console.warn('[kh-register-doc-mapping] failed:', errMsg(err));
    }
  }

  if (msg.type === 'kh-enable-sharing') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.enableSharing(msg.automergeDocId);
      // Update IDB list entry with new khDocId/sharingGroupId
      try {
        const { idbGet, idbSet } = await import('./idb-storage');
        type StoredDocEntry = { id: string; [key: string]: any };
        const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
        const entry = list.find(e => e.id === msg.automergeDocId);
        if (entry) {
          entry.khDocId = result.khDocId;
          if (result.groupId) entry.sharingGroupId = result.groupId;
          entry.encrypted = true;
          await idbSet('automerge-doc-ids', list);
          (self as any).postMessage({ type: 'doc-list-updated', list } satisfies WorkerToMain);
        }
      } catch { /* non-critical */ }
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-generate-invite') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.generateInvite(msg.docId, msg.role);

      // Build invite URL and store record in IDB
      const members = await khOps.getDocMembers(msg.docId);
      const { encodeInvitePayload } = await import('./invite/invite-codec');
      const seed = new Uint8Array(result.inviteKeyBytes);
      const inviteUrl = `${appBaseUrl}#/invite/${msg.automergeDocId}/${msg.docType}/${encodeInvitePayload(seed)}`;
      const { addInviteRecord } = await import('./invite-storage');
      await addInviteRecord({
        id: Date.now().toString(),
        khDocId: msg.docId,
        inviteUrl,
        role: msg.role,
        createdAt: Date.now(),
        inviteSignerAgentId: result.inviteSignerAgentId,
        baselineAgentIds: members.map((m: any) => m.agentId),
      });

      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { ...result, inviteUrl } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-add-member') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.addMember(msg.agentId, msg.docId, msg.role);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-revoke-member') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.revokeMember(msg.agentId, msg.docId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-change-role') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.changeRole(msg.agentId, msg.docId, msg.newRole);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-register-sharing-group') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.registerSharingGroup(msg.khDocId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-claim-invite') {
    try {
      if (!khOps || !khBridge || !khIntegration) throw new Error('Keyhive not available');

      // Seed-only invite: reconstruct invite keyhive using the main keyhive's
      // archive (which has Alice's events from relay sync) and the invite seed.
      const seed = new Uint8Array(msg.inviteSeed);
      const inviteSigner = khBridge.Signer.memorySignerFromBytes(seed);

      // Force an immediate keyhive sync to get latest events from peers
      khIntegration.networkAdapter.syncKeyhive(undefined, true);

      const MAX_WAIT_MS = 60000;
      const POLL_INTERVAL_MS = 3000;
      const start = Date.now();
      let inviteKh: any = null;
      let reachable: any[] = [];

      while (Date.now() - start < MAX_WAIT_MS) {
        const stats = await khIntegration.keyhive.stats();
        const peerCount = (khIntegration.networkAdapter as any).peers?.size ?? '?';
        const mainArchive = await khIntegration.keyhive.toArchive();
        const tempStore = khBridge.CiphertextStore.newInMemory();
        try {
          inviteKh = await mainArchive.tryToKeyhive(tempStore, inviteSigner, () => {});
          reachable = await inviteKh.reachableDocs();
          console.log(`[kh-claim-invite] poll: totalOps=${stats.totalOps} peers=${peerCount} reachable=${reachable.length} elapsed=${Date.now() - start}ms`);
          if (reachable.length > 0) break;
        } catch (e) {
          console.log(`[kh-claim-invite] poll: totalOps=${stats.totalOps} peers=${peerCount} tryToKeyhive error elapsed=${Date.now() - start}ms`);
        }
        // Force sync with contact card to ensure peer discovery
        khIntegration.networkAdapter.syncKeyhive(undefined, true);
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!inviteKh || reachable.length === 0) {
        const stats = await khIntegration.keyhive.stats();
        throw new Error(`Invite signer membership not found after ${Math.round((Date.now() - start) / 1000)}s (totalOps=${stats.totalOps}). The invite may not have synced yet — try again.`);
      }

      const result = await khOps.claimInviteWithKeyhive(inviteKh, msg.automergeDocId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[kh-claim-invite] failed:', err);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-dismiss-invite') {
    try {
      const { removeInviteRecord, getInviteRecords } = await import('./invite-storage');
      await removeInviteRecord(msg.inviteId);
      const invites = await getInviteRecords(msg.khDocId);
      (self as any).postMessage({ type: 'kh-result', id: msg.id, result: { invites } } satisfies WorkerToMain);
    } catch (err: any) {
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
