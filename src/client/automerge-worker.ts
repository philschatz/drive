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
import { isWebRTCSignalType, type WebRTCSignalFrame } from '../shared/webrtc-signal';
import { makeWebRTCRelayAdapter, type WebRTCRelayAdapter } from './webrtc-relay-adapter';
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
  | { type: 'hf-port'; port: MessagePort }
  // Main-thread WebRTC bridge port (RTCPeerConnection lives on the main thread).
  | { type: 'webrtc-port'; port: MessagePort };

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
  // A peer's sync transport flipped between a direct WebRTC channel and the relay.
  | { type: 'p2p-status'; peerId: string; transport: 'direct' | 'relay' }
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
  | { type: 'kh-rdv-event'; rendezvousId: string; status: RendezvousStatus; message?: string };

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
/** automerge-repo's NetworkAdapter base class, captured from the dynamic import
 *  so WebRTCRelayAdapter can extend it without a static (WASM-triggering) import. */
let NetworkAdapterBase: any;
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
  NetworkAdapterBase = repoModule.NetworkAdapter;
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

// ── WebRTC direct-peer transport ─────────────────────────────────────────────
// The composite network adapter that upgrades peers from relay to a direct data
// channel. RTCPeerConnection lives on the main thread (not available in Workers),
// so the adapter talks to it over a MessagePort. The port may arrive before or
// after the adapter is built; hold it until both exist.
let p2pAdapter: WebRTCRelayAdapter | null = null;
let pendingWebrtcPort: MessagePort | null = null;

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

/** Human-readable byte size, e.g. 512 → "512 B", 1234 → "1.2 KB". */
function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  return `${(n / 1000).toFixed(1)} KB`;
}

/** Encrypt and send a payload to the other peer on a rendezvous topic. */
async function rdvSendPayload(rendezvousId: string, key: string, plaintext: string): Promise<void> {
  const framed = await encryptString(key, plaintext);
  // The 'sending' step carries the on-the-wire size (12-byte IV + ciphertext) so
  // the UI can show how much this device is uploading. Every send leg goes
  // through here, so all of them report a size.
  rdvEvent(rendezvousId, 'sending', formatBytes(framed.length));
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
  const { idbGet, idbSet, KEYS } = await import('./idb-storage');
  const list = (await idbGet<string[]>(KEYS.knownContactGroups)) ?? [];
  if (list.includes(groupId)) return true;
  list.push(groupId);
  await idbSet(KEYS.knownContactGroups, list);
  return false;
}
async function removeKnownContactGroup(groupId: string): Promise<void> {
  const { idbGet, idbSet, KEYS } = await import('./idb-storage');
  const list = (await idbGet<string[]>(KEYS.knownContactGroups)) ?? [];
  const next = list.filter(g => g !== groupId);
  if (next.length !== list.length) await idbSet(KEYS.knownContactGroups, next);
}

// ── Contact-name store ───────────────────────────────────────────────────────
// The worker is the single owner/writer of the persisted contact-name map (IDB
// key KEYS.contactNames); the main thread keeps only a read cache, refreshed from
// the 'contact-names-updated' broadcasts these helpers emit. Centralising the
// writes here lets worker-internal flows (e.g. the rendezvous contact exchange)
// name a contact directly, without a round-trip through the UI.
async function getContactNames(): Promise<Record<string, string>> {
  const { idbGet, KEYS } = await import('./idb-storage');
  return (await idbGet<Record<string, string>>(KEYS.contactNames)) ?? {};
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
  const { idbSet, KEYS } = await import('./idb-storage');
  await idbSet(KEYS.contactNames, names);
  broadcastContactNames(names);
}
/** Forget a contact's name and drop them from the known registry, then broadcast. */
async function deleteContactName(agentId: string): Promise<void> {
  const names = await getContactNames();
  delete names[agentId];
  const { idbSet, KEYS } = await import('./idb-storage');
  await idbSet(KEYS.contactNames, names);
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

/** Run a keyhive WASM operation on the bridge's shared serialization queue.
 *  ALL keyhive access (blob encryption, signing, sync) goes through this single
 *  PromiseQueue; calling keyhive concurrently/reentrantly traps the WASM
 *  ("unreachable executed"). Used directly for the few keyhive entry points that
 *  don't already go through the serialized `kh` proxy (e.g. shareConfig's
 *  bestAccessForDoc). Never nest these calls (serial queue → deadlock). */
function runOnKeyhiveQueue<T>(fn: () => Promise<T>): Promise<T> {
  // keyhiveQueue is private in the bridge's types but is the only shared lock; reach it directly.
  const queue = (khIntegration as any)?.networkAdapter?.keyhiveQueue;
  return queue ? queue.run(fn) : fn();
}

/** Wrap a keyhive instance so EVERY method call is serialized on the shared queue.
 *  keyhive WASM is not reentrant: if one keyhive method is suspended at an await and
 *  another runs, it traps ("unreachable executed"). The bridge serializes its own
 *  calls (blob/sync/sign) on the shared queue, but KeyhiveOps and worker-level calls
 *  did not — so high-frequency presence encrypt/decrypt collided with them. Routing
 *  the keyhive instance through this proxy puts every method on the same queue.
 *  Per-method (not per-operation) granularity keeps slots short, so polling loops
 *  (e.g. KeyhiveOps.waitForGroup's setTimeout) release the lock between calls.
 *  Synchronous getters/properties pass through untouched — they can't be interrupted
 *  mid-call, so they're reentrancy-safe. */
function serializeKeyhive(realKh: any): any {
  return new Proxy(realKh, {
    get(target, prop) {
      const val = (target as any)[prop];
      if (typeof val !== 'function') return val;
      return (...args: any[]) => runOnKeyhiveQueue(() => Promise.resolve(val.apply(target, args)));
    },
  });
}

/** Resolve the keyhive Document object for an automerge doc-ID, or null if not available yet.
 *  (khOps.kh is the serialized proxy, so getDocument is queued automatically.) */
async function getKhDoc(automergeDocId: string): Promise<any | null> {
  if (!khOps || !khBridge) return null;
  try {
    const khDocId = khBridge.docIdFromAutomergeUrl(`automerge:${automergeDocId}` as any);
    return await khOps.kh.getDocument(khDocId);
  } catch (err) {
    console.warn('[worker] getKhDoc failed:', errMsg(err));
    return null;
  }
}

/** Encrypt a presence channel value with the document's keyhive (per-document) key, so
 *  only current members can read it. khOps.kh is the serialized proxy, so tryEncrypt is
 *  queued; extracting the ciphertext bytes from the result is self-contained (no keyhive
 *  borrow) and safe off-queue. Mirrors the proven path in keyhive-ops.test.ts. */
async function encryptPresenceValue(doc: any, value: unknown): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
  const ref = new khBridge!.ChangeId(crypto.getRandomValues(new Uint8Array(32)));
  const result = await khOps!.kh.tryEncrypt(doc, ref, [], bytes);
  return result.encrypted_content().toBytes();
}

/** Decrypt a presence channel value. Throws if the current key isn't available yet
 *  (e.g. a freshly-joined peer before keyhive sync completes) — callers skip on throw. */
async function decryptPresenceValue(doc: any, enc: Uint8Array): Promise<unknown> {
  const decrypted = await khOps!.kh.tryDecrypt(doc, khBridge!.Encrypted.fromBytes(enc));
  return JSON.parse(new TextDecoder().decode(decrypted));
}

/** Encrypt a presence value, returning null (never throwing) when keyhive can't yet make
 *  the key for this peer ("SecretKey not found" before the doc's PCS key has synced in).
 *  Mirrors how the keyhive blob-interceptor skips encryption when there's no PCS key. */
async function encryptPresenceValueOrNull(doc: any, value: unknown): Promise<Uint8Array | null> {
  try {
    return await encryptPresenceValue(doc, value);
  } catch {
    // No usable key yet (e.g. PCS key not synced) — defer; schedulePresenceRetry re-attempts.
    return null;
  }
}

/** Encrypt + broadcast the desired local presence state. Returns true only if every
 *  channel encrypted successfully (false means the keyhive key isn't available yet). */
async function flushPresenceOut(entry: DocEntry): Promise<boolean> {
  if (!entry.presence || !entry.presenceDoc || !entry.presenceDesired) return true;
  let allOk = true;
  for (const [k, v] of Object.entries(entry.presenceDesired)) {
    const enc = await encryptPresenceValueOrNull(entry.presenceDoc, v);
    if (enc) entry.presence.broadcast(k, enc);
    else allOk = false;
  }
  return allOk;
}

/** While encrypt OR decrypt is failing (keyhive key not yet synced for this peer/doc),
 *  re-attempt both on a timer so presence recovers automatically once the key arrives.
 *  Stops itself once a cycle fully succeeds. Idempotent (one timer per entry). */
function schedulePresenceRetry(entry: DocEntry): void {
  if (entry.presenceRetry) return;
  entry.presenceRetry = setInterval(async () => {
    if (!entry.presence) { clearInterval(entry.presenceRetry); entry.presenceRetry = null; return; }
    const outOk = await flushPresenceOut(entry);
    const inOk = entry.presenceSend ? await entry.presenceSend() : true;
    if (outOk && inOk) {
      clearInterval(entry.presenceRetry);
      entry.presenceRetry = null;
    }
  }, 5000);
}

/** Return the (only) repo. */
function getRepo(): InstanceType<typeof Repo> {
  if (!secureRepo) throw new Error('Secure repo not initialized');
  return secureRepo;
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
  presenceDoc?: any;                          // keyhive doc used to encrypt/decrypt presence
  presenceDesired?: Record<string, unknown>;  // plaintext local presence state (viewing, focusedField)
  presenceSend?: () => Promise<boolean>;      // decrypt incoming peer states + post; true if all decrypted
  presenceRetry?: any;                        // retry timer: re-attempts encrypt/decrypt until keys are available
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
 * repo.find) that doc in the background. The persisted cache:query: cache is always served
 * first for instant paint either way.
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
 * query result cache (`queryResultCache` + IDB `cache:query:*`), and the validation cache. Hydrated
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

  const { idbSet, queryCacheKey } = await import('./idb-storage');
  const cacheKey = queryCacheKey(docId, filter);
  const json = JSON.stringify(result);

  const cached = queryResultCache.get(cacheKey);
  if (cached && cached.json === json) {
    return { result, heads, lastModified, changed: false };
  }

  const entry: QueryCacheEntry = { result, json, lastModified, heads };
  queryResultCache.set(cacheKey, entry);
  idbSet(cacheKey, entry);
  return { result, heads, lastModified, changed: true };
}

/** Subscribe to a jq query, routing results to the given poster. Shared by main-thread and port subscriptions. */
async function handleSubscribeQuery(docId: string, subId: number, filter: string, post: (m: any) => void) {
  subIdToDocId.set(subId, docId);

  // Serve from cache if available, for instant paint. Skipped when caching is disabled —
  // results then come only from the live query below.
  if (!cacheDisabled) {
    const { idbGet, queryCacheKey } = await import('./idb-storage');
    const cacheKey = queryCacheKey(docId, filter);
    const memoryCached = queryResultCache.get(cacheKey);
    if (memoryCached) {
      post({ type: 'query-result', subId, result: memoryCached.result, heads: memoryCached.heads, lastModified: memoryCached.lastModified });
    } else {
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
  const { docCachePrefix } = await import('./idb-storage');
  const prefix = docCachePrefix(docId);
  for (const key of queryResultCache.keys()) {
    if (key.startsWith(prefix) && !activeHashes.has(key.slice(prefix.length))) {
      console.log(`[worker] might want to (but will not) delete possibly stale key ${key}`);
    }
  }

  if (hasValidation) {
    void pushValidation(docId, activeDoc);
  }
}

async function pushValidation(docId: string, doc: any) {
  const allErrors = validateDocument(doc);
  const errors = allErrors.slice(0, 100);

  // When cacheDisabled, skip the validation cache — always emit below.
  if (!cacheDisabled) {
    const json = JSON.stringify(errors);
    const { idbSet, validationCacheKey } = await import('./idb-storage');
    const cacheKey = validationCacheKey(docId);
    const cached = queryResultCache.get(cacheKey);
    if (cached && cached.json === json) return; // unchanged — skip the re-emit below
    const entry: QueryCacheEntry = { result: errors, json, heads: [] };
    queryResultCache.set(cacheKey, entry);
    idbSet(cacheKey, entry);
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

/**
 * Load the freshly-linked device's library. After adopting the original device's
 * user-group, the group's doc-admin delegations arrive over the relay
 * asynchronously — so rather than waiting for a share-config change to happen to
 * fire, force a keyhive sync and reconcile a few times to surface every doc the
 * group (and thus this device) now has access to.
 */
async function reconcileHomeDocsAfterLink() {
  for (let i = 0; i < 6; i++) {
    try { khIntegration?.networkAdapter?.syncKeyhive?.(); } catch { /* best effort */ }
    await reconcileHomeDocs();
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function reconcileHomeDocsOnce() {
  if (!khOps || !amDocIdFromBytes) return;
  try {
    const { accessibleKhIds, reachableKhIds } = await khOps.enumerateUserDocs();
    const { idbGet, idbSet, KEYS } = await import('./idb-storage');
    type StoredDocEntry = { id: string; type?: string; name?: string; sharingGroupId?: string };
    const list = (await idbGet<StoredDocEntry[]>(KEYS.docIds)) ?? [];
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
      await idbSet(KEYS.docIds, list);
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

        // --- Rendezvous frame interception (wire-level) ---
        // Monkey-patch receiveMessage: rendezvous frames ride the same socket but
        // aren't automerge-repo protocol — handle them and DON'T forward to the repo.
        const origReceive = secureWs.receiveMessage.bind(secureWs);
        (secureWs as any).receiveMessage = (bytes: Uint8Array) => {
          try {
            const decoded = cborDecode(new Uint8Array(bytes));
            if (isRendezvousType(decoded?.type)) {
              handleRendezvousFrame(decoded);
              return;
            }
            // WebRTC signaling frames ride the same socket but drive the direct
            // data-channel negotiation — hand them to the p2p adapter, not the repo.
            if (isWebRTCSignalType(decoded?.type)) {
              p2pAdapter?.handleSignal(decoded as WebRTCSignalFrame);
              return;
            }
          } catch { /* not an overlay frame — fall through to the repo adapter */ }
          return origReceive(bytes);
        };
        // Expose the raw socket so rendezvous frames can bypass the repo adapter.
        // The adapter recreates its socket on reconnect, so read it lazily too.
        rdvSocket = (secureWs as any).socket;
        const origOnOpenForRdv = secureWs.onOpen;
        secureWs.onOpen = () => { rdvSocket = (secureWs as any).socket; origOnOpenForRdv(); };

        // Wrap the relay adapter so peers can be upgraded to direct WebRTC data
        // channels. Keyhive still wraps a SINGLE adapter, so its encryption and
        // access control are unchanged — only the underlying pipe switches.
        p2pAdapter = makeWebRTCRelayAdapter(NetworkAdapterBase, secureWs, {
          sendSignalFrame: (frame) => {
            if (rdvSocket && rdvSocket.readyState === WebSocket.OPEN) {
              rdvSocket.send(rdvEncoder.encode(frame) as unknown as ArrayBuffer);
            }
          },
          onTransportChange: (peerId, transport) => {
            (self as any).postMessage({ type: 'p2p-status', peerId, transport } satisfies WorkerToMain);
          },
          relayPeerId: RELAY_PEER_ID,
        });
        if (pendingWebrtcPort) { p2pAdapter.attachPort(pendingWebrtcPort); pendingWebrtcPort = null; }

        khIntegration = await khBridge.initializeAutomergeRepoKeyhive({
          storage: secureStorage,
          peerIdSuffix: 'drive',
          // Cast: WebRTCRelayAdapter implements NetworkAdapterInterface but the
          // bridge's .d.ts asks for the concrete NetworkAdapter class brand.
          networkAdapter: p2pAdapter as any,
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
            // shareConfig is consulted off the keyhive queue (during sync-message
            // handling), so serialize this keyhive access too.
            const access = await runOnKeyhiveQueue(() => khIntegration!.bestAccessForDoc(identifier, `automerge:${docId}` as any));
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
            // Notify main thread so useAccess/Home can re-check access levels
            (self as any).postMessage({ type: 'kh-state-changed' } satisfies WorkerToMain);
          },
        });

        // Serialize ALL keyhive access through the bridge's shared queue: KeyhiveOps
        // calls keyhive WASM (which is non-reentrant) and previously ran unserialized,
        // racing with the bridge's own queued calls and our frequent presence calls.
        const khSerial = serializeKeyhive(khIntegration.keyhive);
        khOps = new KeyhiveOps(khSerial, khBridge as any, {
          persist: () => khIntegration!.keyhiveStorage.saveKeyhiveWithHash(khSerial),
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
            const { idbGet, KEYS } = await import('./idb-storage');
            return (await idbGet<string>(KEYS.userGroupId)) ?? null;
          },
          setUserGroupId: async (groupId) => {
            const { idbSet, KEYS } = await import('./idb-storage');
            await idbSet(KEYS.userGroupId, groupId);
          },
        });

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
          // Use the serialized proxy so these init-time reads don't race the bridge.
          const kh = khOps?.kh ?? khIntegration.keyhive;
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
          const { idbGet: idbGetDocs, KEYS } = await import('./idb-storage');
          type StoredDocEntry = { id: string;[key: string]: any };
          const earlyList = (await idbGetDocs<StoredDocEntry[]>(KEYS.docIds)) ?? [];
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
      const { settingSet, idbDelPrefix, CACHE_PREFIX } = await import('./idb-storage');
      await settingSet('cache-disabled', msg.disabled);
      if (msg.disabled) {
        // Clear performance caches when disabling. (The caller reloads afterward, so the
        // in-memory LRUs are also wiped on restart; the IDB clear is the part that persists.)
        queryResultCache.clear();
        jqCache.clear();
        await idbDelPrefix(CACHE_PREFIX);
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
      const { idbDelPrefix, CACHE_PREFIX } = await import('./idb-storage');
      await idbDelPrefix(CACHE_PREFIX);
      (self as any).postMessage({ type: 'result', id: msg.id, result: null } satisfies WorkerToMain);
    } catch (err) {
      (self as any).postMessage({ type: 'result', id: msg.id, error: errMsg(err) } satisfies WorkerToMain);
    }
    return;
  }

  if (msg.type === 'get-doc-list') {
    try {
      const { idbGet, KEYS } = await import('./idb-storage');
      type StoredDocEntry = { id: string; type?: string; name?: string; sharingGroupId?: string };
      const list = (await idbGet<StoredDocEntry[]>(KEYS.docIds)) ?? [];
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
        const { idbGet: idbGetList, idbSet: idbSetList, KEYS } = await import('./idb-storage');
        type S = { id: string;[k: string]: any };
        const earlyList = (await idbGetList<S[]>(KEYS.docIds)) ?? [];
        earlyList.unshift({ id: handle.documentId, ...(msg.metadata ?? {}) });
        await idbSetList(KEYS.docIds, earlyList);
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
    const { idbGet, validationCacheKey } = await import('./idb-storage');
    const valCacheKey = validationCacheKey(msg.docId);
    const valMemCached = queryResultCache.get(valCacheKey);
    if (valMemCached) {
      (self as any).postMessage({ type: 'update-validation', docId: msg.docId, errors: valMemCached.result } satisfies WorkerToMain);
    } else {
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
        // Presence values are encrypted with the document's keyhive key, so the
        // ephemeral channel (which travels in plaintext) never leaks what a peer is
        // viewing/editing. Needs the keyhive doc; if it isn't ready yet, skip and
        // let the next subscribe (on editor mount) start presence.
        const doc = await getKhDoc(msg.docId);
        if (!doc) {
          console.warn('[worker] presence-subscribe: keyhive doc not ready; skipping');
        } else {
          const presence = new PresenceClass({ handle });
          // Start with empty state so presence ALWAYS starts (and can receive) even when
          // this peer can't encrypt yet; the real state is broadcast (and retried) below.
          presence.start({ initialState: {}, heartbeatMs: 5000, peerTtlMs: 15000 });
          entry.presence = presence;
          entry.presenceDoc = doc;
          // Advertise our user-group id so peers can resolve us to a contact name and
          // collapse our devices into one identity. Broadcast as its own encrypted
          // channel by flushPresenceOut below. Omitted if no group exists yet (fresh
          // install) — viewing a shared doc generally implies group membership.
          const userGroupId = await khOps?.getUserGroupId();
          entry.presenceDesired = {
            viewing: true,
            focusedField: null,
            ...(userGroupId ? { userGroupId } : {}),
          };

          // Decrypt incoming peer states and post them; returns true only if every
          // channel decrypted (false ⇒ key not synced yet ⇒ schedule a retry).
          const sendPresence = async (): Promise<boolean> => {
            const raw = presence.getPeerStates().value;
            const peers: Record<string, any> = {};
            let allOk = true;
            for (const [peerId, st] of Object.entries<any>(raw)) {
              const value: Record<string, unknown> = {};
              for (const [ch, enc] of Object.entries<any>(st?.value ?? {})) {
                try { value[ch] = await decryptPresenceValue(doc, enc as Uint8Array); }
                catch { allOk = false; }
              }
              peers[peerId] = { ...st, value };
            }
            (self as any).postMessage({ type: 'update-presence', docId: msg.docId, peers } satisfies WorkerToMain);
            if (!allOk) schedulePresenceRetry(entry);
            return allOk;
          };
          entry.presenceSend = sendPresence;
          presence.on('update', () => { void sendPresence(); });
          presence.on('goodbye', () => { void sendPresence(); });
          presence.on('snapshot', () => { void sendPresence(); });

          // Broadcast our initial state; if the key isn't available yet, retry until it is.
          if (!(await flushPresenceOut(entry))) schedulePresenceRetry(entry);
        }
      }
    } catch (err: any) {
      console.warn('[worker] presence-subscribe failed:', errMsg(err));
    }
  }

  if (msg.type === 'unsubscribe-presence') {
    const entry = docRegistry.get(msg.docId);
    if (entry?.presence) {
      if (entry.presenceRetry) { clearInterval(entry.presenceRetry); entry.presenceRetry = null; }
      entry.presence.stop();
      entry.presence = null;
      entry.presenceDoc = undefined;
      entry.presenceDesired = undefined;
      entry.presenceSend = undefined;
    }
  }

  if (msg.type === 'set-presence') {
    const entry = docRegistry.get(msg.docId);
    // If presence hasn't started yet (subscribe still in flight), drop this update —
    // the editor re-broadcasts on the next focus change, and the initial state is set
    // by subscribe itself.
    if (entry?.presence) {
      // Update desired local state, then encrypt+broadcast what we can; retry the rest.
      entry.presenceDesired = { ...(entry.presenceDesired ?? {}), ...msg.state };
      if (!(await flushPresenceOut(entry))) schedulePresenceRetry(entry);
    }
  }

  // --- Doc list mutations (IDB-backed) ---

  if (msg.type === 'remove-me-from-doc') {
    try {
      const { idbGet, idbSet, idbDelPrefix, KEYS, docCachePrefix } = await import('./idb-storage');
      type StoredDocEntry = { id: string;[key: string]: any };
      const list = (await idbGet<StoredDocEntry[]>(KEYS.docIds)) ?? [];
      const removedEntry = list.find(e => e.id === msg.docId);
      const filtered = list.filter(e => e.id !== msg.docId);
      await idbSet(KEYS.docIds, filtered);
      // Clean up active subscriptions and query cache for removed doc
      const entry = docRegistry.get(msg.docId);
      if (entry) {
        for (const subId of entry.subscriptions.keys()) subIdToDocId.delete(subId);
        if (entry.presenceRetry) clearInterval(entry.presenceRetry);
        if (entry.presence) entry.presence.stop();
        docRegistry.delete(msg.docId);
      }
      queryResultCache.deletePrefix(docCachePrefix(msg.docId));
      await idbDelPrefix(docCachePrefix(msg.docId));
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
      const { idbGet, KEYS } = await import('./idb-storage');
      const contactNames = await getContactNames();
      const knownGroups = (await idbGet<string[]>(KEYS.knownContactGroups)) ?? [];
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
      // We just adopted the original device's user-group — pull in its whole library.
      void reconcileHomeDocsAfterLink();
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
      // Adopting/converging a group can grant access to the peer's docs — surface them.
      void reconcileHomeDocsAfterLink();
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

  if (msg.type === 'webrtc-port') {
    const port = (msg as any).port as MessagePort;
    // The port may arrive before keyhive init builds the adapter; hold it.
    if (p2pAdapter) p2pAdapter.attachPort(port);
    else pendingWebrtcPort = port;
  }

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
