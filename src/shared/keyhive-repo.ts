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
 * This is the app's ONLY import of the bridge. What travels between two
 * devices, from the bottom up:
 *
 * - **The secure channel** (secure-channel.ts) over the relay/WebRTC adapter the
 *   caller hands in. A peer exists above it only once it has proved the device
 *   key in its peerId, and every message is sealed for that one device. The
 *   relay sees who is introduced to whom, and sizes and timing; nothing else.
 *   Both of the following ride it.
 * - **Keyhive's own state** (membership, keys) uses the bridge's network-adapter
 *   ("legacy") path: signed `keyhive-*` messages. The adapter the bridge is
 *   given is the channel, narrowed to exactly those (keyhive-only-adapter.ts).
 * - **Documents** sync through the Repo's subduction instance, over a link per
 *   peer device (subduction-links.ts). Every commit is encrypted under the
 *   document's keyhive key before it is stored for sync
 *   (subduction-interceptor.ts), so a peer is handed ciphertext it can read only
 *   if it holds that key — and is handed it only if keyhive says it may be
 *   (subduction-policy.ts, subduction-scope.ts).
 *
 * So a document is protected twice: sealed for the device it is sent to, and
 * encrypted for the members of the document. The first keeps the relay out of
 * everything; the second is what holds when a device should no longer be able
 * to read — a member removed from a document cannot read what is written after
 * the writer has heard of it, whoever hands it the bytes.
 *
 * automerge-repo's classic sync protocol, which sends documents as plain
 * Automerge messages, still runs inside every Repo. It is given nothing to do:
 * the Repo shares no document with any peer, and the narrowed adapter would not
 * carry a classic message if it tried.
 *
 * (The bridge has a second path that syncs keyhive through a subduction server.
 * This app has no such server; peers sync with each other.)
 */
import { KeyhiveOps } from './keyhive-ops';
import { RELAY_PEER_ID } from './relay-identity';
import { ensureKeyhiveStorageUsable } from './keyhive-format';
import { makeSecureChannelAdapter, type SecureChannelControl, type SecureChannelTimings } from './secure-channel';
import { makeKeyhiveOnlyAdapter } from './keyhive-only-adapter';
import { makeDeviceSigner } from './subduction-signer';
import { makeGuardedInterceptor, type BlobInterceptor } from './subduction-interceptor';
import { makeDocPolicy, type RequiredAccess } from './subduction-policy';
import { startSubductionLinks, type SubductionLinks, type LinkTimings, type LinkedPeer } from './subduction-links';
import { scopeSubductionToMembers, acceptEphemeral, type SubductionScope } from './subduction-scope';
import { guardSubductionStorage, type DocShape } from './subduction-storage-guard';
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
   * Whether a document link with this device (its 32-byte keyhive key) is
   * wanted. Asked before a link is opened or accepted, and again when keyhive's
   * state changes. Default: every peer the relay introduces — document access
   * is still decided per document, by keyhive.
   */
  mayLinkDevice?: (deviceKey: Uint8Array) => Promise<boolean>;
  /** Secure-channel waits (hello retry, reordering), in ms. Shorten only under test. */
  channelTimings?: Partial<SecureChannelTimings>;
  /** Link waits (handshake, retry), in ms. Shorten only under test. */
  linkTimings?: Partial<LinkTimings>;
  /**
   * automerge-repo's `subductionTimeouts` (sync round deadline, heal-retry
   * backoff). Defaults to automerge-repo's own. Shorten only under test: a
   * sync round's deadline timer outlives the round, so a process that has
   * synced with a peer cannot exit until `syncMs` (60 s by default) has passed.
   */
  subductionTimeouts?: Record<string, number>;
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
  /**
   * A handle's heads → Automerge change hashes. `handle.heads()` — which is
   * what every push to the page carries — is automerge-repo's own encoding
   * (base58check), and Automerge itself (`view`, `hasHeads`, `diff`) takes hex.
   * Throws on anything that is not such heads.
   */
  decodeHeads: (heads: string[]) => string[];
  /** Convert keyhive doc-id bytes (== automerge BinaryDocumentId) → automerge doc id string. */
  amDocIdFromBytes: (bytes: Uint8Array) => string;
  /** The inverse: an automerge doc id string → the keyhive DocumentId with the same bytes. */
  khDocIdFromAm: (docId: string) => any;
  /** Slot a pre-generated keyhive doc-id for the next repo.create2() (create-doc flow). */
  setNextDocId: (bytes: Uint8Array) => void;
  /** The secure channel to peer devices: its state, and the reset a reopened relay socket needs. */
  channel: SecureChannelControl;
  /** The document-sync links to peer devices (subduction-links.ts). */
  links: SubductionLinks;
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
  const NetworkAdapter = repoModule.NetworkAdapter;
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

  // ── Document sync: encrypted, authenticated, and nothing else ──────────────
  //
  // The Repo's config is assembled here but the hive it depends on is built by
  // the bridge, inside the call below, and is not returned until after the Repo
  // exists. So the pieces that need the hive take a promise of it.
  let closed = false;
  let resolveHive!: (h: any) => void;
  const hiveReady = new Promise<any>((resolve) => { resolveHive = resolve; });
  const devicePrivateKey: Promise<CryptoKey> = hiveReady.then((h) => h.active.keyPair.privateKey);

  // Every commit is encrypted under the document's keyhive key on its way into
  // subduction's store. The bridge's interceptor is given the RAW keyhive: it
  // queues its own calls, and handing it the serializing proxy would queue them
  // twice (a nested queue call never runs).
  let bridgeInterceptor: any = null;
  let onPendingDecrypt = () => {};
  const interceptor = makeGuardedInterceptor({
    onPendingDecrypt: () => onPendingDecrypt(),
    inner: hiveReady.then((h): BlobInterceptor => {
      bridgeInterceptor = new bridge.KeyhiveBlobInterceptor(
        h.keyhive, h.networkAdapter.keyhiveQueue, () => h.networkAdapter.invalidateCaches(), opts.storage);
      return bridgeInterceptor;
    }),
    docIdBytes: (documentId) => parseAutomergeUrl(`automerge:${documentId}`).binaryDocumentId,
  });

  // A peer is served, and written by, only what keyhive says. A device is
  // admitted through its user's group: accessForDoc follows group membership.
  const hasAccess = (deviceKey: Uint8Array, docIdBytes: Uint8Array, level: RequiredAccess): Promise<boolean> =>
    runOnKeyhiveQueue(async () => {
      const access = await hive.keyhive.accessForDoc(new bridge.Identifier(deviceKey), new bridge.DocumentId(docIdBytes));
      return access !== undefined && access.atLeast(level === 'edit' ? bridge.Power.edit() : bridge.Power.relay());
    });
  const mayLinkDevice = opts.mayLinkDevice ?? (async () => true);
  const policy = makeDocPolicy({ hasAccess, mayConnect: mayLinkDevice });

  // The Repo's view of storage: the same adapter, minus deletes of records its
  // compaction would remove while the document still needs them
  // (subduction-storage-guard.ts). `repoForGuard` is the Repo, once it exists.
  let repoForGuard: any = null;
  const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
  // A document's shape is asked once per delete and a pass deletes many, so it
  // is kept until the document's heads move.
  const shapes = new Map<string, { heads: string; shape: DocShape }>();
  const repoStorage = guardSubductionStorage(opts.storage, {
    shape: (sedimentreeIdHex) => {
      try {
        const handle = repoForGuard?.handles[amDocIdFromBytes(hexToBytes(sedimentreeIdHex))];
        const doc = handle?.doc();
        if (!doc) return undefined;
        const heads = Automerge.getHeads(doc).join(',');
        const known = shapes.get(sedimentreeIdHex);
        if (known?.heads === heads) return known.shape;
        const shape: DocShape = {
          has: (hash) => Automerge.hasHeads(doc, [hash]),
          looseCommits: new Set((Automerge.getFragmentMetadata(doc, 0) as { head: string }[]).map((m) => m.head)),
          fragments: new Set((Automerge.getFragmentMetadata(doc, { start: 1 }) as { head: string }[]).map((m) => m.head)),
        };
        shapes.set(sedimentreeIdHex, { heads, shape });
        return shape;
      } catch {
        return undefined;
      }
    },
  });

  // The secure channel: what the relay/WebRTC adapter carries from here on is
  // sealed for the one device it is addressed to, and a peer is announced above
  // it only once it has proved its key. It signs its handshakes with the
  // device's keyhive key, which the bridge loads (or creates) below.
  const secure = makeSecureChannelAdapter(NetworkAdapter, opts.networkAdapter, {
    relayPeerId: RELAY_PEER_ID,
    privateKey: devicePrivateKey,
    timings: opts.channelTimings,
  });

  // The links are told about peers by the channel, as the bridge is, so they
  // start listening before the Repo connects it; they act once the Repo exists.
  let resolveLinksReady!: (r: { localPeerId: string; subduction: any }) => void;
  let onLinkUp = () => {};
  let onDatagram: (peer: LinkedPeer, payload: Uint8Array) => void = () => {};
  const links = startSubductionLinks({
    channel: secure,
    relayPeerId: RELAY_PEER_ID,
    ready: new Promise((resolve) => { resolveLinksReady = resolve; }),
    mayLink: mayLinkDevice,
    onLinkUp: () => onLinkUp(),
    onDatagram: (peer, payload) => onDatagram(peer, payload),
    timings: opts.linkTimings,
  });

  // The bridge builds the hive and the Repo together: it injects the hive's
  // network adapter (the channel, narrowed to keyhive's messages and wrapped so
  // they are also signed and verified) and peerId into the config it hands `createRepo`,
  // then links the two so keyhive membership changes reach
  // `repo.shareConfigChanged()`.
  const built = await bridge.initializeLegacyAutomergeRepoKeyhive({
    storage: opts.storage,
    peerIdSuffix: opts.peerIdSuffix,
    networkAdapter: makeKeyhiveOnlyAdapter(NetworkAdapter, secure),
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
      storage: repoStorage,
      // Classic sync shares no document with any peer — see the file header.
      shareConfig: { announce: async () => false, access: async () => false },
      subductionBlobInterceptor: interceptor,
      subductionPolicy: policy,
      ...(opts.subductionTimeouts ? { subductionTimeouts: opts.subductionTimeouts } : {}),
    },
    // The Repo signs subduction's handshake and commits as this device's
    // keyhive key, so the key a peer proves is the one keyhive knows it by.
    createRepo: (config: any) => new Repo({ ...config, idFactory, signer: makeDeviceSigner(config.peerId, devicePrivateKey) }),
  });
  hive = built.hive;
  const repo = built.repo;
  repoForGuard = repo;
  const integration = hive;
  resolveHive(hive);

  // Subduction logs through its own tracing stack, straight to the console, and
  // the Repo sets it to `warn` when it is constructed. Its warnings are routine
  // here — a connection closing, a commit refused because this device's keyhive
  // has not caught up with a membership change yet — so they show only when our
  // own logging is at debug. The links report what matters (up, down, why).
  try { repoModule.setSubductionLogLevel?.(log.enabled('debug') ? 'warn' : 'error'); }
  catch { /* tracing not initialised: nothing to set */ }

  // Subduction's document source only tracks connections it opened itself, so
  // a link made here goes unnoticed: documents already open would not sync with
  // the new peer. Tell the Repo — once, however many links come up together.
  let nudgeTimer: any = null;
  const nudgeDocSync = () => {
    if (nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      try {
        repo.shareConfigChanged();
        for (const documentId of Object.keys(repo.handles)) repo.resyncSubduction(documentId);
      } catch (err) { log.warn('re-syncing documents after a link came up failed:', err); }
    }, 20);
    if (typeof nudgeTimer?.unref === 'function') nudgeTimer.unref();
  };
  onLinkUp = nudgeDocSync;

  let scope: SubductionScope | null = null;

  // Presence arrives as a link datagram (subduction-scope.ts) and is handed to
  // the Repo only when it is what the link proved it to be.
  const docIdBytesOf = (documentId: string): Uint8Array => parseAutomergeUrl(`automerge:${documentId}`).binaryDocumentId;
  onDatagram = (peer, payload) => {
    void acceptEphemeral(peer, payload, {
      policy,
      isOpen: (documentId) => documentId in repo.handles,
      docIdBytes: docIdBytesOf,
      deliver: (message) => repo.synchronizer.receiveMessage(message),
    }).catch((err) => log.warn('handling a presence message failed:', err));
  };

  void (repo.subduction as Promise<any>).then((subduction) => {
    // Before any link exists: from the first sync on, a document is only ever
    // offered to the peers that are in it.
    scope = scopeSubductionToMembers(subduction, {
      links,
      policy,
      onRecovered: (docIdBytes) => {
        try { repo.resyncSubduction(amDocIdFromBytes(docIdBytes)); }
        catch (err) { log.warn('re-syncing a document after its sync recovered failed:', err); }
      },
    });
    resolveLinksReady({ localPeerId: repo.peerId, subduction });
  });

  // A commit can arrive before the key that opens it: a member's first write,
  // or any write after a membership change, starts a new key epoch whose
  // operation travels by keyhive sync, separately. The Repo keeps such a commit
  // and retries it when told the share config changed — which the keyhive-change
  // hook below does. But that signal can fire in the instant between the key
  // landing and the commit being recorded as unreadable, and then nothing fires
  // again: the document sits unreadable with its key in hand (seen in testing).
  // So an unreadable commit also starts a short, bounded series of retries, each
  // asking peers for keyhive state first.
  const DECRYPT_RETRY_MS = [300, 700, 1500, 3000, 5000, 10_000, 20_000, 30_000];
  let decryptRetryTimer: any = null;
  let decryptRetryAttempt = 0;
  const scheduleDecryptRetry = () => {
    if (decryptRetryTimer || closed || decryptRetryAttempt >= DECRYPT_RETRY_MS.length) return;
    const delay = DECRYPT_RETRY_MS[decryptRetryAttempt] * (0.75 + Math.random() * 0.5);
    decryptRetryTimer = setTimeout(() => {
      decryptRetryTimer = null;
      if (closed || !interceptor.hasPendingDecrypts()) { decryptRetryAttempt = 0; return; }
      decryptRetryAttempt++;
      try {
        void hive.networkAdapter.syncKeyhive?.();
        repo.shareConfigChanged();
      } catch (err) { log.warn('retrying pending decrypts failed:', err); }
      scheduleDecryptRetry();
    }, delay);
    if (typeof decryptRetryTimer?.unref === 'function') decryptRetryTimer.unref();
  };
  onPendingDecrypt = () => { decryptRetryAttempt = 0; scheduleDecryptRetry(); };

  // Keyhive learned something (a membership change, a key). Cached policy
  // answers may be stale, a refused link may now be wanted, and a commit that
  // arrived before its key may now decrypt. The bridge tells the Repo itself,
  // but after a 2 s debounce shared with heavier work; a waiting document
  // should not sit unreadable that long.
  let keyhiveChangedTimer: any = null;
  const onKeyhiveChanged = () => {
    policy.invalidate();
    if (keyhiveChangedTimer) return;
    keyhiveChangedTimer = setTimeout(() => {
      keyhiveChangedTimer = null;
      links.reevaluate();
      if (interceptor.hasPendingDecrypts()) {
        try { repo.shareConfigChanged(); } catch (err) { log.warn('retrying pending decrypts failed:', err); }
        decryptRetryAttempt = 0;
        scheduleDecryptRetry();
      }
    }, 100);
    if (typeof keyhiveChangedTimer?.unref === 'function') keyhiveChangedTimer.unref();
  };
  hive.networkAdapter.on('ingest-remote', onKeyhiveChanged);
  (hive as any).emitter?.on?.('update', onKeyhiveChanged);

  // Serialize ALL keyhive access through the bridge's shared queue: keyhive WASM
  // is not reentrant, and the document interceptor and policy above run on that
  // queue at any moment a peer syncs.
  const khForOps = serializeKeyhive(integration.keyhive);
  const khOps = new KeyhiveOps(khForOps, bridge, {
    persist: () => integration.keyhiveStorage.saveKeyhiveWithHash(khForOps),
    syncKeyhive: () => integration.networkAdapter?.syncKeyhive?.(),
    // After a local keyhive membership change: forget cached access answers,
    // and have the Repo retry documents that did not sync or decrypt before.
    forceResyncAllPeers: () => { policy.invalidate(); repo.shareConfigChanged(); },
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
  let flushArchive = async () => {};
  {
    const emitter = (integration as any).emitter;
    let timer: any = null;
    let saving = false;
    let dirty = false;
    // saveKeyhiveWithHash's internal toArchive() is queued by the serializing
    // proxy itself — so the save must NOT be queued as well (nested queue.run
    // deadlocks).
    const doSave = () => integration.keyhiveStorage.saveKeyhiveWithHash(khForOps);
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
    // On close, a save that was still waiting out its debounce happens now: the
    // leaf secret it carries would otherwise be lost with the process.
    flushArchive = async () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      await persistArchive();
    };
  }

  const close = async () => {
    if (closed) return;
    closed = true;
    await flushArchive();
    if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
    if (keyhiveChangedTimer) { clearTimeout(keyhiveChangedTimer); keyhiveChangedTimer = null; }
    if (decryptRetryTimer) { clearTimeout(decryptRetryTimer); decryptRetryTimer = null; }
    scope?.stop();
    try { await links.stop(); } catch (err) { log.warn('stopping the document links failed:', err); }
    try { await secure.channel.stop(); } catch (err) { log.warn('stopping the secure channel failed:', err); }
    try { bridgeInterceptor?.clearCachedKeyMaterial?.(); } catch { /* best effort */ }
    // The hive first: closing it disconnects the network adapter, so nothing
    // arrives while the Repo below flushes and releases storage.
    try { hive.close(); } catch (err) { log.warn('closing the hive failed:', err); }
    try { await repo.shutdown(); } catch (err) { log.warn('shutting the repo down failed:', err); }
  };

  return {
    decodeHeads: (heads: string[]) => repoModule.decodeHeads(heads),
    repo, khOps, integration, bridge,
    Automerge, Presence, amDocIdFromBytes, khDocIdFromAm, setNextDocId, channel: secure.channel, links, close,
  };
}
