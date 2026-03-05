import { Presence, useConnectionStatus, repo } from './automerge';
import type { DocHandle, PeerState } from './automerge';

const PEER_COLORS = [
  '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
  '#009688', '#ff9800', '#795548', '#607d8b',
];

export interface PresenceState {
  viewing: boolean;
  focusedField: (string | number)[] | null;
}

export function peerColor(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
}

export function initPresence<S extends Record<string, any>>(
  handle: DocHandle<any>,
  getInitialState: () => S,
  onPeersChange: (states: Record<string, PeerState<S>>) => void,
): { presence: Presence<S, any>; cleanup: () => void } {
  const presence = new Presence<S, any>({ handle });
  // Track the last broadcast state so visibility restores preserve it
  const lastState = { current: getInitialState() };
  const origBroadcast = presence.broadcast.bind(presence);
  (presence as any).broadcast = (key: keyof S, value: S[keyof S]) => {
    lastState.current = { ...lastState.current, [key]: value };
    return origBroadcast(key, value);
  };

  presence.start({
    initialState: lastState.current,
    heartbeatMs: 5000,
    peerTtlMs: 15000,
  });

  const update = () => onPeersChange({ ...presence.getPeerStates().getStates() });
  presence.on('update', update);
  presence.on('goodbye', update);
  presence.on('pruning', update);
  presence.on('snapshot', update);

  const onVisibility = () => {
    if (document.hidden) {
      presence.stop();
    } else {
      presence.start({ initialState: lastState.current });
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    presence,
    cleanup() {
      presence.stop();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

export function PresenceBar<P extends { peerId: string }>({ peers, peerTitle }: {
  peers: P[];
  peerTitle?: (peer: P) => string;
}) {
  const connected = useConnectionStatus();
  return (
    <div className="flex items-center gap-1 mb-2">
      <div
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: connected ? '#4caf50' : '#f44336' }}
        title={connected ? `Connected to server\nMy peer ID: ${repo.peerId}` : 'Disconnected from server'}
      />
      {peers.length > 0 ? (
        <>
          {peers.map(peer => (
            <div
              key={peer.peerId}
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: peerColor(peer.peerId) }}
              title={peerTitle ? peerTitle(peer) : `Peer ${peer.peerId.slice(0, 8)}`}
            />
          ))}
          <span className="text-xs text-muted-foreground ml-0.5">
            {peers.length} other{peers.length !== 1 ? 's' : ''} online
          </span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground ml-0.5">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      )}
    </div>
  );
}

export interface PeerFieldInfo {
  color: string;
  peerId: string;
}

export function PresenceDot({ fieldId, peerFocusedFields }: {
  fieldId: string;
  peerFocusedFields?: Record<string, PeerFieldInfo>;
}) {
  const info = peerFocusedFields?.[fieldId];
  if (!info) return null;
  return (
    <div
      className="w-2 h-2 rounded-full shrink-0 inline-block"
      style={{ backgroundColor: info.color }}
      title={`Peer ${info.peerId.slice(0, 8)} is editing`}
    />
  );
}
