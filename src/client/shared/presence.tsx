import { subscribePresence, setPresence, usePeerTransports } from '../worker-api';
import type { PeerState } from './automerge';
import { getContactName } from '../contact-names';

const PEER_COLORS = [
  '#e91e63', '#9c27b0', '#673ab7', '#3f51b5',
  '#009688', '#ff9800', '#795548', '#607d8b',
];

export interface PresenceState {
  viewing: boolean;
  focusedField: (string | number)[] | null;
}

export function peerDisplayName(peerId: string): string {
  const agentId = peerId.split('-')[0];
  return getContactName(agentId) || `${agentId.slice(0, 8)}…`;
}

export function peerColor(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
}

export function initPresence<S extends Record<string, any>>(
  docId: string,
  getInitialState: () => S,
  onPeersChange: (states: Record<string, PeerState<S>>) => void,
): { broadcast: (key: keyof S, value: S[keyof S]) => void; cleanup: () => void } {
  const cleanup = subscribePresence(docId, onPeersChange as any);

  // Broadcast initial state
  setPresence(docId, getInitialState() as any);

  const broadcast = (key: keyof S, value: S[keyof S]) => {
    setPresence(docId, { [key]: value } as any);
  };

  return { broadcast, cleanup };
}


export interface PeerFieldInfo {
  color: string;
  peerId: string;
}

/**
 * A peer indicator dot. A FILLED dot means a direct WebRTC (peer-to-peer)
 * channel is open to that peer; a HOLLOW ring means the peer is reachable only
 * through the relay server. Hollow is the default so a relayed connection is
 * never mistaken for a direct one. The transport is also named in the tooltip.
 */
export function PeerDot({ peerId, direct, label, sizeClass = 'w-2 h-2' }: {
  peerId: string;
  direct: boolean;
  /** Base tooltip text; the transport ("direct"/"via relay") is appended. */
  label?: string;
  /** Tailwind size classes for the dot (default 8px). */
  sizeClass?: string;
}) {
  const color = peerColor(peerId);
  const base = label ?? peerDisplayName(peerId);
  return (
    <span
      className={`${sizeClass} rounded-full inline-block shrink-0`}
      style={{
        boxSizing: 'border-box',
        backgroundColor: direct ? color : 'transparent',
        border: direct ? 'none' : `2px solid ${color}`,
      }}
      title={`${base} — ${direct ? 'direct (P2P)' : 'via relay'}`}
    />
  );
}

export function PresenceDot({ fieldId, peerFocusedFields }: {
  fieldId: string;
  peerFocusedFields?: Record<string, PeerFieldInfo>;
}) {
  const transports = usePeerTransports();
  const info = peerFocusedFields?.[fieldId];
  if (!info) return null;
  return (
    <PeerDot
      peerId={info.peerId}
      direct={transports[info.peerId] === 'direct'}
      label={`${peerDisplayName(info.peerId)} is editing`}
    />
  );
}
