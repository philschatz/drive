/**
 * The peer dot — the one indicator for "who is here, and how".
 *
 * There is deliberately only one of these, used by every surface that shows a
 * person or a device: in-document presence, the connection icon, the connection
 * sheet, the sharing panel, Friends, and the device list.
 *
 * Colour identifies *who* — a deterministic palette slot for the identity key,
 * so one person is one colour on every screen they appear on. Fill identifies
 * *reachability*: FILLED for a direct WebRTC (P2P) channel, a HOLLOW ring for
 * relay-only — hollow is the default so a relayed connection is never mistaken
 * for a direct one — and a muted grey dot for offline. The transport is also
 * named in the tooltip.
 *
 * `identityKey` is what makes the colour agree across screens: pass a user-group
 * id wherever one is known (a person, across all their devices) and a device
 * agentId otherwise. `peerIdentityKey` derives it from a presence peer; the
 * keyhive member/friend lists already hold it as `agentId`.
 */

import { usePeerTransports } from '../worker-api';
import { colorForKey, displayNameForKey, peerDisplayName, peerIdentityKey, type PeerFieldInfo } from './presence';

export function PeerDot({ identityKey, online = true, direct = false, label, sizeClass = 'w-2 h-2' }: {
  /** Stable per-identity key: a user-group id where known, else a device agentId. */
  identityKey: string;
  /** False renders the muted offline dot; no identity colour is shown. */
  online?: boolean;
  direct?: boolean;
  /** Base tooltip text; the transport ("direct"/"via relay") is appended. */
  label?: string;
  /** Tailwind size classes for the dot (default 8px). */
  sizeClass?: string;
}) {
  const color = colorForKey(identityKey);
  const state = online ? (direct ? 'direct (P2P)' : 'via relay') : 'Offline';
  const base = label ?? displayNameForKey(identityKey);
  return (
    <span
      data-testid="peer-dot"
      data-online={String(online)}
      data-direct={String(online && direct)}
      // The offline grey is a class, so the inline style has to be dropped
      // entirely rather than set to `transparent` — an inline background would
      // outrank the class and render an invisible dot.
      className={`${sizeClass} rounded-full inline-block shrink-0 box-border${online ? '' : ' bg-muted-foreground/30'}`}
      style={online ? {
        backgroundColor: direct ? color : 'transparent',
        border: direct ? 'none' : `2px solid ${color}`,
      } : undefined}
      title={`${base} — ${state}`}
    />
  );
}


/**
 * The "a peer is editing this" dot for a row or a field: pass the peer that is
 * there (from `usePeersAt`), or nothing, in which case it renders nothing.
 */
export function PresenceDot({ peer }: { peer?: PeerFieldInfo | null }) {
  const transports = usePeerTransports();
  if (!peer) return null;
  return (
    <PeerDot
      identityKey={peerIdentityKey(peer.peerId, peer.userGroupId)}
      direct={transports[peer.peerId] === 'direct'}
      label={`${peerDisplayName(peer.peerId, peer.userGroupId)} is editing`}
    />
  );
}
