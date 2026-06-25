/**
 * Server-side keyhive initialization for CalDAV.
 *
 * Initializes a keyhive-enabled Automerge Repo that connects to the relay
 * running in the same process via a localhost WebSocket. The server becomes
 * a proper keyhive participant and can be invited to access documents.
 *
 * Keyhive types are imported from the @automerge/automerge-repo-keyhive
 * package (which re-exports them) to avoid direct `@keyhive/keyhive/slim`
 * imports that don't resolve under the backend tsconfig's moduleResolution.
 */
import { Repo } from '@automerge/automerge-repo';
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import {
  KeyhiveOps,
  type KeyhiveBridge,
} from '../client/keyhive-ops';

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
  // Dynamic import — the package re-exports all keyhive types.
  // Cast to `any` because the `export * from "@keyhive/keyhive/slim"` re-export
  // doesn't resolve under the backend's moduleResolution setting, but the values
  // are present at runtime. The KeyhiveBridge interface provides type safety.
  // automerge-repo (subduction.37) builds Subduction internally, but its
  // constructor calls into the subduction WASM. setSubductionModule is gone;
  // importing the non-`/slim` automerge-subduction entry initializes the WASM
  // as a side effect (the `/slim` entry the Repo uses shares the instance).
  // Must run before new Repo().
  await import('@automerge/automerge-subduction');

  const khBridge: any = await import('@automerge/automerge-repo-keyhive');
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
    cachingMode: 'none',
    syncRequestInterval: 2000,
  });

  const repo = new Repo({
    network: [integration.networkAdapter],
    storage: storageAdapter,
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
    // Official bridge derives the keyhive DocumentId from the automerge doc id;
    // no explicit registration. Resync = re-evaluate shareConfig.
    registerDoc: () => {},
    forceResyncAllPeers: () => repo.shareConfigChanged(),
    findDoc: (docId: string) => repo.find(docId as any),
    saveEventBytes: (eventBytes: Uint8Array) => integration.keyhiveStorage.saveEventBytesWithHash(eventBytes),
    getUserGroupId: async () => serverUserGroupId,
    setUserGroupId: async (groupId: string) => { serverUserGroupId = groupId; },
  });

  console.log('[caldav-keyhive] initialized, peerId:', integration.peerId);

  return { repo, khOps, integration };
}
