/**
 * Shared keyhive-enabled Automerge Repo construction.
 *
 * Factors out the near-identical init that used to be duplicated in the browser
 * worker (automerge-worker.ts) and the CalDAV server (caldav-keyhive.ts): the
 * storage-format guard, subduction WASM init, the keyhive bridge (which builds
 * the hive AND the Repo together, wiring the hive's network adapter and peerId
 * into it), the share gate, and the KeyhiveOps side-effects. The caller injects
 * the storage adapter, the network adapter, the peerId label, and how the
 * user-group id persists.
 *
 * The keyhive bridge is imported dynamically and cast to `any`: its
 * `export * from "@keyhive/keyhive/slim"` re-export doesn't resolve under the
 * backend tsconfig's moduleResolution, but every value is present at runtime.
 *
 * This is the app's ONLY import of the bridge, and it uses the bridge's
 * network-adapter ("legacy") path: keyhive state syncs over the same
 * automerge-repo NetworkAdapter as documents — here, the relay/WebRTC adapter.
 * (The bridge's default path syncs through a subduction server instead, which
 * this app does not have.)
 */
import { KeyhiveOps } from './keyhive-ops';
import { RELAY_PEER_ID } from './relay-identity';
import { agentIdOfPeerId } from './peer-id';
import { ensureKeyhiveStorageUsable } from './keyhive-format';
import { createLogger } from './logger';

const log = createLogger('keyhive');

export interface CreateKeyhiveRepoOptions {
  /** automerge-repo StorageAdapter (IndexedDB in the browser, NodeFS in Node). */
  storage: any;
  /** automerge-repo NetworkAdapter (already wrapped for WebRTC in the browser).
   * Required even for a local-only caller, which passes an adapter that never
   * connects: the bridge wraps whatever it is given. */
  networkAdapter: any;
  /** A readability label for the peerId ('drive', 'caldav-server') — NOT
   * identity (that is the verifying key in front of it) and NOT unique: the
   * bridge appends its own random component per boot, so the peerId is
   * `<key>-<label>-<random>` (see peer-id.ts). */
  peerIdSuffix: string;
  /** Read the persisted personal user-group id (base64), or null if none. */
  getUserGroupId: () => Promise<string | null>;
  /** Persist the personal user-group id (base64). */
  setUserGroupId: (id: string) => Promise<void>;
  /**
   * Serialize every keyhive call on the bridge's shared queue (keyhive WASM is
   * non-reentrant). The browser/CLI want this because high-frequency presence
   * encrypt/decrypt races the bridge's own queued calls; CalDAV does not.
   */
  serialize?: boolean;
  /**
   * Install the keyhive-membership shareConfig gate (announce/access), so a doc
   * is only announced to peers that have keyhive access. The browser and CLI want
   * this; CalDAV historically ran without it.
   */
  withShareConfig?: boolean;
  /** Called before the bridge fires a share-config change (worker reconciles the home list). */
  onBeforeShareConfigChanged?: () => void;
  /**
   * How long (ms) the bridge waits after a keyhive membership change before
   * telling the repo to re-evaluate who may see which document. Defaults to the
   * bridge's 2000. Lower it only under test.
   */
  shareConfigDebounceMs?: number;
  /**
   * Debug hook: invoked with the method name just before every keyhive WASM call
   * runs, then with `null` once it succeeds. Only wired when debug mode is on. Used
   * to trace which Rust call trapped when the worker dies on a WASM `unreachable`
   * panic (see the crash banner in worker-client.ts) — the non-null value is only
   * live while a call is in flight. Undefined = no tracing, zero overhead.
   */
  onKeyhiveCall?: (method: string | null) => void;
  /**
   * How often (ms) keyhive requests a sync round. Defaults to 2000 (production).
   * Lower it only under test (e.g. via VITE_SYNC_INTERVAL_MS) to collapse the
   * multi-second cross-peer convergence floor the two-peer E2E specs pay — more
   * frequent sync = more traffic, so keep the 2000 default in production.
   */
  syncRequestInterval?: number;
}

export interface KeyhiveRepo {
  repo: any;
  khOps: KeyhiveOps;
  integration: any;
  /** The keyhive bridge module (re-exports all @keyhive/keyhive/slim values). */
  bridge: any;
  /** @automerge/automerge namespace (getHistory, diff, getHeads, …). */
  Automerge: any;
  /** automerge-repo Presence class. */
  Presence: any;
  /** Convert keyhive doc-id bytes (== automerge BinaryDocumentId) → automerge doc id string. */
  amDocIdFromBytes: (bytes: Uint8Array) => string;
  /** The inverse: an automerge doc id string → the keyhive DocumentId with the same bytes. */
  khDocIdFromAm: (docId: string) => any;
  /** Slot a pre-generated keyhive doc-id for the next repo.create2() (create-doc flow). */
  setNextDocId: (bytes: Uint8Array) => void;
  /**
   * Stop the hive (its sync timers, its network adapter) and shut the Repo
   * down, flushing storage. Nothing here is usable afterwards. The app never
   * needs this — an engine lives as long as its process — but a test that boots
   * the real stack cannot exit without it: the bridge's adapter holds interval
   * timers that are not unref'd.
   */
  close: () => Promise<void>;
}

/**
 * Wrap a keyhive instance so EVERY method call is serialized on the shared queue.
 * keyhive WASM is not reentrant: if one keyhive method is suspended at an await and
 * another runs, it traps. Synchronous getters/properties pass through untouched.
 */
function makeSerializeKeyhive(
  runOnKeyhiveQueue: <T>(fn: () => Promise<T>) => Promise<T>,
  onCall?: (method: string | null) => void,
) {
  return (realKh: any): any =>
    new Proxy(realKh, {
      get(target, prop) {
        const val = (target as any)[prop];
        if (typeof val !== 'function') return val;
        if (!onCall) {
          return (...args: any[]) => runOnKeyhiveQueue(() => Promise.resolve(val.apply(target, args)));
        }
        // Debug mode: log the call name BEFORE running it. A WASM `unreachable`
        // trap kills the worker before any post-call code runs, so this pre-call
        // trace is what survives to name the culprit (console + crash banner).
        // Clear it (onCall(null)) once the call succeeds so only an in-flight call
        // is ever attributed to a later crash.
        const method = String(prop);
        return (...args: any[]) =>
          runOnKeyhiveQueue(() => {
            log.debug('→', method);
            onCall(method);
            return Promise.resolve(val.apply(target, args)).then(
              (result: unknown) => { onCall(null); return result; },
              (err: unknown) => { log.warn('✗', method, err); throw err; },
            );
          });
      },
    });
}

export async function createKeyhiveRepo(opts: CreateKeyhiveRepoOptions): Promise<KeyhiveRepo> {
  // FIRST, before anything is handed the storage: refuse keyhive state written
  // by an older version. The bridge's boot path on such state either throws or
  // saves a fresh empty keyhive over it (see keyhive-format.ts). Throws
  // KeyhiveResetRequiredError, which the engine turns into the reset screen.
  await ensureKeyhiveStorageUsable(opts.storage);

  // Importing the non-`/slim` automerge-subduction entry initializes the subduction
  // WASM as a side effect (the `/slim` entry the Repo uses shares the instance).
  // Must run before new Repo() — which the bridge calls, below.
  await import('@automerge/automerge-subduction');
  const repoModule: any = await import('@automerge/automerge-repo');
  const Repo = repoModule.Repo;
  const Presence = repoModule.Presence;
  const stringifyAutomergeUrl = repoModule.stringifyAutomergeUrl;
  const parseAutomergeUrl = repoModule.parseAutomergeUrl;
  // Keyhive doc-id bytes are the automerge BinaryDocumentId, so the two ids
  // convert through the automerge url codec in either direction.
  const amDocIdFromBytes = (bytes: Uint8Array) =>
    parseAutomergeUrl(stringifyAutomergeUrl(bytes)).documentId;

  const Automerge = await import('@automerge/automerge');
  const bridge: any = await import('@automerge/automerge-repo-keyhive');
  bridge.initKeyhiveWasm();
  // The bridge has its own levelled logger, which writes straight to console.
  // Its info and debug lines are a per-event, per-message firehose, so they are
  // on only when ours is at debug; warnings and errors follow our level.
  bridge.setKeyhiveLogLevel(
    log.enabled('debug') ? 'debug' : log.enabled('warn') ? 'warn' : log.enabled('error') ? 'error' : 'silent');
  const khDocIdFromAm = (docId: string) =>
    new bridge.DocumentId(parseAutomergeUrl(`automerge:${docId}`).binaryDocumentId);

  // The hive, once the bridge has built it. The share gate below is handed to
  // the Repo — which the bridge constructs — before this exists, so it reads
  // the binding late.
  let hive: any = null;

  /**
   * Run a keyhive WASM operation on the bridge's shared serialization queue. ALL
   * keyhive access (signing, sync, the share gate) goes through this single
   * PromiseQueue; calling keyhive concurrently/reentrantly traps the WASM. Never
   * nest these calls (serial queue → deadlock).
   */
  const runOnKeyhiveQueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const queue = hive?.networkAdapter?.keyhiveQueue;
    return queue ? queue.run(fn) : fn();
  };
  const serializeKeyhive = makeSerializeKeyhive(runOnKeyhiveQueue, opts.onKeyhiveCall);

  // Slot for pre-generated keyhive doc IDs. The create-doc flow mints the keyhive
  // doc first, sets nextDocIdBytes, then create2() consumes it so the automerge
  // doc ID == keyhive doc ID. This replaces the bridge's own idFactory, which
  // would mint a fresh group + document per create.
  let nextDocIdBytes: Uint8Array | null = null;
  const setNextDocId = (bytes: Uint8Array) => { nextDocIdBytes = bytes; };
  const idFactory = async () => {
    if (!nextDocIdBytes) throw new Error('nextDocIdBytes not set before create2');
    const bytes = nextDocIdBytes;
    nextDocIdBytes = null;
    return bytes;
  };

  // shareConfig gates which docs are announced to which peers based on keyhive
  // membership. A doc a peer has no keyhive access to is not announced/shared.
  const khAccessCheck = async (peerId: string, docId: string | undefined): Promise<boolean> => {
    if (!docId || !hive) return false;
    // The relay is a router, not a keyhive member — never announce docs to it.
    if (peerId === RELAY_PEER_ID) return false;
    try {
      // The peer's device is the verifying key in front of its peerId.
      const keyBytes = Uint8Array.from(atob(agentIdOfPeerId(peerId)), (c) => c.charCodeAt(0));
      const identifier = new bridge.Identifier(keyBytes);
      // shareConfig is consulted off the keyhive queue (during sync-message handling),
      // so serialize this keyhive access too. accessForDoc follows group
      // membership, so a device is admitted through its user's group.
      const access = await runOnKeyhiveQueue(() =>
        hive.accessForDoc(identifier, `automerge:${docId}` as any));
      return access !== undefined;
    } catch {
      return false;
    }
  };

  // The bridge builds the hive and the Repo together: it injects the hive's
  // network adapter (ours, wrapped so its traffic is signed and verified) and
  // peerId into the config it hands `createRepo`, then links the two so keyhive
  // membership changes reach `repo.shareConfigChanged()`.
  const built = await bridge.initializeLegacyAutomergeRepoKeyhive({
    storage: opts.storage,
    peerIdSuffix: opts.peerIdSuffix,
    networkAdapter: opts.networkAdapter,
    // The relay is a stateless router with no keyhive identity, so there is no
    // sync server to register: peers sync keyhive state with each other.
    syncServer: 'none',
    onlyShareWithSyncServer: false,
    periodicallyRequestSync: true,
    automaticArchiveIngestion: true,
    cachingMode: 'none',
    syncRequestInterval: opts.syncRequestInterval ?? 2000,
    ...(opts.shareConfigDebounceMs !== undefined ? { shareConfigDebounceMs: opts.shareConfigDebounceMs } : {}),
    ...(opts.onBeforeShareConfigChanged ? { onBeforeShareConfigChanged: opts.onBeforeShareConfigChanged } : {}),
    repo: {
      storage: opts.storage,
      ...(opts.withShareConfig
        ? { shareConfig: { announce: khAccessCheck, access: khAccessCheck as (peer: string, doc: string) => Promise<boolean> } }
        : {}),
    },
    createRepo: (config: any) => new Repo({ ...config, idFactory }),
  });
  hive = built.hive;
  const repo = built.repo;
  const integration = hive;

  // Serialize ALL keyhive access through the bridge's shared queue when requested.
  const khForOps = opts.serialize ? serializeKeyhive(integration.keyhive) : integration.keyhive;
  const khOps = new KeyhiveOps(khForOps, bridge, {
    persist: () => integration.keyhiveStorage.saveKeyhiveWithHash(khForOps),
    syncKeyhive: () => integration.networkAdapter?.syncKeyhive?.(),
    // After a local keyhive membership change, re-evaluate shareConfig so newly-
    // authorized peers get the doc announced (shareConfigChanged is the equivalent
    // of the old forceResync).
    forceResyncAllPeers: () => repo.shareConfigChanged(),
    getUserGroupId: opts.getUserGroupId,
    setUserGroupId: opts.setUserGroupId,
  });

  // Save the full keyhive archive (debounced) after every keyhive event.
  //
  // The bridge writes each event to storage as it is emitted, and the prekey
  // secrets on each prekey rotation — but a key rotation's LEAF SECRET lives
  // only in the archive, which the bridge saves at boot and at compaction. An
  // encrypt can mint a rotation at any time (after a membership change, on a
  // member's first write, after two concurrent epochs merge), and a restart
  // before the next archive save loses that secret.
  //
  // That no longer wedges the instance, as it did under keyhive alpha.58: it
  // recovers by rotating again on its next encrypt (pinned by the stale-archive
  // test in keyhive-ops.test.ts). But the lost epoch stays unreadable to it —
  // including every peer's presence currently on the wire, until those peers
  // notice the new epoch and re-encrypt (see flushPresenceOutbox). Saving the
  // archive about a second after each event makes that the exception: without
  // it, every reload of a device that has written anything loses an epoch.
  let stopArchiveTimer = () => {};
  {
    const emitter = (integration as any).emitter;
    let timer: any = null;
    let saving = false;
    let dirty = false;
    // With the serializing proxy, saveKeyhiveWithHash's internal toArchive() is
    // queued by the proxy itself; without it (CalDAV), queue the whole save —
    // never both (nested queue.run deadlocks).
    const doSave = opts.serialize
      ? () => integration.keyhiveStorage.saveKeyhiveWithHash(khForOps)
      : () => runOnKeyhiveQueue(() => integration.keyhiveStorage.saveKeyhiveWithHash(integration.keyhive));
    const persistArchive = async () => {
      if (saving) { dirty = true; return; }
      saving = true;
      try { await doSave(); }
      catch (err) { log.warn('archive persist after keyhive event failed:', err); }
      finally {
        saving = false;
        if (dirty) { dirty = false; void persistArchive(); }
      }
    };
    emitter?.on?.('update', () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void persistArchive(); }, 1000);
      if (typeof timer?.unref === 'function') timer.unref();
    });
    stopArchiveTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stopArchiveTimer();
    // The hive first: closing it disconnects the network adapter, so nothing
    // arrives while the Repo below flushes and releases storage.
    try { hive.close(); } catch (err) { log.warn('closing the hive failed:', err); }
    try { await repo.shutdown(); } catch (err) { log.warn('shutting the repo down failed:', err); }
  };

  return {
    repo, khOps, integration, bridge,
    Automerge, Presence, amDocIdFromBytes, khDocIdFromAm, setNextDocId, close,
  };
}
