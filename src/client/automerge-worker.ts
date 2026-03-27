import { deepAssign } from '../shared/deep-assign';
import { syncToTarget } from '../shared/sync-to-target';
import { validateDocument } from '../shared/schemas';
import { KeyhiveOps, bytesToBase64, errMsg } from './keyhive-ops';
import { populateDocRepoMap, setDocRepo, getDocRepo, repoFor as _repoFor, findInRepos } from './repo-routing';
import { isDiscoverable } from './doc-discovery';
import { LRU } from './lru-cache';

export type MainToWorker =
  | { type: 'init'; appBaseUrl: string; enableInsecureRepo: boolean }
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
  | { type: 'subscribe-presence'; docId: string }
  | { type: 'unsubscribe-presence'; docId: string }
  | { type: 'set-presence'; docId: string; state: any }
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
  | { type: 'kh-get-doc-members'; id: number; docId: string }
  | { type: 'kh-get-my-access'; id: number; docId: string }
  | { type: 'kh-add-member'; id: number; agentId: string; docId: string; role: string }
  | { type: 'kh-revoke-member'; id: number; agentId: string; docId: string }
  | { type: 'kh-change-role'; id: number; agentId: string; docId: string; newRole: string }
  | { type: 'kh-generate-invite'; id: number; docId: string; role: string; docType: string }
  | { type: 'kh-list-devices'; id: number }
  | { type: 'kh-remove-device'; id: number; agentId: string }
  | { type: 'kh-get-known-contacts'; id: number; excludeDocId?: string }
  | { type: 'kh-claim-invite'; id: number; inviteSeed: number[]; docId: string }
  | { type: 'kh-dismiss-invite'; id: number; inviteId: string; docId: string }
  | { type: 'open-doc'; id: number; docId: string; secure?: boolean }
  | { type: 'subscribe-validation'; docId: string }
  | { type: 'unsubscribe-validation'; docId: string }
  | { type: 'hf-port'; port: MessagePort };

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
  | { type: 'update-presence'; docId: string; peers: Record<string, any> }
  // Document loading progress
  | { type: 'open-doc-progress'; id: number; pct: number; message: string }
  // Validation
  | { type: 'update-validation'; docId: string; errors: ValidationError[] }
  // Doc list / contact names push
  | { type: 'doc-list-updated'; list: Array<{ id: string; type?: string; name?: string; encrypted?: boolean; sharingGroupId?: string }> }
  | { type: 'contact-names-updated'; names: Record<string, string> }
  // Keyhive state changed (membership/access may have changed)
  | { type: 'kh-state-changed' };

// Queue messages that arrive while WASM is initializing
const pendingMessages: MessageEvent[] = [];
self.onmessage = (e: MessageEvent) => { pendingMessages.push(e); };

// Dynamic import so the queue handler above is registered BEFORE WASM top-level await runs
let Repo: any, IndexedDBStorageAdapter: any, Automerge: any;
let BrowserWebSocketClientAdapter: any;
let PresenceClass: any;
let khBridge: typeof import('../lib/automerge-repo-keyhive/index') | null = null;
try {
  console.log('[worker] importing modules...');
  await import('@automerge/automerge-subduction'); // Initialize subduction WASM before Repo construction
  const repoModule: any = await import('@automerge/automerge-repo');
  Repo = repoModule.Repo;
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
let setNextDocId: ((bytes: Uint8Array) => void) | null = null;
let appBaseUrl = '';

/** Derive the keyhive doc-ID (base64) from an automerge doc-ID.
 *  Works because the automerge binary doc-ID bytes ARE the keyhive doc_id bytes. */
function resolveKhDocId(automergeDocId: string): string {
  const khDocIdObj = khBridge!.docIdFromAutomergeUrl(`automerge:${automergeDocId}` as any);
  return bytesToBase64(khDocIdObj.toBytes());
}

/**
 * The docId currently being loaded via getOrLoadHandle → repo.find().
 * getBlobs receives a sedimentreeId but toDocumentId() truncates 32-byte
 * keyhive IDs to 16 bytes, producing the wrong storage key. Instead of
 * reverse-mapping, we stash the docId before calling find() so getBlobs
 * can read it directly.
 */
let loadingDocId: string | null = null;

/** Pick the correct repo for a given docId based on the docRepoMap. */
function getRepo(docId: string): InstanceType<typeof Repo> {
  return _repoFor(docId, secureRepo, insecureRepo);
}

// --- Doc registry for worker-owned subscriptions ---

interface SubInfo {
  filter: string;
  post: (msg: any) => void; // where to send results (self.postMessage or port.postMessage)
}

interface DocEntry {
  handle: any;
  pinnedVersion: number | null; // null = live view
  subscriptions: Map<number, SubInfo>; // subId → filter + poster
  presence: any | null; // PresenceClass instance
  validationSubscribed: boolean;
}
const docRegistry = new Map<string, DocEntry>();
// Maps subId → docId for O(1) unsubscribe lookup
const subIdToDocId = new Map<number, string>();
// Subscriptions registered before the doc is opened (drained in getOrCreateEntry)
const pendingSubs = new Map<string, Map<number, SubInfo>>();

async function getOrLoadHandle(docId: string): Promise<any> {
  const existing = docRegistry.get(docId);
  if (existing) return existing.handle;
  const r = getRepo(docId);
  loadingDocId = docId;
  const handle = await r.find(docId as any);
  loadingDocId = null;
  return handle;
}

function getOrCreateEntry(docId: string, handle: any): DocEntry {
  let entry = docRegistry.get(docId);
  if (!entry) {
    entry = { handle, pinnedVersion: null, subscriptions: new Map(), presence: null, validationSubscribed: false };
    docRegistry.set(docId, entry);
    handle.on('change', () => { pushToSubscriptions(docId); });
    // Drain subscriptions that were registered before the doc was opened
    const pending = pendingSubs.get(docId);
    if (pending) {
      for (const [subId, sub] of pending) entry.subscriptions.set(subId, sub);
      pendingSubs.delete(docId);
    }
  }
  return entry;
}

// --- Query caching ---

const jqCache = new LRU<string, (input: any) => any>(64);

async function runQuery(filter: string, doc: any): Promise<any> {
  let fn = jqCache.get(filter);
  if (!fn) {
    const { compile } = await import('../shared/jq');
    const compiled = compile(filter);
    fn = (input: any) => { const r = compiled(input); return r.length > 0 ? r[0] : null; };
    jqCache.set(filter, fn);
  }
  return fn(doc);
}

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

interface QueryCacheEntry { result: any; json: string; lastModified?: number; heads: string[] }

/** In-memory LRU mirror of IDB query cache. */
const queryResultCache = new LRU<string, QueryCacheEntry>(256);

/** Run a query, check cache, persist if changed. */
async function runCachedQuery(
  docId: string, filter: string, doc: any, heads: string[], lastModified?: number,
): Promise<{ result: any; heads: string[]; lastModified?: number; changed: boolean }> {
  const cacheKey = `qc:${docId}:${hashStr(filter)}`;
  const result = await runQuery(filter, doc);
  const json = JSON.stringify(result);

  const cached = queryResultCache.get(cacheKey);
  if (cached && cached.json === json) {
    return { result, heads, lastModified, changed: false };
  }

  const entry: QueryCacheEntry = { result, json, lastModified, heads };
  queryResultCache.set(cacheKey, entry);
  const { idbSet } = await import('./idb-storage');
  idbSet(cacheKey, entry);
  return { result, heads, lastModified, changed: true };
}

/** Subscribe to a jq query, routing results to the given poster. Shared by main-thread and port subscriptions. */
async function handleSubscribeQuery(docId: string, subId: number, filter: string, post: (m: any) => void) {
  subIdToDocId.set(subId, docId);

  // Serve from cache if available
  const cacheKey = `qc:${docId}:${hashStr(filter)}`;
  const memoryCached = queryResultCache.get(cacheKey);
  if (memoryCached) {
    post({ type: 'sub-result', subId, result: memoryCached.result, heads: memoryCached.heads, lastModified: memoryCached.lastModified });
  } else {
    const { idbGet } = await import('./idb-storage');
    const idbCached = await idbGet<QueryCacheEntry>(cacheKey);
    if (idbCached) {
      queryResultCache.set(cacheKey, idbCached);
      post({ type: 'sub-result', subId, result: idbCached.result, heads: idbCached.heads, lastModified: idbCached.lastModified });
    }
  }

  // Register the subscription — if the doc is already open, attach directly;
  // otherwise store as pending (drained when the doc is opened via open-doc).
  const entry = docRegistry.get(docId);
  if (entry) {
    entry.subscriptions.set(subId, { filter, post });
    await pushToSubscriptions(docId);
  } else {
    let pending = pendingSubs.get(docId);
    if (!pending) { pending = new Map(); pendingSubs.set(docId, pending); }
    pending.set(subId, { filter, post });
  }
}

function handleUnsubscribeQuery(subId: number) {
  const docId = subIdToDocId.get(subId);
  if (docId) {
    subIdToDocId.delete(subId);
    const entry = docRegistry.get(docId);
    if (entry) entry.subscriptions.delete(subId);
    const pending = pendingSubs.get(docId);
    if (pending) {
      pending.delete(subId);
      if (pending.size === 0) pendingSubs.delete(docId);
    }
  }
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

  // Collect active filter hashes so we can evict stale cache entries below
  const activeHashes = new Set<string>();
  for (const [subId, sub] of entry.subscriptions) {
    activeHashes.add(hashStr(sub.filter));
    try {
      const { result, changed } = await runCachedQuery(docId, sub.filter, activeDoc, heads, lastModified);
      if (!changed) continue;
      sub.post({ type: 'sub-result', subId, result, heads, lastModified });
    } catch (err: any) {
      sub.post({ type: 'sub-result', subId, result: null, heads, error: errMsg(err) });
    }
  }

  // Protect validation cache from eviction
  activeHashes.add('validation');

  // Evict stale cache entries for this doc that no longer have an active subscription
  // (e.g. a calendarQuery for a previous date range). Entries with active subscriptions
  // were already updated by runCachedQuery above.
  const prefix = `qc:${docId}:`;
  for (const key of queryResultCache.keys()) {
    if (key.startsWith(prefix) && !activeHashes.has(key.slice(prefix.length))) {
      queryResultCache.delete(key);
      import('./idb-storage').then(({ idbDel }) => idbDel(key));
    }
  }

  if (hasValidation) {
    pushValidation(docId, activeDoc);
  }
}

function pushValidation(docId: string, doc: any) {
  const allErrors = validateDocument(doc);
  const errors = allErrors.slice(0, 100);
  const json = JSON.stringify(errors);
  const cacheKey = `qc:${docId}:validation`;

  const cached = queryResultCache.get(cacheKey);
  if (cached && cached.json === json) return; // unchanged

  const entry: QueryCacheEntry = { result: errors, json, heads: [] };
  queryResultCache.set(cacheKey, entry);
  import('./idb-storage').then(({ idbSet }) => idbSet(cacheKey, entry));

  (self as any).postMessage({ type: 'update-validation', docId, errors } satisfies WorkerToMain);
}

/**
 * After keyhive ingests remote ops, check if any new documents were shared
 * with us. We detect this by scanning pendingDecrypt — encrypted messages
 * we've received but couldn't decrypt because the doc wasn't registered yet.
 * After keyhive ingestion, getDocument() may now succeed for these docs.
 *
 * We intentionally don't use reachableDocs() because it returns ALL docs
 * visible in the keyhive graph (including docs on the same relay that
 * haven't been explicitly shared with this user).
 */

async function checkForNewKeyhiveDocs() {
  if (!khOps || !khBridge || !khIntegration) return;
  try {
    const { idbGet, idbSet } = await import('./idb-storage');
    type StoredDocEntry = { id: string; type?: string; name?: string; encrypted?: boolean; sharingGroupId?: string };
    const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
    const dismissed = new Set((await idbGet<string[]>('dismissed-doc-ids')) ?? []);
    const knownIds = new Set(list.map(e => e.id));
    let changed = false;
    const addDoc = (amDocId: string, khDocIdObj: any): boolean => {
      if (!isDiscoverable(amDocId, knownIds, dismissed)) return false;
      const khDocIdB64 = bytesToBase64(khDocIdObj.toBytes());
      console.log(`[worker] checkForNewKeyhiveDocs: discovered new doc ${amDocId} (kh=${khDocIdB64})`);
      khIntegration!.networkAdapter.registerDoc(amDocId, khDocIdObj);
      setDocRepo(amDocId, 'secure');
      list.unshift({ id: amDocId, encrypted: true });
      knownIds.add(amDocId);
      changed = true;
      return true;
    };

    const newDocHandles: string[] = [];

    // Check pending encrypted messages for docs not yet in docMap.
    // After ingestion, keyhive may now know about these docs even if
    // reachableDocs() doesn't list them yet.
    const na = khIntegration.networkAdapter as any;
    const pending: Array<{ automergeDocId: string }> = na.pendingDecrypt ?? [];
    const checkedIds = new Set<string>();
    for (const entry of pending) {
      const amDocId = entry.automergeDocId;
      if (knownIds.has(amDocId) || checkedIds.has(amDocId)) continue;
      checkedIds.add(amDocId);
      try {
        const automergeUrl = `automerge:${amDocId}`;
        const khDocId = khBridge!.docIdFromAutomergeUrl(automergeUrl as any);
        const doc = await khOps.kh.getDocument(khDocId);
        if (doc) {
          console.log(`[worker] checkForNewKeyhiveDocs: found pending doc ${amDocId} via getDocument`);
          if (addDoc(amDocId, khDocId)) newDocHandles.push(amDocId);
        }
      } catch {
        // Not a keyhive-formatted docId — skip
      }
    }

    if (changed) {
      await idbSet('automerge-doc-ids', list);
      (self as any).postMessage({ type: 'doc-list-updated', list } satisfies WorkerToMain);
      // Pre-load newly discovered docs so they show type/name on the homepage
      // instead of appearing as "?" until manually opened.
      for (const docId of newDocHandles) {
        try {
          const handle = await getOrLoadHandle(docId);
          getOrCreateEntry(docId, handle);
        } catch (err) {
          console.warn(`[worker] checkForNewKeyhiveDocs: failed to pre-load ${docId}:`, errMsg(err));
        }
      }
    }
  } catch (err) {
    console.warn('[worker] checkForNewKeyhiveDocs failed:', errMsg(err));
  }
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

      // --- Optionally create insecure repo ---
      if (msg.enableInsecureRepo) {
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
          getBlobs(_sedimentreeId: any) {
            if (!loadingDocId || !insecureRepo?.storageSubsystem) return Promise.resolve([]);
            return insecureRepo.storageSubsystem.loadDocData(loadingDocId)
              .then((data: Uint8Array | null) => data ? [data] : []);
          },
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
      } else {
        console.log('[worker] insecure repo disabled by user setting');
      }

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
          // Only load from storage for docs the current identity owns —
          // i.e., docs that were in the IDB doc list at init (which is
          // keyhive-verified). This prevents loading another user's data
          // from shared IndexedDB.
          getBlobs(_sedimentreeId: any) {
            if (!loadingDocId || !secureRepo?.storageSubsystem) {
              console.log(`[worker] secure getBlobs: skip (loadingDocId=${loadingDocId}, ss=${!!secureRepo?.storageSubsystem})`);
              return Promise.resolve([]);
            }
            if (getDocRepo(loadingDocId) !== 'secure') {
              console.log(`[worker] secure getBlobs: skip (docRepo=${getDocRepo(loadingDocId)} for ${loadingDocId})`);
              return Promise.resolve([]);
            }
            const docId = loadingDocId;
            return secureRepo.storageSubsystem.loadDocData(docId)
              .then((data: Uint8Array | null) => {
                console.log(`[worker] secure getBlobs(${docId}): ${data ? data.length + ' bytes' : 'null'}`);
                return data ? [data] : [];
              });
          },
          addCommit() { return Promise.resolve(undefined); },
          addFragment() { return Promise.resolve(undefined); },
        };
        // Slot for pre-generated keyhive doc IDs. enableSharing creates the
        // keyhive doc first, sets nextDocIdBytes, then create2() consumes it
        // so the automerge doc ID = keyhive doc ID.
        let nextDocIdBytes: Uint8Array | null = null;
        setNextDocId = (bytes: Uint8Array) => { nextDocIdBytes = bytes; };
        secureRepo = new Repo({
          network: [khIntegration.networkAdapter],
          storage: secureStorage,
          subduction: noopSubduction,
          peerId: khIntegration.peerId,
          idFactory: async () => {
            if (!nextDocIdBytes) throw new Error('nextDocIdBytes not set before create2');
            const bytes = nextDocIdBytes;
            nextDocIdBytes = null;
            return bytes;
          },
        } as any);

        khIntegration.linkRepo(secureRepo, {
          onBeforeShareConfigChanged: () => {
            // After keyhive ingests remote ops, check for newly discovered documents
            // (e.g. Bob was added as a member by Alice — the doc should appear in Bob's list)
            void checkForNewKeyhiveDocs();
            // Notify main thread so useAccess/Home can re-check access levels
            (self as any).postMessage({ type: 'kh-state-changed' } satisfies WorkerToMain);
          },
        });

        khOps = new KeyhiveOps(khIntegration.keyhive, khBridge as any, {
          persist: () => khIntegration!.keyhiveStorage.saveKeyhiveWithHash(khIntegration!.keyhive),
          syncKeyhive: () => khIntegration!.networkAdapter.syncKeyhive(),
          registerDoc: (amDocId, khDocId) => khIntegration!.networkAdapter.registerDoc(amDocId, khDocId),
          forceResyncAllPeers: () => (khIntegration!.networkAdapter as any).forceResyncAllPeers(),
          findDoc: (docId) => secureRepo!.find(docId as any),
          saveEventBytes: (eventBytes) => khIntegration!.keyhiveStorage.saveEventBytesWithHash(eventBytes),
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

        // --- Debug: dump keyhive archive contents ---
        try {
          const kh = khIntegration.keyhive;
          const me = await kh.individual;
          const stats = await kh.stats();
          const pendingHashes = await kh.pendingEventHashes();
          const reachable = await kh.reachableDocs();

          // Contact card
          const card = await kh.contactCard();
          let existingCard: any = null;
          try { existingCard = await kh.getExistingContactCard(); } catch {}

          // Public agent event counts (used by sync protocol)
          let publicEventInfo: any = null;
          try {
            const { Identifier: Id } = await import('@keyhive/keyhive/slim');
            const pubAgent = await kh.getAgent(Id.publicId());
            if (pubAgent) {
              const hashes = await kh.eventHashesForAgent(pubAgent);
              const events = await kh.eventsForAgent(pubAgent);
              publicEventInfo = {
                eventHashesForAgent: hashes.length,
                eventsForAgent: events.size,
                consistent: hashes.length === events.size,
              };
            }
          } catch {}

          // Per-doc details
          const docs: any[] = [];
          for (const summary of reachable) {
            const doc = summary.doc;
            const access = summary.access;
            const members: any[] = [];
            try {
              const caps = await kh.docMemberCapabilities(doc.doc_id);
              for (const m of caps) {
                members.push({
                  who: m.who.toString(),
                  agentId: bytesToBase64(m.who.id.toBytes()),
                  can: m.can.toString(),
                  isIndividual: m.who.isIndividual(),
                  isGroup: m.who.isGroup(),
                });
              }
            } catch {}

            // My access for this doc
            let myAccess: string | null = null;
            try {
              const { Identifier: Id } = await import('@keyhive/keyhive/slim');
              const myId = new Id(kh.id.bytes);
              const a = await kh.accessForDoc(myId, doc.doc_id);
              myAccess = a ? a.toString() : null;
            } catch {}

            docs.push({
              docId: bytesToBase64(doc.id.toBytes()),
              memberCount: members.length,
              summaryAccess: access.toString(),
              myAccess,
              members,
            });
          }

          // Pending hashes detail
          const pendingCount = pendingHashes ? Array.from(pendingHashes.keys()).length : 0;

          // Archive size
          const archive = await kh.toArchive();
          const archiveBytes = archive.toBytes();

          // Storage stats
          const storage = khIntegration.keyhiveStorage;
          let storedArchiveCount = 0;
          let storedEventCount = 0;
          try {
            const archiveChunks = await (storage as any).storage.loadRange(['keyhive', 'archives']);
            storedArchiveCount = archiveChunks.length;
            const eventChunks = await (storage as any).storage.loadRange(['keyhive', 'events']);
            storedEventCount = eventChunks.length;
          } catch {}

          console.log('[worker] === KEYHIVE ARCHIVE DUMP ===');
          console.log('[worker] identity:', {
            idString: String(kh.idString),
            agentId: bytesToBase64(me.id.toBytes()),
            contactCardId: bytesToBase64(card.id.toBytes()),
            existingCardId: existingCard ? bytesToBase64(existingCard.id.toBytes()) : null,
            cardIdMatch: existingCard ? bytesToBase64(card.id.toBytes()) === bytesToBase64(existingCard.id.toBytes()) : 'no existing card',
          });
          console.log('[worker] stats:', {
            totalOps: Number(stats.totalOps),
            archiveSize: archiveBytes.length,
            pendingEventHashes: pendingCount,
          });
          console.log('[worker] storage:', {
            storedArchives: storedArchiveCount,
            storedEvents: storedEventCount,
          });
          if (publicEventInfo) {
            console.log('[worker] publicAgent events:', publicEventInfo);
          }
          console.log('[worker] reachableDocs (' + docs.length + '):', docs);
          console.log('[worker] === END KEYHIVE DUMP ===');
        } catch (dumpErr) {
          console.warn('[worker] keyhive dump failed:', dumpErr);
        }

        // Pre-register encrypted docs with keyhive and push doc list + contact names
        // BEFORE kh-ready so code awaiting keyhiveReady can read them immediately.
        {
          const { idbGet: idbGetDocs } = await import('./idb-storage');
          type StoredDocEntry = { id: string; encrypted?: boolean; [key: string]: any };
          const earlyList = (await idbGetDocs<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
          for (const entry of earlyList) {
            if (entry.encrypted) {
              const khDocId = resolveKhDocId(entry.id);
              try {
                khOps!.registerDocMapping(entry.id, khDocId);
                await khOps!.registerSharingGroup(khDocId);
              } catch (err) {
                console.warn(`[worker] Failed to pre-register doc ${entry.id}:`, errMsg(err));
              }
            }
          }
          populateDocRepoMap(earlyList);
          (self as any).postMessage({ type: 'doc-list-updated', list: earlyList } satisfies WorkerToMain);
          const earlyNames = (await idbGetDocs<Record<string, string>>('contact-names')) ?? {};
          (self as any).postMessage({ type: 'contact-names-updated', names: earlyNames } satisfies WorkerToMain);
        }
        (self as any).postMessage({ type: 'kh-ready' } satisfies WorkerToMain);
      } catch (khErr: any) {
        console.error('[worker] keyhive init failed (continuing without encryption):', khErr);
        (self as any).postMessage({ type: 'kh-error', message: errMsg(khErr) } satisfies WorkerToMain);
      }

      // --- Store appBaseUrl ---
      appBaseUrl = msg.appBaseUrl;

      // Doc list and contact names already pushed before kh-ready above.
      // Re-read for invite pruning and keyhive GC below.
      const { idbGet } = await import('./idb-storage');
      type StoredDocEntry = { id: string; type?: string; name?: string; encrypted?: boolean; sharingGroupId?: string };
      const docList = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];

      // Prune invite records for docs no longer in the list
      const { pruneInvitesNotIn } = await import('./invite-storage');
      const knownDocIds = new Set(docList.map(d => d.id));
      await pruneInvitesNotIn(knownDocIds);

      // GC: self-revoke from keyhive docs no longer in our list
      if (khOps) {
        try {
          const reachable = await khOps.kh.reachableDocs();
          const myKhDocIds = new Set(docList.filter(d => d.encrypted).map(d => resolveKhDocId(d.id)));
          for (const summary of reachable) {
            const khDocId = bytesToBase64(summary.doc.id.toBytes());
            if (myKhDocIds.has(khDocId)) continue;
            try {
              await khOps.leaveDoc(khDocId);
              console.log(`[worker] keyhive GC: left doc ${khDocId}`);
            } catch (err: any) {
              console.warn(`[worker] keyhive GC: failed to leave doc ${khDocId}:`, errMsg(err));
            }
          }
        } catch (err: any) {
          console.warn('[worker] keyhive GC failed:', errMsg(err));
        }
      }

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
      if (msg.secure) {
        if (!secureRepo || !khOps || !setNextDocId) throw new Error('Secure repo not available');
        // Create the keyhive document first (no co-parents, correct access model).
        // Then create the automerge document using the keyhive doc_id as its ID
        // so that recipients can look up the keyhive doc from the automerge URL.
        const { docIdBytes } = await khOps.createKeyhiveDoc();
        setNextDocId(docIdBytes);
        handle = await secureRepo.create2(msg.initialJson);
        // Add to IDB BEFORE enableSharing so checkForNewKeyhiveDocs (triggered
        // by keyhive sync during enableSharing) sees it as already known.
        {
          const { idbGet: idbGetList, idbSet: idbSetList } = await import('./idb-storage');
          type S = { id: string; [k: string]: any };
          const earlyList = (await idbGetList<S[]>('automerge-doc-ids')) ?? [];
          earlyList.unshift({ id: handle.documentId, encrypted: true });
          await idbSetList('automerge-doc-ids', earlyList);
          (self as any).postMessage({ type: 'doc-list-updated', list: earlyList } satisfies WorkerToMain);
        }
        await khOps.enableSharing(handle.documentId, docIdBytes);
      } else {
        if (!insecureRepo) throw new Error('Insecure repo not available');
        handle = insecureRepo.create(msg.initialJson);
        // Add to IDB immediately so the doc is visible on the home page
        {
          const { idbGet: idbGetList, idbSet: idbSetList } = await import('./idb-storage');
          type S = { id: string; [k: string]: any };
          const earlyList = (await idbGetList<S[]>('automerge-doc-ids')) ?? [];
          earlyList.unshift({ id: handle.documentId, encrypted: false });
          await idbSetList('automerge-doc-ids', earlyList);
          (self as any).postMessage({ type: 'doc-list-updated', list: earlyList } satisfies WorkerToMain);
        }
      }
      const docId = handle.documentId;
      setDocRepo(docId, msg.secure ? 'secure' : 'insecure');
      // Repo.create() registers the save listener AFTER the initial handle.update(),
      // so the first heads-changed event is missed and the initial doc is never persisted.
      // Explicitly save to ensure the initial data survives a refresh.
      const repo = msg.secure ? secureRepo : insecureRepo;
      const doc = handle.doc();
      if (repo?.storageSubsystem && doc) {
        repo.storageSubsystem.saveDoc(docId, doc).then(() => {
          console.log(`[worker] create-doc: saveDoc OK for ${docId}`);
        }).catch((err: any) => {
          console.error(`[worker] create-doc: saveDoc FAILED for ${docId}:`, err);
        });
      }
      (self as any).postMessage({ type: 'result', id: msg.id, result: { docId } } satisfies WorkerToMain);
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
      } else if (khOps && khBridge && khIntegration) {
        // No local entry — check if our keyhive already knows about this doc
        // (e.g. we were added as a member by someone else)
        try {
          const automergeUrl = `automerge:${msg.docId}`;
          const khDocId = khBridge.docIdFromAutomergeUrl(automergeUrl as any);
          const doc = await khOps.kh.getDocument(khDocId);
          if (doc) {
            const khDocIdB64 = bytesToBase64(doc.id.toBytes());
            khOps.khDocuments.set(khDocIdB64, doc);
            khIntegration.networkAdapter.registerDoc(msg.docId, khDocId);
            setDocRepo(msg.docId, 'secure');
          }
        } catch (err) {
          console.warn('[worker] Failed to check keyhive for doc:', errMsg(err));
        }
      }
      progress(10, 'Finding document\u2026');
      let handle: any;
      if (getDocRepo(msg.docId) === undefined) {
        // Unknown repo — try both and use whichever becomes ready first.
        // This handles shared secure docs where keyhive hasn't synced yet.
        const result = await findInRepos(msg.docId, secureRepo, insecureRepo);
        handle = result.handle;
      } else {
        handle = await getOrLoadHandle(msg.docId);
      }
      getOrCreateEntry(msg.docId, handle);
      progress(50, 'Loading document data\u2026');
      const isReady = handle.isReady ? handle.isReady() : false;
      const secure = getDocRepo(msg.docId) === 'secure';
      if (isReady) {
        progress(100, 'Ready');
        post.postMessage({ type: 'result', id: msg.id, result: { docId: msg.docId, secure } } satisfies WorkerToMain);
      } else {
        // Wait for doc data to arrive
        handle.whenReady().then(() => {
          progress(100, 'Ready');
          post.postMessage({ type: 'result', id: msg.id, result: { docId: msg.docId, secure } } satisfies WorkerToMain);
        }).catch((err: any) => {
          post.postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
        });
      }
    } catch (err: any) {
      post.postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'subscribe-query') {
    try {
      await handleSubscribeQuery(msg.docId, msg.subId, msg.filter, (m) => (self as any).postMessage(m));
    } catch (err: any) {
      (self as any).postMessage({ type: 'sub-result', subId: msg.subId, result: null, heads: [], error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'unsubscribe-query') {
    handleUnsubscribeQuery(msg.subId);
  }

  if (msg.type === 'subscribe-validation') {
    // Serve from cache immediately (same pattern as query subscriptions)
    const valCacheKey = `qc:${msg.docId}:validation`;
    const valMemCached = queryResultCache.get(valCacheKey);
    if (valMemCached) {
      (self as any).postMessage({ type: 'update-validation', docId: msg.docId, errors: valMemCached.result } satisfies WorkerToMain);
    } else {
      const { idbGet } = await import('./idb-storage');
      const valIdbCached = await idbGet<QueryCacheEntry>(valCacheKey);
      if (valIdbCached) {
        queryResultCache.set(valCacheKey, valIdbCached);
        (self as any).postMessage({ type: 'update-validation', docId: msg.docId, errors: valIdbCached.result } satisfies WorkerToMain);
      }
    }
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const entry = getOrCreateEntry(msg.docId, handle);
      entry.validationSubscribed = true;
      // Push immediately (will be skipped if cache is fresh)
      await pushToSubscriptions(msg.docId);
    } catch (err: any) {
      (self as any).postMessage({ type: 'update-validation', docId: msg.docId, errors: [] } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'unsubscribe-validation') {
    const entry = docRegistry.get(msg.docId);
    if (entry) entry.validationSubscribed = false;
  }

  if (msg.type === 'set-doc-version') {
    try {
      const entry = docRegistry.get(msg.docId);
      if (!entry) return;
      entry.pinnedVersion = msg.version;
      await pushToSubscriptions(msg.docId);
    } catch (err: any) {
      console.warn('[worker] set-doc-version failed:', errMsg(err));
    }
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

  if (msg.type === 'subscribe-presence') {
    try {
      const handle = await getOrLoadHandle(msg.docId);
      const entry = getOrCreateEntry(msg.docId, handle);
      if (!entry.presence) {
        const presence = new PresenceClass({ handle });
        presence.start({ initialState: { viewing: true, focusedField: null }, heartbeatMs: 5000, peerTtlMs: 15000 });
        const sendPresence = () => {
          const peers = { ...presence.getPeerStates().value };
          (self as any).postMessage({ type: 'update-presence', docId: msg.docId, peers } satisfies WorkerToMain);
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

  if (msg.type === 'unsubscribe-presence') {
    const entry = docRegistry.get(msg.docId);
    if (entry?.presence) {
      entry.presence.stop();
      entry.presence = null;
    }
  }

  if (msg.type === 'set-presence') {
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
      // Don't re-add a doc the user explicitly deleted
      const dismissed = new Set((await idbGet<string[]>('dismissed-doc-ids')) ?? []);
      if (dismissed.has(msg.docId)) return;
      type StoredDocEntry = { id: string; [key: string]: any };
      const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
      const metadata = msg.metadata ?? {};
      const idx = list.findIndex(e => e.id === msg.docId);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...metadata, id: msg.docId };
        list.unshift(list.splice(idx, 1)[0]);
      } else {
        list.unshift({ id: msg.docId, ...metadata });
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
      // Clean up active subscriptions and query cache for removed doc
      const entry = docRegistry.get(msg.docId);
      if (entry) {
        for (const subId of entry.subscriptions.keys()) subIdToDocId.delete(subId);
        if (entry.presence) entry.presence.stop();
        docRegistry.delete(msg.docId);
      }
      queryResultCache.deletePrefix(`qc:${msg.docId}:`);
      const { idbDelPrefix } = await import('./idb-storage');
      idbDelPrefix(`qc:${msg.docId}:`);
      // Remove invite records for the deleted doc
      {
        const { removeInviteRecordsForDoc } = await import('./invite-storage');
        await removeInviteRecordsForDoc(msg.docId);
      }
      // Mark as dismissed BEFORE leaveDoc, so checkForNewKeyhiveDocs
      // won't re-add it if triggered during leaveDoc's syncKeyhive()
      const dismissed = (await idbGet<string[]>('dismissed-doc-ids')) ?? [];
      if (!dismissed.includes(msg.docId)) {
        dismissed.push(msg.docId);
        await idbSet('dismissed-doc-ids', dismissed);
      }
      // Self-revoke from keyhive ACL
      const removedKhDocId = removedEntry?.encrypted ? resolveKhDocId(msg.docId) : null;
      if (removedKhDocId && khOps) {
        try {
          await khOps.leaveDoc(removedKhDocId);
        } catch (err: any) {
          console.warn('[worker] leaveDoc failed on delete:', errMsg(err));
        }
        khOps.khDocuments.delete(removedKhDocId);
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
      (self as any).postMessage({ type: 'result', id: msg.id, result: identity } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-contact-card') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.getContactCard();
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
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
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-doc-members') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const khDocId = resolveKhDocId(msg.docId);
      const members = await khOps.getDocMembers(khDocId);
      const { getInviteRecords } = await import('./invite-storage');
      const invites = await getInviteRecords(msg.docId);
      (self as any).postMessage({ type: 'result', id: msg.id, result: { members, invites } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-my-access') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const khDocId = resolveKhDocId(msg.docId);
      const result = await khOps.getMyAccess(khDocId);
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-known-contacts') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const { idbGet } = await import('./idb-storage');
      const contactNames = (await idbGet<Record<string, string>>('contact-names')) ?? {};
      const contactAgentIds = Object.keys(contactNames);
      const excludeKhDocId = msg.excludeDocId ? resolveKhDocId(msg.excludeDocId) : undefined;
      const result = await khOps.getKnownContacts(excludeKhDocId, contactAgentIds);
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-list-devices') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const { idbGet } = await import('./idb-storage');
      const linkedIds = (await idbGet<string[]>('linked-devices')) ?? [];
      const myId = (await khOps.getIdentity()).deviceId;
      const devices: { agentId: string; role: string; isMe?: boolean }[] = [
        { agentId: myId, role: 'owner', isMe: true },
      ];
      for (const id of linkedIds) {
        devices.push({ agentId: id, role: 'linked', isMe: false });
      }
      (self as any).postMessage({ type: 'result', id: msg.id, result: devices } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-remove-device') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const { idbGet, idbSet } = await import('./idb-storage');
      const devices = (await idbGet<string[]>('linked-devices')) ?? [];
      const updated = devices.filter(id => id !== msg.agentId);
      await idbSet('linked-devices', updated);
      (self as any).postMessage({ type: 'result', id: msg.id, result: undefined } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-generate-invite') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const khDocId = resolveKhDocId(msg.docId);
      const result = await khOps.generateInvite(khDocId, msg.role);

      // Build invite URL and store record in IDB
      const members = await khOps.getDocMembers(khDocId);
      const { encodeInvitePayload } = await import('./invite/invite-codec');
      const seed = new Uint8Array(result.inviteKeyBytes);
      const inviteUrl = `${appBaseUrl}#/invite/${msg.docId}/${msg.docType}/${encodeInvitePayload(seed)}`;
      const { addInviteRecord } = await import('./invite-storage');
      await addInviteRecord({
        id: Date.now().toString(),
        docId: msg.docId,
        inviteUrl,
        role: msg.role,
        createdAt: Date.now(),
        inviteSignerAgentId: result.inviteSignerAgentId,
        baselineAgentIds: members.map((m: any) => m.agentId),
      });

      (self as any).postMessage({ type: 'result', id: msg.id, result: { ...result, inviteUrl } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-add-member') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const khDocId = resolveKhDocId(msg.docId);
      const result = await khOps.addMember(msg.agentId, khDocId, msg.role);
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-revoke-member') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const khDocId = resolveKhDocId(msg.docId);
      const result = await khOps.revokeMember(msg.agentId, khDocId);
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-change-role') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const khDocId = resolveKhDocId(msg.docId);
      const result = await khOps.changeRole(msg.agentId, khDocId, msg.newRole);
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
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

      const result = await khOps.claimInviteWithKeyhive(inviteKh, msg.docId);
      // khDocId is derived on-demand via resolveKhDocId.
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[kh-claim-invite] failed:', err);
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-dismiss-invite') {
    try {
      const { removeInviteRecord, getInviteRecords } = await import('./invite-storage');
      await removeInviteRecord(msg.inviteId);
      const invites = await getInviteRecords(msg.docId);
      (self as any).postMessage({ type: 'result', id: msg.id, result: { invites } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
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

  // --- HyperFormula worker port ---

  if (msg.type === 'hf-port') {
    const hfPort = (msg as any).port as MessagePort;
    const post = (m: any) => hfPort.postMessage(m);
    hfPort.onmessage = async (pe: MessageEvent) => {
      const pm = pe.data;
      if (pm.type === 'subscribe-query') {
        try {
          await handleSubscribeQuery(pm.docId, pm.subId, pm.filter, post);
        } catch (err: any) {
          post({ type: 'sub-result', subId: pm.subId, result: null, heads: [], error: errMsg(err) });
        }
      } else if (pm.type === 'unsubscribe-query') {
        handleUnsubscribeQuery(pm.subId);
      }
    };
  }
}

// Replace queue handler with real handler and drain
console.log('[worker] module loaded, queued messages:', pendingMessages.length);
self.onmessage = handleMessage;
for (const msg of pendingMessages) handleMessage(msg);
pendingMessages.length = 0;
