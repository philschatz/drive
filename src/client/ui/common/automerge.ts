// Thin re-export facade — new code should import from '../worker-api' directly.
export type { Presence, DocHandle, DocumentId, PeerId, PeerState, PresenceState } from '@automerge/automerge-repo';
export { workerReady, keyhiveReady, useConnectionStatus, useWsStatus, whenWsConnected, usePeerList, usePeerTransports, getWorkerPeerId } from '../worker-api';
