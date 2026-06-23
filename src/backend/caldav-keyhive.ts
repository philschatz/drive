/**
 * Server-side keyhive initialization for CalDAV.
 *
 * Initializes a keyhive-enabled Automerge Repo that connects to the relay
 * running in the same process via a localhost WebSocket. The server becomes
 * a proper keyhive participant and can be invited to access documents.
 *
 * Keyhive types are imported from the lib bridge (which re-exports them)
 * to avoid direct `@keyhive/keyhive/slim` imports that don't resolve under
 * the backend tsconfig's moduleResolution.
 */
import { Repo } from '@automerge/automerge-repo';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import {
  KeyhiveOps,
  type KeyhiveBridge,
} from '../client/keyhive-ops';

const noopSubduction = {
  storage: {},
  removeSedimentree() {},
  connectDiscover() {},
  disconnectAll() {},
  disconnectFromPeer() {},
  syncAll() { return Promise.resolve({ entries() { return []; } }); },
  getBlobs() { return Promise.resolve([]); },
  addCommit() { return Promise.resolve(undefined); },
  addFragment() { return Promise.resolve(undefined); },
};

export interface CaldavKeyhive {
  repo: Repo;
  khOps: KeyhiveOps;
  integration: any; // AutomergeRepoKeyhive
}

/**
 * Initialize a keyhive-enabled Repo for CalDAV.
 * Must be called after the HTTP server + relay are listening.
 *
 * Uses dynamic import for the keyhive bridge to avoid module resolution
 * issues with the backend tsconfig.
 */
export async function initCaldavKeyhive(
  dataDir: string,
  wsUrl: string,
): Promise<CaldavKeyhive> {
  // Dynamic import — the lib re-exports all keyhive types.
  // Cast to `any` because the `export * from "@keyhive/keyhive/slim"` re-export
  // doesn't resolve under the backend's moduleResolution setting, but the values
  // are present at runtime. The KeyhiveBridge interface provides type safety.
  // Initialize subduction WASM (required by Repo constructor).
  // Repo.js (ESM) imports FragmentStateStore from a nested copy of
  // automerge-subduction. We must initialize that exact copy's WASM.
  const { createRequire } = await import('module');
  const repoRequire = createRequire(require.resolve('@automerge/automerge-repo'));
  const nestedSubductionCjs = repoRequire.resolve('@automerge/automerge-subduction');
  const nestedSubductionEsm = nestedSubductionCjs.replace('/dist/cjs/node.cjs', '/dist/esm/node.js');
  const subductionModule = await import(nestedSubductionEsm);
  const { setSubductionModule } = await import('@automerge/automerge-repo');
  setSubductionModule(subductionModule);

  const khBridge: any = await import('../lib/automerge-repo-keyhive/index');
  khBridge.initKeyhiveWasm();

  const storageAdapter = new NodeFSStorageAdapter(dataDir);
  const wsAdapter = new WebSocketClientAdapter(wsUrl);

  const integration = await khBridge.initializeAutomergeRepoKeyhive({
    storage: storageAdapter,
    peerIdSuffix: 'caldav-server',
    networkAdapter: wsAdapter,
    onlyShareWithHardcodedServerPeerId: false,
    periodicallyRequestSync: true,
    automaticArchiveIngestion: true,
    cacheHashes: false,
    syncRequestInterval: 2000,
  });

  const repo = new Repo({
    network: [integration.networkAdapter],
    storage: storageAdapter,
    subduction: noopSubduction,
    peerId: integration.peerId,
  } as any);

  integration.linkRepo(repo);

  const bridge: KeyhiveBridge = {
    ChangeId: khBridge.ChangeId as any,
    DocumentId: khBridge.DocumentId as any,
    Identifier: khBridge.Identifier as any,
    GroupId: { fromBytes: (bytes: Uint8Array) => (khBridge as any).GroupId.fromBytes(bytes) },
    Signer: { memorySignerFromBytes: (bytes: Uint8Array) => khBridge.Signer.memorySignerFromBytes(bytes) },
    CiphertextStore: { newInMemory: () => khBridge.CiphertextStore.newInMemory() },
    Keyhive: { init: (signer: any, store: any, cb: () => void) => khBridge.Keyhive.init(signer, store, cb) },
    Access: { tryFromString: (s: string) => khBridge.Access.tryFromString(s) },
    ContactCard: { fromJson: (json: string) => khBridge.ContactCard.fromJson(json) },
  };

  // The CalDAV server participates as a single device (Individual); it does not form
  // a multi-device user group, so the user-group side-effects are no-ops.
  let serverUserGroupId: string | null = null;
  const khOps = new KeyhiveOps(integration.keyhive, bridge, {
    persist: () => integration.keyhiveStorage.saveKeyhiveWithHash(integration.keyhive),
    syncKeyhive: () => integration.networkAdapter.syncKeyhive(),
    registerDoc: (amDocId: string, khDocId: any) => integration.networkAdapter.registerDoc(amDocId, khDocId),
    forceResyncAllPeers: () => (integration.networkAdapter as any).forceResyncAllPeers(),
    findDoc: (docId: string) => repo.find(docId as any),
    saveEventBytes: (eventBytes: Uint8Array) => integration.keyhiveStorage.saveEventBytesWithHash(eventBytes),
    getUserGroupId: async () => serverUserGroupId,
    setUserGroupId: async (groupId: string) => { serverUserGroupId = groupId; },
  });

  console.log('[caldav-keyhive] initialized, peerId:', integration.peerId);

  return { repo, khOps, integration };
}
