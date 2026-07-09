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
import { KeyhiveOps } from '../client/keyhive-ops';
import { RELAY_PEER_ID } from './relay-identity';

export interface CreateKeyhiveRepoOptions {
  /** automerge-repo StorageAdapter (IndexedDB in the browser, NodeFS in Node). */
  storage: any;
  /** automerge-repo NetworkAdapter (already wrapped for WebRTC in the browser). */
  networkAdapter: any;
  /** peerId suffix — MUST be 'drive' for the app/CLI so peer identity is consistent. */
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
  /** Run a keyhive op on the bridge's shared serialization queue. */
  runOnKeyhiveQueue: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Slot a pre-generated keyhive doc-id for the next repo.create2() (create-doc flow). */
  setNextDocId: (bytes: Uint8Array) => void;
}

/**
 * Wrap a keyhive instance so EVERY method call is serialized on the shared queue.
 * keyhive WASM is not reentrant: if one keyhive method is suspended at an await and
 * another runs, it traps. Synchronous getters/properties pass through untouched.
 */
function makeSerializeKeyhive(runOnKeyhiveQueue: <T>(fn: () => Promise<T>) => Promise<T>) {
  return (realKh: any): any =>
    new Proxy(realKh, {
      get(target, prop) {
        const val = (target as any)[prop];
        if (typeof val !== 'function') return val;
        return (...args: any[]) => runOnKeyhiveQueue(() => Promise.resolve(val.apply(target, args)));
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
    syncRequestInterval: 2000,
  });

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
  const serializeKeyhive = makeSerializeKeyhive(runOnKeyhiveQueue);

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
    network: [integration.networkAdapter],
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
    syncKeyhive: () => integration.networkAdapter.syncKeyhive(),
    // The official bridge derives the keyhive DocumentId from the automerge doc id
    // directly, so there is no explicit doc registration step.
    registerDoc: () => { },
    // After a local keyhive membership change, re-evaluate shareConfig so newly-
    // authorized peers get the doc announced (shareConfigChanged is the equivalent
    // of the old forceResync).
    forceResyncAllPeers: () => repo.shareConfigChanged(),
    findDoc: (docId: string) => repo.find(docId as any),
    saveEventBytes: (eventBytes: Uint8Array) => integration.keyhiveStorage.saveEventBytesWithHash(eventBytes),
    getUserGroupId: opts.getUserGroupId,
    setUserGroupId: opts.setUserGroupId,
  });

  return {
    repo, khOps, integration, bridge,
    Automerge, Presence, amDocIdFromBytes, runOnKeyhiveQueue, setNextDocId,
  };
}
