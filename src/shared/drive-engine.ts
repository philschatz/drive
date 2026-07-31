/**
 * DriveEngine — the app's entire sync/keyhive/document engine, extracted from the
 * browser Web Worker so it can run unchanged in a Web Worker (browser) or
 * in-process (the Node CLI). It performs no direct browser I/O: storage, network,
 * key-value persistence, and event delivery are all supplied by an `EngineHost`.
 *
 * The browser worker shell (automerge-worker.ts) and the Node CLI (cli.ts) each
 * build a host and drive the engine — the worker via `handleMessage`, the CLI via
 * `init()` / `rendezvousLinkJoin()` / `startWatching()` directly.
 *
 * The class is composed from a core base plus one mixin per subsystem:
 *   EngineCore → EngineSettings → EnginePresence → EngineRendezvous → EngineWatch
 * Each mixin exposes a late-bound `*Surface` hook (set in its constructor to
 * `this`) so the core can reach INTO the subsystem for state that the subsystem
 * owns — e.g. archive-doc's presence teardown, update-doc's settings validation.
 */
import { deepAssign } from './deep-assign';
import { syncToTarget } from './sync-to-target';
import { validateDocument, DRIVE_SETTINGS_TYPE } from './schemas';
import { KeyhiveOps, bytesToBase64, base64ToBytes, errMsg } from './keyhive-ops';
import { LRU } from './lru-cache';
import {
  KEYS, CACHE_PREFIX, queryCacheKey, validationCacheKey, docCachePrefix, hashStr,
  type QueryCacheEntry,
} from './storage-keys';
import { createKeyhiveRepo } from './keyhive-repo';
import { RELAY_PEER_ID } from './relay-identity';
import type { EngineHost } from './engine-host';
import type { MainToWorker, WorkerToMain } from './worker-protocol';
import { applyRichTextOps, richTextAwareStringSync, type RichTextOp } from './rich-text-ops';
import { EngineSettings, type EngineSettingsSurface } from './engine-settings';
import { EnginePresence, type EnginePresenceSurface } from './engine-presence';
import { EngineRendezvous, type EngineRendezvousSurface } from './engine-rendezvous';
import { EngineWatch, type EngineWatchSurface } from './engine-watch';

/** JSON with recursively sorted object keys — for value comparisons where the
 * producer's key order is nondeterministic (e.g. Automerge span block values). */
function stableJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

type StoredDocEntry = { id: string; type?: string; name?: string; sharingGroupId?: string;[k: string]: any };

interface SubInfo {
  filter: string;
  post: (msg: any) => void; // where to send results (host.emit or an hf-port poster)
  peek?: boolean; // true = this read doesn't count as the user viewing the doc
  // true = also deliver a result carrying fresh heads/lastModified when the doc
  // changes but this jq projection does not (Home's relative-time). Off for the
  // editor, HyperFormula bridge, and source-viewer subs.
  meta?: boolean;
  // Peritext field whose rich-text spans (marks + block markers) ride along
  // with every result. Mark-only edits don't change the jq projection, so a
  // spans sub also posts whenever the serialized spans change.
  spansPath?: (string | number)[];
  lastSpansJson?: string;
  lastCursorsJson?: string;
}

interface DocEntry {
  handle: any;
  pinnedVersion: number | null; // null = live view
  subscriptions: Map<number, SubInfo>; // subId → filter + poster
  validationSubscribed: boolean;
}

/** See OPEN_DOCS_IN_BACKGROUND in the original worker. */
const OPEN_DOCS_IN_BACKGROUND = true;

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

export class EngineCore {
  protected host: EngineHost;

  // Populated by init() via createKeyhiveRepo. Protected (not private) so the
  // mixins can read them; null until init() runs.
  protected repo: any = null;
  protected khIntegration: any = null;
  protected khOps: KeyhiveOps | null = null;
  protected bridge: any = null;
  protected Automerge: any = null;
  protected PresenceClass: any = null;
  protected amDocIdFromBytes: ((bytes: Uint8Array) => string) | null = null;
  protected setNextDocId: ((bytes: Uint8Array) => void) | null = null;

  // Doc registry + subscriptions.
  protected docRegistry = new Map<string, DocEntry>();
  private subIdToDocId = new Map<number, string>();
  private pendingSubs = new Map<string, Map<number, SubInfo>>();
  // Cursor tokens to resolve into positions on every push: docId → stableJson(path)
  // → tokens (peers' carets plus the local one). Set wholesale by
  // 'subscribe-cursors'. Deliberately NOT on DocEntry: a registration routinely
  // arrives before the doc handle has loaded (same reason pendingSubs exists), and
  // hanging it off the entry would silently drop it on a cold page load.
  protected cursorSubs = new Map<string, Map<string, string[]>>();

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

  // "New changes since last viewed" — device-local seen state: docId → sorted heads
  // when a viewing query last saw the doc. Persisted to KEYS.lastViewedHeads in IDB
  // (loaded in init()). Deliberately NOT synced: it changes on every doc edit, so
  // syncing that churn would bloat keyhive on every change.
  private lastViewedHeads: Record<string, string[]> | null = null; // null until init() loads it
  private unseenChanges: Record<string, boolean> = {};             // last computed state (what we emit)

  // Late-bound hooks into the mixin classes (each mixin's constructor assigns
  // `this.<name>Surface = this as any`, so the core can reach subsystem state
  // that the core class no longer declares). Assigned after super() in the
  // composed constructor chain, i.e. before any message can arrive.
  protected settingsSurface!: EngineSettingsSurface;
  protected presenceSurface!: EnginePresenceSurface;
  protected rendezvousSurface!: EngineRendezvousSurface;
  protected watchSurface!: EngineWatchSurface;

  // How often (ms) keyhive requests a sync round; undefined ⇒ keyhive-repo's
  // 2000ms default. Only the browser worker sets this (from a build-time env, to
  // speed up the E2E convergence floor); the CLI/CalDAV leave it at the default.
  private syncRequestInterval?: number;

  constructor(host: EngineHost, opts?: { syncRequestInterval?: number }) {
    this.host = host;
    this.syncRequestInterval = opts?.syncRequestInterval;
  }

  // ── small accessors ────────────────────────────────────────────────────────
  get peerId(): string { return this.repo?.peerId; }
  get keyhiveOps(): KeyhiveOps | null { return this.khOps; }
  get automergeRepo(): any { return this.repo; }

  protected emit(event: WorkerToMain): void { this.host.emit(event); }
  private getRepo(): any {
    if (!this.repo) throw new Error('Secure repo not initialized');
    return this.repo;
  }

  /**
   * Run a request handler and emit the single `{result}`/`{error}` envelope the
   * main thread awaits. `log` (if given) prefixes the error-level log for the
   * handlers that want one; `error` is always emitted so callers see the failure.
   */
  protected async respond(id: number, fn: () => Promise<unknown> | unknown, log?: string): Promise<void> {
    try {
      this.host.emit({ type: 'result', id, result: await fn() });
    } catch (err: any) {
      if (log) console.error(log, errMsg(err));
      this.host.emit({ type: 'result', id, error: errMsg(err) });
    }
  }

  /** Mint a keyhive-backed automerge doc (keyhive doc, next-doc-id, create, enable-sharing). */
  protected async createKeyhiveDocHandle(initialJson: any): Promise<any> {
    const { docIdBytes } = await this.khOps!.createKeyhiveDoc();
    this.setNextDocId!(docIdBytes);
    const handle = await this.repo!.create2(initialJson);
    await this.khOps!.enableSharing(handle.documentId, docIdBytes);
    return handle;
  }

  /** Overwrite a doc with a target snapshot, unpin it, and push subscribers. */
  private async restoreDoc(docId: string, targetDoc: any): Promise<void> {
    const handle = await this.getOrLoadHandle(docId);
    handle.change((d: any) => syncToTarget(d, targetDoc, richTextAwareStringSync(this.Automerge, targetDoc)));
    const entry = this.docRegistry.get(docId);
    if (entry) entry.pinnedVersion = null;
    await this.pushToSubscriptions(docId);
  }

  // ── keyhive doc-id helpers ─────────────────────────────────────────────────
  /** Derive the keyhive doc-ID (base64) from an automerge doc-ID. */
  protected resolveKhDocId(automergeDocId: string): string {
    const khDocIdObj = this.bridge.docIdFromAutomergeUrl(`automerge:${automergeDocId}` as any);
    return bytesToBase64(khDocIdObj.toBytes());
  }

  /** Resolve the keyhive Document for an automerge doc-ID, or null if not available yet. */
  protected async getKhDoc(automergeDocId: string): Promise<any | null> {
    if (!this.khOps || !this.bridge) return null;
    try {
      const khDocId = this.bridge.docIdFromAutomergeUrl(`automerge:${automergeDocId}` as any);
      return await this.khOps.kh.getDocument(khDocId);
    } catch (err) {
      console.warn('[engine] getKhDoc failed:', errMsg(err));
      return null;
    }
  }

  // ── Doc registry ───────────────────────────────────────────────────────────
  protected async getOrLoadHandle(docId: string): Promise<any> {
    const existing = this.docRegistry.get(docId);
    if (existing) return existing.handle;
    const r = this.getRepo();
    return await r.find(docId as any);
  }

  protected getOrCreateEntry(docId: string, handle: any): DocEntry {
    let entry = this.docRegistry.get(docId);
    if (!entry) {
      entry = { handle, pinnedVersion: null, subscriptions: new Map(), validationSubscribed: false };
      this.docRegistry.set(docId, entry);
      const onChange = () => {
        void this.pushToSubscriptions(docId);
        // Independent of pushToSubscriptions: that early-returns with no subs
        // and dedups on jq results, but seen-state must track every head change.
        this.refreshSeenState(docId);
        if (this.watchSurface.watchedDocs.has(docId)) this.watchSurface.emitWatchUpdate(docId);
      };
      handle.on('change', onChange);
      // Some automerge-repo versions also emit 'doc' for remote changes
      if (typeof handle.on === 'function') handle.on('doc', onChange);
      // Initial seen-state + summary delivery once loaded — covers docs
      // background-opened by the home page's peek subscriptions, where the drain's
      // push below early-returns on a not-yet-ready handle and no change event may
      // ever fire. Only push when we actually had to wait (readyNow false), so a
      // handle that was ready at drain time isn't posted twice.
      const readyNow = handle.isReady?.();
      Promise.resolve(readyNow ? undefined : handle.whenReady?.())
        .then(() => {
          this.refreshSeenState(docId);
          if (!readyNow) void this.pushToSubscriptions(docId);
        })
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

  /**
   * Best-effort save of loaded docs to the durable store, so an imminent page
   * unload never loses the last in-memory edits (the Repo's debounce may not
   * have flushed them yet). Returns the number of docs saved. `docId` limits
   * the flush to one doc (the worker flushes the open doc on hidden); absent,
   * every registered handle is flushed. Not a complete fix for a hard close:
   * a page being torn down cannot await a postMessage round trip. Shrinking the
   * window further means tuning `saveDebounceRate` where the Repo is built.
   */
  protected async flushStorage(docId?: string): Promise<number> {
    const storage = this.repo?.storageSubsystem;
    if (!storage) return 0;
    const handles = docId
      ? [this.docRegistry.get(docId)?.handle].filter(Boolean)
      : [...this.docRegistry.values()].map(e => e.handle);
    let saved = 0;
    for (const handle of handles) {
      const doc = handle?.doc?.();
      if (!doc) continue;
      try {
        await storage.saveDoc(handle.documentId, doc);
        saved++;
      } catch (err) {
        console.warn(`[engine] flush-storage failed for ${handle.documentId}:`, errMsg(err));
      }
    }
    return saved;
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
    // Device-local: seen state changes on every doc edit, so it stays in IDB (a
    // cheap local write) rather than the synced DriveSettings doc, whose per-change
    // keyhive ops would grow unbounded.
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
    if (cached && cached.json === json) {
      // Projection unchanged, but heads/lastModified may have advanced. Refresh the
      // cached entry (memory-only — no IDB write on every no-op change) so a later
      // cache replay, and meta subscriptions, carry the current timestamp.
      cached.heads = heads;
      cached.lastModified = lastModified;
      return { result, heads, lastModified, changed: false };
    }

    const entry: QueryCacheEntry = { result, json, lastModified, heads };
    this.queryResultCache.set(cacheKey, entry);
    void this.host.kv.set(cacheKey, entry);
    return { result, heads, lastModified, changed: true };
  }

  /** Subscribe to a jq query, routing results to the given poster. */
  async subscribeQuery(docId: string, subId: number, filter: string, post: (m: any) => void, peek?: boolean, meta?: boolean, spansPath?: (string | number)[]): Promise<void> {
    this.subIdToDocId.set(subId, docId);

    // The query cache stores only the jq projection; a spans sub must wait for
    // a real push (a cached result without spans would look like an empty doc).
    if (!this.debugEnabled && !spansPath) {
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
      entry.subscriptions.set(subId, { filter, post, peek, meta, spansPath });
      // A non-peek sub on an already-loaded doc = the user started viewing it.
      this.refreshSeenState(docId);
      await this.pushToSubscriptions(docId);
    } else {
      let pending = this.pendingSubs.get(docId);
      if (!pending) { pending = new Map(); this.pendingSubs.set(docId, pending); }
      pending.set(subId, { filter, post, peek, meta, spansPath });
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
        // Rich-text subs also carry the Peritext spans of their field. Marks
        // and block attributes are invisible to the jq projection, so "did it
        // change?" must consider the serialized spans too. The comparison MUST
        // be key-order-canonical: Automerge materializes block values from a
        // Rust hash map, so plain JSON.stringify flips between calls and would
        // count every change twice (once per push path), derailing the undo
        // cursor, which counts deliveries.
        let spans: any;
        let spansChanged = false;
        let cursors: Record<string, number | null> | undefined;
        let cursorsChanged = false;
        if (sub.spansPath) {
          spans = this.Automerge.spans(activeDoc, sub.spansPath);
          const spansJson = stableJson(spans);
          spansChanged = spansJson !== sub.lastSpansJson;
          sub.lastSpansJson = spansJson;

          // Resolving the registered cursor tokens here is what keeps caret
          // positions in the SAME message as the spans they describe — a peer
          // caret drawn from a separately-fetched index is always a tick stale,
          // and the local caret rendered against fresher text splices at the
          // wrong offset on the next keystroke.
          const tokens = this.cursorSubs.get(docId)?.get(stableJson(sub.spansPath));
          if (tokens?.length) {
            cursors = {};
            for (const t of tokens) {
              // A foreign/malformed token, or one pointing at text a pinned
              // version doesn't have, resolves to null rather than failing.
              try { cursors[t] = this.Automerge.getCursorPosition(activeDoc, sub.spansPath, t); }
              catch { cursors[t] = null; }
            }
          }
          const cursorsJson = stableJson(cursors ?? null);
          cursorsChanged = cursorsJson !== sub.lastCursorsJson;
          sub.lastCursorsJson = cursorsJson;
        }
        // meta subs still get the post so their heads/lastModified stay fresh even
        // when the jq projection is byte-identical (Home's relative-time).
        // `cursorsChanged` is what makes a freshly-registered peer caret render
        // right away instead of waiting for somebody to type.
        if (!changed && !spansChanged && !cursorsChanged && !sub.meta) continue;
        sub.post({
          type: 'query-result', subId, result, heads, lastModified,
          ...(sub.spansPath ? { spans } : {}),
          ...(cursors ? { cursors } : {}),
        });
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

  protected async reconcileHomeDocsAfterLink(): Promise<void> {
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
      const tombstones = this.settingsSurface.getArchivedTombstones(); // now synced in the DriveSettings doc
      const removedTombstones: string[] = [];
      const knownIds = new Set(list.map(e => e.id));
      const accessibleAmIds = new Set(accessibleKhIds.map(k => this.amDocIdFromBytes!(base64ToBytes(k))));
      const reachableSet = new Set(reachableKhIds);
      let changed = false;
      const newDocHandles: string[] = [];

      for (const amDocId of accessibleAmIds) {
        if (knownIds.has(amDocId)) continue;
        // The DriveSettings doc is accessible but is NOT a home-list document.
        if (amDocId === this.settingsSurface.driveSettingsDocId) continue;
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
          removedTombstones.push(amDocId);
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
        // Safety net: if the DriveSettings doc ever slipped into the list (a
        // reconcile that raced ensureDriveSettingsDoc), drop it — it is not a
        // home-list document.
        if (e.id === this.settingsSurface.driveSettingsDocId) {
          list.splice(i, 1);
          knownIds.delete(e.id);
          changed = true;
          continue;
        }
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
          removedTombstones.push(amDocId);
        }
      }
      this.settingsSurface.deleteArchivedTombstones(removedTombstones);

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

  // ── Init ─────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    // Hydrate the debug-enable flag from its persisted setting. When on it also
    // disables the caches (bypass checks below) and traces keyhive calls.
    try {
      this.debugEnabled = (await this.host.kv.settingGet('debug-enable')) === true;
    } catch (err) {
      console.warn('[engine] failed to read debug-enable setting:', errMsg(err));
    }

    // Resolve the settings storage mode from the single KEYS.driveSettings value:
    // a string is a settings-doc id ⇒ SHARED; an object (or absent) ⇒ LOCAL (default).
    // Must happen before the ensureDriveSettingsDoc() below so it dispatches correctly.
    try {
      const v = await this.host.kv.get<unknown>(KEYS.driveSettings);
      this.settingsSurface.settingsMode = typeof v === 'string' ? 'shared' : 'local';
    } catch (err) {
      console.warn('[engine] failed to read settings-storage mode:', errMsg(err));
      this.settingsSurface.settingsMode = 'local';
    }

    // Load device-local seen state (docId → sorted heads) up front, so seen-state
    // works even if keyhive init fails below. Persisted by persistLastViewed().
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
        // Test builds only (see automerge-worker.ts); unset in prod →
        // keyhive-repo's 2000ms default.
        syncRequestInterval: this.syncRequestInterval,
        getUserGroupId: async () => (await this.host.kv.get<string>(KEYS.userGroupId)) ?? null,
        setUserGroupId: async (groupId) => { await this.host.kv.set(KEYS.userGroupId, groupId); },
        onBeforeShareConfigChanged: () => {
          // After keyhive ingests remote ops, (re)resolve the settings doc (so a
          // deferred pointer or a just-synced settings doc loads) AND reconcile the
          // home list. Run independently so settings-doc sync never delays the home
          // list — reconcile's own safety-net drops the settings doc if it races
          // ahead of driveSettingsDocId being set.
          void this.settingsSurface.ensureDriveSettingsDoc();
          void this.reconcileHomeDocs();
          // Remote ops can add doc co-member groups the relay watch must name.
          this.rendezvousSurface.scheduleRelayWatchRefresh();
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

      // Creating or adopting the user group changes what this device announces
      // to the relay, and not every path that does so also touches the settings
      // doc — wrap the two group-shaping ops so no call site is missed.
      for (const method of ['ensureUserGroup', 'linkDevice'] as const) {
        const orig = (this.khOps as any)[method].bind(this.khOps);
        (this.khOps as any)[method] = async (...args: unknown[]) => {
          const result = await orig(...args);
          this.rendezvousSurface.scheduleRelayWatchRefresh();
          return result;
        };
      }

      // Route inbound rendezvous frames from the host's socket into the engine.
      this.host.network.onRendezvousFrame((frame) => this.rendezvousSurface.handleRendezvousFrame(frame));

      // Declare (and on every reconnect re-declare) whom the relay may pair us
      // with. Its discovery state is per-socket, so a fresh socket starts
      // undeclared — and an undeclared device is invisible to everyone.
      this.host.network.onSocketOpen?.(() => {
        this.rendezvousSurface.lastRelayWatch = null;
        void this.rendezvousSurface.refreshRelayWatch();
      });

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
          await this.khOps.registerSharingGroup(khDocId);
        } catch (err) {
          console.warn(`[engine] Failed to pre-register doc ${entry.id}:`, errMsg(err));
        }
      }
      this.emit({ type: 'doc-list-updated', list: earlyList });
      // Load (or, for a user-group that has none yet, create + migrate) the synced
      // DriveSettings doc so contact/device names are ready for the broadcasts below.
      await this.settingsSurface.ensureDriveSettingsDoc();
      // Missing last-viewed record = unseen: computable without loading any doc.
      // Docs WITH a record stay absent (unknown) until they load and compare —
      // avoids a dot-flash on every start.
      for (const e of earlyList) if (!this.lastViewedHeads![e.id]) this.unseenChanges[e.id] = true;
      this.emitUnseen();
      this.settingsSurface.broadcastNames('friends');
      this.settingsSurface.broadcastNames('deviceNames');
      // Initial relay discovery declaration (settings doc + keyhive are ready;
      // if the socket isn't open yet, the onSocketOpen re-send covers it).
      void this.rendezvousSurface.refreshRelayWatch();
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
      await this.respond(msg.id, async () => {
        this.debugEnabled = msg.enabled;
        await this.host.kv.settingSet('debug-enable', msg.enabled);
        if (msg.enabled) {
          this.queryResultCache.clear();
          this.jqCache.clear();
          await this.host.kv.delPrefix(CACHE_PREFIX);
        }
      });
      return;
    }


    // Read-only probe (no mutation, no mode flip): the docId of an existing
    // reachable DriveSettings doc to adopt, or null. Used by the Settings page to
    // decide whether "sync settings" is a permanent create (confirm) or a reuse.

    // One-way opt-in: migrate the device-local settings blob into a synced DriveSettings
    // doc and switch to SHARED mode. There is no reverse (Shared is permanent).



    if (msg.type === 'clear-caches') {
      await this.respond(msg.id, async () => {
        this.queryResultCache.clear();
        this.jqCache.clear();
        await this.host.kv.delPrefix(CACHE_PREFIX);
      });
      return;
    }

    if (msg.type === 'get-doc-list') {
      await this.respond(msg.id, async () => (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? []);
      return;
    }

    if (msg.type === 'create-doc') {
      await this.respond(msg.id, async () => {
        if (!this.repo || !this.khOps || !this.setNextDocId) throw new Error('Secure repo not available');
        const handle = await this.createKeyhiveDocHandle(msg.initialJson);
        {
          const earlyList = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
          earlyList.unshift({ id: handle.documentId, ...(msg.metadata ?? {}) });
          await this.host.kv.set(KEYS.docIds, earlyList);
          emit({ type: 'doc-list-updated', list: earlyList });
        }
        const docId = handle.documentId;
        const doc = handle.doc();
        if (this.repo.storageSubsystem && doc) {
          this.repo.storageSubsystem.saveDoc(docId, doc).then(() => {
            console.log(`[engine] create-doc: saveDoc OK for ${docId}`);
          }).catch((err: any) => {
            console.error(`[engine] create-doc: saveDoc FAILED for ${docId}:`, err);
          });
        }
        return { docId };
      });
      return;
    }

    if (msg.type === 'open-doc') {
      const progress = (pct: number, message: string) =>
        emit({ type: 'open-doc-progress', id: msg.id, pct, message });
      await this.respond(msg.id, async () => {
        this.settingsSurface.pinnedDocs.add(msg.docId);
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
        if (handle.isReady ? handle.isReady() : false) {
          progress(100, 'Ready');
          return { docId: msg.docId };
        }
        // Await readiness OR unavailability so a doc no online peer has resolves
        // the wait (as 'unavailable') instead of hanging forever. In this
        // automerge-repo (subduction.37) `Repo.find()` already rejects on
        // unavailable — caught below — but a handle that reaches this branch and
        // then goes unavailable is reported as an error rather than left pending.
        await handle.whenReady(['ready', 'unavailable']);
        if (handle.isReady ? handle.isReady() : true) {
          progress(100, 'Ready');
          return { docId: msg.docId };
        }
        throw new Error('Document is unavailable — no connected peer has it yet.');
      });
      return;
    }

    if (msg.type === 'subscribe-query') {
      try {
        await this.subscribeQuery(msg.docId, msg.subId, msg.filter, (m) => emit(m), msg.peek, msg.meta, msg.spansPath);
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
      await this.respond(msg.id, async () => {
        const handle = await this.getOrLoadHandle(msg.docId);
        const workerFns: Record<string, any> = {
          deepAssign,
          // Rich-text editors send plain-JSON Peritext ops (see rich-text-ops.ts);
          // this bridges them to the engine's own Automerge module.
          richText: (d: any, path: (string | number)[], ops: RichTextOp[]) =>
            applyRichTextOps(this.Automerge, d, path, ops),
        };
        const argVals = (msg.args as any[]).map((a: any) =>
          a && typeof a === 'object' && '__workerFn__' in a ? workerFns[a.__workerFn__] : a
        );
        const applyFn = (d: any) => {
          const fn = new Function('return ' + msg.fnSource)();
          fn(d, ...argVals);
        };
        // DriveSettings edits are ENFORCED: validate the proposed result on a clone
        // and reject (throw) rather than store an invalid document. This covers
        // hand-edits made through the universal source inspector. Other doc types
        // keep the advisory validation (pushValidation) they had before.
        if (handle.doc?.()?.['@type'] === DRIVE_SETTINGS_TYPE) {
          this.settingsSurface.assertValidSettingsChange(handle, applyFn);
        }
        handle.change(applyFn);
        await this.pushToSubscriptions(msg.docId);
        if (this.settingsSurface.driveSettingsHandle === handle) this.settingsSurface.refreshFromSettingsDoc();
      }, '[engine] update-doc failed:');
      return;
    }

    if (msg.type === 'flush-storage') {
      await this.respond(msg.id, async () => this.flushStorage(msg.docId));
      return;
    }

    if (msg.type === 'get-doc-history') {
      await this.respond(msg.id, async () => {
        const handle = await this.getOrLoadHandle(msg.docId);
        const doc = handle.doc();
        if (!doc) throw new Error('Document not ready');
        return this.Automerge.getHistory(doc).map((e: any, i: number) => ({ version: i, time: e.change.time }));
      });
      return;
    }

    if (msg.type === 'debug-get-version-patches') {
      await this.respond(msg.id, async () => {
        const { patches } = await this.watchSurface.diffVersions(msg.docId, msg.version - 1, msg.version);
        return patches;
      });
      return;
    }

    if (msg.type === 'restore-doc-to-heads') {
      await this.respond(msg.id, async () => {
        const handle = await this.getOrLoadHandle(msg.docId);
        const targetDoc = handle.view(msg.heads as any).doc();
        if (!targetDoc) throw new Error('Could not view document at heads');
        await this.restoreDoc(msg.docId, targetDoc);
      });
      return;
    }

    if (msg.type === 'restore-doc-to-version') {
      await this.respond(msg.id, async () => {
        const history = this.Automerge.getHistory((await this.getOrLoadHandle(msg.docId)).doc());
        const snap = history[msg.version]?.snapshot;
        if (!snap) throw new Error(`Version ${msg.version} not found`);
        await this.restoreDoc(msg.docId, snap);
      });
      return;
    }

    if (msg.type === 'text-cursors') {
      await this.respond(msg.id, async () => {
        const handle = await this.getOrLoadHandle(msg.docId);
        const doc = handle.doc();
        if (!doc) throw new Error('Document not ready');
        return msg.positions.map((p: number) => this.Automerge.getCursor(doc, msg.path, p));
      });
      return;
    }

    if (msg.type === 'subscribe-cursors') {
      // Fire-and-forget: replace the token set for this path, then push so the
      // caller gets positions immediately instead of waiting for someone to type
      // (pushToSubscriptions treats a changed cursor map as a reason to post).
      // Stored regardless of load state — resolution is lazy, so a registration
      // that arrives before the handle is ready still takes effect on first push.
      const key = stableJson(msg.path);
      let byPath = this.cursorSubs.get(msg.docId);
      if (msg.tokens.length === 0) {
        byPath?.delete(key);
        if (byPath && byPath.size === 0) this.cursorSubs.delete(msg.docId);
      } else {
        if (!byPath) { byPath = new Map(); this.cursorSubs.set(msg.docId, byPath); }
        byPath.set(key, [...msg.tokens]);
      }
      await this.pushToSubscriptions(msg.docId);
      return;
    }




    if (msg.type === 'archive-doc') {
      await this.respond(msg.id, async () => {
        // Tombstone FIRST (empty baseline), so a reconcile racing this handler
        // (any keyhive ingest triggers one) can't re-add the doc between the
        // list write and the revoke below. The baseline is upgraded to the real
        // grant signatures once revokeMyAccess reports them. The tombstone now
        // lives in the synced DriveSettings doc, so an archive propagates to the
        // user's other devices (archiving requires a user-group, so it exists).
        await this.settingsSurface.ensureDriveSettingsDoc({ create: true });
        this.settingsSurface.setArchivedTombstone(msg.docId, { grantSigs: [] });
        const list = (await this.host.kv.get<StoredDocEntry[]>(KEYS.docIds)) ?? [];
        const removedEntry = list.find(e => e.id === msg.docId);
        const filtered = list.filter(e => e.id !== msg.docId);
        await this.host.kv.set(KEYS.docIds, filtered);
        this.presenceSurface.cancelPending(msg.docId);
        this.presenceSurface.teardown(msg.docId);
        const entry = this.docRegistry.get(msg.docId);
        if (entry) {
          for (const subId of entry.subscriptions.keys()) this.subIdToDocId.delete(subId);
          this.docRegistry.delete(msg.docId);
        }
        this.cursorSubs.delete(msg.docId);
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
              this.settingsSurface.setArchivedTombstone(msg.docId, { grantSigs: res.grantSigs });
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
        return { status };
      }, '[engine] archive-doc failed:');
      return;
    }

    // Pure keyhive delegations: one entry per message type. Args match the khOps
    // method except the resolveKhDocId wrappers; kh-link-device also re-runs the
    // post-link home reconcile. kh-receive-contact-card / kh-get-known-friends
    // and the kh-rdv-* rendezvous handlers live in the settings / rendezvous mixins.
    const khDelegates: Record<string, (kh: KeyhiveOps, m: any) => Promise<unknown> | unknown> = {
      'kh-get-identity': (kh) => kh.getIdentity(),
      'kh-get-contact-card': (kh) => kh.getContactCard(),
      'kh-get-doc-members': (kh, m) => kh.getDocMembers(this.resolveKhDocId(m.docId)).then(members => ({ members })),
      'kh-get-my-access': (kh, m) => kh.getMyAccess(this.resolveKhDocId(m.docId)),
      'kh-add-member': (kh, m) => kh.addMember(m.agentId, this.resolveKhDocId(m.docId), m.role),
      'kh-revoke-member': (kh, m) => kh.revokeMember(m.agentId, this.resolveKhDocId(m.docId)),
      'kh-change-role': (kh, m) => kh.changeRole(m.agentId, this.resolveKhDocId(m.docId), m.newRole),
      'kh-list-devices': (kh) => kh.listGroupDevices(),
      'kh-remove-device': (kh, m) => kh.removeDeviceFromGroup(m.agentId),
      'kh-change-device-role': (kh, m) => kh.changeDeviceRole(m.agentId, m.newRole),
      'kh-ensure-user-group': (kh, m) => kh.ensureUserGroup({ create: m.create, adoptGroupId: m.adoptGroupId, waitForSync: m.waitForSync }),
      'kh-get-link-payload': async (kh) => {
        const userGroupId = await kh.ensureUserGroup({ create: true });
        return { card: await kh.getContactCard(), userGroupId };
      },
      'kh-link-device': async (kh, m) => {
        const result = await kh.linkDevice(m.deviceAgentId, m.peerGroupId);
        void this.reconcileHomeDocsAfterLink();
        return result;
      },
    };
    const khDelegate = khDelegates[msg.type];
    if (khDelegate) {
      const m = msg as any;
      await this.respond(m.id, () => {
        if (!this.khOps) throw new Error('Keyhive not available');
        return khDelegate(this.khOps, m);
      });
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

/**
 * The composed engine: settings → presence → rendezvous → watch, layered over
 * the core. Each mixin assigns its `*Surface` hook in a field initializer (they
 * avoid constructors so the composed class keeps the core's `(host, opts)`
 * signature — see engine-settings.ts), and the core's `init()`/`handleMessage`
 * reach subsystem state through those hooks.
 */
export const DriveEngine = EngineWatch(EngineRendezvous(EnginePresence(EngineSettings(EngineCore))));

/** The composed engine's instance type (mixins' public members included). */
export type DriveEngineInstance = InstanceType<typeof DriveEngine>;

// Re-exports kept for the tests and the CLI (see Phase 3 split):
export type { EngineSettingsSurface } from './engine-settings';
export type { EnginePresenceSurface } from './engine-presence';
export type { EngineRendezvousSurface } from './engine-rendezvous';
export type { EngineWatchSurface, WatchUpdate } from './engine-watch';
export { RDV_MAX_DATA_BYTES } from './engine-rendezvous';
export { freshPresencePeerIds, PRESENCE_STALE_MS, PRESENCE_HEARTBEAT_MS } from './engine-presence';
