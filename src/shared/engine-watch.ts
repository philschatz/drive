/**
 * Watch + CLI-metadata subsystem for DriveEngine (class-expression mixin over
 * the core).
 *
 * Owns the CLI-facing document reads (`getDocMeta`/`getDocJson`/`diffVersions`,
 * enumeration) and the keep-N-open + rotate watcher. Extends the rendezvous
 * mixin, so presence liveness checks (`isActive`) and the registry are
 * reachable directly on `this`.
 *
 * The mixin chain is composed in drive-engine.ts:
 *   EngineCore → EngineSettings → EnginePresence → EngineRendezvous → EngineWatch
 * and the core reaches in through the late-bound {@link EngineWatchSurface}
 * (assigned in a field initializer to `this`) for the change-listener wiring in
 * getOrCreateEntry and the debug version-patches handler.
 */
import { base64ToBytes, errMsg } from './keyhive-ops';
import type { EngineCore } from './drive-engine';
import type { EngineSettingsSurface } from './engine-settings';
import type { EnginePresenceSurface } from './engine-presence';
import { createLogger } from './logger';

const log = createLogger('engine');

/** Base this mixin extends: the core plus the settings/presence surfaces, so
 *  the watcher can call `pinnedDocs` (settings) and `isActive` (presence)
 *  directly on `this`. */
export type EngineWatchCtor = new (...args: any[]) =>
  EngineCore & EngineSettingsSurface & EnginePresenceSurface;

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

/**
 * The surface the CORE (base class) calls up into this module plus this
 * mixin's external API (the CLI's doc reads + watcher). Set in a field
 * initializer to `this` — one late-bound getter per feature module. It also
 * types the composed instance, so every public member is listed here.
 */
export interface EngineWatchSurface {
  watchedDocs: Set<string>;
  emitWatchUpdate(docId: string): void;
  diffVersions(
    docId: string, fromVersion?: number, toVersion?: number,
  ): Promise<{ from: number; to: number; patches: any[] }>;
  enumerateAccessibleDocIds(): Promise<string[]>;
  getDocMeta(docId: string): Promise<WatchUpdate>;
  getDocJson(docId: string, version?: number): Promise<any>;
  startWatching(opts: StartWatchingOptions, onUpdate?: (u: WatchUpdate) => void): Promise<void>;
  stopWatching(): void;
}

export function EngineWatch<C extends EngineWatchCtor>(Base: C):
  new (...args: any[]) => InstanceType<C> & EngineWatchSurface {
  return class EngineWatchMixin extends Base {
    // Watcher (keep-N-open + rotate).
    protected watching = false;
    watchedDocs = new Set<string>();
    protected watchOnUpdate: ((u: WatchUpdate) => void) | null = null;

    // The core's late-bound hook into this module (field initializer — see
    // engine-settings.ts for why the mixins avoid constructors).
    protected watchSurface: EngineWatchSurface = this as any;

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

    emitWatchUpdate(docId: string): void {
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
        log.warn(`watch keep-open failed ${docId}:`, errMsg(err));
      }
    }

    /** Best-effort close: stop watching + drop the registry entry if nothing else needs it. */
    private watchClose(docId: string): void {
      this.watchedDocs.delete(docId);
      if (this.pinnedDocs.has(docId)) return;
      const entry = this.docRegistry.get(docId);
      if (!entry) return;
      if (entry.subscriptions.size > 0 || entry.validationSubscribed || this.isActive(docId)) return;
      this.docRegistry.delete(docId);
      this.cursorSubs.delete(docId);
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
          log.info(`watch: keeping ${keep.length} doc(s) open (min ${opts.keepOpen}, ${withinWindow} within ${opts.recentDays}d)`);

          // Release any previously-watched doc that dropped out of the kept set (and
          // isn't pinned) so only the kept set stays resident between rotations.
          for (const id of [...this.watchedDocs]) {
            if (!keepSet.has(id)) this.watchClose(id);
          }

          // Rotate the remainder one-by-one: open, hold open long enough to sync, close.
          const rest = ranked.slice(keepCount).map(r => r.id).filter(id => !this.pinnedDocs.has(id));
          for (const id of rest) {
            if (!this.watching) return;
            log.info(`watch: syncing ${id} for ${Math.round(syncMs / 1000)}s`);
            await this.watchKeepOpen(id);
            this.emitWatchUpdate(id);
            await this.sleep(syncMs);
            if (!keepSet.has(id)) this.watchClose(id);
          }
        } catch (err) {
          log.warn('watch loop error:', errMsg(err));
        }
        await this.sleep(reenumerateEveryMs);
      }
    }

    private sleep(ms: number): Promise<void> {
      return new Promise((r) => setTimeout(r, ms));
    }
  } as any;
}
