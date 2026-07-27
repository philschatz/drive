/**
 * Server-side keyhive initialization for CalDAV.
 *
 * Initializes a keyhive-enabled Automerge Repo that connects to the relay
 * running in the same process via a localhost WebSocket. The server becomes
 * a proper keyhive participant and can be invited to access documents.
 *
 * The repo/keyhive wiring is shared with the browser worker and the CLI via
 * createKeyhiveRepo() (src/shared/keyhive-repo.ts). The CalDAV server participates
 * as a single device (Individual); it does not form a multi-device user group, so
 * the user-group side-effects are in-memory no-ops, and it runs without keyhive
 * serialization or shareConfig gating (unchanged from before the refactor).
 */
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { NodeFSStorageAdapter } from '@automerge/automerge-repo-storage-nodefs';
import { KeyhiveOps } from '../shared/keyhive-ops';
import { createKeyhiveRepo } from '../shared/keyhive-repo';
import { ensureKeyhiveNodeShim, initSubductionNode } from './keyhive-node-shim';

export interface CaldavKeyhive {
  repo: any;
  khOps: KeyhiveOps;
  integration: any; // AutomergeRepoKeyhive
}

/**
 * Initialize a keyhive-enabled Repo for CalDAV.
 * Must be called after the HTTP server + relay are listening.
 */
export async function initCaldavKeyhive(
  dataDir: string,
  wsUrl: string,
): Promise<CaldavKeyhive> {
  // Patch the keyhive slim build + initialize subduction WASM for Node, both
  // before the bridge is imported / the Repo is created.
  ensureKeyhiveNodeShim();
  await initSubductionNode();

  const storageAdapter = new NodeFSStorageAdapter(dataDir);
  const wsAdapter = new WebSocketClientAdapter(wsUrl);

  let serverUserGroupId: string | null = null;
  const { repo, khOps, integration } = await createKeyhiveRepo({
    storage: storageAdapter,
    networkAdapter: wsAdapter,
    peerIdSuffix: 'caldav-server',
    getUserGroupId: async () => serverUserGroupId,
    setUserGroupId: async (groupId: string) => { serverUserGroupId = groupId; },
  });

  console.log('[caldav-keyhive] initialized, peerId:', integration.peerId);

  return { repo, khOps, integration };
}
