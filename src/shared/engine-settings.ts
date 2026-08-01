/**
 * DriveSettings subsystem for DriveEngine (class-expression mixin over the core).
 *
 * Owns the per-user, keyhive-private DriveSettings document: resolution
 * (local blob ⇄ synced doc), the enforced validate-before-commit writes, the
 * friend/device-name string-map stores, and the archive tombstones. Exposes
 * the core's narrow surface ({@link EngineSettingsSurface}) so reconcile,
 * update-doc, archive-doc, and relay-watch can reach in without copying state.
 *
 * The mixin chain is composed in drive-engine.ts:
 *   EngineCore → EngineSettings → EnginePresence → EngineRendezvous → EngineWatch
 */
import { validateDocument, DRIVE_SETTINGS_TYPE, createDriveSettingsDocJson } from './schemas';
import { base64ToBytes, errMsg } from './keyhive-ops';
import { KEYS, LEGACY_IDB_KEYS } from './storage-keys';
import type { EngineCore } from './drive-engine';
import type { MainToWorker } from './worker-protocol';

export type EngineCtor = new (...args: any[]) => EngineCore;

/** KEYS.archivedDocIds value: archived automerge docId → re-share-detection baseline. */
export type ArchivedDocTombstones = Record<string, { grantSigs: string[] }>;

/**
 * The narrow surface the CORE (base class) and the OUTER mixins call up into
 * this module. Set in the mixin to `this` — one late-bound getter per feature
 * module. `scheduleRelayWatchRefresh` is how the settings module nudges the
 * (outer) rendezvous mixin when the friend roster changes. The roster/name
 * members beyond the core's needs exist so the rendezvous mixin's `this.`
 * calls typecheck against the settings members.
 */
export interface EngineSettingsSurface {
  settingsMode: 'shared' | 'local';
  driveSettingsDocId: string | null;
  driveSettingsHandle: any;
  pinnedDocs: Set<string>;
  driveSettingsDoc(): any | null;
  ensureDriveSettingsDoc(opts?: { create?: boolean }): Promise<any | null>;
  assertValidSettingsChange(handle: any, mutator: (d: any) => void): void;
  /** Commit a DriveSettings mutation validate-before-commit (backup import merges entries through this). */
  changeDriveSettings(mutator: (d: any) => void): void;
  /** Flip LOCAL → SHARED and drop the local facade so the synced doc can be created (backup import). */
  openSharedSettingsForImport(): void;
  broadcastNames(field: 'friends' | 'deviceNames'): void;
  getArchivedTombstones(): ArchivedDocTombstones;
  setArchivedTombstone(docId: string, entry: { grantSigs: string[] }): void;
  deleteArchivedTombstones(docIds: string[]): void;
  refreshFromSettingsDoc(): void;
  adoptDriveSettingsDoc(docId: string): Promise<void>;
  addKnownFriendGroup(groupId: string): Promise<boolean>;
  putFriendName(agentId: string, name: string | undefined): Promise<void>;
  putDeviceName(agentId: string, name: string | undefined): Promise<void>;
  /** Drop all DriveSettings state (full-backup restore: a reload re-resolves from the restored store). */
  resetDriveSettings(): void;
}

export function EngineSettings<C extends EngineCtor>(Base: C):
  new (...args: any[]) => InstanceType<C> & EngineSettingsSurface {
  return class EngineSettingsMixin extends Base {
    // DriveSettings doc: the synced, keyhive-private source of truth for contacts,
    // device names, and archived-doc tombstones. Located
    // via the device-local KEYS.driveSettings pointer (set from local creation,
    // guarded discovery of the user's own private docs, or the device-link
    // rendezvous) — never by scanning synced docs for @type:'DriveSettings'.
    driveSettingsDocId: string | null = null;
    driveSettingsHandle: any = null;
    protected ensureSettingsInFlight: Promise<any> | null = null;
    protected legacyMerged = false;
    // A settings-doc handle whose ops haven't synced yet. We subscribe to it ONCE and
    // adopt when it arrives, rather than re-running loadDriveSettingsHandle on every
    // keyhive ingest — that per-ingest churn (a serialized kh.getDocument + repo.find +
    // whenReady) starves the post-device-link keyhive convergence of the user's real
    // docs on a large established account, so nothing ever decrypts.
    protected driveSettingsDeferredHandle: any = null;

    // Settings storage mode. LOCAL (default): the four settings live in a device-local
    // JSON blob stored under KEYS.driveSettings (no sync, no user-group minted). SHARED
    // (opt-in, one-way): the synced DriveSettings Automerge doc above. The mode is
    // resolved in init() from the KEYS.driveSettings value TYPE — a string is a docId
    // ⇒ shared; an object is the blob ⇒ local; absent ⇒ local. In LOCAL mode
    // this.driveSettingsHandle is a lightweight facade ({__local, doc, change, on}) over
    // this.localSettings, so every store method + changeDriveSettings works unchanged.
    settingsMode: 'shared' | 'local' = 'local';
    protected localSettings: any = null;
    protected ensureLocalInFlight: Promise<any> | null = null;

    // Docs held open regardless of the watcher's rotation (the settings doc, and
    // docs with an active editor). Shared with the (outer) watch mixin, which is
    // why it lives here: settings is the base watch extends.
    pinnedDocs = new Set<string>();

    // The core's late-bound hook into this module. A field initializer (not a
    // constructor) so the mixin class needs no constructor — which keeps the
    // composed DriveEngine's own `(host, opts)` constructor signature intact.
    protected settingsSurface: EngineSettingsSurface = this as any;

    /** Current DriveSettings contents, or null if the doc isn't loaded yet. */
    driveSettingsDoc(): any | null {
      try { return this.driveSettingsHandle?.doc?.() ?? null; } catch { return null; }
    }

    private plainClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

    /** Throw if applying `mutator` would make a DriveSettings doc invalid. */
    assertValidSettingsChange(handle: any, mutator: (d: any) => void): void {
      // Branch on the handle, not this.settingsMode: a LOCAL-mode user can still open a
      // real leftover DriveSettings automerge doc in the source viewer, which passes a
      // real (non-__local) handle here and must use Automerge.clone.
      let next: any;
      if (handle.__local) {
        next = this.plainClone(handle.doc());
        mutator(next);
      } else {
        next = this.Automerge.change(this.Automerge.clone(handle.doc()), mutator);
      }
      // Only hard errors reject. An unknown property is reported as a `warning`
      // (see obj() in schemas/core.ts) — a key this build doesn't know about must
      // never make every subsequent settings write throw, which is what a stale
      // key from another build would otherwise do.
      const errors = validateDocument(next).filter(e => e.kind !== 'warning');
      if (errors.length) {
        const detail = errors.slice(0, 3).map(e => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
        throw new Error(`DriveSettings change rejected (would be invalid): ${detail}`);
      }
    }

    /**
     * Validate a proposed change on a clone and throw if it would make the doc
     * invalid, then commit it. This is what makes DriveSettings edits *enforced*
     * (unlike other doc types, whose validation is advisory).
     */
    protected changeDriveSettings(mutator: (d: any) => void): void {
      const handle = this.driveSettingsHandle;
      if (!handle) throw new Error('DriveSettings document is not loaded');
      this.assertValidSettingsChange(handle, mutator);
      handle.change(mutator);
    }

    /** Flip LOCAL → SHARED and drop the local facade (backup settings import, and
     * the local→shared opt-in's first half). No-op when already shared. */
    openSharedSettingsForImport(): void {
      if (this.settingsMode === 'shared') return;
      this.settingsMode = 'shared';
      this.driveSettingsHandle = null;
      this.driveSettingsDocId = null;
      this.driveSettingsDeferredHandle = null;
      this.ensureSettingsInFlight = null;
    }

    /**
     * Resolve (loading, discovering, or creating) this user's DriveSettings doc.
     * Idempotent + single-flight. Returns the handle, or null when there is no
     * user-group yet and `create` was not requested.
     */
    async ensureDriveSettingsDoc(opts: { create?: boolean } = {}): Promise<any | null> {
      // LOCAL mode: never touch keyhive. Return BEFORE any create path so `create:true`
      // (which store methods pass) can never mint a user-group in local mode.
      if (this.settingsMode === 'local') return this.ensureLocalSettings();
      if (this.driveSettingsHandle) return this.driveSettingsHandle;
      // Already waiting for a known settings doc to sync in — don't re-load it (that is
      // the per-ingest churn that starves post-link convergence). Its 'change' handler
      // adopts it once it arrives.
      if (this.driveSettingsDeferredHandle) return null;
      if (this.ensureSettingsInFlight) return this.ensureSettingsInFlight;
      this.ensureSettingsInFlight = this.resolveDriveSettingsDoc(opts)
        .catch(err => { console.warn('[engine] ensureDriveSettingsDoc failed:', errMsg(err)); return null; })
        .finally(() => { this.ensureSettingsInFlight = null; });
      return this.ensureSettingsInFlight;
    }

    // ── LOCAL settings backend (device-local JSON blob under KEYS.driveSettings) ──
    // Installs a lightweight "handle" facade so every store method + changeDriveSettings
    // operates on the in-memory blob and persists it, with no keyhive/sync involved.

    /** Resolve the LOCAL settings blob (load-or-seed + one-time legacy migration). Single-flight. */
    protected async ensureLocalSettings(): Promise<any> {
      if (this.driveSettingsHandle?.__local) return this.driveSettingsHandle;
      if (this.ensureLocalInFlight) return this.ensureLocalInFlight;
      this.ensureLocalInFlight = this.resolveLocalSettings()
        .catch(err => { console.warn('[engine] ensureLocalSettings failed:', errMsg(err)); return this.driveSettingsHandle; })
        .finally(() => { this.ensureLocalInFlight = null; });
      return this.ensureLocalInFlight;
    }

    private async resolveLocalSettings(): Promise<any> {
      const stored = await this.host.kv.get<any>(KEYS.driveSettings);
      // A string here would mean SHARED mode — we should never be in LOCAL mode then, but
      // guard anyway: only adopt an object as the blob, else seed a bare one.
      this.localSettings = (stored && typeof stored === 'object')
        ? stored
        : createDriveSettingsDocJson();
      this.installLocalHandle();
      // Rename first: everything below writes into `friends`.
      this.migrateContactsToFriends();
      // The one-time legacy-key → blob consolidation (writes the blob via the local
      // handle, then deletes the five LEGACY_IDB_KEYS). This IS the local migration.
      await this.mergeLegacyIntoSettings();
      this.refreshFromSettingsDoc();
      return this.driveSettingsHandle;
    }

    /**
     * One-way local rename of the roster map `contacts` → `friends`. Idempotent,
     * and a no-op on docs created after the rename. Must run before anything else
     * writes settings, since the schema no longer declares `contacts`.
     *
     * Safe despite the pre-state being "invalid": assertValidSettingsChange
     * validates the post-mutation clone, which no longer carries the old key.
     */
    private migrateContactsToFriends(): void {
      const doc = this.driveSettingsDoc();
      if (!doc?.contacts) return;
      this.changeDriveSettings(d => {
        if (!d.friends) d.friends = {};
        for (const [k, v] of Object.entries(d.contacts ?? {})) {
          if (!(k in d.friends)) d.friends[k] = v; // never clobber a newer name
        }
        delete d.contacts;
      });
    }

    /** Install the __local facade over this.localSettings into this.driveSettingsHandle. */
    private installLocalHandle(): void {
      // LOCAL mode has no synced settings doc, so keep the pointer null (reconcileHomeDocs
      // excludes by this.driveSettingsDocId; there is nothing to exclude here).
      this.driveSettingsDocId = null;
      this.driveSettingsHandle = {
        __local: true,
        doc: () => this.localSettings,
        change: (fn: (d: any) => void) => {
          const c = this.plainClone(this.localSettings);
          fn(c);
          this.localSettings = c;
          void this.host.kv.set(KEYS.driveSettings, c);
        },
        on: () => {},
      };
    }

    private async resolveDriveSettingsDoc(opts: { create?: boolean }): Promise<any | null> {
      if (!this.khOps || !this.repo || !this.amDocIdFromBytes) return null;

      // 1) Device-local pointer → load it. If the pointer is set but the doc hasn't
      //    synced yet, DEFER (do not create a duplicate) — a later ensure (fired on
      //    keyhive ingest) will load it once its ops arrive. A non-string value means the
      //    key currently holds a LOCAL blob (a local→shared opt-in in progress); treat it
      //    as "no pointer" so we fall through to create (which overwrites it with the id).
      const pointerVal = await this.host.kv.get<unknown>(KEYS.driveSettings);
      const pointer = typeof pointerVal === 'string' ? pointerVal : null;
      if (pointer) {
        const handle = await this.loadDriveSettingsHandle(pointer);
        if (handle) { await this.mergeLegacyIntoSettings(); return handle; }
        // Not synced yet — loadDriveSettingsHandle has subscribed to adopt it on arrival
        // (no per-ingest re-poll). mergeLegacy runs then too.
        return null;
      }

      const userGroupId = await this.khOps.getUserGroupId();

      // 2) Create it. createKeyhiveDoc mints the user-group if absent, so this
      //    doubles as the first-write identity bootstrap. Reuse of an existing
      //    settings doc is NOT attempted ambiently here — the enable-settings-sync
      //    handler does that explicitly (findReachableDriveSettingsDocs) at the
      //    user-initiated button press.
      if (opts.create || userGroupId) {
        const handle = await this.createDriveSettingsDoc();
        await this.mergeLegacyIntoSettings();
        return handle;
      }
      return null;
    }

    /** Find, register, pin, and subscribe the DriveSettings doc at `docId`. */
    protected async loadDriveSettingsHandle(docId: string): Promise<any | null> {
      try {
        // The settings doc is intentionally absent from the home list, so register
        // its sharing group here (home docs get this in init) so it syncs.
        const khDocId = this.resolveKhDocId(docId);
        try {
          await this.khOps!.registerSharingGroup(khDocId);
        } catch { /* best-effort */ }
        this.pinnedDocs.add(docId);
        const handle = await this.getOrLoadHandle(docId);
        if (handle.isReady && !handle.isReady()) {
          await handle.whenReady?.(['ready', 'unavailable']).catch(() => {});
        }
        const doc = handle.doc?.();
        if (doc && doc['@type'] === DRIVE_SETTINGS_TYPE) {
          this.adoptLoadedSettingsHandle(docId, handle);
          return handle;
        }
        if (doc && doc['@type'] !== DRIVE_SETTINGS_TYPE) {
          console.warn(`[engine] doc ${docId} is not DriveSettings (@type=${doc['@type']}); not adopting`);
          return null;
        }
        // Not synced yet. Subscribe ONCE and adopt when it arrives — do NOT let the
        // caller re-run this load on every keyhive ingest (see driveSettingsDeferredHandle).
        this.deferDriveSettingsHandle(docId, handle);
        return null;
      } catch (err) {
        console.warn(`[engine] loadDriveSettingsHandle(${docId}) failed:`, errMsg(err));
        return null;
      }
    }

    /** Commit a loaded settings handle as the active one (clears any deferred wait). */
    private adoptLoadedSettingsHandle(docId: string, handle: any): void {
      this.driveSettingsDeferredHandle = null;
      this.driveSettingsDocId = docId;
      this.driveSettingsHandle = handle;
      this.subscribeDriveSettings(handle);
      // Rename before the first read/write of the roster (see migrateContactsToFriends).
      this.migrateContactsToFriends();
      this.refreshFromSettingsDoc();
    }

    /**
     * Wait for a known-but-not-yet-synced settings doc to arrive by subscribing to its
     * handle ONCE, instead of re-loading it on every keyhive ingest. The repeated load
     * (registerSharingGroup → kh.getDocument, plus repo.find/whenReady, all serialized on
     * the keyhive queue) otherwise contends with — and can indefinitely starve — the
     * post-device-link sync of the user's real documents on a large account.
     */
    private deferDriveSettingsHandle(docId: string, handle: any): void {
      if (this.driveSettingsDeferredHandle === handle) return;
      this.driveSettingsDeferredHandle = handle;
      console.warn('[engine] DriveSettings pointer set but doc not synced yet; waiting for it (no re-poll)');
      const onArrive = () => {
        if (this.driveSettingsDeferredHandle !== handle) { handle.off?.('change', onArrive); handle.off?.('doc', onArrive); return; }
        let d: any = null;
        try { d = handle.doc?.(); } catch { /* not ready */ }
        if (d && d['@type'] === DRIVE_SETTINGS_TYPE) {
          handle.off?.('change', onArrive);
          handle.off?.('doc', onArrive);
          this.adoptLoadedSettingsHandle(docId, handle);
          void this.mergeLegacyIntoSettings();
        }
      };
      handle.on?.('change', onArrive);
      handle.on?.('doc', onArrive);
    }

    /** One-time merge of any legacy device-local IDB copies into the doc, then delete them. */
    private async mergeLegacyIntoSettings(): Promise<void> {
      if (this.legacyMerged || !this.driveSettingsHandle) return;
      this.legacyMerged = true;
      try {
        const [friendNames, knownGroups, deviceNames, archivedDocIds] = await Promise.all([
          this.host.kv.get<Record<string, string>>(LEGACY_IDB_KEYS.friendNames),
          this.host.kv.get<string[]>(LEGACY_IDB_KEYS.knownFriendGroups),
          this.host.kv.get<Record<string, string>>(LEGACY_IDB_KEYS.deviceNames),
          this.host.kv.get<ArchivedDocTombstones>(LEGACY_IDB_KEYS.archivedDocIds),
        ]);
        if (friendNames || knownGroups || deviceNames || archivedDocIds) {
          this.changeDriveSettings(d => {
            if (!d.friends) d.friends = {};
            if (!d.deviceNames) d.deviceNames = {};
            if (!d.archivedDocIds) d.archivedDocIds = {};
            for (const g of knownGroups ?? []) if (!(g in d.friends)) d.friends[g] = null;
            for (const [k, v] of Object.entries(friendNames ?? {})) if (d.friends[k] == null) d.friends[k] = v;
            for (const [k, v] of Object.entries(deviceNames ?? {})) if (!(k in d.deviceNames)) d.deviceNames[k] = v;
            for (const [k, v] of Object.entries(archivedDocIds ?? {})) if (!(k in d.archivedDocIds)) d.archivedDocIds[k] = { grantSigs: [...((v as any)?.grantSigs ?? [])] };
          });
          console.log('[engine] migrated legacy IDB settings into the DriveSettings doc');
        }
        await Promise.all([
          this.host.kv.del(LEGACY_IDB_KEYS.friendNames),
          this.host.kv.del(LEGACY_IDB_KEYS.knownFriendGroups),
          this.host.kv.del(LEGACY_IDB_KEYS.deviceNames),
          this.host.kv.del(LEGACY_IDB_KEYS.archivedDocIds),
        ]);
        this.refreshFromSettingsDoc();
      } catch (err) {
        console.warn('[engine] mergeLegacyIntoSettings failed:', errMsg(err));
      }
    }

    private async createDriveSettingsDoc(): Promise<any | null> {
      if (!this.repo || !this.khOps || !this.setNextDocId) return null;
      const handle = await this.createKeyhiveDocHandle(createDriveSettingsDocJson());
      const doc = handle.doc();
      if (this.repo.storageSubsystem && doc) {
        void this.repo.storageSubsystem.saveDoc(handle.documentId, doc);
      }
      await this.host.kv.set(KEYS.driveSettings, handle.documentId);
      this.pinnedDocs.add(handle.documentId);
      this.driveSettingsDocId = handle.documentId;
      this.driveSettingsHandle = handle;
      this.subscribeDriveSettings(handle);
      console.log(`[engine] created DriveSettings doc ${handle.documentId}`);
      return handle;
    }

    /**
     * Adopt a settings docId received over the trusted device-link rendezvous.
     * Persists the pointer synchronously but loads the doc in the BACKGROUND — the
     * doc may not have synced from the host yet, and blocking here would stall the
     * device-link handshake. A later ensure (fired on keyhive ingest) loads it.
     */
    async adoptDriveSettingsDoc(docId: string): Promise<void> {
      // Writing the docId string is what makes this device SHARED — and it is one-way
      // (nothing ever writes the local blob back over a string). Flip the in-memory mode
      // synchronously so the subsequent ensure resolves down the shared path.
      this.settingsMode = 'shared';
      await this.host.kv.set(KEYS.driveSettings, docId);
      if (this.driveSettingsDocId !== docId) {
        this.driveSettingsHandle = null;
        this.driveSettingsDocId = null;
        this.driveSettingsDeferredHandle = null; // drop any stale wait; the new ensure re-subscribes
      }
      void this.ensureDriveSettingsDoc();
    }

    private subscribeDriveSettings(handle: any): void {
      const onChange = () => this.refreshFromSettingsDoc();
      handle.on('change', onChange);
      if (typeof handle.on === 'function') handle.on('doc', onChange);
    }

    /** Drop all in-memory DriveSettings state (full-backup restore). The next
     * init() re-resolves the mode from the restored KEYS.driveSettings value. */
    resetDriveSettings(): void {
      this.settingsMode = 'local';
      this.driveSettingsHandle = null;
      this.driveSettingsDocId = null;
      this.driveSettingsDeferredHandle = null;
      this.ensureSettingsInFlight = null;
      this.ensureLocalInFlight = null;
      this.localSettings = null;
      this.legacyMerged = false;
    }

    /** Rebroadcast names (called on load + on any local or remote edit). */
    refreshFromSettingsDoc(): void {
      this.broadcastNames('friends');
      this.broadcastNames('deviceNames');
      // The friends roster feeds the relay watch list, and this fires for every
      // settings-doc change — local writes AND edits synced from other devices.
      // The method lives on the (outer) rendezvous mixin; this mixin's `this`
      // doesn't know it, so reach it through the instance (no-op if this mixin
      // is composed without rendezvous, e.g. under test).
      (this as any).scheduleRelayWatchRefresh?.();
    }

    /**
     * Explicit reuse discovery for the "sync settings across devices" opt-in:
     * automerge docIds of every REACHABLE DriveSettings doc, sorted ascending
     * (canonical = [0]). Deliberately skips the member/permission check the old
     * guarded discovery used — a doc synced from another of the user's devices
     * whose keyhive group/CGKA ops haven't fully arrived yet fails that check, and
     * that is exactly the doc we must adopt instead of minting a duplicate. Only
     * invoked from the enable-settings-sync handler (one-time, user-initiated).
     */
    protected async findReachableDriveSettingsDocs(): Promise<string[]> {
      if (!this.khOps || !this.amDocIdFromBytes) return [];
      const found: string[] = [];
      try {
        const { reachableKhIds } = await this.khOps.enumerateUserDocs();
        for (const khId of reachableKhIds) {
          const amId = this.amDocIdFromBytes(base64ToBytes(khId));
          let handle: any;
          try {
            handle = await this.getOrLoadHandle(amId);
            if (handle.isReady && !handle.isReady()) await handle.whenReady?.(['ready', 'unavailable']).catch(() => {});
          } catch { continue; }
          const doc = handle?.doc?.();
          if (doc && doc['@type'] === DRIVE_SETTINGS_TYPE) found.push(amId);
        }
      } catch (err) {
        console.warn('[engine] findReachableDriveSettingsDocs failed:', errMsg(err));
      }
      return found.sort();
    }

    /** Merge redundant (offline-race) settings docs into the canonical one, fill-missing. */
    protected async mergeRedundantSettingsDocs(loserDocIds: string[]): Promise<void> {
      for (const id of loserDocIds) {
        try {
          const handle = await this.getOrLoadHandle(id);
          const doc = handle?.doc?.();
          if (doc) this.fillMissingSettings(doc);
          console.warn(`[engine] DriveSettings: merged redundant doc ${id} into canonical (now orphaned)`);
        } catch (err) {
          console.warn(`[engine] DriveSettings: failed to merge redundant doc ${id}:`, errMsg(err));
        }
      }
    }

    /** Copy keys from `src`'s maps into the canonical doc without clobbering existing ones. */
    protected fillMissingSettings(src: any): void {
      this.changeDriveSettings(d => {
        for (const field of ['friends', 'deviceNames', 'archivedDocIds'] as const) {
          const s = src?.[field];
          if (!s || typeof s !== 'object') continue;
          if (!d[field]) d[field] = {};
          for (const [k, v] of Object.entries(s)) {
            if (!(k in d[field])) d[field][k] = (v !== null && typeof v === 'object') ? this.plainClone(v) : v;
          }
        }
      });
    }

    /** Archived-doc tombstones, read from / written to the DriveSettings doc. */
    getArchivedTombstones(): ArchivedDocTombstones {
      const t = this.driveSettingsDoc()?.archivedDocIds;
      return t ? this.plainClone(t) : {};
    }
    setArchivedTombstone(docId: string, entry: { grantSigs: string[] }): void {
      this.changeDriveSettings(d => { if (!d.archivedDocIds) d.archivedDocIds = {}; d.archivedDocIds[docId] = entry; });
    }
    deleteArchivedTombstones(docIds: string[]): void {
      if (!this.driveSettingsHandle || !docIds.length) return;
      this.changeDriveSettings(d => { for (const id of docIds) if (d.archivedDocIds) delete d.archivedDocIds[id]; });
    }

    // ── Settings string-map stores (friend roster + device names, both in the DriveSettings doc) ──
    // Friend value is the display name, or null when a friend is known but unnamed;
    // deleting the key drops a friend from the roster entirely (no separate groups list).
    private namesMap(field: 'friends' | 'deviceNames'): Record<string, string> {
      const src = this.driveSettingsDoc()?.[field];
      const out: Record<string, string> = {};
      if (src) for (const [k, v] of Object.entries(src)) if (typeof v === 'string') out[k] = v;
      return out;
    }
    /** Persist a friend's user-group (unnamed → null); returns true if already known. */
    async addKnownFriendGroup(groupId: string): Promise<boolean> {
      const handle = await this.ensureDriveSettingsDoc({ create: true });
      if (!handle) return false;
      if (this.driveSettingsDoc()?.friends && groupId in this.driveSettingsDoc()!.friends) return true;
      this.changeDriveSettings(d => { if (!d.friends) d.friends = {}; if (!(groupId in d.friends)) d.friends[groupId] = null; });
      return false;
    }
    broadcastNames(field: 'friends' | 'deviceNames'): void {
      const names = this.namesMap(field);
      this.emit(field === 'friends' ? { type: 'friend-names-updated', names } : { type: 'device-names-updated', names });
    }
    private async getNames(field: 'friends' | 'deviceNames'): Promise<Record<string, string>> { return this.namesMap(field); }
    private async putSettingsName(field: 'friends' | 'deviceNames', agentId: string, name: string | undefined): Promise<void> {
      const trimmed = name?.trim();
      if (!trimmed) return;
      const handle = await this.ensureDriveSettingsDoc({ create: true });
      if (!handle) throw new Error('Cannot save name — settings document unavailable');
      if (this.driveSettingsDoc()?.[field]?.[agentId] === trimmed) return;
      this.changeDriveSettings(d => { if (!d[field]) d[field] = {}; d[field][agentId] = trimmed; });
      this.broadcastNames(field);
    }
    private async deleteSettingsName(field: 'friends' | 'deviceNames', agentId: string): Promise<void> {
      if (!this.driveSettingsHandle) return;
      if (!(this.driveSettingsDoc()?.[field] && agentId in this.driveSettingsDoc()![field])) return;
      this.changeDriveSettings(d => { if (d[field]) delete d[field][agentId]; });
      this.broadcastNames(field);
    }
    protected async getFriendNames(): Promise<Record<string, string>> { return this.getNames('friends'); }
    async putFriendName(agentId: string, name: string | undefined): Promise<void> { await this.putSettingsName('friends', agentId, name); }
    protected async deleteFriendName(agentId: string): Promise<void> { await this.deleteSettingsName('friends', agentId); }
    async putDeviceName(agentId: string, name: string | undefined): Promise<void> { await this.putSettingsName('deviceNames', agentId, name); }

    /** Handle this module's message types; passes everything else down the chain. */
    async handleMessage(msg: MainToWorker): Promise<void> {
      if (msg.type === 'get-settings-mode') {
        await this.respond(msg.id, async () => {
          const userGroupId = this.khOps ? await this.khOps.getUserGroupId() : null;
          return { mode: this.settingsMode, hasUserGroup: !!userGroupId };
        });
        return;
      }

      // Read-only probe (no mutation, no mode flip): the docId of an existing
      // reachable DriveSettings doc to adopt, or null. Used by the Settings page to
      // decide whether "sync settings" is a permanent create (confirm) or a reuse.
      if (msg.type === 'get-reachable-settings-doc') {
        await this.respond(msg.id, async () => {
          const docs = this.khOps ? await this.findReachableDriveSettingsDocs() : [];
          return docs[0] ?? null;
        });
        return;
      }

      // One-way opt-in: migrate the device-local settings blob into a synced DriveSettings
      // doc and switch to SHARED mode. There is no reverse (Shared is permanent).
      if (msg.type === 'enable-settings-sync') {
        await this.respond(msg.id, async () => {
          if (this.settingsMode === 'shared') return { mode: 'shared' }; // idempotent
          if (!this.khOps) throw new Error('Keyhive not available — cannot sync settings');
          // Snapshot the current local blob so we can seed the synced doc with it.
          await this.ensureLocalSettings();
          const snapshot = this.plainClone(
            this.localSettings ?? { ...createDriveSettingsDocJson(), contacts: {} },
          );
          // Flip to shared and drop the local handle so its change() can't write the blob
          // back over the docId string createDriveSettingsDoc is about to persist.
          this.openSharedSettingsForImport();
          // Reuse an existing reachable DriveSettings doc (e.g. one already synced from
          // another of this user's devices) rather than minting a duplicate. Skip the
          // member/permission check — a synced-but-not-yet-CGKA-complete doc fails it, and
          // that is the very case we need to catch. Create only when none is reachable.
          let handle: any = null;
          const reachable = await this.findReachableDriveSettingsDocs();
          if (reachable.length) {
            const canonical = reachable[0]; // lowest docId — deterministic across devices
            handle = await this.loadDriveSettingsHandle(canonical);
            if (handle) {
              await this.host.kv.set(KEYS.driveSettings, canonical); // string pointer = SHARED
              if (reachable.length > 1) await this.mergeRedundantSettingsDocs(reachable.slice(1));
            }
          }
          if (!handle) handle = await this.ensureDriveSettingsDoc({ create: true });
          if (!handle) {
            // Rollback: keyhive/doc unavailable. The key still holds the blob object
            // (createDriveSettingsDoc never reached its kv.set), so no data is lost.
            this.settingsMode = 'local';
            this.installLocalHandle();
            throw new Error('Could not create the synced settings document');
          }
          // Copy the local blob into the (empty) synced doc, not clobbering anything
          // already synced from another device.
          this.fillMissingSettings(snapshot);
          this.refreshFromSettingsDoc();
          return { mode: 'shared' };
        });
        return;
      }

      if (msg.type === 'ensure-device-name') {
        await this.respond(msg.id, async () => {
          const trimmed = msg.name?.trim();
          if (trimmed) {
            // Set THIS device's name to the generated default ONLY if none is stored
            // yet — so the device gets a real, editable name at creation, never
            // clobbering a user edit or a name synced from another device. In LOCAL
            // mode this seeds the blob and mints no user-group.
            const handle = await this.ensureDriveSettingsDoc({ create: true });
            if (handle && this.driveSettingsDoc()?.deviceNames?.[msg.agentId] == null) {
              await this.putDeviceName(msg.agentId, trimmed);
            }
          }
        });
        return;
      }

      if (msg.type === 'set-friend-name') {
        await this.respond(msg.id, () => this.putFriendName(msg.agentId, msg.name), '[engine] set-friend-name failed:');
        return;
      }

      if (msg.type === 'remove-friend-name') {
        await this.respond(msg.id, () => this.deleteFriendName(msg.agentId), '[engine] remove-friend-name failed:');
        return;
      }

      if (msg.type === 'set-device-name') {
        await this.respond(msg.id, () => this.putDeviceName(msg.agentId, msg.name), '[engine] set-device-name failed:');
        return;
      }

      if (msg.type === 'remove-device-name') {
        await this.respond(msg.id, () => this.deleteSettingsName('deviceNames', msg.agentId), '[engine] remove-device-name failed:');
        return;
      }

      if (msg.type === 'kh-receive-contact-card') {
        await this.respond(msg.id, async () => {
          if (!this.khOps) throw new Error('Keyhive not available');
          if (!msg.isDevice && !msg.userGroupId) {
            throw new Error('This contact is not a group — ask them to open Settings and show a fresh friend QR/link.');
          }
          const result = await this.khOps.receiveContactCard(msg.cardJson);
          const friendGroupId = msg.isDevice ? null : msg.userGroupId;
          const alreadyKnown = !result.isOwnCard && !!friendGroupId
            ? await this.addKnownFriendGroup(friendGroupId)
            : false;
          return { ...result, userGroupId: friendGroupId, alreadyKnown };
        });
        return;
      }

      if (msg.type === 'kh-get-known-friends') {
        await this.respond(msg.id, async () => {
          if (!this.khOps) throw new Error('Keyhive not available');
          // The unified `friends` map holds every known friend (named or null),
          // so its keys ARE the known-friend-group ids.
          await this.ensureDriveSettingsDoc();
          const friendGroupIds = Object.keys(this.driveSettingsDoc()?.friends ?? {});
          const excludeKhDocId = msg.excludeDocId ? this.resolveKhDocId(msg.excludeDocId) : undefined;
          return this.khOps.getKnownFriends(excludeKhDocId, friendGroupIds);
        });
        return;
      }

      await super.handleMessage(msg);
    }
  } as any;
}
