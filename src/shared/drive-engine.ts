/**
 * DriveEngine — the app's entire sync/keyhive/document engine, extracted from the
 * browser Web Worker so it can run unchanged in a Web Worker (browser) or
 * in-process (the Node CLI). It performs no direct browser I/O: storage, network,
 * key-value persistence, and event delivery are all supplied by an `EngineHost`.
 *
 * The browser worker shell (automerge-worker.ts) and the Node CLI (cli.ts) each
 * build a host and drive the engine — the worker via `handleMessage`, the CLI via
 * `init()` / `rendezvousLinkJoin()` / `startWatching()` directly.
 */
import { deepAssign } from './deep-assign';
import { syncToTarget } from './sync-to-target';
import { validateDocument } from './schemas';
import { KeyhiveOps, bytesToBase64, base64ToBytes, errMsg } from '../client/keyhive-ops';
import { LRU } from '../client/lru-cache';
import { generateRendezvous, encryptString, decryptString } from '../client/rendezvous-crypto';
import { formatBytes } from './format-bytes';
import {
  RDV_SUB, RDV_UNSUB, RDV_MSG, RDV_PEER,
  type RendezvousStatus,
} from './rendezvous-protocol';
import {
  KEYS, CACHE_PREFIX, queryCacheKey, validationCacheKey, docCachePrefix, hashStr,
  type QueryCacheEntry,
} from './storage-keys';
import { createKeyhiveRepo } from './keyhive-repo';
import { RELAY_PEER_ID } from './relay-identity';
import type { EngineHost } from './engine-host';
import type { MainToWorker, WorkerToMain } from './worker-protocol';

type StoredDocEntry = { id: string; type?: string; name?: string; sharingGroupId?: string;[k: string]: any };
/** KEYS.archivedDocIds value: archived automerge docId → re-share-detection baseline. */
type ArchivedDocTombstones = Record<string, { grantSigs: string[] }>;

interface SubInfo {
  filter: string;
  post: (msg: any) => void; // where to send results (host.emit or an hf-port poster)
  peek?: boolean; // true = this read doesn't count as the user viewing the doc
}

interface DocEntry {
  handle: any;
  pinnedVersion: number | null; // null = live view
  subscriptions: Map<number, SubInfo>; // subId → filter + poster
  presence: any | null;
  presenceDoc?: any;
  presenceDesired?: Record<string, unknown>;
  presenceSend?: () => Promise<boolean>;
  presenceRetry?: any;
  presenceLiveness?: any;
  validationSubscribed: boolean;
}

/**
 * One live rendezvous. `onPeer` fires when another peer joins the topic; `onData`
 * fires with the decrypted payload of an inbound message. A one-way share sets only
 * `onPeer`; a receiver sets only `onData`; a device link sets both.
 */
interface RdvSession {
  key: string;
  onPeer?: () => void;
  onData?: (plaintext: string) => void;
}

const RDV_RECEIVE_TIMEOUT_MS = 120_000;

/**
 * Upper bound on an inbound encrypted rendezvous payload. Anyone who learns a
 * topic id (or a hostile relay) can push bytes at it, so cap the size BEFORE
 * any decrypt/parse work. Legitimate payloads — contact bundles — run ~25 KB;
 * 256 KiB leaves generous headroom.
 */
export const RDV_MAX_DATA_BYTES = 256 * 1024;

/** See OPEN_DOCS_IN_BACKGROUND in the original worker. */
const OPEN_DOCS_IN_BACKGROUND = true;

// These are mutable so the set-presence-timing test hook can shrink the
// windows (specs drive a short stale window instead of sleeping past the 12s
// default); production never reassigns them. There is one engine per worker,
// so a module-level override is effectively per-engine.
/** How often each peer's Presence broadcasts a heartbeat when otherwise idle. */
export let PRESENCE_HEARTBEAT_MS = 5000;
/** A peer with no presence activity for this long is hidden from clients
 *  (two missed heartbeats plus network slack). */
export let PRESENCE_STALE_MS = 12_000;
/** How often to re-check freshness between events; worst-case detection
 *  latency is PRESENCE_STALE_MS + this. */
let PRESENCE_LIVENESS_CHECK_MS = 3000;
/** How often to re-attempt presence setup while the doc/keyhive isn't ready. */
const PRESENCE_SETUP_RETRY_MS = 2000;

/** Order-insensitive head-set equality. A missing record never equals. */
export function headsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((h, i) => h === sb[i]);
}

/**
 * Peers to surface as connected devices/contacts in the UI (counts + dots).
 *
 * The stateless relay completes the automerge-repo handshake with a real peerId
 * (RELAY_PEER_ID, whose all-zero bytes decode to a valid keyhive Identifier — see
 * relay-identity.ts), so keyhive's network adapter registers it as a peer-candidate
 * and it lands in `repo.peers` like any device. It is a message router, not a
 * device or contact, so it must be excluded from user-facing peer counts and dots.
 */
export function visiblePeerIds(repoPeers: readonly string[]): string[] {
  return repoPeers.filter((p) => p !== RELAY_PEER_ID);
}

/** Peers seen within `staleMs` of `now`. Fresh iff now - lastSeen < staleMs. */
export function freshPresencePeerIds(
  lastSeen: ReadonlyMap<string, number>,
  now: number,
  staleMs: number = PRESENCE_STALE_MS,
): Set<string> {
  const fresh = new Set<string>();
  for (const [peerId, seenAt] of lastSeen) {
    if (now - seenAt < staleMs) fresh.add(peerId);
  }
  return fresh;
}

export interface WatchUpdate {
  docId: string;
  docType?: string;
  name?: string;
  heads: string[];
  lastModified?: number;
  versions?: number;
}

export interface StartWatchingOptions {
  /** Minimum number of most-recently-updated docs to keep open continuously. */
  keepOpen: number;
  /** Also keep open every doc edited within this many days (the kept-open set is
   *  whichever is larger: the top-N or the docs within this window). */
  recentDays: number;
  /** How long to hold each rotated doc open so it can sync before closing (ms). */
  syncMs: number;
  reenumerateEveryMs?: number;
}

export class DriveEngine {
  private host: EngineHost;

  // Populated by init() via createKeyhiveRepo.
  private repo: any = null;
  private khIntegration: any = null;
  private khOps: KeyhiveOps | null = null;
  private bridge: any = null;
  private Automerge: any = null;
  private PresenceClass: any = null;
  private amDocIdFromBytes: ((bytes: Uint8Array) => string) | null = null;
  private setNextDocId: ((bytes: Uint8Array) => void) | null = null;

  // Doc registry + subscriptions.
  private docRegistry = new Map<string, DocEntry>();
  private subIdToDocId = new Map<number, string>();
  private pendingSubs = new Map<string, Map<number, SubInfo>>();

  // Presence subscriptions still waiting for the doc/keyhive to be ready:
  // docId → retry timer (null while an attempt is in flight). Present iff a
  // subscription wants presence that hasn't started yet.
  private presencePending = new Map<string, any>();
  // set-presence state that arrived before presence finished starting.
  private presenceDesiredEarly = new Map<string, Record<string, unknown>>();

  // Query caching.
  private jqCache = new LRU<string, (input: any) => any>(64);
  private queryResultCache = new LRU<string, QueryCacheEntry>(256);
  private debugEnabled = false;
  /**
   * Debug mode only: the name of the most-recent keyhive (Rust/WASM) call, set
   * just before it runs. The worker's error handler reads this to name the call
   * that trapped when a WASM `unreachable` panic kills the worker.
   */
  lastKeyhiveCall: string | null = null;

  // Reconcile coalescing.
  private reconcileInFlight = false;
  private reconcilePending = false;

  // "New changes since last viewed" (per-device, worker-owned; see KEYS.lastViewedHeads).
  private lastViewedHeads: Record<string, string[]> | null = null; // null until init() loads it
  private unseenChanges: Record<string, boolean> = {};             // last computed state (what we emit)

  // Rendezvous.
  private rdvSessions = new Map<string, RdvSession>();

  // Watcher (keep-N-open + rotate).
  private watching = false;
  private watchedDocs = new Set<string>();
  private pinnedDocs = new Set<string>();
  private watchOnUpdate: ((u: WatchUpdate) => void) | null = null;

  constructor(host: EngineHost) {
    this.host = host;
  }

  // ── small accessors ────────────────────────────────────────────────────────
  get peerId(): string { return this.repo?.peerId; }
  get keyhiveOps(): KeyhiveOps | null { return this.khOps; }
  get automergeRepo(): any { return this.repo; }

  private emit(event: WorkerToMain): void { this.host.emit(event); }
  private getRepo(): any {
    if (!this.repo) throw new Error('Secure repo not initialized');
    return this.repo;
  }

  // ── Known-contact registry ───────────────────────────────────────────────
  /** Persist a contact's user-group; returns true if we already knew them. */
  private async addKnownContactGroup(groupId: string): Promise<boolean> {
    const list = (await this.host.kv.get<string[]>(KEYS.knownContactGroups)) ?? [];
    if (list.includes(groupId)) return true;
    list.push(groupId);
    await this.host.kv.set(KEYS.knownContactGroups, list);
    return false;
  }
  private async removeKnownContactGroup(groupId: string): Promise<void> {
    const list = (await this.host.kv.get<string[]>(KEYS.knownContactGroups)) ?? [];
    const next = list.filter(g => g !== groupId);
    if (next.length !== list.length) await this.host.kv.set(KEYS.knownContactGroups, next);
  }

  // ── Contact-name store ─────────────────────────────────────────────────────
  private async getContactNames(): Promise<Record<string, string>> {
    return (await this.host.kv.get<Record<string, string>>(KEYS.contactNames)) ?? {};
  }
  private broadcastContactNames(names: Record<string, string>): void {
    this.emit({ type: 'contact-names-updated', names });
  }
  private async putContactName(agentId: string, name: string | undefined): Promise<void> {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const names = await this.getContactNames();
    if (names[agentId] === trimmed) return;
    names[agentId] = trimmed;
    await this.host.kv.set(KEYS.contactNames, names);
    this.broadcastContactNames(names);
  }
  private async deleteContactName(agentId: string): Promise<void> {
    const names = await this.getContactNames();
    delete names[agentId];
    await this.host.kv.set(KEYS.contactNames, names);
    // "Delete contact" must also drop them from the known registry, else they'd
    // reappear (by short id) on the next getKnownContacts.
    await this.removeKnownContactGroup(agentId);
    this.broadcastContactNames(names);
  }

  // ── Device-name store (keyed by device agentId; twin of the contact store) ──
  private async getDeviceNames(): Promise<Record<string, string>> {
    return (await this.host.kv.get<Record<string, string>>(KEYS.deviceNames)) ?? {};
  }
  private broadcastDeviceNames(names: Record<string, string>): void {
    this.emit({ type: 'device-names-updated', names });
  }
  private async putDeviceName(agentId: string, name: string | undefined): Promise<void> {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const names = await this.getDeviceNames();
    if (names[agentId] === trimmed) return;
    names[agentId] = trimmed;
    await this.host.kv.set(KEYS.deviceNames, names);
    this.broadcastDeviceNames(names);
  }
  private async deleteDeviceName(agentId: string): Promise<void> {
    const names = await this.getDeviceNames();
    if (!(agentId in names)) return;
    delete names[agentId];
    await this.host.kv.set(KEYS.deviceNames, names);
    this.broadcastDeviceNames(names);
  }

  // ── keyhive doc-id helpers ─────────────────────────────────────────────────
  /** Derive the keyhive doc-ID (base64) from an automerge doc-ID. */
  private resolveKhDocId(automergeDocId: string): string {
    const khDocIdObj = this.bridge.docIdFromAutomergeUrl(`automerge:${automergeDocId}` as any);
    return bytesToBase64(khDocIdObj.toBytes());
  }

  /** Resolve the keyhive Document for an automerge doc-ID, or null if not available yet. */
  private async getKhDoc(automergeDocId: string): Promise<any | null> {
    if (!this.khOps || !this.bridge) return null;
    try {
      const khDocId = this.bridge.docIdFromAutomergeUrl(`automerge:${automergeDocId}` as any);
      return await this.khOps.kh.getDocument(khDocId);
    } catch (err) {
      console.warn('[engine] getKhDoc failed:', errMsg(err));
      return null;
    }
  }

  // ── Presence crypto ────────────────────────────────────────────────────────
  private async encryptPresenceValue(doc: any, value: unknown): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
    const ref = new this.bridge.ChangeId(crypto.getRandomValues(new Uint8Array(32)));
    const result = await this.khOps!.kh.tryEncrypt(doc, ref, [], bytes);
    return result.encrypted_content().toBytes();
  }
  private async decryptPresenceValue(doc: any, enc: Uint8Array): Promise<unknown> {
    const decrypted = await this.khOps!.kh.tryDecrypt(doc, this.bridge.Encrypted.fromBytes(enc));
    return JSON.parse(new TextDecoder().decode(decrypted));
  }
  private async encryptPresenceValueOrNull(doc: any, value: unknown): Promise<Uint8Array | null> {
    try { return await this.encryptPresenceValue(doc, value); }
    catch (err) {
      // Swallowing this silently hid a wedged CGKA ("SecretKey not found" after
      // a reload lost an in-memory leaf secret) for a long time — keep it loud.
      console.warn('[engine] presence encrypt failed:', errMsg(err));
      return null;
    }
  }
  private async flushPresenceOut(entry: DocEntry): Promise<boolean> {
    if (!entry.presence || !entry.presenceDoc || !entry.presenceDesired) return true;
    let allOk = true;
    for (const [k, v] of Object.entries(entry.presenceDesired)) {
      const enc = await this.encryptPresenceValueOrNull(entry.presenceDoc, v);
      if (enc) entry.presence.broadcast(k, enc);
      else allOk = false;
    }
    return allOk;
  }
  private schedulePresenceRetry(entry: DocEntry): void {
    if (entry.presenceRetry) return;
    entry.presenceRetry = setInterval(async () => {
      if (!entry.presence) { clearInterval(entry.presenceRetry); entry.presenceRetry = null; return; }
      const outOk = await this.flushPresenceOut(entry);
      const inOk = entry.presenceSend ? await entry.presenceSend() : true;
      if (outOk && inOk) {
        clearInterval(entry.presenceRetry);
        entry.presenceRetry = null;
        return;
      }
      // Still failing to decrypt a peer (typical after a reload: the rehydrated
      // keyhive lacks the epoch secrets for the peer's cyphertext). Two levers,
      // both needed: force a keyhive sync round so the missing key material can
      // arrive, and re-announce ourselves — peers respond to a snapshot by
      // re-flushing freshly-encrypted channels (see the 'snapshot' handler) —
      // so each retry round has new material to try until decryption succeeds.
      // broadcastLocalState is TS-private but a plain method at runtime.
      this.khIntegration?.networkAdapter?.syncKeyhive?.();
      (entry.presence as any)?.broadcastLocalState?.();
    }, 5000);
  }

  /** Drop any pending presence-setup retry (and its buffered early state). */
  private cancelPendingPresence(docId: string): void {
    const t = this.presencePending.get(docId);
    if (t) clearTimeout(t);
    this.presencePending.delete(docId);
    this.presenceDesiredEarly.delete(docId);
  }

  /** Stop and forget a doc's running presence (timers, listeners, goodbye). */
  private teardownPresence(docId: string): void {
    const entry = this.docRegistry.get(docId);
    if (!entry?.presence) return;
    if (entry.presenceRetry) { clearInterval(entry.presenceRetry); entry.presenceRetry = null; }
    if (entry.presenceLiveness) { clearInterval(entry.presenceLiveness); entry.presenceLiveness = null; }
    entry.presence.stop();
    entry.presence = null;
    entry.presenceDoc = undefined;
    entry.presenceDesired = undefined;
    entry.presenceSend = undefined;
  }

  /**
   * Create + start the Presence for a doc. Returns false when keyhive isn't
   * ready for it yet (caller retries); throws when the doc handle can't be
   * loaded yet; returns true once presence is running.
   */
  private async trySetupPresence(docId: string): Promise<boolean> {
    const handle = await this.getOrLoadHandle(docId);
    const entry = this.getOrCreateEntry(docId, handle);
    if (entry.presence) {
      void entry.presenceSend?.(); // give the new subscriber a current snapshot
      return true;
    }
    const doc = await this.getKhDoc(docId);
    if (!doc) return false;

    const presence = new this.PresenceClass({ handle });
    // Library pruning is disabled (peerTtlMs = MAX_SAFE_INTEGER): its heartbeat
    // handler (markSeen) bumps lastUpdateAt while prune() filters on
    // lastActiveAt, so it drops idle-but-heartbeating peers. Liveness is
    // tracked here instead, via lastSeen below.
    presence.start({
      initialState: {},
      heartbeatMs: PRESENCE_HEARTBEAT_MS,
      peerTtlMs: Number.MAX_SAFE_INTEGER,
    });
    entry.presence = presence;
    entry.presenceDoc = doc;
    const userGroupId = await this.khOps?.getUserGroupId();
    entry.presenceDesired = {
      viewing: true,
      focusedField: null,
      ...(userGroupId ? { userGroupId } : {}),
      // State the main thread set while setup was still retrying.
      ...(this.presenceDesiredEarly.get(docId) ?? {}),
    };
    this.presenceDesiredEarly.delete(docId);

    const lastSeen = new Map<string, number>();
    let lastEmittedFresh = new Set<string>();
    const sendPresence = async (): Promise<boolean> => {
      const raw = presence.getPeerStates().value;
      const fresh = freshPresencePeerIds(lastSeen, Date.now());
      const peers: Record<string, any> = {};
      let allOk = true;
      for (const [peerId, st] of Object.entries<any>(raw)) {
        if (!fresh.has(peerId)) continue; // stale — hide and skip decrypt work
        const value: Record<string, unknown> = {};
        for (const [ch, enc] of Object.entries<any>(st?.value ?? {})) {
          try { value[ch] = await this.decryptPresenceValue(doc, enc as Uint8Array); }
          catch (err) {
            allOk = false;
            console.warn(`[engine] presence decrypt failed (peer ${peerId}, channel ${ch}):`, errMsg(err));
          }
        }
        // A fresh peer with no readable state — nothing received yet, or
        // nothing we could decrypt — needs the retry loop's re-announce.
        if (Object.keys(value).length === 0) allOk = false;
        // A heartbeat-first entry has no peerId of its own; the map key fills it in.
        peers[peerId] = { peerId, ...st, value };
      }
      lastEmittedFresh = fresh;
      this.emit({ type: 'update-presence', docId, peers });
      if (!allOk) this.schedulePresenceRetry(entry);
      return allOk;
    };
    entry.presenceSend = sendPresence;
    presence.on('update', (e: any) => { lastSeen.set(e.peerId, Date.now()); void sendPresence(); });
    presence.on('snapshot', (e: any) => {
      lastSeen.set(e.peerId, Date.now());
      // A snapshot is an announce: the sender either just started (its
      // Presence.start broadcast, possibly after a tab reload) or is stuck
      // unable to decrypt us and is asking for fresh material (see
      // schedulePresenceRetry). Respond by re-encrypting and re-sending our
      // channels: a freshly-started peer needs them because the library only
      // re-announces to peerIds it has forgotten (and with pruning disabled it
      // never forgets), and a stuck peer needs fresh cyphertext because each
      // encrypt creates new keyhive ops whose sync delivers the key material
      // it is missing. Flushes go out as updates, never snapshots, so two
      // peers can't ping-pong announces.
      void this.flushPresenceOut(entry);
      void sendPresence();
    });
    presence.on('goodbye', (e: any) => { lastSeen.delete(e.peerId); void sendPresence(); });
    presence.on('heartbeat', (e: any) => {
      const wasFresh = lastEmittedFresh.has(e.peerId);
      lastSeen.set(e.peerId, Date.now());
      // Steady-state heartbeats only bump lastSeen; re-emit just for a peer
      // that was hidden (new, or returning after going stale).
      if (!wasFresh) void sendPresence();
    });
    const setsEqual = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every(x => b.has(x));
    entry.presenceLiveness = setInterval(() => {
      if (!setsEqual(freshPresencePeerIds(lastSeen, Date.now()), lastEmittedFresh)) {
        void sendPresence();
      }
    }, PRESENCE_LIVENESS_CHECK_MS);
    if (typeof entry.presenceLiveness?.unref === 'function') entry.presenceLiveness.unref();
    if (!(await this.flushPresenceOut(entry))) this.schedulePresenceRetry(entry);
    return true;
  }

  // ── Doc registry ───────────────────────────────────────────────────────────
  private async getOrLoadHandle(docId: string): Promise<any> {
    const existing = this.docRegistry.get(docId);
    if (existing) return existing.handle;
    const r = this.getRepo();
    return await r.find(docId as any);
  }

  private getOrCreateEntry(docId: string, handle: any): DocEntry {
    let entry = this.docRegistry.get(docId);
    if (!entry) {
      entry = { handle, pinnedVersion: null, subscriptions: new Map(), presence: null, validationSubscribed: false };
      this.docRegistry.set(docId, entry);
      const onChange = () => {
        void this.pushToSubscriptions(docId);
        // Independent of pushToSubscriptions: that early-returns with no subs
        // and dedups on jq results, but seen-state must track every head change.
        this.refreshSeenState(docId);
        if (this.watchedDocs.has(docId)) this.emitWatchUpdate(docId);
      };
      handle.on('change', onChange);
      // Some automerge-repo versions also emit 'doc' for remote changes
      if (typeof handle.on === 'function') handle.on('doc', onChange);
      // Initial seen-state comparison once loaded — covers docs background-opened
      // by the home page's peek subscriptions, where no change event may ever fire.
      Promise.resolve(handle.isReady?.() ? undefined : handle.whenReady?.())
        .then(() => this.refreshSeenState(docId))
        .catch(() => { /* unavailable — stays unknown */ });
      // Drain subscriptions that were registered before the doc was opened
      const pending = this.pendingSubs.get(docId);
      if (pending) {
        for (const [subId, sub] of pending) entry.subscriptions.set(subId, sub);
        this.pendingSubs.delete(docId);
        void this.pushToSubscriptions(docId);
      }
    }
    return entry;
  }

  // ── "New changes since last viewed" ────────────────────────────────────────
  // A doc is being VIEWED while it has ≥1 live non-peek query subscription (the
  // editor route's subscriptions; the home page and source inspector pass
  // peek: true). While viewed, every change re-records last-viewed heads, so
  // remote edits arriving mid-view count as seen and unsubscribe/tab-close need
  // no bookkeeping. Missing last-viewed record = never viewed = unseen.

  private hasViewingSub(entry: DocEntry): boolean {
    for (const sub of entry.subscriptions.values()) if (!sub.peek) return true;
    return false;
  }

  private emitUnseen(): void {
    this.emit({ type: 'unseen-changes-updated', unseen: { ...this.unseenChanges } });
  }

  private setUnseen(docId: string, value: boolean): void {
    if (this.unseenChanges[docId] === value) return; // transition-only emission
    this.unseenChanges[docId] = value;
    this.emitUnseen();
  }

  private persistLastViewed(): void {
    if (this.lastViewedHeads) void this.host.kv.set(KEYS.lastViewedHeads, this.lastViewedHeads);
  }

  /** Record the doc's current heads as viewed. */
  private markViewed(docId: string, heads: string[]): void {
    if (!this.lastViewedHeads || heads.length === 0) return; // never record "empty" as seen
    if (!headsEqual(this.lastViewedHeads[docId], heads)) {
      this.lastViewedHeads[docId] = [...heads].sort();
      this.persistLastViewed();
    }
    this.setUnseen(docId, false);
  }

  /** Recompute a loaded doc's flag; while a viewing sub is live, keep last-viewed current instead. */
  private refreshSeenState(docId: string): void {
    if (!this.lastViewedHeads) return; // init not finished
    const entry = this.docRegistry.get(docId);
    if (!entry) return;
    const handle = entry.handle;
    if (handle.isReady && !handle.isReady()) return; // heads unknown until load
    const heads: string[] = handle.heads ? handle.heads() : [];
    if (heads.length === 0) return;
    if (this.hasViewingSub(entry)) this.markViewed(docId, heads);
    else this.setUnseen(docId, !headsEqual(this.lastViewedHeads[docId], heads));
  }

  /** Doc left the home list (archive / revoke) — drop its seen state. */
  private pruneSeenState(docId: string): void {
    if (this.lastViewedHeads && docId in this.lastViewedHeads) {
      delete this.lastViewedHeads[docId];
      this.persistLastViewed();
    }
    if (docId in this.unseenChanges) {
      delete this.unseenChanges[docId];
      this.emitUnseen();
    }
  }

  // ── Query caching ──────────────────────────────────────────────────────────
  private async runQuery(filter: string, doc: any): Promise<any> {
    let fn = this.debugEnabled ? undefined : this.jqCache.get(filter);
    if (!fn) {
      const { compile } = await import('./jq');
      const compiled = compile(filter);
      fn = (input: any) => { const r = compiled(input); return r.length > 0 ? r[0] : null; };
      if (!this.debugEnabled) this.jqCache.set(filter, fn);
    }
    return fn(doc);
  }

  private async runCachedQuery(
    docId: string, filter: string, doc: any, heads: string[], lastModified?: number,
  ): Promise<{ result: any; heads: string[]; lastModified?: number; changed: boolean }> {
    const result = await this.runQuery(filter, doc);
    if (this.debugEnabled) return { result, heads, lastModified, changed: true };

    const cacheKey = queryCacheKey(docId, filter);
    const json = JSON.stringify(result);
    const cached = this.queryResultCache.get(cacheKey);
    if (cached && cached.json === json) return { result, heads, lastModified, changed: false };

    const entry: QueryCacheEntry = { result, json, lastModified, heads };
    this.queryResultCache.set(cacheKey, entry);
    void this.host.kv.set(cacheKey, entry);
    return { result, heads, lastModified, changed: true };
  }

  /** Subscribe to a jq query, routing results to the given poster. */
  async subscribeQuery(docId: string, subId: number, filter: string, post: (m: any) => void, peek?: boolean): Promise<void> {
    this.subIdToDocId.set(subId, docId);

    if (!this.debugEnabled) {
      const cacheKey = queryCacheKey(docId, filter);
      const memoryCached = this.queryResultCache.get(cacheKey);
      if (memoryCached) {
        post({ type: 'query-result', subId, result: memoryCached.result, heads: memoryCached.heads, lastModified: memoryCached.lastModified });
      } else {
        const idbCached = await this.host.kv.get<QueryCacheEntry>(cacheKey);
        if (idbCached) {
          this.queryResultCache.set(cacheKey, idbCached);
          post({ type: 'query-result', subId, result: idbCached.result, heads: idbCached.heads, lastModified: idbCached.lastModified });
        }
      }
    }

    const entry = this.docRegistry.get(docId);
    if (entry) {
      entry.subscriptions.set(subId, { filter, post, peek });
      // A non-peek sub on an already-loaded doc = the user started viewing it.
      this.refreshSeenState(docId);
      await this.pushToSubscriptions(docId);
    } else {
      let pending = this.pendingSubs.get(docId);
      if (!pending) { pending = new Map(); this.pendingSubs.set(docId, pending); }
      pending.set(subId, { filter, post, peek });
      if (OPEN_DOCS_IN_BACKGROUND) {
        this.getOrLoadHandle(docId)
          .then(handle => this.getOrCreateEntry(docId, handle))
          .catch(err => console.warn(`[engine] subscribe-query open failed ${docId}:`, errMsg(err)));
      }
    }
  }

  unsubscribeQuery(subId: number): void {
    const docId = this.subIdToDocId.get(subId);
    if (docId) {
      this.subIdToDocId.delete(subId);
      const entry = this.docRegistry.get(docId);
      if (entry) entry.subscriptions.delete(subId);
      const pending = this.pendingSubs.get(docId);
      if (pending) {
        pending.delete(subId);
        if (pending.size === 0) this.pendingSubs.delete(docId);
      }
    }
  }

  private async pushToSubscriptions(docId: string): Promise<void> {
    const entry = this.docRegistry.get(docId);
    if (!entry) return;

    const hasQuerySubs = entry.subscriptions.size > 0;
    const hasValidation = entry.validationSubscribed;
    if (!hasQuerySubs && !hasValidation) return;

    const handle = entry.handle;
    if (handle.isReady && !handle.isReady()) return;
    const rawDoc = handle.doc();
    if (!rawDoc) return;
    const history = this.Automerge.getHistory(rawDoc);
    let activeDoc: any;
    if (entry.pinnedVersion !== null) {
      activeDoc = history[entry.pinnedVersion]?.snapshot ?? rawDoc;
    } else {
      activeDoc = rawDoc;
    }
    const heads: string[] = handle.heads ? handle.heads() : [];

    let lastModified: number | undefined;
    if (history.length > 0) {
      const ts = history[history.length - 1].change.time;
      if (ts) lastModified = ts;
    }

    const activeHashes = new Set<string>();
    for (const [subId, sub] of entry.subscriptions) {
      activeHashes.add(hashStr(sub.filter));
      try {
        const { result, changed } = await this.runCachedQuery(docId, sub.filter, activeDoc, heads, lastModified);
        if (!changed) continue;
        sub.post({ type: 'query-result', subId, result, heads, lastModified });
      } catch (err: any) {
        sub.post({ type: 'query-result', subId, result: null, heads, error: errMsg(err) });
      }
    }

    activeHashes.add('validation');

    const prefix = docCachePrefix(docId);
    for (const key of this.queryResultCache.keys()) {
      if (key.startsWith(prefix) && !activeHashes.has(key.slice(prefix.length))) {
        console.log(`[engine] might want to (but will not) delete possibly stale key ${key}`);
      }
    }

    if (hasValidation) void this.pushValidation(docId, activeDoc);
  }

  private async pushValidation(docId: string, doc: any): Promise<void> {
    const allErrors = validateDocument(doc);
    const errors = allErrors.slice(0, 100);

    if (!this.debugEnabled) {
      const json = JSON.stringify(errors);
      const cacheKey = validationCacheKey(docId);
      const cached = this.queryResultCache.get(cacheKey);
      if (cached && cached.json === json) return;
      const entry: QueryCacheEntry = { result: errors, json, heads: [] };
      this.queryResultCache.set(cacheKey, entry);
      void this.host.kv.set(cacheKey, entry);
    }

    this.emit({ type: 'update-validation', docId, errors });
  }

  // ── Home doc reconcile ─────────────────────────────────────────────────────
  private async reconcileHomeDocs(): Promise<void> {
    if (this.reconcileInFlight) { this.reconcilePending = true; return; }
    this.reconcileInFlight = true;
    try {
      do {
        this.reconcilePending = false;
        await this.reconcileHomeDocsOnce();
      } while (this.reconcilePending);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async reconcileHomeDocsAfterLink(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      try { this.khIntegration?.networkAdapter?.syncKeyhive?.(); } catch { /* best effort */ }
      await this.reconcileHomeDocs();
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  private async reconcileHomeDocsOnce(): Promise<void> {
    if (!this.khOps || !this.amDocIdFromBytes) return;
    try {
      const { accessibleKhIds, reachableKhIds } = await this.khOps.enumerateUserDocs();
      const list = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
      const tombstones = (await this.host.kv.get<ArchivedDocTombstones>(KEYS.archivedDocIds)) ?? {};
      const knownIds = new Set(list.map(e => e.id));
      const accessibleAmIds = new Set(accessibleKhIds.map(k => this.amDocIdFromBytes!(base64ToBytes(k))));
      const reachableSet = new Set(reachableKhIds);
      let changed = false;
      let tombstonesChanged = false;
      const newDocHandles: string[] = [];

      for (const amDocId of accessibleAmIds) {
        if (knownIds.has(amDocId)) continue;
        const tomb = tombstones[amDocId];
        if (tomb) {
          // Archived here while the user-group kept access (self-revoke wasn't
          // possible). Un-archive ONLY on a deliberate re-share: a direct grant
          // whose signature isn't in the archive-time baseline. An empty
          // baseline (signatures couldn't be captured) never auto-un-archives.
          const sigs = await this.khOps.getUserGroupGrantSigs(this.resolveKhDocId(amDocId));
          const reshared = tomb.grantSigs.length > 0 && sigs.some(s => !tomb.grantSigs.includes(s));
          if (!reshared) continue;
          console.log(`[engine] reconcileHomeDocs: re-shared archived doc ${amDocId}, un-archiving`);
          delete tombstones[amDocId];
          tombstonesChanged = true;
        }
        console.log(`[engine] reconcileHomeDocs: adding accessible doc ${amDocId}`);
        list.unshift({ id: amDocId });
        knownIds.add(amDocId);
        newDocHandles.push(amDocId);
        changed = true;
        // Newly-shared docs get the new-changes dot immediately (never viewed here).
        if (!this.lastViewedHeads?.[amDocId]) this.setUnseen(amDocId, true);
      }

      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (tombstones[e.id]) {
          // Archived, but still listed — a reconcile raced the archive handler.
          console.log(`[engine] reconcileHomeDocs: removing archived doc ${e.id}`);
          list.splice(i, 1);
          knownIds.delete(e.id);
          changed = true;
          this.pruneSeenState(e.id);
          continue;
        }
        if (accessibleAmIds.has(e.id)) continue;
        const khDocId = this.resolveKhDocId(e.id);
        if (reachableSet.has(khDocId)) {
          console.log(`[engine] reconcileHomeDocs: removing revoked doc ${e.id}`);
          list.splice(i, 1);
          knownIds.delete(e.id);
          changed = true;
          this.pruneSeenState(e.id);
        }
      }

      // A tombstone whose doc the user-group can no longer access is done: the
      // revoke landed (or access was withdrawn), so the derived list alone keeps
      // it out and a future grant should surface the doc again normally.
      for (const amDocId of Object.keys(tombstones)) {
        if (!accessibleAmIds.has(amDocId)) {
          delete tombstones[amDocId];
          tombstonesChanged = true;
        }
      }
      if (tombstonesChanged) await this.host.kv.set(KEYS.archivedDocIds, tombstones);

      if (changed) {
        await this.host.kv.set(KEYS.docIds, list);
        this.emit({ type: 'doc-list-updated', list });
        for (const docId of newDocHandles) {
          try {
            const handle = await this.getOrLoadHandle(docId);
            this.getOrCreateEntry(docId, handle);
          } catch (err) {
            console.warn(`[engine] reconcileHomeDocs: failed to pre-load ${docId}:`, errMsg(err));
          }
        }
      }
    } catch (err) {
      console.warn('[engine] reconcileHomeDocs failed:', errMsg(err));
    }
  }

  private postStatus(): void {
    const peers = visiblePeerIds(this.repo ? this.repo.peers : []);
    const peerCount = peers.length;
    this.emit({ type: peerCount > 0 ? 'peer-connected' : 'peer-disconnected', peerCount, peers });
  }

  // ── Rendezvous ─────────────────────────────────────────────────────────────
  private rdvSend(frame: { type: string; rendezvousId: string; data?: Uint8Array }): void {
    this.host.network.sendOverlayFrame(frame);
  }
  private rdvEvent(rendezvousId: string, status: RendezvousStatus, message?: string): void {
    this.emit({ type: 'kh-rdv-event', rendezvousId, status, ...(message !== undefined ? { message } : {}) });
  }
  private async rdvSendPayload(rendezvousId: string, key: string, plaintext: string): Promise<void> {
    const framed = await encryptString(key, plaintext);
    this.rdvEvent(rendezvousId, 'sending', formatBytes(framed.length));
    this.rdvSend({ type: RDV_MSG, rendezvousId, data: framed });
  }
  /** Handle an inbound rendezvous frame (host routes rdv frames here). */
  handleRendezvousFrame(msg: any): void {
    const rid: string | undefined = msg.rendezvousId;
    if (!rid) return;
    const session = this.rdvSessions.get(rid);
    if (!session) return;
    if (msg.type === RDV_PEER) {
      session.onPeer?.();
    } else if (msg.type === RDV_MSG && session.onData) {
      const data: Uint8Array = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
      if (data.byteLength > RDV_MAX_DATA_BYTES) {
        console.warn(`[engine] dropping oversized rendezvous payload (${data.byteLength} bytes, max ${RDV_MAX_DATA_BYTES})`);
        return;
      }
      decryptString(session.key, data)
        .then(pt => session.onData!(pt))
        .catch(err => console.error('[engine] failed to decrypt inbound rendezvous payload:', errMsg(err)));
    }
  }

  /** Device-link joiner (the new device). Adopts the original device's user-group. */
  async rendezvousLinkJoin(rendezvousId: string, key: string, deviceName?: string): Promise<{ ok: true }> {
    if (!this.khOps) throw new Error('Keyhive not available');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rdvSessions.delete(rendezvousId);
        reject(new Error('Timed out waiting for your other device. Make sure its QR/link is open, then try again.'));
      }, RDV_RECEIVE_TIMEOUT_MS);
      this.rdvSessions.set(rendezvousId, {
        key,
        onPeer: () => this.rdvEvent(rendezvousId, 'peer-joined'),
        onData: (pt) => {
          (async () => {
            try {
              this.rdvEvent(rendezvousId, 'receiving');
              const { card: peerCard, userGroupId: peerGroupId, deviceName: peerDeviceName } = JSON.parse(pt);
              const result = await this.khOps!.receiveContactCard(peerCard);
              if (result.isOwnCard) throw new Error("This is your own device's link. Open it on a different device.");
              await this.khOps!.linkDevice(result.agentId, peerGroupId ?? null);
              // Record the original device's name against its agentId (both sides
              // exchange names so each ends up knowing the other from one scan).
              await this.putDeviceName(result.agentId, peerDeviceName);
              const myUserGroupId = await this.khOps!.ensureUserGroup({ create: true });
              const myCard = await this.khOps!.getContactCard();
              await this.rdvSendPayload(rendezvousId, key, JSON.stringify({ card: myCard, userGroupId: myUserGroupId, deviceName }));
              clearTimeout(timer);
              this.rdvSessions.delete(rendezvousId);
              this.rdvSend({ type: RDV_UNSUB, rendezvousId });
              this.rdvEvent(rendezvousId, 'linked');
              resolve();
            } catch (err) {
              clearTimeout(timer);
              this.rdvSessions.delete(rendezvousId);
              this.rdvSend({ type: RDV_UNSUB, rendezvousId });
              this.rdvEvent(rendezvousId, 'error', errMsg(err));
              reject(err);
            }
          })();
        },
      });
      this.rdvSend({ type: RDV_SUB, rendezvousId });
      this.rdvEvent(rendezvousId, 'waiting');
    });
    void this.reconcileHomeDocsAfterLink();
    return { ok: true };
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    // Hydrate the debug-enable flag from its persisted setting. When on it also
    // disables the caches (bypass checks below) and traces keyhive calls.
    try {
      this.debugEnabled = (await this.host.kv.settingGet('debug-enable')) === true;
    } catch (err) {
      console.warn('[engine] failed to read debug-enable setting:', errMsg(err));
    }

    // Load the last-viewed heads map early so seen-state works even if keyhive
    // init fails below.
    try {
      this.lastViewedHeads = (await this.host.kv.get<Record<string, string[]>>(KEYS.lastViewedHeads)) ?? {};
    } catch (err) {
      console.warn('[engine] failed to read last-viewed heads:', errMsg(err));
      this.lastViewedHeads = {};
    }

    try {
      const kh = await createKeyhiveRepo({
        storage: this.host.storage,
        networkAdapter: this.host.network.networkAdapter,
        // Fixed suffix ⇒ all tabs of a device share one peerId, and the relay's
        // duplicate-join rejection means only ONE tab is connected at a time.
        // Per-tab suffixes (`drive.<nonce>`) are NOT allowed: a sibling tab's
        // first presence encrypt on a shared doc hits a keyhive WASM panic
        // (beekem new_app_secret_for pcs_key_ops lookup — "unreachable
        // executed") that kills its worker. See keyhive-cgka-presence-panic.
        peerIdSuffix: 'drive',
        serialize: true,
        withShareConfig: true,
        // Debug mode only: record the most-recent keyhive (Rust/WASM) call so the
        // worker's error handler can name the call that trapped when the worker dies
        // on a WASM `unreachable` panic. See reportWorkerError in automerge-worker.ts.
        onKeyhiveCall: this.debugEnabled ? (method) => { this.lastKeyhiveCall = method; } : undefined,
        getUserGroupId: async () => (await this.host.kv.get<string>(KEYS.userGroupId)) ?? null,
        setUserGroupId: async (groupId) => { await this.host.kv.set(KEYS.userGroupId, groupId); },
        onBeforeShareConfigChanged: () => {
          // After keyhive ingests remote ops, reconcile the home list and notify the UI.
          void this.reconcileHomeDocs();
          this.emit({ type: 'kh-state-changed' });
        },
      });
      this.repo = kh.repo;
      this.khIntegration = kh.integration;
      this.khOps = kh.khOps;
      this.bridge = kh.bridge;
      this.Automerge = kh.Automerge;
      this.PresenceClass = kh.Presence;
      this.amDocIdFromBytes = kh.amDocIdFromBytes;
      this.setNextDocId = kh.setNextDocId;

      // Route inbound rendezvous frames from the host's socket into the engine.
      this.host.network.onRendezvousFrame((frame) => this.handleRendezvousFrame(frame));

      const ns = this.repo.networkSubsystem;
      ns.on('peer', () => this.postStatus());
      ns.on('peer-disconnected', () => this.postStatus());

      console.log('[engine] secure repo created, peerId:', this.repo.peerId);

      // Pre-register docs with keyhive and push doc list + contact names BEFORE
      // kh-ready so code awaiting keyhiveReady can read them immediately.
      const earlyList = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
      for (const entry of earlyList) {
        const khDocId = this.resolveKhDocId(entry.id);
        try {
          this.khOps.registerDocMapping(entry.id, khDocId);
          await this.khOps.registerSharingGroup(khDocId);
        } catch (err) {
          console.warn(`[engine] Failed to pre-register doc ${entry.id}:`, errMsg(err));
        }
      }
      this.emit({ type: 'doc-list-updated', list: earlyList });
      // Missing last-viewed record = unseen: computable without loading any doc.
      // Docs WITH a record stay absent (unknown) until they load and compare —
      // avoids a dot-flash on every start.
      for (const e of earlyList) if (!this.lastViewedHeads![e.id]) this.unseenChanges[e.id] = true;
      this.emitUnseen();
      this.broadcastContactNames(await this.getContactNames());
      this.broadcastDeviceNames(await this.getDeviceNames());
      this.emit({ type: 'kh-ready' });
    } catch (khErr: any) {
      console.error('[engine] keyhive init failed:', khErr);
      this.emit({ type: 'kh-error', message: errMsg(khErr) });
    }

    // If the repo never came up (keyhive init threw), stop here — there is nothing
    // to reconcile or watch, and emitting `ready` would dereference a null repo.
    if (!this.repo) {
      this.emit({ type: 'error', message: 'init failed: repo not created (keyhive init error above)' });
      return;
    }

    // Detect a dangling user-group (id persisted but its group missing from keyhive).
    const danglingGroup = this.khOps ? await this.khOps.findDanglingUserGroup() : null;
    if (danglingGroup) {
      console.error(`[engine] user-group ${danglingGroup} is dangling — skipping reconcile to preserve the home list`);
      this.emit({
        type: 'data-warning',
        message: `Your user-group is missing from local keyhive storage (likely from a data migration). Documents are preserved, but sharing is broken — reset via Settings → Delete All Data.`,
      });
    } else {
      void this.reconcileHomeDocs();
    }

    console.log('[engine] init complete');
    this.emit({ type: 'ready', peerId: this.repo!.peerId });
  }

  // ── Enumeration helpers (used by the CLI watch loop) ───────────────────────
  /** Automerge doc ids the user-group can access. */
  async enumerateAccessibleDocIds(): Promise<string[]> {
    if (!this.khOps || !this.amDocIdFromBytes) return [];
    const { accessibleKhIds } = await this.khOps.enumerateUserDocs();
    return accessibleKhIds.map(k => this.amDocIdFromBytes!(base64ToBytes(k)));
  }

  /** Read a doc's `@type`/name and last-change time (opening it if needed). */
  async getDocMeta(docId: string): Promise<WatchUpdate> {
    const handle = await this.getOrLoadHandle(docId);
    // Resolve on 'unavailable' too, so a doc no connected peer has (e.g. every
    // read in the CLI's local-only mode) reports empty instead of hanging.
    if (handle.whenReady) { try { await handle.whenReady(['ready', 'unavailable']); } catch { /* keep going */ } }
    const doc = handle.doc();
    const heads: string[] = handle.heads ? handle.heads() : [];
    let lastModified: number | undefined;
    let docType: string | undefined;
    let name: string | undefined;
    let versions: number | undefined;
    if (doc) {
      docType = doc['@type'];
      name = doc.name;
      const history = this.Automerge.getHistory(doc);
      versions = history.length;
      if (history.length > 0) {
        const ts = history[history.length - 1].change.time;
        if (ts) lastModified = ts;
      }
    }
    return { docId, docType, name, heads, lastModified, versions };
  }

  /**
   * A doc as a plain JS object (opens + waits for ready). With no `version`, the
   * current view; otherwise the snapshot at that history index (0-based).
   */
  async getDocJson(docId: string, version?: number): Promise<any> {
    const handle = await this.getOrLoadHandle(docId);
    if (handle.whenReady) { try { await handle.whenReady(['ready', 'unavailable']); } catch { /* keep going */ } }
    const doc = handle.doc();
    if (!doc || version === undefined) return doc ?? null;
    const history = this.Automerge.getHistory(doc);
    if (version < 0 || version >= history.length) {
      throw new Error(`version ${version} out of range (0..${history.length - 1})`);
    }
    return history[version].snapshot ?? null;
  }

  /**
   * Automerge patch ops between two history versions (0-based indices). Defaults
   * mirror the git-style range: `to` is the latest version, `from` is `to - 1`,
   * so calling with no range shows what the most-recent change did. A `from` of
   * -1 (or version 0 as the latest) diffs against the empty document.
   */
  async diffVersions(
    docId: string, fromVersion?: number, toVersion?: number,
  ): Promise<{ from: number; to: number; patches: any[] }> {
    const handle = await this.getOrLoadHandle(docId);
    if (handle.whenReady) { try { await handle.whenReady(['ready', 'unavailable']); } catch { /* keep going */ } }
    const doc = handle.doc();
    if (!doc) throw new Error('document not ready');
    const history = this.Automerge.getHistory(doc);
    const n = history.length;
    if (n === 0) throw new Error('document has no history');

    const to = toVersion ?? (n - 1);
    const from = fromVersion ?? (to - 1); // -1 ⇒ diff against the empty document
    if (to < 0 || to >= n) throw new Error(`version ${to} out of range (0..${n - 1})`);
    if (from < -1 || from >= n) throw new Error(`version ${from} out of range (-1..${n - 1})`);

    const beforeHeads = from < 0 ? [] : [history[from].change.hash];
    const afterHeads = [history[to].change.hash];
    const patches = this.Automerge.diff(doc, beforeHeads, afterHeads);
    return { from, to, patches };
  }

  private emitWatchUpdate(docId: string): void {
    if (!this.watchOnUpdate) return;
    void this.getDocMeta(docId).then(u => this.watchOnUpdate?.(u)).catch(() => { });
  }

  // ── Watcher: keep N most-recent open + rotate the rest ─────────────────────
  async startWatching(opts: StartWatchingOptions, onUpdate?: (u: WatchUpdate) => void): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    this.watchOnUpdate = onUpdate ?? null;
    void this.runWatchLoop(opts);
  }

  stopWatching(): void {
    this.watching = false;
    this.watchedDocs.clear();
  }

  /** Mark a doc as watched (attaches to its change listener via getOrCreateEntry). */
  private async watchKeepOpen(docId: string): Promise<void> {
    this.watchedDocs.add(docId);
    try {
      const handle = await this.getOrLoadHandle(docId);
      this.getOrCreateEntry(docId, handle);
    } catch (err) {
      console.warn(`[engine] watch keep-open failed ${docId}:`, errMsg(err));
    }
  }

  /** Best-effort close: stop watching + drop the registry entry if nothing else needs it. */
  private watchClose(docId: string): void {
    this.watchedDocs.delete(docId);
    if (this.pinnedDocs.has(docId)) return;
    const entry = this.docRegistry.get(docId);
    if (!entry) return;
    if (entry.subscriptions.size > 0 || entry.validationSubscribed || entry.presence) return;
    this.docRegistry.delete(docId);
  }

  private async runWatchLoop(opts: StartWatchingOptions): Promise<void> {
    const syncMs = opts.syncMs;
    const reenumerateEveryMs = opts.reenumerateEveryMs ?? 30_000;
    while (this.watching) {
      try {
        const ids = await this.enumerateAccessibleDocIds();
        // Rank by recency (last-change time, in seconds).
        const ranked: Array<{ id: string; rec: number }> = [];
        for (const id of ids) {
          if (!this.watching) return;
          try {
            const meta = await this.getDocMeta(id);
            ranked.push({ id, rec: meta.lastModified ?? 0 });
          } catch {
            ranked.push({ id, rec: 0 });
          }
        }
        ranked.sort((a, b) => b.rec - a.rec);

        // Kept-open set = whichever is LARGER: the top-N, or every doc edited within
        // the last `recentDays`. Since the recent-window docs are the most recent,
        // keeping the top max(N, #within-window) by recency yields exactly that union.
        const nowSec = Date.now() / 1000;
        const windowStart = nowSec - opts.recentDays * 86_400;
        const withinWindow = ranked.filter(r => r.rec >= windowStart).length;
        const keepCount = Math.max(opts.keepOpen, withinWindow);
        const keep = ranked.slice(0, keepCount).map(r => r.id);
        const keepSet = new Set(keep);

        for (const id of keep) await this.watchKeepOpen(id);
        console.log(`[engine] watch: keeping ${keep.length} doc(s) open (min ${opts.keepOpen}, ${withinWindow} within ${opts.recentDays}d)`);

        // Release any previously-watched doc that dropped out of the kept set (and
        // isn't pinned) so only the kept set stays resident between rotations.
        for (const id of [...this.watchedDocs]) {
          if (!keepSet.has(id)) this.watchClose(id);
        }

        // Rotate the remainder one-by-one: open, hold open long enough to sync, close.
        const rest = ranked.slice(keepCount).map(r => r.id).filter(id => !this.pinnedDocs.has(id));
        for (const id of rest) {
          if (!this.watching) return;
          console.log(`[engine] watch: syncing ${id} for ${Math.round(syncMs / 1000)}s`);
          await this.watchKeepOpen(id);
          this.emitWatchUpdate(id);
          await this.sleep(syncMs);
          if (!keepSet.has(id)) this.watchClose(id);
        }
      } catch (err) {
        console.warn('[engine] watch loop error:', errMsg(err));
      }
      await this.sleep(reenumerateEveryMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── Message dispatch (browser worker shell) ────────────────────────────────
  /**
   * Handle a MainToWorker message. `post` receives query-result messages for
   * subscribe-query (defaults to host.emit). All other results/broadcasts go via
   * host.emit. hf-port/webrtc-port are transport concerns handled by the shell.
   */
  async handleMessage(msg: MainToWorker): Promise<void> {
    const emit = (m: WorkerToMain) => this.host.emit(m);

    if (msg.type === 'init') {
      try { await this.init(); }
      catch (err: any) {
        console.error('[engine] init failed:', err);
        emit({ type: 'error', message: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'set-debug-mode') {
      try {
        this.debugEnabled = msg.enabled;
        await this.host.kv.settingSet('debug-enable', msg.enabled);
        if (msg.enabled) {
          this.queryResultCache.clear();
          this.jqCache.clear();
          await this.host.kv.delPrefix(CACHE_PREFIX);
        }
        emit({ type: 'result', id: msg.id, result: null });
      } catch (err) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'set-presence-timing') {
      // Test hook: override presence timing so specs can drive a short stale
      // window instead of sleeping past the 12s default. Takes effect on the
      // next presence setup, so callers must set it before subscribing.
      if (typeof msg.staleMs === 'number') PRESENCE_STALE_MS = msg.staleMs;
      if (typeof msg.heartbeatMs === 'number') PRESENCE_HEARTBEAT_MS = msg.heartbeatMs;
      if (typeof msg.livenessCheckMs === 'number') PRESENCE_LIVENESS_CHECK_MS = msg.livenessCheckMs;
      emit({ type: 'result', id: msg.id, result: null });
      return;
    }

    if (msg.type === 'clear-caches') {
      try {
        this.queryResultCache.clear();
        this.jqCache.clear();
        await this.host.kv.delPrefix(CACHE_PREFIX);
        emit({ type: 'result', id: msg.id, result: null });
      } catch (err) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'get-doc-list') {
      try {
        const list = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
        emit({ type: 'result', id: msg.id, result: list });
      } catch (err) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'create-doc') {
      try {
        if (!this.repo || !this.khOps || !this.setNextDocId) throw new Error('Secure repo not available');
        const { docIdBytes } = await this.khOps.createKeyhiveDoc();
        this.setNextDocId(docIdBytes);
        const handle = await this.repo.create2(msg.initialJson);
        {
          const earlyList = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
          earlyList.unshift({ id: handle.documentId, ...(msg.metadata ?? {}) });
          await this.host.kv.set(KEYS.docIds, earlyList);
          emit({ type: 'doc-list-updated', list: earlyList });
        }
        await this.khOps.enableSharing(handle.documentId, docIdBytes);
        const docId = handle.documentId;
        const doc = handle.doc();
        if (this.repo.storageSubsystem && doc) {
          this.repo.storageSubsystem.saveDoc(docId, doc).then(() => {
            console.log(`[engine] create-doc: saveDoc OK for ${docId}`);
          }).catch((err: any) => {
            console.error(`[engine] create-doc: saveDoc FAILED for ${docId}:`, err);
          });
        }
        emit({ type: 'result', id: msg.id, result: { docId } });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'open-doc') {
      const progress = (pct: number, message: string) =>
        emit({ type: 'open-doc-progress', id: msg.id, pct, message });
      try {
        this.pinnedDocs.add(msg.docId);
        if (this.khOps && this.bridge && this.khIntegration) {
          try {
            const khDocId = this.bridge.docIdFromAutomergeUrl(`automerge:${msg.docId}` as any);
            const doc = await this.khOps.kh.getDocument(khDocId);
            if (doc) {
              const khDocIdB64 = bytesToBase64(doc.id.toBytes());
              this.khOps.khDocuments.set(khDocIdB64, doc);
            }
          } catch (err) {
            console.warn('[engine] Failed to check keyhive for doc:', errMsg(err));
          }
        }
        progress(10, 'Finding document…');
        const handle = await this.getOrLoadHandle(msg.docId);
        this.getOrCreateEntry(msg.docId, handle);
        progress(50, 'Loading document data…');
        const isReady = handle.isReady ? handle.isReady() : false;
        if (isReady) {
          progress(100, 'Ready');
          emit({ type: 'result', id: msg.id, result: { docId: msg.docId } });
        } else {
          // Await readiness OR unavailability so a doc no online peer has resolves
          // the wait (as 'unavailable') instead of hanging forever. In this
          // automerge-repo (subduction.37) `Repo.find()` already rejects on
          // unavailable — caught below — but a handle that reaches this branch and
          // then goes unavailable is reported as an error rather than left pending.
          handle.whenReady(['ready', 'unavailable']).then(() => {
            const nowReady = handle.isReady ? handle.isReady() : true;
            if (nowReady) {
              progress(100, 'Ready');
              emit({ type: 'result', id: msg.id, result: { docId: msg.docId } });
            } else {
              emit({ type: 'result', id: msg.id, error: 'Document is unavailable — no connected peer has it yet.' });
            }
          }).catch((err: any) => {
            emit({ type: 'result', id: msg.id, error: errMsg(err) });
          });
        }
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'subscribe-query') {
      try {
        await this.subscribeQuery(msg.docId, msg.subId, msg.filter, (m) => emit(m), msg.peek);
      } catch (err: any) {
        emit({ type: 'query-result', subId: msg.subId, result: null, heads: [], error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'unsubscribe-query') { this.unsubscribeQuery(msg.subId); return; }

    if (msg.type === 'subscribe-validation') {
      const valCacheKey = validationCacheKey(msg.docId);
      const valMemCached = this.queryResultCache.get(valCacheKey);
      if (valMemCached) {
        emit({ type: 'update-validation', docId: msg.docId, errors: valMemCached.result });
      } else {
        const valIdbCached = await this.host.kv.get<QueryCacheEntry>(valCacheKey);
        if (valIdbCached) {
          this.queryResultCache.set(valCacheKey, valIdbCached);
          emit({ type: 'update-validation', docId: msg.docId, errors: valIdbCached.result });
        }
      }
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const entry = this.getOrCreateEntry(msg.docId, handle);
        entry.validationSubscribed = true;
        await this.pushToSubscriptions(msg.docId);
      } catch (err: any) {
        emit({ type: 'update-validation', docId: msg.docId, errors: [] });
      }
      return;
    }

    if (msg.type === 'unsubscribe-validation') {
      const entry = this.docRegistry.get(msg.docId);
      if (entry) entry.validationSubscribed = false;
      return;
    }

    if (msg.type === 'set-doc-version') {
      try {
        const entry = this.docRegistry.get(msg.docId);
        if (!entry) return;
        entry.pinnedVersion = msg.version;
        await this.pushToSubscriptions(msg.docId);
      } catch (err: any) {
        console.warn('[engine] set-doc-version failed:', errMsg(err));
      }
      return;
    }

    if (msg.type === 'update-doc') {
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const workerFns: Record<string, any> = { deepAssign };
        const argVals = (msg.args as any[]).map((a: any) =>
          a && typeof a === 'object' && '__workerFn__' in a ? workerFns[a.__workerFn__] : a
        );
        handle.change((d: any) => {
          const fn = new Function('return ' + msg.fnSource)();
          fn(d, ...argVals);
        });
        await this.pushToSubscriptions(msg.docId);
        emit({ type: 'result', id: msg.id, result: null });
      } catch (err: any) {
        console.error('[engine] update-doc failed:', errMsg(err));
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'get-doc-history') {
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const doc = handle.doc();
        if (!doc) throw new Error('Document not ready');
        const history = this.Automerge.getHistory(doc);
        const result = history.map((e: any, i: number) => ({ version: i, time: e.change.time }));
        emit({ type: 'result', id: msg.id, result });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'debug-get-version-patches') {
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const doc = handle.doc();
        if (!doc) throw new Error('Document not ready');
        const history = this.Automerge.getHistory(doc);
        if (msg.version < 0 || msg.version >= history.length) throw new Error('Version out of range');
        const afterHash = history[msg.version].change.hash;
        const beforeHeads = msg.version === 0 ? [] : [history[msg.version - 1].change.hash];
        const patches = this.Automerge.diff(doc, beforeHeads, [afterHash]);
        emit({ type: 'result', id: msg.id, result: patches });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'restore-doc-to-heads') {
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const targetDoc = handle.view(msg.heads as any).doc();
        if (!targetDoc) throw new Error('Could not view document at heads');
        handle.change((d: any) => syncToTarget(d, targetDoc));
        const entry = this.docRegistry.get(msg.docId);
        if (entry) entry.pinnedVersion = null;
        await this.pushToSubscriptions(msg.docId);
        emit({ type: 'result', id: msg.id, result: null });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'restore-doc-to-version') {
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const history = this.Automerge.getHistory(handle.doc());
        const snap = history[msg.version]?.snapshot;
        if (!snap) throw new Error(`Version ${msg.version} not found`);
        handle.change((d: any) => syncToTarget(d, snap));
        const entry = this.docRegistry.get(msg.docId);
        if (entry) entry.pinnedVersion = null;
        await this.pushToSubscriptions(msg.docId);
        emit({ type: 'result', id: msg.id, result: null });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'subscribe-presence') {
      // On a cold worker the doc handle / keyhive doc may not be ready yet
      // (repo.find can throw before the first sync), so keep retrying until
      // setup succeeds or the doc is unsubscribed — a one-shot attempt left
      // presence permanently dead for pages loaded directly on an editor URL.
      if (this.presencePending.has(msg.docId)) return; // already being established
      this.presencePending.set(msg.docId, null); // null = attempt in flight
      const attempt = async () => {
        let ok = false;
        try { ok = await this.trySetupPresence(msg.docId); }
        catch (err: any) { console.warn('[engine] presence-subscribe not ready, retrying:', errMsg(err)); }
        if (!this.presencePending.has(msg.docId)) {
          // Unsubscribed while this attempt ran — undo a setup that won the race.
          if (ok) this.teardownPresence(msg.docId);
          return;
        }
        if (ok) { this.cancelPendingPresence(msg.docId); return; }
        const t: any = setTimeout(() => { void attempt(); }, PRESENCE_SETUP_RETRY_MS);
        if (typeof t?.unref === 'function') t.unref();
        this.presencePending.set(msg.docId, t);
      };
      void attempt();
      return;
    }

    if (msg.type === 'unsubscribe-presence') {
      this.cancelPendingPresence(msg.docId);
      this.teardownPresence(msg.docId);
      return;
    }

    if (msg.type === 'set-presence') {
      const entry = this.docRegistry.get(msg.docId);
      if (entry?.presence) {
        entry.presenceDesired = { ...(entry.presenceDesired ?? {}), ...msg.state };
        if (!(await this.flushPresenceOut(entry))) this.schedulePresenceRetry(entry);
      } else if (this.presencePending.has(msg.docId)) {
        // Presence is still starting — buffer the state so it broadcasts once
        // setup succeeds instead of being silently dropped.
        this.presenceDesiredEarly.set(msg.docId, {
          ...(this.presenceDesiredEarly.get(msg.docId) ?? {}),
          ...msg.state,
        });
      }
      return;
    }

    if (msg.type === 'archive-doc') {
      try {
        // Tombstone FIRST (empty baseline), so a reconcile racing this handler
        // (any keyhive ingest triggers one) can't re-add the doc between the
        // list write and the revoke below. The baseline is upgraded to the real
        // grant signatures once revokeMyAccess reports them.
        const tombstones = (await this.host.kv.get<ArchivedDocTombstones>(KEYS.archivedDocIds)) ?? {};
        tombstones[msg.docId] = { grantSigs: [] };
        await this.host.kv.set(KEYS.archivedDocIds, tombstones);
        const list = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
        const removedEntry = list.find(e => e.id === msg.docId);
        const filtered = list.filter(e => e.id !== msg.docId);
        await this.host.kv.set(KEYS.docIds, filtered);
        this.cancelPendingPresence(msg.docId);
        this.teardownPresence(msg.docId);
        const entry = this.docRegistry.get(msg.docId);
        if (entry) {
          for (const subId of entry.subscriptions.keys()) this.subIdToDocId.delete(subId);
          this.docRegistry.delete(msg.docId);
        }
        this.queryResultCache.deletePrefix(docCachePrefix(msg.docId));
        await this.host.kv.delPrefix(docCachePrefix(msg.docId));
        this.pruneSeenState(msg.docId);
        const removedKhDocId = removedEntry ? this.resolveKhDocId(msg.docId) : null;
        let status: string = 'not-found';
        if (removedKhDocId && this.khOps) {
          try {
            const res = await this.khOps.revokeMyAccess(removedKhDocId);
            status = res.status;
            if (res.grantSigs.length) {
              const t = (await this.host.kv.get<ArchivedDocTombstones>(KEYS.archivedDocIds)) ?? {};
              t[msg.docId] = { grantSigs: res.grantSigs };
              await this.host.kv.set(KEYS.archivedDocIds, t);
            }
          } catch (err: any) {
            console.warn('[engine] revokeMyAccess failed on archive:', errMsg(err));
            status = 'no-authority';
          }
          this.khOps.khDocuments.delete(removedKhDocId);
        }
        // Drop the doc's local automerge data (local-only: peers keep theirs).
        try { this.repo?.delete(msg.docId as any); } catch (err: any) {
          console.warn('[engine] repo.delete failed on archive:', errMsg(err));
        }
        this.emit({ type: 'doc-list-updated', list: filtered });
        emit({ type: 'result', id: msg.id, result: { status } });
      } catch (err: any) {
        console.warn('[engine] archive-doc failed:', errMsg(err));
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'set-contact-name') {
      try {
        await this.putContactName(msg.agentId, msg.name);
        emit({ type: 'result', id: msg.id });
      } catch (err: any) {
        console.error('[engine] set-contact-name failed:', errMsg(err));
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'remove-contact-name') {
      try {
        await this.deleteContactName(msg.agentId);
        emit({ type: 'result', id: msg.id });
      } catch (err: any) {
        console.error('[engine] remove-contact-name failed:', errMsg(err));
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'set-device-name') {
      try {
        await this.putDeviceName(msg.agentId, msg.name);
        emit({ type: 'result', id: msg.id });
      } catch (err: any) {
        console.error('[engine] set-device-name failed:', errMsg(err));
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'remove-device-name') {
      try {
        await this.deleteDeviceName(msg.agentId);
        emit({ type: 'result', id: msg.id });
      } catch (err: any) {
        console.error('[engine] remove-device-name failed:', errMsg(err));
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'kh-get-identity') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        emit({ type: 'result', id: msg.id, result: await this.khOps.getIdentity() });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-get-contact-card') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        emit({ type: 'result', id: msg.id, result: await this.khOps.getContactCard() });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-receive-contact-card') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        if (!msg.isDevice && !msg.userGroupId) {
          throw new Error('This contact is not a group — ask them to open Settings and show a fresh friend QR/link.');
        }
        const result = await this.khOps.receiveContactCard(msg.cardJson);
        const friendGroupId = msg.isDevice ? null : msg.userGroupId;
        const alreadyKnown = !result.isOwnCard && !!friendGroupId
          ? await this.addKnownContactGroup(friendGroupId)
          : false;
        emit({ type: 'result', id: msg.id, result: { ...result, userGroupId: friendGroupId, alreadyKnown } });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-get-doc-members') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const members = await this.khOps.getDocMembers(this.resolveKhDocId(msg.docId));
        emit({ type: 'result', id: msg.id, result: { members } });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-get-my-access') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        emit({ type: 'result', id: msg.id, result: await this.khOps.getMyAccess(this.resolveKhDocId(msg.docId)) });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-get-known-contacts') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const contactNames = await this.getContactNames();
        const knownGroups = (await this.host.kv.get<string[]>(KEYS.knownContactGroups)) ?? [];
        const contactGroupIds = [...new Set([...Object.keys(contactNames), ...knownGroups])];
        const excludeKhDocId = msg.excludeDocId ? this.resolveKhDocId(msg.excludeDocId) : undefined;
        const result = await this.khOps.getKnownContacts(excludeKhDocId, contactGroupIds);
        emit({ type: 'result', id: msg.id, result });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    // Sharer: stage our (large) contact bundle for a rendezvous and return the id+key.
    if (msg.type === 'kh-rdv-create-share') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const myUserGroupId = await this.khOps.ensureUserGroup({ create: true });
        const myCard = await this.khOps.getContactCard();
        const plaintext = JSON.stringify({ card: myCard, displayName: msg.displayName, userGroupId: myUserGroupId ?? undefined });
        // Approximate size of what we'll send once the peer joins (plaintext bytes;
        // the on-wire framed size adds only ~28 bytes of IV+GCM tag). Surfaced to the
        // sender's QR page so they can see how much is being transferred up front.
        const payloadBytes = new TextEncoder().encode(plaintext).length;
        const { rendezvousId, key } = generateRendezvous();
        // Bidirectional: after sending our bundle we STAY subscribed to ingest the
        // receiver's reply (their card + display name) so both peers end up knowing
        // each other from a single scan. The receiver's own UI names us; we have no
        // UI here, so the worker records their name from the reply payload.
        this.rdvSessions.set(rendezvousId, {
          key,
          onPeer: () => {
            this.rdvEvent(rendezvousId, 'peer-joined');
            this.rdvSendPayload(rendezvousId, key, plaintext)
              .catch((err) => this.rdvEvent(rendezvousId, 'error', errMsg(err)));
          },
          onData: (pt) => {
            void (async () => {
              try {
                this.rdvEvent(rendezvousId, 'receiving');
                let cardJson = pt;
                let displayName: string | undefined;
                let replyGroupId: string | undefined;
                try {
                  const parsed = JSON.parse(pt);
                  if (parsed && typeof parsed === 'object' && typeof parsed.card === 'string') {
                    cardJson = parsed.card; displayName = parsed.displayName; replyGroupId = parsed.userGroupId;
                  }
                } catch { /* raw card string */ }
                const result = await this.khOps!.receiveContactCard(cardJson);
                const resolvedGroupId = replyGroupId ?? result.groupId ?? null;
                if (!result.isOwnCard && resolvedGroupId) {
                  await this.addKnownContactGroup(resolvedGroupId);
                  await this.putContactName(resolvedGroupId, displayName);
                }
                this.rdvSessions.delete(rendezvousId);
                this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                this.rdvEvent(rendezvousId, 'received');
              } catch (err: any) {
                this.rdvSessions.delete(rendezvousId);
                this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                this.rdvEvent(rendezvousId, 'error', errMsg(err));
              }
            })();
          },
        });
        this.rdvSend({ type: RDV_SUB, rendezvousId });
        this.rdvEvent(rendezvousId, 'waiting');
        emit({ type: 'result', id: msg.id, result: { rendezvousId, key, payloadBytes } });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'kh-rdv-receive') {
      const { rendezvousId, key } = msg;
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const plaintext = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.rdvSessions.delete(rendezvousId);
            reject(new Error('Timed out waiting for your friend. Make sure they have the QR/link open, then try again.'));
          }, RDV_RECEIVE_TIMEOUT_MS);
          this.rdvSessions.set(rendezvousId, {
            key,
            onPeer: () => this.rdvEvent(rendezvousId, 'peer-joined'),
            onData: (pt) => {
              clearTimeout(timer);
              this.rdvSessions.delete(rendezvousId);
              this.rdvEvent(rendezvousId, 'receiving');
              resolve(pt);
            },
          });
          this.rdvSend({ type: RDV_SUB, rendezvousId });
          this.rdvEvent(rendezvousId, 'waiting');
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

        const result = await this.khOps.receiveContactCard(cardJson);
        const resolvedGroupId = userGroupId ?? result.groupId ?? null;
        const alreadyKnown = !result.isOwnCard && !!resolvedGroupId
          ? await this.addKnownContactGroup(resolvedGroupId)
          : false;
        if (!result.isOwnCard) {
          const myUserGroupId = await this.khOps.ensureUserGroup({ create: true });
          const myCard = await this.khOps.getContactCard();
          await this.rdvSendPayload(rendezvousId, key, JSON.stringify({ card: myCard, displayName: msg.displayName, userGroupId: myUserGroupId ?? undefined }));
        }
        this.rdvSend({ type: RDV_UNSUB, rendezvousId });
        this.rdvEvent(rendezvousId, 'received');
        emit({ type: 'result', id: msg.id, result: { ...result, userGroupId: resolvedGroupId, displayName, alreadyKnown } });
      } catch (err: any) {
        this.rdvSessions.delete(rendezvousId);
        this.rdvSend({ type: RDV_UNSUB, rendezvousId });
        this.rdvEvent(rendezvousId, 'error', errMsg(err));
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'kh-rdv-link-create') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const myUserGroupId = await this.khOps.ensureUserGroup({ create: true });
        const myCard = await this.khOps.getContactCard();
        const myPayload = JSON.stringify({ card: myCard, userGroupId: myUserGroupId, deviceName: msg.deviceName });
        // See kh-rdv-create-share: approximate payload size for the sender's QR page.
        const payloadBytes = new TextEncoder().encode(myPayload).length;
        const { rendezvousId, key } = generateRendezvous();
        this.rdvSessions.set(rendezvousId, {
          key,
          onPeer: () => {
            this.rdvEvent(rendezvousId, 'peer-joined');
            this.rdvSendPayload(rendezvousId, key, myPayload).catch(err =>
              this.rdvEvent(rendezvousId, 'error', errMsg(err)));
          },
          onData: (pt) => {
            (async () => {
              try {
                this.rdvEvent(rendezvousId, 'receiving');
                const { card: peerCard, userGroupId: peerGroupId, deviceName: peerDeviceName } = JSON.parse(pt);
                const result = await this.khOps!.receiveContactCard(peerCard);
                await this.khOps!.linkDevice(result.agentId, peerGroupId ?? null);
                // Record the new device's name against its agentId.
                await this.putDeviceName(result.agentId, peerDeviceName);
                this.rdvSessions.delete(rendezvousId);
                this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                this.rdvEvent(rendezvousId, 'linked');
              } catch (err: any) {
                this.rdvEvent(rendezvousId, 'error', errMsg(err));
              }
            })();
          },
        });
        this.rdvSend({ type: RDV_SUB, rendezvousId });
        this.rdvEvent(rendezvousId, 'waiting');
        emit({ type: 'result', id: msg.id, result: { rendezvousId, key, payloadBytes } });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'kh-rdv-link-join') {
      try {
        const result = await this.rendezvousLinkJoin(msg.rendezvousId, msg.key, msg.deviceName);
        emit({ type: 'result', id: msg.id, result });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'kh-rdv-cancel') {
      this.rdvSessions.delete(msg.rendezvousId);
      this.rdvSend({ type: RDV_UNSUB, rendezvousId: msg.rendezvousId });
      return;
    }

    if (msg.type === 'kh-list-devices') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        emit({ type: 'result', id: msg.id, result: await this.khOps.listGroupDevices() });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-remove-device') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        await this.khOps.removeDeviceFromGroup(msg.agentId);
        emit({ type: 'result', id: msg.id, result: undefined });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-change-device-role') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        await this.khOps.changeDeviceRole(msg.agentId, msg.newRole);
        emit({ type: 'result', id: msg.id, result: undefined });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-ensure-user-group') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const userGroupId = await this.khOps.ensureUserGroup({
          create: msg.create,
          adoptGroupId: msg.adoptGroupId,
          waitForSync: msg.waitForSync,
        });
        emit({ type: 'result', id: msg.id, result: { userGroupId } });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-link-device') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const result = await this.khOps.linkDevice(msg.deviceAgentId, msg.peerGroupId);
        void this.reconcileHomeDocsAfterLink();
        emit({ type: 'result', id: msg.id, result });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-get-link-payload') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const userGroupId = await this.khOps.ensureUserGroup({ create: true });
        const card = await this.khOps.getContactCard();
        emit({ type: 'result', id: msg.id, result: { card, userGroupId } });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-add-member') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const result = await this.khOps.addMember(msg.agentId, this.resolveKhDocId(msg.docId), msg.role);
        emit({ type: 'result', id: msg.id, result });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-revoke-member') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const result = await this.khOps.revokeMember(msg.agentId, this.resolveKhDocId(msg.docId));
        emit({ type: 'result', id: msg.id, result });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'kh-change-role') {
      try {
        if (!this.khOps) throw new Error('Keyhive not available');
        const result = await this.khOps.changeRole(msg.agentId, this.resolveKhDocId(msg.docId), msg.newRole);
        emit({ type: 'result', id: msg.id, result });
      } catch (err: any) { emit({ type: 'result', id: msg.id, error: errMsg(err) }); }
      return;
    }

    if (msg.type === 'query') {
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const doc = handle.doc();
        const heads: string[] = handle.heads ? handle.heads() : [];
        if (!doc) {
          emit({ type: 'result', id: msg.id, error: 'Document not ready' });
          return;
        }
        // Use runQuery (same path as subscribeQuery) so a one-shot query returns
        // the FIRST jq output, not the raw output-stream array. compile()(doc)
        // yields an array; forwarding it unwrapped made queryDoc hand callers
        // `[{...}]` instead of `{...}` — see AllCalendars' `doc['@type']` filter.
        const result = await this.runQuery(msg.filter, doc);
        if (!msg.peek) this.markViewed(msg.docId, heads);
        emit({ type: 'result', id: msg.id, result: { result, heads } });
      } catch (err: any) {
        // "unavailable"/"not ready" just means the doc hasn't synced/loaded yet
        // — an expected transient while a caller polls a doc into existence (the
        // error is still returned below so the poll keeps going). Only genuine
        // failures (e.g. a bad jq filter) warrant an error-level log.
        const m = errMsg(err);
        if (/unavailable|not ready/i.test(m)) {
          console.debug('[engine] query deferred (doc not ready) for', msg.docId);
        } else {
          console.error('[engine] query failed for', msg.docId, err);
        }
        emit({ type: 'result', id: msg.id, error: m });
      }
      return;
    }
  }
}
