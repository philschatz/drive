/**
 * Shared keyhive-enabled Automerge Repo construction.
 *
 * Factors out the near-identical init that used to be duplicated in the browser
 * worker (automerge-worker.ts) and the CalDAV server (caldav-keyhive.ts):
 * subduction WASM init, keyhive WASM init, initializeAutomergeRepoKeyhive, the
 * Repo (with optional shareConfig/idFactory), linkRepo, and the KeyhiveOps
 * side-effects. The caller injects the storage adapter, the network adapter, the
 * peerId suffix, and how the user-group id persists.
 *
 * The keyhive bridge is imported dynamically and cast to `any`: its
 * `export * from "@keyhive/keyhive/slim"` re-export doesn't resolve under the
 * backend tsconfig's moduleResolution, but every value is present at runtime.
 */
import { KeyhiveOps } from './keyhive-ops';
import { RELAY_PEER_ID } from './relay-identity';

export interface CreateKeyhiveRepoOptions {
  /** automerge-repo StorageAdapter (IndexedDB in the browser, NodeFS in Node). */
  storage: any;
  /** automerge-repo NetworkAdapter (already wrapped for WebRTC in the browser). */
  networkAdapter: any;
  /** peerId suffix — a FIXED per-service instance id ('drive', 'caldav-server'),
   * NOT identity (identity is the verifying key; the wire strips the suffix).
   * Never make it per-tab/per-instance (`drive.<nonce>`): sibling workers of one
   * device panic keyhive WASM on their first presence encrypt (beekem
   * new_app_secret_for), and the relay's duplicate-join rejection is what keeps
   * extra tabs offline under a fixed suffix. */
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
  /** Slot a pre-generated keyhive doc-id for the next repo.create2() (create-doc flow). */
  setNextDocId: (bytes: Uint8Array) => void;
}

/**
 * Shadow `forcePcsUpdate` on a keyhive WASM instance with a no-op.
 *
 * The npm bridge's membership nudge calls `this.keyhive.forcePcsUpdate(doc)` after
 * our agent adds a member. Under the pinned keyhive (alpha.58) that rotation is
 * invisible outside the WASM: `Document::pcs_update` does NOT emit the op via the
 * event listener (unlike the update minted inside `try_encrypt_content`), and the
 * binding resolves `void` (so the bridge's `saveLeafSecret(undefined)` persists an
 * empty blob instead of the rotated leaf secret — a version skew; newer keyhive
 * returns the secret). The op itself still syncs (peer delivery is state-derived),
 * but the un-emitted rotation bypasses the persist-archive-on-event hook below,
 * leaving its new leaf SECRET in WASM memory only. A worker reload then restores
 * an instance that can no longer derive its own current epoch: every encrypt
 * fails "SecretKey not found" and every peer ciphertext "Key not found", forever
 * — the cross-browser presence outage.
 *
 * No-op'ing it is safe AND preserves the nudge's goal: after an add,
 * `has_pcs_key()` is false, so the very next `tryEncrypt` (the nudge's own
 * `_lastAddMember` edit, or the next presence flush) mints the rotation via
 * `try_encrypt_content` — which IS emitted, so it reaches storage, sync, AND the
 * archive-persist hook.
 *
 * Own-property assignment shadows the wasm prototype method, so the bridge's own
 * reference hits the no-op too (the serializing Proxy below only wraps drive's
 * handle). Remove this once keyhive emits pcs_update ops — the characterization
 * test in keyhive-ops.test.ts ("forcePcsUpdate mints a CGKA op WITHOUT emitting
 * it") starts failing when that day comes.
 */
export function neutralizeForcePcsUpdate(kh: any): void {
  kh.forcePcsUpdate = async () => {};
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
            console.log('[keyhive] →', method);
            onCall(method);
            return Promise.resolve(val.apply(target, args)).then(
              (result: unknown) => { onCall(null); return result; },
              (err: unknown) => { console.warn('[keyhive] ✗', method, err); throw err; },
            );
          });
      },
    });
}

export async function createKeyhiveRepo(opts: CreateKeyhiveRepoOptions): Promise<KeyhiveRepo> {
  // Importing the non-`/slim` automerge-subduction entry initializes the subduction
  // WASM as a side effect (the `/slim` entry the Repo uses shares the instance).
  // Must run before new Repo().
  await import('@automerge/automerge-subduction');
  const repoModule: any = await import('@automerge/automerge-repo');
  const Repo = repoModule.Repo;
  const Presence = repoModule.Presence;
  const stringifyAutomergeUrl = repoModule.stringifyAutomergeUrl;
  const parseAutomergeUrl = repoModule.parseAutomergeUrl;
  // Keyhive doc-id bytes are the automerge BinaryDocumentId; stringify+parse is the
  // build-portable inverse of docIdFromAutomergeUrl.
  const amDocIdFromBytes = (bytes: Uint8Array) =>
    parseAutomergeUrl(stringifyAutomergeUrl(bytes)).documentId;

  const Automerge = await import('@automerge/automerge');
  const bridge: any = await import('@automerge/automerge-repo-keyhive');
  bridge.initKeyhiveWasm();

  const integration = await bridge.initializeAutomergeRepoKeyhive({
    storage: opts.storage,
    peerIdSuffix: opts.peerIdSuffix,
    networkAdapter: opts.networkAdapter,
    onlyShareWithHardcodedServerPeerId: false,
    periodicallyRequestSync: true,
    automaticArchiveIngestion: true,
    cachingMode: 'none',
    syncRequestInterval: opts.syncRequestInterval ?? 2000,
  });

  // The bridge's membership nudge would call this on the instance it holds —
  // see neutralizeForcePcsUpdate's doc comment for why that must never happen
  // under the pinned keyhive version.
  neutralizeForcePcsUpdate(integration.keyhive);

  /**
   * Run a keyhive WASM operation on the bridge's shared serialization queue. ALL
   * keyhive access (blob encryption, signing, sync) goes through this single
   * PromiseQueue; calling keyhive concurrently/reentrantly traps the WASM. Never
   * nest these calls (serial queue → deadlock).
   */
  const runOnKeyhiveQueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const queue = (integration as any)?.networkAdapter?.keyhiveQueue;
    return queue ? queue.run(fn) : fn();
  };
  const serializeKeyhive = makeSerializeKeyhive(runOnKeyhiveQueue, opts.onKeyhiveCall);

  // Slot for pre-generated keyhive doc IDs. enableSharing creates the keyhive doc
  // first, sets nextDocIdBytes, then create2() consumes it so the automerge doc ID
  // == keyhive doc ID.
  let nextDocIdBytes: Uint8Array | null = null;
  const setNextDocId = (bytes: Uint8Array) => { nextDocIdBytes = bytes; };

  // shareConfig gates which docs are announced to which peers based on keyhive
  // membership. A doc a peer has no keyhive access to is not announced/shared.
  const khAccessCheck = async (peerId: string, docId: string | undefined): Promise<boolean> => {
    if (!docId) return false;
    // The relay is a router, not a keyhive member — never announce docs to it.
    if (peerId === RELAY_PEER_ID) return false;
    try {
      // peerId is "<base64 verifying key>-<suffix>"; recover the Identifier.
      const keyB64 = bridge.verifyingKeyPeerIdWithoutSuffix(peerId as any);
      const keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
      const identifier = new bridge.Identifier(keyBytes);
      // shareConfig is consulted off the keyhive queue (during sync-message handling),
      // so serialize this keyhive access too.
      const access = await runOnKeyhiveQueue(() =>
        integration.bestAccessForDoc(identifier, `automerge:${docId}` as any));
      return access !== undefined;
    } catch {
      return false;
    }
  };

  const repoConfig: any = {
    // Local-only callers (e.g. the CLI's read commands) pass no networkAdapter;
    // build the repo with an empty network so nothing ever dials the relay.
    network: opts.networkAdapter ? [integration.networkAdapter] : [],
    storage: opts.storage,
    peerId: integration.peerId,
    idFactory: async () => {
      if (!nextDocIdBytes) throw new Error('nextDocIdBytes not set before create2');
      const bytes = nextDocIdBytes;
      nextDocIdBytes = null;
      return bytes;
    },
  };
  if (opts.withShareConfig) {
    repoConfig.shareConfig = {
      announce: khAccessCheck,
      access: khAccessCheck as (peer: string, doc: string) => Promise<boolean>,
    };
  }
  const repo = new Repo(repoConfig);

  // Only pass a share-config callback when the caller wants one (CalDAV links the
  // repo with no options, exactly as before).
  if (opts.onBeforeShareConfigChanged) {
    integration.linkRepo(repo, { onBeforeShareConfigChanged: opts.onBeforeShareConfigChanged });
  } else {
    integration.linkRepo(repo);
  }

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

  // Persist the full keyhive archive (debounced) after every keyhive event.
  //
  // Under the pinned keyhive (alpha.58) a locally-minted CGKA update op — e.g.
  // the leaf rotation minted by the first tryEncrypt after a membership change —
  // keeps its new leaf SECRET in WASM memory only: the op itself is emitted,
  // persisted, and synced, but the secret is not (newer keyhive returns it for
  // the bridge's saveLeafSecret pipeline; alpha.58 returns void). The archive
  // snapshot is the only place that secret survives, and without this hook it is
  // only written on explicit KeyhiveOps actions (membership, contacts) — never
  // after an encrypt-minted rotation. A worker reload in that window restores an
  // instance that HAS every op but can no longer derive any epoch at-or-after
  // its own rotation, so every peer ciphertext fails with "Key not found"
  // forever (the cross-browser presence outage; presence-liveness step 2b).
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
      catch (err) { console.warn('[keyhive-repo] archive persist after keyhive event failed:', err); }
      finally {
        saving = false;
        if (dirty) { dirty = false; void persistArchive(); }
      }
    };
    emitter?.on?.('update', () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; void persistArchive(); }, 1000);
    });
  }

  return {
    repo, khOps, integration, bridge,
    Automerge, Presence, amDocIdFromBytes, setNextDocId,
  };
}
