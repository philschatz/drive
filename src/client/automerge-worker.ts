import { deepAssign } from '../shared/deep-assign';
import { syncToTarget } from '../shared/sync-to-target';
import { validateDocument } from '../shared/schemas';
import { RELAY_PEER_ID } from '../shared/relay-identity';
import { KeyhiveOps, bytesToBase64, base64ToBytes, errMsg } from './keyhive-ops';
import { LRU } from './lru-cache';
import { decode as cborDecode, Encoder } from 'cbor-x';
import {
  RDV_SUB, RDV_UNSUB, RDV_MSG, RDV_PEER, isRendezvousType,
  type RendezvousStatus,
} from '../shared/rendezvous-protocol';
import { generateRendezvous, encryptString, decryptString } from './rendezvous-crypto';
// hashStr and QueryCacheEntry are also exported from idb-storage for main-thread use.
// Defined inline here to avoid adding a static import that may affect worker module loading.
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
interface QueryCacheEntry { result: any; json: string; lastModified?: number; heads: string[] }

export type MainToWorker =
  | { type: 'init' }
  | { type: 'set-cache-disabled'; id: number; disabled: boolean }
  | { type: 'clear-caches'; id: number }
  | { type: 'get-doc-list'; id: number }
  | { type: 'query'; id: number; docId: string; filter: string }
  // New worker-owned doc API
  | { type: 'create-doc'; id: number; initialJson: any; metadata?: Record<string, any> }
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
  // Doc list mutations (IDB-backed). Adding a doc is folded into 'create-doc';
  // every other doc enters the list via reconcileHomeDocs (keyhive-access driven).
  | { type: 'remove-me-from-doc'; docId: string }
  // Contact name mutations (IDB-backed). `id` correlates the result so the main
  // thread can await persistence and surface failures instead of losing them.
  | { type: 'set-contact-name'; id: number; agentId: string; name: string }
  | { type: 'remove-contact-name'; id: number; agentId: string }
  // Keyhive operations
  | { type: 'kh-get-identity'; id: number }
  | { type: 'kh-get-contact-card'; id: number }
  | { type: 'kh-receive-contact-card'; id: number; cardJson: string; isDevice?: boolean; userGroupId?: string | null }
  | { type: 'kh-get-doc-members'; id: number; docId: string }
  | { type: 'kh-get-my-access'; id: number; docId: string }
  | { type: 'kh-add-member'; id: number; agentId: string; docId: string; role: string }
  | { type: 'kh-revoke-member'; id: number; agentId: string; docId: string }
  | { type: 'kh-change-role'; id: number; agentId: string; docId: string; newRole: string }
  | { type: 'kh-list-devices'; id: number }
  | { type: 'kh-remove-device'; id: number; agentId: string }
  | { type: 'kh-ensure-user-group'; id: number; create?: boolean; adoptGroupId?: string; waitForSync?: boolean }
  | { type: 'kh-link-device'; id: number; deviceAgentId: string; peerGroupId?: string | null }
  | { type: 'kh-get-link-payload'; id: number }
  | { type: 'kh-get-known-contacts'; id: number; excludeDocId?: string }
  // Encrypted relay rendezvous (large-payload contact exchange via QR id+key)
  | { type: 'kh-rdv-create-share'; id: number; displayName?: string }
  | { type: 'kh-rdv-receive'; id: number; rendezvousId: string; key: string; displayName?: string }
  | { type: 'kh-rdv-link-create'; id: number }
  | { type: 'kh-rdv-link-join'; id: number; rendezvousId: string; key: string }
  | { type: 'kh-rdv-cancel'; rendezvousId: string }
  | { type: 'open-doc'; id: number; docId: string }
  | { type: 'subscribe-validation'; docId: string }
  | { type: 'unsubscribe-validation'; docId: string }
  | { type: 'hf-port'; port: MessagePort };

export type ValidationError = { path: (string | number)[]; message: string; kind?: 'schema' | 'dependency' | 'warning' };

export type WorkerToMain =
  | { type: 'ready'; peerId: string }
  | { type: 'kh-ready' }
  | { type: 'kh-error'; message: string }
  | { type: 'error'; message: string }
  | { type: 'data-warning'; message: string }
  | { type: 'peer-connected'; peerCount: number; peers: string[] }
  | { type: 'peer-disconnected'; peerCount: number; peers: string[] }
  | { type: 'ws-status'; connected: boolean }
  // New worker-owned doc API responses
  | { type: 'result'; id: number; result?: any; error?: string }
  | { type: 'query-result'; subId: number; result: any; heads: string[]; lastModified?: number; error?: string }
  | { type: 'update-presence'; docId: string; peers: Record<string, any> }
  // Document loading progress
  | { type: 'open-doc-progress'; id: number; pct: number; message: string }
  // Validation
  | { type: 'update-validation'; docId: string; errors: ValidationError[] }
  // Doc list / contact names push
  | { type: 'doc-list-updated'; list: Array<{ id: string; type?: string; name?: string; sharingGroupId?: string }> }
  | { type: 'contact-names-updated'; names: Record<string, string> }
  // Keyhive state changed (membership/access may have changed)
  | { type: 'kh-state-changed' }
  // Rendezvous progress (emitted for both the sharer and the receiver so each
  // side can render a step-by-step indicator; the receiver also gets a `result`)
  | { type: 'kh-rdv-event'; rendezvousId: string; status: RendezvousStatus; message?: string }
  // Relay message log
  | { type: 'relay-log'; entry: { id: number; ts: number; dir: 'sent' | 'recv'; message: any } };

// Catch-all error surfacing: any uncaught error or unhandled promise rejection in the
// worker is logged and forwarded to the main thread, which shows it in a banner. Registered
// first thing so it also covers failures during WASM/keyhive init.
// Mirror the main thread's message logging (worker-api.ts) from inside the worker
// so each `[main] → send X` pairs with a `[worker] ← recv X` and vice-versa. Log
// every outgoing type (no filter). Wrapping self.postMessage covers all ~70 send
// sites at once. Installed first thing, before any send (the error surfacing below).
const origPostMessage = self.postMessage.bind(self);
(self as any).postMessage = (msg: any, ...rest: any[]) => {
  try { console.log('[worker] → send', msg?.type, msg); } catch { /* never let logging break a send */ }
  return (origPostMessage as any)(msg, ...rest);
};

function reportWorkerError(prefix: string, detail: unknown) {
  const message = (detail as any)?.message || String(detail ?? 'Unknown worker error');
  console.error(`[worker] ${prefix}:`, detail);
  try {
    (self as any).postMessage({ type: 'data-warning', message } satisfies WorkerToMain);
  } catch { /* postMessage can fail if detail isn't structured-cloneable; message string is */ }
}
self.addEventListener('error', (e: ErrorEvent) => reportWorkerError('uncaught error', e.error ?? e.message));
self.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => reportWorkerError('unhandled rejection', e.reason));

// Queue messages that arrive while WASM is initializing
const pendingMessages: MessageEvent[] = [];
self.onmessage = (e: MessageEvent) => { pendingMessages.push(e); };

// Dynamic import so the queue handler above is registered BEFORE WASM top-level await runs
let Repo: any, IndexedDBStorageAdapter: any, Automerge: any;
let BrowserWebSocketClientAdapter: any;
let PresenceClass: any;
/** Convert keyhive doc-id bytes (== automerge BinaryDocumentId) → automerge doc id string. */
let amDocIdFromBytes: ((bytes: Uint8Array) => string) | null = null;
let khBridge: typeof import('@automerge/automerge-repo-keyhive') | null = null;
// Suppress chatty log/debug/info output from the third-party keyhive bridge
// (it has no log-level config): the [AMRepoKeyhive] firehose and the
// [Streaming+] per-type metrics report. warn/error pass through so real
// failures stay visible. Must run before the dynamic import of
// @automerge/automerge-repo-keyhive below.
const SILENCED_LOG_PREFIXES = ['[AMRepoKeyhive]', '[Streaming]', '[Streaming+]'];
for (const level of ['log', 'debug', 'info'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && SILENCED_LOG_PREFIXES.some((p) => (args[0] as string).startsWith(p))) return;
    orig(...args);
  };
}
try {
  console.log('[worker] importing modules...');
  // automerge-repo (subduction.37) builds Subduction internally, but its
  // constructor still calls into the subduction WASM (e.g. set_subduction_logger).
  // Importing the non-`/slim` entry of automerge-subduction initializes that WASM
  // as a side effect (vite aliases it to the web base64 build); the `/slim` entry
  // the Repo uses shares the same module-scoped instance. Must run before new Repo().
  await import('@automerge/automerge-subduction');
  const repoModule: any = await import('@automerge/automerge-repo');
  Repo = repoModule.Repo;
  PresenceClass = repoModule.Presence;
  // Keyhive doc-id bytes are the automerge BinaryDocumentId; stringify+parse is the
  // build-portable inverse of docIdFromAutomergeUrl (binaryToDocumentId isn't exported
  // from every entrypoint).
  const stringifyAutomergeUrl = repoModule.stringifyAutomergeUrl;
  const parseAutomergeUrl = repoModule.parseAutomergeUrl;
  amDocIdFromBytes = (bytes: Uint8Array) => parseAutomergeUrl(stringifyAutomergeUrl(bytes)).documentId;
  console.log('[worker] Repo imported');
  ({ IndexedDBStorageAdapter } = await import('@automerge/automerge-repo-storage-indexeddb'));
  ({ BrowserWebSocketClientAdapter } = await import('@automerge/automerge-repo-network-websocket'));
  Automerge = await import('@automerge/automerge');
  console.log('[worker] importing keyhive bridge...');
  khBridge = await import('@automerge/automerge-repo-keyhive');
  console.log('[worker] keyhive bridge imported (initKeyhiveWasm deferred to init handler)');
} catch (err: any) {
  console.error('[worker] Failed to load modules:', err);
  (self as any).postMessage({ type: 'error', message: `Module load failed: ${errMsg(err)}` });
  throw err;
}

let secureRepo: InstanceType<typeof Repo> | null = null;
let khIntegration: InstanceType<typeof khBridge.AutomergeRepoKeyhive> | null = null;
let khOps: KeyhiveOps | null = null;
let setNextDocId: ((bytes: Uint8Array) => void) | null = null;

// ── Encrypted relay rendezvous ───────────────────────────────────────────────
// Hands a large encrypted payload (e.g. a 25 KB keyhive contact bundle) between
// two peers who only share a short id+key from a QR code. See rendezvous-protocol.ts.
const rdvEncoder = new Encoder({ tagUint8Array: false, useRecords: false });
/** The underlying relay WebSocket (set during init). Rendezvous frames bypass the
 *  automerge-repo adapter and ride the raw socket. */
let rdvSocket: WebSocket | undefined;

/**
 * One live rendezvous. `onPeer` fires when another peer joins the topic (e.g. send
 * our card); `onData` fires with the decrypted payload of an inbound message. A
 * one-way share sets only `onPeer`; a receiver sets only `onData`; a device link
 * (bidirectional handshake) sets both.
 */
interface RdvSession {
  key: string;
  onPeer?: () => void;
  onData?: (plaintext: string) => void;
}
const rdvSessions = new Map<string, RdvSession>();
const RDV_RECEIVE_TIMEOUT_MS = 120_000;

function rdvSend(frame: { type: string; rendezvousId: string; data?: Uint8Array }): void {
  if (rdvSocket && rdvSocket.readyState === WebSocket.OPEN) {
    rdvSocket.send(rdvEncoder.encode(frame) as unknown as ArrayBuffer);
  }
}

/** Post a rendezvous progress event to the UI (drives the step indicator). */
function rdvEvent(rendezvousId: string, status: RendezvousStatus, message?: string): void {
  (self as any).postMessage(
    { type: 'kh-rdv-event', rendezvousId, status, ...(message !== undefined ? { message } : {}) } satisfies WorkerToMain,
  );
}

/** Encrypt and send a payload to the other peer on a rendezvous topic. */
async function rdvSendPayload(rendezvousId: string, key: string, plaintext: string): Promise<void> {
  const framed = await encryptString(key, plaintext);
  rdvSend({ type: RDV_MSG, rendezvousId, data: framed });
}

/** Handle an inbound rendezvous frame intercepted off the relay socket. */
function handleRendezvousFrame(msg: any): void {
  const rid: string | undefined = msg.rendezvousId;
  if (!rid) return;
  const session = rdvSessions.get(rid);
  if (!session) return;
  if (msg.type === RDV_PEER) {
    session.onPeer?.();
  } else if (msg.type === RDV_MSG && session.onData) {
    const data: Uint8Array = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
    decryptString(session.key, data)
      .then(pt => session.onData!(pt))
      .catch(err => console.error('[rdv] failed to decrypt inbound payload:', errMsg(err)));
  }
}

// ── Known-contact registry ───────────────────────────────────────────────────
// A received contact is "known" the moment we ingest their card — independent of
// whether we've named them or share a doc. getKnownContacts otherwise only sees
// contacts via docs or saved names, so a freshly added friend would be invisible.
// We persist their user-group id here so they surface immediately (by short id
// until renamed). Cleared when the user deletes the contact.
/** Persist a contact's user-group; returns true if we already knew them. */
async function addKnownContactGroup(groupId: string): Promise<boolean> {
  const { idbGet, idbSet } = await import('./idb-storage');
  const list = (await idbGet<string[]>('known-contact-groups')) ?? [];
  if (list.includes(groupId)) return true;
  list.push(groupId);
  await idbSet('known-contact-groups', list);
  return false;
}
async function removeKnownContactGroup(groupId: string): Promise<void> {
  const { idbGet, idbSet } = await import('./idb-storage');
  const list = (await idbGet<string[]>('known-contact-groups')) ?? [];
  const next = list.filter(g => g !== groupId);
  if (next.length !== list.length) await idbSet('known-contact-groups', next);
}

// ── Contact-name store ───────────────────────────────────────────────────────
// The worker is the single owner/writer of the persisted contact-name map (IDB
// key 'contact-names'); the main thread keeps only a read cache, refreshed from
// the 'contact-names-updated' broadcasts these helpers emit. Centralising the
// writes here lets worker-internal flows (e.g. the rendezvous contact exchange)
// name a contact directly, without a round-trip through the UI.
async function getContactNames(): Promise<Record<string, string>> {
  const { idbGet } = await import('./idb-storage');
  return (await idbGet<Record<string, string>>('contact-names')) ?? {};
}
function broadcastContactNames(names: Record<string, string>): void {
  (self as any).postMessage({ type: 'contact-names-updated', names } satisfies WorkerToMain);
}
/** Persist (or overwrite) a contact's name and broadcast the new map. Blank/absent = no-op. */
async function putContactName(agentId: string, name: string | undefined): Promise<void> {
  const trimmed = name?.trim();
  if (!trimmed) return;
  const names = await getContactNames();
  if (names[agentId] === trimmed) return;
  names[agentId] = trimmed;
  const { idbSet } = await import('./idb-storage');
  await idbSet('contact-names', names);
  broadcastContactNames(names);
}
/** Forget a contact's name and drop them from the known registry, then broadcast. */
async function deleteContactName(agentId: string): Promise<void> {
  const names = await getContactNames();
  delete names[agentId];
  const { idbSet } = await import('./idb-storage');
  await idbSet('contact-names', names);
  // "Delete contact" must also drop them from the known registry, else they'd
  // reappear (by short id) on the next getKnownContacts.
  await removeKnownContactGroup(agentId);
  broadcastContactNames(names);
}

/** Derive the keyhive doc-ID (base64) from an automerge doc-ID.
 *  Works because the automerge binary doc-ID bytes ARE the keyhive doc_id bytes. */
function resolveKhDocId(automergeDocId: string): string {
  const khDocIdObj = khBridge!.docIdFromAutomergeUrl(`automerge:${automergeDocId}` as any);
  return bytesToBase64(khDocIdObj.toBytes());
}

/** Return the (only) repo. */
function getRepo(): InstanceType<typeof Repo> {
  if (!secureRepo) throw new Error('Secure repo not initialized');
  return secureRepo;
}

// --- User-group migration: fold legacy flat 'linked-devices' into a keyhive Group ---
let linkedDevicesMigrated = false;

/** One-time: move any 'linked-devices' agentIds into the personal user-group. */
async function migrateLinkedDevices(): Promise<void> {
  if (linkedDevicesMigrated || !khOps) return;
  linkedDevicesMigrated = true;
  try {
    const { idbGet, idbSet } = await import('./idb-storage');
    const legacy = (await idbGet<string[]>('linked-devices')) ?? [];
    if (legacy.length === 0) return;
    await khOps.ensureUserGroup({ create: true });
    const pending = new Set<string>((await idbGet<string[]>('pending-group-adds')) ?? []);
    const remaining: string[] = [];
    for (const agentId of legacy) {
      try {
        await khOps.addDeviceToGroup(agentId);
        pending.delete(agentId);
      } catch {
        // Device's contact card not synced yet — retry on the next keyhive state change.
        remaining.push(agentId);
        pending.add(agentId);
      }
    }
    await idbSet('linked-devices', remaining);
    await idbSet('pending-group-adds', [...pending]);
  } catch (err) {
    console.warn('[worker] migrateLinkedDevices failed:', err);
  }
}

/** Retry adding any devices that couldn't be added to the group earlier. */
async function drainPendingGroupAdds(): Promise<void> {
  if (!khOps) return;
  try {
    const { idbGet, idbSet } = await import('./idb-storage');
    const pending = (await idbGet<string[]>('pending-group-adds')) ?? [];
    if (pending.length === 0) return;
    if (!(await khOps.getUserGroupId())) return;
    const stillPending: string[] = [];
    for (const agentId of pending) {
      try {
        await khOps.addDeviceToGroup(agentId);
      } catch {
        stillPending.push(agentId);
      }
    }
    await idbSet('pending-group-adds', stillPending);
    const legacy = (await idbGet<string[]>('linked-devices')) ?? [];
    const kept = legacy.filter((id) => stillPending.includes(id));
    if (kept.length !== legacy.length) await idbSet('linked-devices', kept);
  } catch (err) {
    console.warn('[worker] drainPendingGroupAdds failed:', err);
  }
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
  const r = getRepo();
  return await r.find(docId as any);
}

function getOrCreateEntry(docId: string, handle: any): DocEntry {
  let entry = docRegistry.get(docId);
  if (!entry) {
    entry = { handle, pinnedVersion: null, subscriptions: new Map(), presence: null, validationSubscribed: false };
    docRegistry.set(docId, entry);
    handle.on('change', () => { pushToSubscriptions(docId); });
    // Some automerge-repo versions also emit 'doc' for remote changes
    if (typeof handle.on === 'function') {
      handle.on('doc', () => { pushToSubscriptions(docId); });
    }
    // Drain subscriptions that were registered before the doc was opened
    const pending = pendingSubs.get(docId);
    if (pending) {
      for (const [subId, sub] of pending) entry.subscriptions.set(subId, sub);
      pendingSubs.delete(docId);
      void pushToSubscriptions(docId);
    }
  }
  return entry;
}

// --- Query caching ---

/**
 * Whether a summary subscription for a not-yet-open doc opens (loads + syncs via
 * repo.find) that doc in the background. The persisted qc: cache is always served first
 * for instant paint either way.
 *  - true (default): after serving the cache, open the doc so it syncs and the summary
 *    refreshes live — without this an un-found doc never syncs, so a remote edit to a
 *    listed-but-unopened doc leaves the homepage stale until it is opened.
 *  - false: only serve the cached summary; do not open the doc (lighter, but summaries
 *    stay stale until the doc is opened).
 */
const OPEN_DOCS_IN_BACKGROUND = true;

const jqCache = new LRU<string, (input: any) => any>(64);

/**
 * When true, all performance caches are bypassed: the compiled-filter `jqCache`, the
 * query result cache (`queryResultCache` + IDB `qc:*`), and the validation cache. Hydrated
 * from the persisted `settings:cache-disabled` setting at init; updated on `set-cache-disabled`.
 */
let cacheDisabled = false;

async function runQuery(filter: string, doc: any): Promise<any> {
  // When cacheDisabled, recompile the filter fresh each call instead of reusing jqCache.
  let fn = cacheDisabled ? undefined : jqCache.get(filter);
  if (!fn) {
    const { compile } = await import('../shared/jq');
    const compiled = compile(filter);
    fn = (input: any) => { const r = compiled(input); return r.length > 0 ? r[0] : null; };
    if (!cacheDisabled) jqCache.set(filter, fn);
  }
  return fn(doc);
}


/** In-memory LRU mirror of IDB query cache. */
const queryResultCache = new LRU<string, QueryCacheEntry>(256);

/** Run a query, check cache, persist if changed. */
async function runCachedQuery(
  docId: string, filter: string, doc: any, heads: string[], lastModified?: number,
): Promise<{ result: any; heads: string[]; lastModified?: number; changed: boolean }> {
  const result = await runQuery(filter, doc);

  if (cacheDisabled) {
    // Bypass the query result cache (in-memory + IDB) — always recompute, always emit.
    return { result, heads, lastModified, changed: true };
  }

  const cacheKey = `qc:${docId}:${hashStr(filter)}`;
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

  // Serve from cache if available, for instant paint. Skipped when caching is disabled —
  // results then come only from the live query below.
  if (!cacheDisabled) {
    const cacheKey = `qc:${docId}:${hashStr(filter)}`;
    const memoryCached = queryResultCache.get(cacheKey);
    if (memoryCached) {
      post({ type: 'query-result', subId, result: memoryCached.result, heads: memoryCached.heads, lastModified: memoryCached.lastModified });
    } else {
      const { idbGet } = await import('./idb-storage');
      const idbCached = await idbGet<QueryCacheEntry>(cacheKey);
      if (idbCached) {
        queryResultCache.set(cacheKey, idbCached);
        post({ type: 'query-result', subId, result: idbCached.result, heads: idbCached.heads, lastModified: idbCached.lastModified });
      }
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
    if (OPEN_DOCS_IN_BACKGROUND) {
      // Open (find + sync) the doc in the background so remote edits reach this
      // subscription and refresh the cached summary served above. Without this an
      // un-found doc never syncs, so a remote edit to a listed-but-unopened doc leaves
      // the homepage stale. getOrCreateEntry attaches change/doc listeners, drains
      // pending subs, and pushes fresh results.
      getOrLoadHandle(docId)
        .then(handle => getOrCreateEntry(docId, handle))
        .catch(err => console.warn(`[worker] subscribe-query open failed ${docId}:`, errMsg(err)));
    }
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
      sub.post({ type: 'query-result', subId, result, heads, lastModified });
    } catch (err: any) {
      sub.post({ type: 'query-result', subId, result: null, heads, error: errMsg(err) });
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
      console.log(`[worker] might want to (but will not) delete possibly stale key ${key}`);
    }
  }

  if (hasValidation) {
    pushValidation(docId, activeDoc);
  }
}

function pushValidation(docId: string, doc: any) {
  const allErrors = validateDocument(doc);
  const errors = allErrors.slice(0, 100);

  // When cacheDisabled, skip the validation cache — always emit below.
  if (!cacheDisabled) {
    const json = JSON.stringify(errors);
    const cacheKey = `qc:${docId}:validation`;

    const cached = queryResultCache.get(cacheKey);
    if (cached && cached.json === json) return; // unchanged

    const entry: QueryCacheEntry = { result: errors, json, heads: [] };
    queryResultCache.set(cacheKey, entry);
    import('./idb-storage').then(({ idbSet }) => idbSet(cacheKey, entry));
  }

  (self as any).postMessage({ type: 'update-validation', docId, errors } satisfies WorkerToMain);
}

/**
 * Reconcile the home doc list to equal the set of documents the current user's
 * personal user-group can access (at least read). This is the home page's source
 * of truth: it runs at init and whenever keyhive ingests ops (so a newly-linked
 * device auto-populates once its user-group membership syncs).
 *
 * - ADD any accessible doc not yet in the list (and pre-load it for name/type).
 * - PRUNE an encrypted entry the user-group can no longer access — but only when
 *   it's confirmed *revoked* (still reachable in the keyhive graph). A doc that's
 *   simply not reachable yet (offline / not synced) is kept, so we never wipe the
 *   list on a transient empty state.
 *
 * We filter by user-group access (not device): a doc's creating device holds a
 * permanent root delegation keyhive can't revoke, so a device-based check could
 * never "delete" a self-created doc.
 */
let reconcileInFlight = false;
let reconcilePending = false;
async function reconcileHomeDocs() {
  // Coalesce overlapping calls (the share-config callback can fire on every sync tick).
  if (reconcileInFlight) { reconcilePending = true; return; }
  reconcileInFlight = true;
  try {
    do {
      reconcilePending = false;
      await reconcileHomeDocsOnce();
    } while (reconcilePending);
  } finally {
    reconcileInFlight = false;
  }
}

async function reconcileHomeDocsOnce() {
  if (!khOps || !amDocIdFromBytes) return;
  try {
    const { accessibleKhIds, reachableKhIds } = await khOps.enumerateUserDocs();
    const { idbGet, idbSet } = await import('./idb-storage');
    type StoredDocEntry = { id: string; type?: string; name?: string; sharingGroupId?: string };
    const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
    const knownIds = new Set(list.map(e => e.id));
    const accessibleAmIds = new Set(accessibleKhIds.map(k => amDocIdFromBytes!(base64ToBytes(k))));
    const reachableSet = new Set(reachableKhIds);
    let changed = false;
    const newDocHandles: string[] = [];

    // ADD accessible docs missing from the list.
    for (const amDocId of accessibleAmIds) {
      if (knownIds.has(amDocId)) continue;
      console.log(`[worker] reconcileHomeDocs: adding accessible doc ${amDocId}`);
      list.unshift({ id: amDocId });
      knownIds.add(amDocId);
      newDocHandles.push(amDocId);
      changed = true;
    }

    // PRUNE entries the user-group can no longer access, but only when confirmed
    // revoked (still reachable in the graph). Keep unsynced/offline docs. A dangling
    // user-group (which would make EVERY doc look inaccessible and wipe the list) is
    // caught at startup by assertUserGroupIntact, so this pass can trust the view.
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (accessibleAmIds.has(e.id)) continue;
      const khDocId = resolveKhDocId(e.id);
      if (reachableSet.has(khDocId)) {
        console.log(`[worker] reconcileHomeDocs: removing revoked doc ${e.id}`);
        list.splice(i, 1);
        knownIds.delete(e.id);
        changed = true;
      }
    }

    if (changed) {
      await idbSet('automerge-doc-ids', list);
      (self as any).postMessage({ type: 'doc-list-updated', list } satisfies WorkerToMain);
      // Pre-load newly added docs so they show type/name on the homepage
      // instead of appearing as "?" until manually opened.
      for (const docId of newDocHandles) {
        try {
          const handle = await getOrLoadHandle(docId);
          getOrCreateEntry(docId, handle);
        } catch (err) {
          console.warn(`[worker] reconcileHomeDocs: failed to pre-load ${docId}:`, errMsg(err));
        }
      }
    }
  } catch (err) {
    console.warn('[worker] reconcileHomeDocs failed:', errMsg(err));
  }
}

function postStatus() {
  const peers = secureRepo ? secureRepo.peers : [];
  const peerCount = peers.length;
  (self as any).postMessage({ type: peerCount > 0 ? 'peer-connected' : 'peer-disconnected', peerCount, peers } satisfies WorkerToMain);
}


async function handleMessage(e: MessageEvent<MainToWorker>) {
  const msg = e.data;
  console.log('[worker] ← recv', msg.type, msg);

  if (msg.type === 'init') {
    try {
      console.log('[worker] init message received');

      // Hydrate the cache-disabled flag from its persisted setting (IDB source of truth).
      try {
        const { settingGet } = await import('./idb-storage');
        cacheDisabled = (await settingGet('cache-disabled')) === true;
      } catch (err) {
        console.warn('[worker] failed to read cache-disabled setting:', errMsg(err));
      }

      // --- Create secure repo ---
      try {
        if (!khBridge) throw new Error('Keyhive bridge not loaded');

        await khBridge.initKeyhiveWasm();
        console.log('[worker] keyhive WASM initialized');

        const secureStorage = new IndexedDBStorageAdapter('automerge-secure');
        const secureWs = new BrowserWebSocketClientAdapter(
          self.location?.protocol === 'https:'
            ? 'wss://drive-relay-ebe030e3546f.herokuapp.com'
            : `ws://${self.location?.hostname || 'localhost'}:${self.location?.port || 3000}`
        );

        // --- Relay message logging (wire-level interception) ---
        const ENC_ENCRYPTED_FLAG = 0x01;
        let relayLogId = 0;

        function toBase64(bytes: Uint8Array): string {
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const b64 = btoa(binary);
          return b64.length > 256 ? b64.slice(0, 256) + '...' : b64;
        }

        function summarizeForLog(val: unknown): unknown {
          if (val instanceof Uint8Array) {
            if (val.length === 0) return '[0 bytes]';
            if (val[0] === ENC_ENCRYPTED_FLAG) return { _encrypted: true, bytes: val.length };
            return { bytes: val.length, base64: toBase64(val) };
          }
          if (Array.isArray(val)) {
            return val.map(item => summarizeForLog(item));
          }
          if (val && typeof val === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(val)) out[k] = summarizeForLog(v);
            return out;
          }
          return val;
        }

        function decodeMessageForLog(msg: any): any {
          const entry: any = { type: msg.type };
          if (msg.senderId) entry.senderId = msg.senderId;
          if (msg.targetId) entry.targetId = msg.targetId;
          if (msg.documentId) entry.documentId = msg.documentId;
          if (msg.peerMetadata) entry.peerMetadata = msg.peerMetadata;
          if (msg.supportedProtocolVersions) entry.supportedProtocolVersions = msg.supportedProtocolVersions;
          if (msg.selectedProtocolVersion) entry.selectedProtocolVersion = msg.selectedProtocolVersion;
          // ephemeral message fields
          if (msg.count !== undefined) entry.count = msg.count;
          if (msg.sessionId) entry.sessionId = msg.sessionId;

          if (msg.data && msg.data instanceof Uint8Array && msg.data.length > 0) {
            try {
              const decoded = cborDecode(msg.data);
              if (decoded && typeof decoded === 'object' && decoded.signed instanceof Uint8Array) {
                // KeyhiveMessageData: { contactCard: string, signed: Uint8Array }
                const signedEntry: any = {
                  signed: { _signed: true, bytes: decoded.signed.length, base64: toBase64(decoded.signed) },
                };
                if (decoded.contactCard) signedEntry.contactCard = decoded.contactCard;
                entry.data = signedEntry;
              } else {
                // Some other CBOR structure — include full decoded content
                entry.data = summarizeForLog(decoded);
              }
            } catch {
              // Not valid CBOR — include raw bytes
              if (msg.data[0] === ENC_ENCRYPTED_FLAG) {
                entry.data = { _encrypted: true, bytes: msg.data.length };
              } else {
                entry.data = { bytes: msg.data.length, base64: toBase64(msg.data) };
              }
            }
          } else if (msg.data) {
            entry.data = { bytes: msg.data.byteLength ?? msg.data.length ?? 0 };
          }
          return entry;
        }

        function postRelayLog(dir: 'sent' | 'recv', msg: any) {
          try {
            const entry = { id: ++relayLogId, ts: Date.now(), dir, message: decodeMessageForLog(msg) };
            (self as any).postMessage({ type: 'relay-log', entry } satisfies WorkerToMain);
          } catch { /* never let logging break the app */ }
        }

        // Monkey-patch send — intercepts the Message object before CBOR encoding
        const origSend = secureWs.send.bind(secureWs);
        (secureWs as any).send = (message: any) => {
          postRelayLog('sent', message);
          return origSend(message);
        };

        // Monkey-patch receiveMessage — intercepts raw bytes from the WebSocket
        const origReceive = secureWs.receiveMessage.bind(secureWs);
        (secureWs as any).receiveMessage = (bytes: Uint8Array) => {
          try {
            const decoded = cborDecode(new Uint8Array(bytes));
            // Rendezvous frames ride the same socket but aren't automerge-repo
            // protocol — handle them and DON'T forward to the repo adapter.
            if (isRendezvousType(decoded?.type)) {
              handleRendezvousFrame(decoded);
              return;
            }
            postRelayLog('recv', decoded);
          } catch { /* ignore decode errors for logging */ }
          return origReceive(bytes);
        };
        // Expose the raw socket so rendezvous frames can bypass the repo adapter.
        // The adapter recreates its socket on reconnect, so read it lazily too.
        rdvSocket = (secureWs as any).socket;
        const origOnOpenForRdv = secureWs.onOpen;
        secureWs.onOpen = () => { rdvSocket = (secureWs as any).socket; origOnOpenForRdv(); };
        // --- End relay message logging ---

        khIntegration = await khBridge.initializeAutomergeRepoKeyhive({
          storage: secureStorage,
          peerIdSuffix: 'drive',
          networkAdapter: secureWs,
          onlyShareWithHardcodedServerPeerId: false,
          periodicallyRequestSync: true,
          automaticArchiveIngestion: true,
          cachingMode: 'none',
          syncRequestInterval: 2000,
        });

        // Slot for pre-generated keyhive doc IDs. enableSharing creates the
        // keyhive doc first, sets nextDocIdBytes, then create2() consumes it
        // so the automerge doc ID = keyhive doc ID.
        let nextDocIdBytes: Uint8Array | null = null;
        setNextDocId = (bytes: Uint8Array) => { nextDocIdBytes = bytes; };
        // shareConfig gates which docs are announced to which peers based on
        // keyhive membership. A doc the peer has no keyhive access to is not
        // announced/shared. Once Alice shares with Bob via keyhive, Bob gains
        // access and the keyhive bridge calls repo.shareConfigChanged() — at
        // that point the doc starts being announced to Bob.
        // The official bridge derives the keyhive DocumentId directly from the
        // automerge doc id (they share the same bytes), so we just look up
        // bestAccessForDoc for the peer's keyhive Identifier.
        const khAccessCheck = async (peerId: string, docId: string | undefined): Promise<boolean> => {
          if (!docId) return false;
          // The relay is a router, not a keyhive member — never announce docs to it.
          if (peerId === RELAY_PEER_ID) return false;
          try {
            // peerId is "<base64 verifying key>-<suffix>"; recover the Identifier.
            const keyB64 = khBridge!.verifyingKeyPeerIdWithoutSuffix(peerId as any);
            const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
            const identifier = new khBridge!.Identifier(keyBytes);
            const access = await khIntegration!.bestAccessForDoc(identifier, `automerge:${docId}` as any);
            return access !== undefined;
          } catch {
            return false;
          }
        };
        secureRepo = new Repo({
          network: [khIntegration.networkAdapter],
          storage: secureStorage,
          peerId: khIntegration.peerId,
          shareConfig: {
            announce: khAccessCheck,
            access: khAccessCheck as (peer: string, doc: string) => Promise<boolean>,
          },
          idFactory: async () => {
            if (!nextDocIdBytes) throw new Error('nextDocIdBytes not set before create2');
            const bytes = nextDocIdBytes;
            nextDocIdBytes = null;
            return bytes;
          },
        } as any);

        khIntegration.linkRepo(secureRepo, {
          onBeforeShareConfigChanged: () => {
            // After keyhive ingests remote ops, reconcile the home list to the
            // user-group's accessible docs (e.g. a doc shared with us, or a newly
            // linked device gaining access to the user's whole library).
            void reconcileHomeDocs();
            // Retry any device-group adds that were waiting on contact cards to sync.
            void drainPendingGroupAdds();
            // Notify main thread so useAccess/Home can re-check access levels
            (self as any).postMessage({ type: 'kh-state-changed' } satisfies WorkerToMain);
          },
        });

        khOps = new KeyhiveOps(khIntegration.keyhive, khBridge as any, {
          persist: () => khIntegration!.keyhiveStorage.saveKeyhiveWithHash(khIntegration!.keyhive),
          syncKeyhive: () => khIntegration!.networkAdapter.syncKeyhive(),
          // The official bridge derives the keyhive DocumentId from the automerge
          // doc id directly, so there is no explicit doc registration step.
          registerDoc: () => { },
          // After a local keyhive membership change, re-evaluate shareConfig so
          // newly-authorized peers get the doc announced (the official adapter
          // has no explicit forceResync; shareConfigChanged is the equivalent).
          forceResyncAllPeers: () => secureRepo!.shareConfigChanged(),
          findDoc: (docId) => secureRepo!.find(docId as any),
          saveEventBytes: (eventBytes) => khIntegration!.keyhiveStorage.saveEventBytesWithHash(eventBytes),
          getUserGroupId: async () => {
            const { idbGet } = await import('./idb-storage');
            return (await idbGet<string>('user-group-id')) ?? null;
          },
          setUserGroupId: async (groupId) => {
            const { idbSet } = await import('./idb-storage');
            await idbSet('user-group-id', groupId);
          },
        });

        // Fold any legacy flat linked-devices into a personal user-group (one-time).
        void migrateLinkedDevices();

        const secureNs = secureRepo.networkSubsystem;
        secureNs.on('peer', postStatus);
        secureNs.on('peer-disconnected', postStatus);

        // --- Subduction peer connections (disabled while debugging sync) ---
        // TODO: Wire up NetworkAdapterConnection + connectTransport/acceptTransport
        // when Subduction handshake issues are resolved.
        // Monitor WS open/close directly for connection status
        const origSecureOpen = secureWs.onOpen;
        const origSecureClose = secureWs.onClose;
        secureWs.onOpen = () => { origSecureOpen(); (self as any).postMessage({ type: 'ws-status', connected: true } satisfies WorkerToMain); };
        secureWs.onClose = () => { origSecureClose(); (self as any).postMessage({ type: 'ws-status', connected: false } satisfies WorkerToMain); };

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
          try { existingCard = await kh.getExistingContactCard(); } catch { }

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
          } catch { }

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
            } catch { }

            // My access for this doc
            let myAccess: string | null = null;
            try {
              const { Identifier: Id } = await import('@keyhive/keyhive/slim');
              const myId = new Id(kh.id.bytes);
              const a = await kh.accessForDoc(myId, doc.doc_id);
              myAccess = a ? a.toString() : null;
            } catch { }

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
          } catch { }

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

        // Pre-register docs with keyhive and push doc list + contact names BEFORE
        // kh-ready so code awaiting keyhiveReady can read them immediately.
        {
          const { idbGet: idbGetDocs } = await import('./idb-storage');
          type StoredDocEntry = { id: string;[key: string]: any };
          const earlyList = (await idbGetDocs<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
          for (const entry of earlyList) {
            const khDocId = resolveKhDocId(entry.id);
            try {
              khOps!.registerDocMapping(entry.id, khDocId);
              await khOps!.registerSharingGroup(khDocId);
            } catch (err) {
              console.warn(`[worker] Failed to pre-register doc ${entry.id}:`, errMsg(err));
            }
          }
          (self as any).postMessage({ type: 'doc-list-updated', list: earlyList } satisfies WorkerToMain);
          broadcastContactNames(await getContactNames());
        }
        (self as any).postMessage({ type: 'kh-ready' } satisfies WorkerToMain);
      } catch (khErr: any) {
        console.error('[worker] keyhive init failed (continuing without encryption):', khErr);
        (self as any).postMessage({ type: 'kh-error', message: errMsg(khErr) } satisfies WorkerToMain);
      }

      // Detect a dangling user-group (id persisted but its group missing from keyhive,
      // e.g. keyhive storage was migrated/reset while the IDB id survived). Such a group
      // can administer no docs, so reconcileHomeDocs would see zero accessible docs and
      // prune the whole home list. Surface it as a warning and SKIP reconcile — the app
      // stays usable (docs are preserved, served from the IDB list) and the user can
      // recover via Settings → Delete All Data. We don't abort init: that would hang every
      // request()-gated screen on an infinite spinner.
      const danglingGroup = khOps ? await khOps.findDanglingUserGroup() : null;
      if (danglingGroup) {
        console.error(`[worker] user-group ${danglingGroup} is dangling (missing from keyhive) — skipping reconcile to preserve the home list`);
        (self as any).postMessage({
          type: 'data-warning',
          message: `Your user-group is missing from local keyhive storage (likely from a data migration). Documents are preserved, but sharing is broken — reset via Settings → Delete All Data.`,
        } satisfies WorkerToMain);
      } else {
        // Reconcile the home list to the docs the user-group can access. (Replaces the
        // old GC that self-revoked from reachable docs missing from the local list — the
        // opposite of this model. Deletion now removes access explicitly via removeMyAccess,
        // and the share-config callback reconciles again as more ops sync in.)
        void reconcileHomeDocs();
      }

      console.log('[worker] init complete');
      (self as any).postMessage({ type: 'ready', peerId: secureRepo!.peerId } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[worker] init failed:', err);
      (self as any).postMessage({ type: 'error', message: errMsg(err) } satisfies WorkerToMain);
    }
  }

  // --- Cache controls ---

  if (msg.type === 'set-cache-disabled') {
    try {
      cacheDisabled = msg.disabled;
      const { settingSet, idbDelPrefix } = await import('./idb-storage');
      await settingSet('cache-disabled', msg.disabled);
      if (msg.disabled) {
        // Clear performance caches when disabling. (The caller reloads afterward, so the
        // in-memory LRUs are also wiped on restart; the IDB clear is the part that persists.)
        queryResultCache.clear();
        jqCache.clear();
        await idbDelPrefix('qc:');
      }
      (self as any).postMessage({ type: 'result', id: msg.id, result: null } satisfies WorkerToMain);
    } catch (err) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
    return;
  }

  if (msg.type === 'clear-caches') {
    try {
      queryResultCache.clear();
      jqCache.clear();
      const { idbDelPrefix } = await import('./idb-storage');
      await idbDelPrefix('qc:');
      (self as any).postMessage({ type: 'result', id: msg.id, result: null } satisfies WorkerToMain);
    } catch (err) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
    return;
  }

  if (msg.type === 'get-doc-list') {
    try {
      const { idbGet } = await import('./idb-storage');
      type StoredDocEntry = { id: string; type?: string; name?: string; sharingGroupId?: string };
      const list = (await idbGet<StoredDocEntry[]>('automerge-doc-ids')) ?? [];
      (self as any).postMessage({ type: 'result', id: msg.id, result: list } satisfies WorkerToMain);
    } catch (err) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
    return;
  }

  // --- New worker-owned doc API ---

  if (msg.type === 'create-doc') {
    try {
      if (!secureRepo || !khOps || !setNextDocId) throw new Error('Secure repo not available');
      // Create the keyhive document first (no co-parents, correct access model).
      // Then create the automerge document using the keyhive doc_id as its ID
      // so that recipients can look up the keyhive doc from the automerge URL.
      const { docIdBytes } = await khOps.createKeyhiveDoc();
      setNextDocId(docIdBytes);
      const handle = await secureRepo.create2(msg.initialJson);
      // Add to IDB BEFORE enableSharing so reconcileHomeDocs (triggered by
      // keyhive sync during enableSharing) sees it as already known.
      {
        const { idbGet: idbGetList, idbSet: idbSetList } = await import('./idb-storage');
        type S = { id: string;[k: string]: any };
        const earlyList = (await idbGetList<S[]>('automerge-doc-ids')) ?? [];
        earlyList.unshift({ id: handle.documentId, ...(msg.metadata ?? {}) });
        await idbSetList('automerge-doc-ids', earlyList);
        (self as any).postMessage({ type: 'doc-list-updated', list: earlyList } satisfies WorkerToMain);
      }
      await khOps.enableSharing(handle.documentId, docIdBytes);
      const docId = handle.documentId;
      // Repo.create() registers the save listener AFTER the initial handle.update(),
      // so the first heads-changed event is missed and the initial doc is never persisted.
      // Explicitly save to ensure the initial data survives a refresh.
      const doc = handle.doc();
      if (secureRepo.storageSubsystem && doc) {
        secureRepo.storageSubsystem.saveDoc(docId, doc).then(() => {
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
      // Check if our keyhive already knows about this doc
      // (e.g. we were added as a member by someone else)
      if (khOps && khBridge && khIntegration) {
        try {
          const automergeUrl = `automerge:${msg.docId}`;
          const khDocId = khBridge.docIdFromAutomergeUrl(automergeUrl as any);
          const doc = await khOps.kh.getDocument(khDocId);
          if (doc) {
            const khDocIdB64 = bytesToBase64(doc.id.toBytes());
            khOps.khDocuments.set(khDocIdB64, doc);
            // Official bridge maps automerge doc id -> keyhive DocumentId on demand;
            // no explicit registerDoc needed.
          }
        } catch (err) {
          console.warn('[worker] Failed to check keyhive for doc:', errMsg(err));
        }
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
      (self as any).postMessage({ type: 'query-result', subId: msg.subId, result: null, heads: [], error: errMsg(err) } satisfies WorkerToMain);
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

  // --- Presence temporarily disabled ---
  if (msg.type === 'subscribe-presence') {
    // no-op
  }

  if (msg.type === 'unsubscribe-presence') {
    // no-op
  }

  if (msg.type === 'set-presence') {
    // no-op
  }

  // --- Doc list mutations (IDB-backed) ---

  if (msg.type === 'remove-me-from-doc') {
    try {
      const { idbGet, idbSet } = await import('./idb-storage');
      type StoredDocEntry = { id: string;[key: string]: any };
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
      await idbDelPrefix(`qc:${msg.docId}:`);
      // Remove the current user (their user-group) from the doc's keyhive ACL.
      // No dismissed-list bookkeeping: losing group access is what makes the doc
      // drop off the home list (here and on the user's other devices) at the next
      // reconcile — there's nothing to hide.
      const removedKhDocId = removedEntry ? resolveKhDocId(msg.docId) : null;
      if (removedKhDocId && khOps) {
        try {
          await khOps.removeMyAccess(removedKhDocId);
        } catch (err: any) {
          console.warn('[worker] removeMyAccess failed on delete:', errMsg(err));
        }
        khOps.khDocuments.delete(removedKhDocId);
      }
      (self as any).postMessage({ type: 'doc-list-updated', list: filtered } satisfies WorkerToMain);
    } catch (err: any) {
      console.warn('[worker] remove-me-from-doc failed:', errMsg(err));
    }
  }

  // --- Contact name mutations (IDB-backed) ---

  if (msg.type === 'set-contact-name') {
    try {
      await putContactName(msg.agentId, msg.name);
      (self as any).postMessage({ type: 'result', id: msg.id } satisfies WorkerToMain);
    } catch (err: any) {
      // Surface the failure instead of swallowing it — a lost write must not look
      // like a successful save (it would silently vanish on the next reload).
      console.error('[worker] set-contact-name failed:', errMsg(err));
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'remove-contact-name') {
    try {
      await deleteContactName(msg.agentId);
      (self as any).postMessage({ type: 'result', id: msg.id } satisfies WorkerToMain);
    } catch (err: any) {
      console.error('[worker] remove-contact-name failed:', errMsg(err));
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
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
      // A friend is always a user-group (sharing is group-only). A friend link
      // with no group id is not a group — reject it. Device links are exempt
      // (they legitimately add an individual device to your own group).
      if (!msg.isDevice && !msg.userGroupId) {
        throw new Error('This contact is not a group — ask them to open Settings and show a fresh friend QR/link.');
      }
      const result = await khOps.receiveContactCard(msg.cardJson);
      // We identify a friend by their user-group id (their share target), never by
      // a bare individual device id. The group id is what the client persists as
      // the contact (its name), so surface it back alongside the individual.
      const friendGroupId = msg.isDevice ? null : msg.userGroupId;
      const alreadyKnown = !result.isOwnCard && !!friendGroupId
        ? await addKnownContactGroup(friendGroupId)
        : false;
      (self as any).postMessage({
        type: 'result',
        id: msg.id,
        result: { ...result, userGroupId: friendGroupId, alreadyKnown },
      } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-doc-members') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const khDocId = resolveKhDocId(msg.docId);
      const members = await khOps.getDocMembers(khDocId);
      (self as any).postMessage({ type: 'result', id: msg.id, result: { members } } satisfies WorkerToMain);
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
      const contactNames = await getContactNames();
      const knownGroups = (await idbGet<string[]>('known-contact-groups')) ?? [];
      // Contacts are keyed by user-group id (sharing is group-only): union the
      // named contacts with received-but-unnamed ones from the known registry.
      const contactGroupIds = [...new Set([...Object.keys(contactNames), ...knownGroups])];
      const excludeKhDocId = msg.excludeDocId ? resolveKhDocId(msg.excludeDocId) : undefined;
      const result = await khOps.getKnownContacts(excludeKhDocId, contactGroupIds);
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  // Sharer: stage our (large) contact bundle for a rendezvous and return the
  // tiny {id,key} for the QR. Bidirectional, like device-link: we send our bundle
  // when the friend joins, then ingest the bundle they send back so the friendship
  // is mutual from a single exchange (the friend never has to reciprocate by hand).
  if (msg.type === 'kh-rdv-create-share') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const userGroupId = await khOps.ensureUserGroup({ create: true });
      const card = await khOps.getContactCard();
      const plaintext = JSON.stringify({ card, displayName: msg.displayName, userGroupId: userGroupId ?? undefined });
      const { rendezvousId, key } = generateRendezvous();
      rdvSessions.set(rendezvousId, {
        key,
        // Leg 1: send our bundle as soon as the friend joins the channel.
        onPeer: () => {
          rdvEvent(rendezvousId, 'peer-joined');
          rdvEvent(rendezvousId, 'sending');
          rdvSendPayload(rendezvousId, key, plaintext)
            .catch(err => rdvEvent(rendezvousId, 'error', errMsg(err)));
        },
        // Leg 2: ingest the friend's bundle so they become our contact too, then
        // close the channel. Completion ('received') only fires after this.
        onData: (pt) => {
          (async () => {
            try {
              rdvEvent(rendezvousId, 'receiving');
              const { card: peerCard, displayName: peerName, userGroupId: peerGroupId } = JSON.parse(pt);
              const result = await khOps!.receiveContactCard(peerCard);
              const resolvedGroupId = peerGroupId ?? result.groupId ?? null;
              if (!result.isOwnCard && resolvedGroupId) {
                await addKnownContactGroup(resolvedGroupId);
                // We have no UI to name the friend on this (sharer) side, so adopt
                // the name they sent — the worker owns contact names, so it can.
                await putContactName(resolvedGroupId, peerName);
              }
              rdvSessions.delete(rendezvousId);
              rdvSend({ type: RDV_UNSUB, rendezvousId });
              rdvEvent(rendezvousId, 'received');
            } catch (err: any) {
              rdvEvent(rendezvousId, 'error', errMsg(err));
            }
          })();
        },
      });
      rdvSend({ type: RDV_SUB, rendezvousId });
      rdvEvent(rendezvousId, 'waiting');
      (self as any).postMessage({ type: 'result', id: msg.id, result: { rendezvousId, key } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  // Receiver: subscribe to the rendezvous, wait for the encrypted bundle, decrypt
  // it, and ingest the contact card — then send our own bundle back over the same
  // channel so the friendship is mutual (the sharer's onData ingests it). Resolves
  // like kh-receive-contact-card.
  if (msg.type === 'kh-rdv-receive') {
    const { rendezvousId, key } = msg;
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const plaintext = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          rdvSessions.delete(rendezvousId);
          reject(new Error('Timed out waiting for your friend. Make sure they have the QR/link open, then try again.'));
        }, RDV_RECEIVE_TIMEOUT_MS);
        rdvSessions.set(rendezvousId, {
          key,
          onPeer: () => rdvEvent(rendezvousId, 'peer-joined'),
          onData: (pt) => {
            clearTimeout(timer);
            rdvSessions.delete(rendezvousId);
            rdvEvent(rendezvousId, 'receiving');
            resolve(pt);
          },
        });
        rdvSend({ type: RDV_SUB, rendezvousId });
        rdvEvent(rendezvousId, 'waiting');
      });

      let cardJson = plaintext;
      let displayName: string | undefined;
      let userGroupId: string | undefined;
      try {
        const parsed = JSON.parse(plaintext);
        if (parsed && typeof parsed === 'object' && typeof parsed.card === 'string') {
          cardJson = parsed.card; displayName = parsed.displayName; userGroupId = parsed.userGroupId;
        }
      } catch { /* raw card string */ }

      const result = await khOps.receiveContactCard(cardJson);
      const resolvedGroupId = userGroupId ?? result.groupId ?? null;
      const alreadyKnown = !result.isOwnCard && !!resolvedGroupId
        ? await addKnownContactGroup(resolvedGroupId)
        : false;
      // Reciprocate: send our bundle back so the sharer adds us too. Must happen
      // while still subscribed (the relay only routes to current subscribers), so
      // send before RDV_UNSUB. Skip when it's our own card — no one to reply to.
      if (!result.isOwnCard) {
        const myUserGroupId = await khOps.ensureUserGroup({ create: true });
        const myCard = await khOps.getContactCard();
        rdvEvent(rendezvousId, 'sending');
        await rdvSendPayload(rendezvousId, key, JSON.stringify({ card: myCard, displayName: msg.displayName, userGroupId: myUserGroupId ?? undefined }));
      }
      rdvSend({ type: RDV_UNSUB, rendezvousId });
      rdvEvent(rendezvousId, 'received');
      (self as any).postMessage({
        type: 'result', id: msg.id,
        result: { ...result, userGroupId: resolvedGroupId, displayName, alreadyKnown },
      } satisfies WorkerToMain);
    } catch (err: any) {
      rdvSessions.delete(rendezvousId);
      rdvSend({ type: RDV_UNSUB, rendezvousId });
      rdvEvent(rendezvousId, 'error', errMsg(err));
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  // Device-link sharer (the original/admin device). Bidirectional handshake over
  // one rendezvous: we send our card when the new device joins, then ingest the
  // new device's card and add it to our user-group. Returns {id,key} immediately;
  // posts a 'linked' event when the handshake completes.
  if (msg.type === 'kh-rdv-link-create') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const myUserGroupId = await khOps.ensureUserGroup({ create: true });
      const myCard = await khOps.getContactCard();
      const myPayload = JSON.stringify({ card: myCard, userGroupId: myUserGroupId });
      const { rendezvousId, key } = generateRendezvous();
      rdvSessions.set(rendezvousId, {
        key,
        onPeer: () => {
          rdvEvent(rendezvousId, 'peer-joined');
          rdvEvent(rendezvousId, 'sending');
          rdvSendPayload(rendezvousId, key, myPayload).catch(err =>
            rdvEvent(rendezvousId, 'error', errMsg(err)));
        },
        onData: (pt) => {
          (async () => {
            try {
              rdvEvent(rendezvousId, 'receiving');
              const { card: peerCard, userGroupId: peerGroupId } = JSON.parse(pt);
              const result = await khOps!.receiveContactCard(peerCard);
              await khOps!.linkDevice(result.agentId, peerGroupId ?? null);
              rdvSessions.delete(rendezvousId);
              rdvSend({ type: RDV_UNSUB, rendezvousId });
              rdvEvent(rendezvousId, 'linked');
            } catch (err: any) {
              rdvEvent(rendezvousId, 'error', errMsg(err));
            }
          })();
        },
      });
      rdvSend({ type: RDV_SUB, rendezvousId });
      rdvEvent(rendezvousId, 'waiting');
      (self as any).postMessage({ type: 'result', id: msg.id, result: { rendezvousId, key } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  // Device-link joiner (the new device, from the QR/link). Wait for the original
  // device's card, adopt its user-group, then send our (post-adopt) card back so
  // the original can add us. Resolves once we've done our half of the handshake.
  if (msg.type === 'kh-rdv-link-join') {
    const { rendezvousId, key } = msg;
    try {
      if (!khOps) throw new Error('Keyhive not available');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          rdvSessions.delete(rendezvousId);
          reject(new Error('Timed out waiting for your other device. Make sure its QR/link is open, then try again.'));
        }, RDV_RECEIVE_TIMEOUT_MS);
        rdvSessions.set(rendezvousId, {
          key,
          onPeer: () => rdvEvent(rendezvousId, 'peer-joined'),
          onData: (pt) => {
            (async () => {
              try {
                rdvEvent(rendezvousId, 'receiving');
                const { card: peerCard, userGroupId: peerGroupId } = JSON.parse(pt);
                const result = await khOps!.receiveContactCard(peerCard);
                if (result.isOwnCard) throw new Error("This is your own device's link. Open it on a different device.");
                // Leg 1: adopt the original device's user-group.
                await khOps!.linkDevice(result.agentId, peerGroupId ?? null);
                // Leg 2: send our now-adopted card back so the original adds us.
                const myUserGroupId = await khOps!.ensureUserGroup({ create: true });
                const myCard = await khOps!.getContactCard();
                rdvEvent(rendezvousId, 'sending');
                await rdvSendPayload(rendezvousId, key, JSON.stringify({ card: myCard, userGroupId: myUserGroupId }));
                clearTimeout(timer);
                rdvSessions.delete(rendezvousId);
                rdvSend({ type: RDV_UNSUB, rendezvousId });
                rdvEvent(rendezvousId, 'linked');
                resolve();
              } catch (err) {
                clearTimeout(timer);
                rdvSessions.delete(rendezvousId);
                rdvSend({ type: RDV_UNSUB, rendezvousId });
                rdvEvent(rendezvousId, 'error', errMsg(err));
                reject(err);
              }
            })();
          },
        });
        rdvSend({ type: RDV_SUB, rendezvousId });
        rdvEvent(rendezvousId, 'waiting');
      });
      (self as any).postMessage({ type: 'result', id: msg.id, result: { ok: true } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  // Either side abandons a rendezvous (e.g. the sharer navigates away).
  if (msg.type === 'kh-rdv-cancel') {
    rdvSessions.delete(msg.rendezvousId);
    rdvSend({ type: RDV_UNSUB, rendezvousId: msg.rendezvousId });
  }

  if (msg.type === 'kh-list-devices') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const devices = await khOps.listGroupDevices();
      (self as any).postMessage({ type: 'result', id: msg.id, result: devices } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-remove-device') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      await khOps.removeDeviceFromGroup(msg.agentId);
      (self as any).postMessage({ type: 'result', id: msg.id, result: undefined } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-ensure-user-group') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const userGroupId = await khOps.ensureUserGroup({
        create: msg.create,
        adoptGroupId: msg.adoptGroupId,
        waitForSync: msg.waitForSync,
      });
      (self as any).postMessage({ type: 'result', id: msg.id, result: { userGroupId } } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-link-device') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      const result = await khOps.linkDevice(msg.deviceAgentId, msg.peerGroupId);
      (self as any).postMessage({ type: 'result', id: msg.id, result } satisfies WorkerToMain);
    } catch (err: any) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
  }

  if (msg.type === 'kh-get-link-payload') {
    try {
      if (!khOps) throw new Error('Keyhive not available');
      // Ensure a personal user-group exists so its id can travel with the contact card.
      const userGroupId = await khOps.ensureUserGroup({ create: true });
      const card = await khOps.getContactCard();
      (self as any).postMessage({ type: 'result', id: msg.id, result: { card, userGroupId } } satisfies WorkerToMain);
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
          post({ type: 'query-result', subId: pm.subId, result: null, heads: [], error: errMsg(err) });
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
