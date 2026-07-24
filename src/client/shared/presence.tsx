import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  /**
   * Base64 keyhive user-group id of the sender. Identifies the *user* across all of
   * their devices (the peerId is per-device). Carried in ephemeral data because the
   * peerId itself cannot be the group id — see plan notes. Contact names and the
   * local user's own name are keyed by this group id (see contact-names.ts), so it
   * is what resolves a peer to a display name; absent only if no group exists yet.
   */
  userGroupId?: string;
}

/**
 * Stable identity for a peer: the user-group id when the peer advertised one
 * (collapses a user's many devices to one identity), else the per-device agentId
 * parsed from the peerId. base64 never contains '-', so the split is unambiguous.
 */
export function peerIdentityKey(peerId: string, userGroupId?: string | null): string {
  return userGroupId || peerId.split('-')[0];
}

export function peerDisplayName(peerId: string, userGroupId?: string | null): string {
  const key = peerIdentityKey(peerId, userGroupId);
  return getContactName(key) || `${key.slice(0, 8)}…`;
}

export function peerColor(peerId: string, userGroupId?: string | null): string {
  const key = peerIdentityKey(peerId, userGroupId);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
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

/**
 * Subscribe to a document's presence and broadcast our own. This is the common
 * per-editor wiring: it owns the peer-states map, re-subscribes when `docId`
 * changes, and no-ops while `docId` is falsy (e.g. the doc isn't loaded yet).
 * The worker only emits peers whose heartbeats are fresh, so a peer that
 * silently disappears drops out of `peers` (and every dot derived from it)
 * within ~15s without any client-side timers.
 */
export function usePresence<S extends Record<string, any> = PresenceState>(
  docId: string | null | undefined,
  opts?: {
    /** Initial state to broadcast (default: viewing, no focused field). */
    getInitialState?: () => S;
    /** Called with every raw worker emission (e.g. the Source debug log). */
    onRawUpdate?: (states: Record<string, PeerState<S>>) => void;
  },
): {
  peers: Record<string, PeerState<S>>;
  /** Peers currently viewing the doc — what the title-bar dot list renders. */
  peerList: PeerState<S>[];
  broadcast: (key: keyof S, value: S[keyof S]) => void;
} {
  const [peers, setPeers] = useState<Record<string, PeerState<S>>>({});
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // Latest full local presence state. Presence values are only sent when they
  // change, so a peer that joins later (another browser opening the doc, a
  // reloaded tab — always a fresh peerId now) has missed our earlier
  // broadcasts. Kept here so we can re-announce the whole state to newcomers.
  const lastStateRef = useRef<Record<string, any> | null>(null);

  useEffect(() => {
    if (!docId) return;
    let mounted = true;
    const initial = (optsRef.current?.getInitialState?.()
      ?? ({ viewing: true, focusedField: null } as unknown as S)) as Record<string, any>;
    lastStateRef.current = { ...initial };
    const known = new Set<string>();
    const { cleanup } = initPresence<S>(
      docId,
      () => initial as S,
      (states) => {
        optsRef.current?.onRawUpdate?.(states);
        if (mounted) setPeers(states);
        // Re-announce our full state whenever a peerId we haven't seen in this
        // subscription appears: they definitionally missed our past broadcasts.
        // One extra setPresence per newcomer batch; no echo loop (we're not new
        // to them-being-new).
        let hasNew = false;
        for (const pid of Object.keys(states)) {
          if (!known.has(pid)) { known.add(pid); hasNew = true; }
        }
        if (hasNew && mounted && lastStateRef.current) {
          setPresence(docId, lastStateRef.current as any);
        }
      },
    );
    return () => { mounted = false; cleanup(); setPeers({}); lastStateRef.current = null; };
  }, [docId]);

  const broadcast = useCallback((key: keyof S, value: S[keyof S]) => {
    if (!docId) return;
    if (lastStateRef.current) lastStateRef.current[key as string] = value;
    setPresence(docId, { [key]: value } as any);
  }, [docId]);

  const peerList = useMemo(
    () => Object.values(peers).filter(p => p.value?.viewing),
    [peers],
  );

  return { peers, peerList, broadcast };
}


export interface PeerFieldInfo {
  color: string;
  peerId: string;
  /** User-group id of the peer, if advertised — used for display name + dedupe. */
  userGroupId?: string;
}

/**
 * A peer indicator dot. A FILLED dot means a direct WebRTC (peer-to-peer)
 * channel is open to that peer; a HOLLOW ring means the peer is reachable only
 * through the relay server. Hollow is the default so a relayed connection is
 * never mistaken for a direct one. The transport is also named in the tooltip.
 */
export function PeerDot({ peerId, userGroupId, direct, label, sizeClass = 'w-2 h-2' }: {
  peerId: string;
  /** User-group id of the peer, if known — drives color + name resolution. */
  userGroupId?: string;
  direct: boolean;
  /** Base tooltip text; the transport ("direct"/"via relay") is appended. */
  label?: string;
  /** Tailwind size classes for the dot (default 8px). */
  sizeClass?: string;
}) {
  const color = peerColor(peerId, userGroupId);
  const base = label ?? peerDisplayName(peerId, userGroupId);
  return (
    <span
      data-testid="peer-dot"
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

/**
 * Online/offline status dot, following the PeerDot convention: a FILLED green
 * dot means a direct WebRTC (P2P) channel is open, a HOLLOW green ring means the
 * peer is reachable only via the relay, and a muted gray dot means offline — so a
 * relayed connection is never mistaken for P2P. The transport is named in the
 * tooltip. Unlike PeerDot this is a plain green/gray indicator (not per-peer
 * colored) since it answers "is this device/user reachable, and how".
 */
export function StatusDot({ online, direct, label, sizeClass = 'w-2 h-2' }: {
  online: boolean;
  /** True only when a direct (P2P) channel is open; ignored when offline. */
  direct?: boolean;
  /** Optional prefix for the tooltip (e.g. a device/user name). */
  label?: string;
  sizeClass?: string;
}) {
  const cls = !online ? 'bg-muted-foreground/30'
    : direct ? 'bg-green-500'
    : 'border-2 border-green-500';
  const state = online ? `Online — ${direct ? 'direct (P2P)' : 'via relay'}` : 'Offline';
  return (
    <span
      className={`${sizeClass} rounded-full inline-block shrink-0 box-border ${cls}`}
      title={label ? `${label} — ${state}` : state}
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
      userGroupId={info.userGroupId}
      direct={transports[info.peerId] === 'direct'}
      label={`${peerDisplayName(info.peerId, info.userGroupId)} is editing`}
    />
  );
}
