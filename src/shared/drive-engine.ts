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
import {
  RDV_SUB, RDV_UNSUB, RDV_MSG, RDV_PEER,
  type RendezvousStatus,
} from './rendezvous-protocol';
import {
  KEYS, CACHE_PREFIX, queryCacheKey, validationCacheKey, docCachePrefix, hashStr,
  type QueryCacheEntry,
} from './storage-keys';
import { createKeyhiveRepo } from './keyhive-repo';
import type { EngineHost } from './engine-host';
import type { MainToWorker, WorkerToMain } from './worker-protocol';

type StoredDocEntry = { id: string; type?: string; name?: string; sharingGroupId?: string;[k: string]: any };

interface SubInfo {
  filter: string;
  post: (msg: any) => void; // where to send results (host.emit or an hf-port poster)
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

  // Query caching.
  private jqCache = new LRU<string, (input: any) => any>(64);
  private queryResultCache = new LRU<string, QueryCacheEntry>(256);
  private cacheDisabled = false;

  // Reconcile coalescing.
  private reconcileInFlight = false;
  private reconcilePending = false;

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
    catch { return null; }
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
      }
    }, 5000);
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
        if (this.watchedDocs.has(docId)) this.emitWatchUpdate(docId);
      };
      handle.on('change', onChange);
      // Some automerge-repo versions also emit 'doc' for remote changes
      if (typeof handle.on === 'function') handle.on('doc', onChange);
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

  // ── Query caching ──────────────────────────────────────────────────────────
  private async runQuery(filter: string, doc: any): Promise<any> {
    let fn = this.cacheDisabled ? undefined : this.jqCache.get(filter);
    if (!fn) {
      const { compile } = await import('./jq');
      const compiled = compile(filter);
      fn = (input: any) => { const r = compiled(input); return r.length > 0 ? r[0] : null; };
      if (!this.cacheDisabled) this.jqCache.set(filter, fn);
    }
    return fn(doc);
  }

  private async runCachedQuery(
    docId: string, filter: string, doc: any, heads: string[], lastModified?: number,
  ): Promise<{ result: any; heads: string[]; lastModified?: number; changed: boolean }> {
    const result = await this.runQuery(filter, doc);
    if (this.cacheDisabled) return { result, heads, lastModified, changed: true };

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
  async subscribeQuery(docId: string, subId: number, filter: string, post: (m: any) => void): Promise<void> {
    this.subIdToDocId.set(subId, docId);

    if (!this.cacheDisabled) {
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
      entry.subscriptions.set(subId, { filter, post });
      await this.pushToSubscriptions(docId);
    } else {
      let pending = this.pendingSubs.get(docId);
      if (!pending) { pending = new Map(); this.pendingSubs.set(docId, pending); }
      pending.set(subId, { filter, post });
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

    if (!this.cacheDisabled) {
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
      const knownIds = new Set(list.map(e => e.id));
      const accessibleAmIds = new Set(accessibleKhIds.map(k => this.amDocIdFromBytes!(base64ToBytes(k))));
      const reachableSet = new Set(reachableKhIds);
      let changed = false;
      const newDocHandles: string[] = [];

      for (const amDocId of accessibleAmIds) {
        if (knownIds.has(amDocId)) continue;
        console.log(`[engine] reconcileHomeDocs: adding accessible doc ${amDocId}`);
        list.unshift({ id: amDocId });
        knownIds.add(amDocId);
        newDocHandles.push(amDocId);
        changed = true;
      }

      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (accessibleAmIds.has(e.id)) continue;
        const khDocId = this.resolveKhDocId(e.id);
        if (reachableSet.has(khDocId)) {
          console.log(`[engine] reconcileHomeDocs: removing revoked doc ${e.id}`);
          list.splice(i, 1);
          knownIds.delete(e.id);
          changed = true;
        }
      }

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
    const peers = this.repo ? this.repo.peers : [];
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
  private formatBytes(n: number): string {
    if (n < 1000) return `${n} B`;
    return `${(n / 1000).toFixed(1)} KB`;
  }
  private async rdvSendPayload(rendezvousId: string, key: string, plaintext: string): Promise<void> {
    const framed = await encryptString(key, plaintext);
    this.rdvEvent(rendezvousId, 'sending', this.formatBytes(framed.length));
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
  async rendezvousLinkJoin(rendezvousId: string, key: string): Promise<{ ok: true }> {
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
              const { card: peerCard, userGroupId: peerGroupId } = JSON.parse(pt);
              const result = await this.khOps!.receiveContactCard(peerCard);
              if (result.isOwnCard) throw new Error("This is your own device's link. Open it on a different device.");
              await this.khOps!.linkDevice(result.agentId, peerGroupId ?? null);
              const myUserGroupId = await this.khOps!.ensureUserGroup({ create: true });
              const myCard = await this.khOps!.getContactCard();
              await this.rdvSendPayload(rendezvousId, key, JSON.stringify({ card: myCard, userGroupId: myUserGroupId }));
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
    // Hydrate the cache-disabled flag from its persisted setting.
    try {
      this.cacheDisabled = (await this.host.kv.settingGet('cache-disabled')) === true;
    } catch (err) {
      console.warn('[engine] failed to read cache-disabled setting:', errMsg(err));
    }

    try {
      const kh = await createKeyhiveRepo({
        storage: this.host.storage,
        networkAdapter: this.host.network.networkAdapter,
        peerIdSuffix: 'drive',
        serialize: true,
        withShareConfig: true,
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
      this.broadcastContactNames(await this.getContactNames());
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
    if (handle.whenReady) { try { await handle.whenReady(); } catch { /* keep going */ } }
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
    if (handle.whenReady) { try { await handle.whenReady(); } catch { /* keep going */ } }
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
    if (handle.whenReady) { try { await handle.whenReady(); } catch { /* keep going */ } }
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

    if (msg.type === 'set-cache-disabled') {
      try {
        this.cacheDisabled = msg.disabled;
        await this.host.kv.settingSet('cache-disabled', msg.disabled);
        if (msg.disabled) {
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
          handle.whenReady().then(() => {
            progress(100, 'Ready');
            emit({ type: 'result', id: msg.id, result: { docId: msg.docId } });
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
        await this.subscribeQuery(msg.docId, msg.subId, msg.filter, (m) => emit(m));
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
      try {
        const handle = await this.getOrLoadHandle(msg.docId);
        const entry = this.getOrCreateEntry(msg.docId, handle);
        if (!entry.presence) {
          const doc = await this.getKhDoc(msg.docId);
          if (!doc) {
            console.warn('[engine] presence-subscribe: keyhive doc not ready; skipping');
          } else {
            const presence = new this.PresenceClass({ handle });
            presence.start({ initialState: {}, heartbeatMs: 5000, peerTtlMs: 15000 });
            entry.presence = presence;
            entry.presenceDoc = doc;
            const userGroupId = await this.khOps?.getUserGroupId();
            entry.presenceDesired = {
              viewing: true,
              focusedField: null,
              ...(userGroupId ? { userGroupId } : {}),
            };
            const sendPresence = async (): Promise<boolean> => {
              const raw = presence.getPeerStates().value;
              const peers: Record<string, any> = {};
              let allOk = true;
              for (const [peerId, st] of Object.entries<any>(raw)) {
                const value: Record<string, unknown> = {};
                for (const [ch, enc] of Object.entries<any>(st?.value ?? {})) {
                  try { value[ch] = await this.decryptPresenceValue(doc, enc as Uint8Array); }
                  catch { allOk = false; }
                }
                peers[peerId] = { ...st, value };
              }
              this.emit({ type: 'update-presence', docId: msg.docId, peers });
              if (!allOk) this.schedulePresenceRetry(entry);
              return allOk;
            };
            entry.presenceSend = sendPresence;
            presence.on('update', () => { void sendPresence(); });
            presence.on('goodbye', () => { void sendPresence(); });
            presence.on('snapshot', () => { void sendPresence(); });
            if (!(await this.flushPresenceOut(entry))) this.schedulePresenceRetry(entry);
          }
        }
      } catch (err: any) {
        console.warn('[engine] presence-subscribe failed:', errMsg(err));
      }
      return;
    }

    if (msg.type === 'unsubscribe-presence') {
      const entry = this.docRegistry.get(msg.docId);
      if (entry?.presence) {
        if (entry.presenceRetry) { clearInterval(entry.presenceRetry); entry.presenceRetry = null; }
        entry.presence.stop();
        entry.presence = null;
        entry.presenceDoc = undefined;
        entry.presenceDesired = undefined;
        entry.presenceSend = undefined;
      }
      return;
    }

    if (msg.type === 'set-presence') {
      const entry = this.docRegistry.get(msg.docId);
      if (entry?.presence) {
        entry.presenceDesired = { ...(entry.presenceDesired ?? {}), ...msg.state };
        if (!(await this.flushPresenceOut(entry))) this.schedulePresenceRetry(entry);
      }
      return;
    }

    if (msg.type === 'remove-me-from-doc') {
      try {
        const list = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
        const removedEntry = list.find(e => e.id === msg.docId);
        const filtered = list.filter(e => e.id !== msg.docId);
        await this.host.kv.set(KEYS.docIds, filtered);
        const entry = this.docRegistry.get(msg.docId);
        if (entry) {
          for (const subId of entry.subscriptions.keys()) this.subIdToDocId.delete(subId);
          if (entry.presenceRetry) clearInterval(entry.presenceRetry);
          if (entry.presence) entry.presence.stop();
          this.docRegistry.delete(msg.docId);
        }
        this.queryResultCache.deletePrefix(docCachePrefix(msg.docId));
        await this.host.kv.delPrefix(docCachePrefix(msg.docId));
        const removedKhDocId = removedEntry ? this.resolveKhDocId(msg.docId) : null;
        if (removedKhDocId && this.khOps) {
          try { await this.khOps.removeMyAccess(removedKhDocId); }
          catch (err: any) { console.warn('[engine] removeMyAccess failed on delete:', errMsg(err)); }
          this.khOps.khDocuments.delete(removedKhDocId);
        }
        this.emit({ type: 'doc-list-updated', list: filtered });
      } catch (err: any) {
        console.warn('[engine] remove-me-from-doc failed:', errMsg(err));
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
        const { rendezvousId, key } = generateRendezvous();
        this.rdvSessions.set(rendezvousId, {
          key,
          onPeer: () => {
            this.rdvEvent(rendezvousId, 'peer-joined');
            this.rdvSendPayload(rendezvousId, key, plaintext)
              .then(() => {
                this.rdvSend({ type: RDV_UNSUB, rendezvousId });
                this.rdvSessions.delete(rendezvousId);
                this.rdvEvent(rendezvousId, 'sent');
              })
              .catch((err) => this.rdvEvent(rendezvousId, 'error', errMsg(err)));
          },
        });
        this.rdvSend({ type: RDV_SUB, rendezvousId });
        this.rdvEvent(rendezvousId, 'waiting');
        emit({ type: 'result', id: msg.id, result: { rendezvousId, key } });
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
        const myPayload = JSON.stringify({ card: myCard, userGroupId: myUserGroupId });
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
                const { card: peerCard, userGroupId: peerGroupId } = JSON.parse(pt);
                const result = await this.khOps!.receiveContactCard(peerCard);
                await this.khOps!.linkDevice(result.agentId, peerGroupId ?? null);
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
        emit({ type: 'result', id: msg.id, result: { rendezvousId, key } });
      } catch (err: any) {
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }

    if (msg.type === 'kh-rdv-link-join') {
      try {
        const result = await this.rendezvousLinkJoin(msg.rendezvousId, msg.key);
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
        const { compile } = await import('./jq');
        const fn = compile(msg.filter);
        const result = fn(doc);
        emit({ type: 'result', id: msg.id, result: { result, heads } });
      } catch (err: any) {
        console.error('[engine] query failed for', msg.docId, err);
        emit({ type: 'result', id: msg.id, error: errMsg(err) });
      }
      return;
    }
  }
}
