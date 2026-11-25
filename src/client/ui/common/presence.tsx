import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { subscribePresence, setPresence } from '../worker-api';
import type { PeerState } from './automerge';
import { getFriendName } from '../friend-names';
import { getDeviceName } from '../device-names';

import { MATERIAL_CATEGORICAL as PEER_COLORS } from './categorical-colors';
import { agentIdOfPeerId } from '../../../shared/peer-id';

export interface PresenceState {
  viewing: boolean;
  focusedField: (string | number)[] | null;
  /**
   * Base64 keyhive user-group id of the sender. Identifies the *user* across all of
   * their devices (the peerId is per-device). Carried in ephemeral data because the
   * peerId itself cannot be the group id — see plan notes. Contact names and the
   * local user's own name are keyed by this group id (see friend-names.ts), so it
   * is what resolves a peer to a display name; absent only if no group exists yet.
   */
  userGroupId?: string;
}

/**
 * Stable identity for a peer: the user-group id when the peer advertised one
 * (collapses a user's many devices to one identity), else the per-device agentId
 * parsed from the peerId (see shared/peer-id.ts).
 */
export function peerIdentityKey(peerId: string, userGroupId?: string | null): string {
  return userGroupId || agentIdOfPeerId(peerId);
}

/**
 * The name to show for a stable identity key (see peerIdentityKey): a friend's
 * name for a user-group id, else a device's name for a device agentId (a peer
 * with no group id, e.g. Home's bare repo peers). The two caches are keyed by
 * different kinds of id, so they cannot collide. Not resolveDeviceName: its
 * fallback is *this* browser's generated name, which would mislabel the peer.
 */
export function displayNameForKey(key: string): string {
  return getFriendName(key) || getDeviceName(key) || `${key.slice(0, 8)}…`;
}

export function peerDisplayName(peerId: string, userGroupId?: string | null): string {
  return displayNameForKey(peerIdentityKey(peerId, userGroupId));
}

/**
 * Filter a presence peer list down to the OTHER people to display: drops the
 * local peer and all of the local user's own devices, and collapses a user's
 * multiple devices to one entry (keyed by user-group id). Shared by the
 * title-bar peer dots and the connection sheet.
 */
export function dedupePeers<P extends { peerId: string; value?: { userGroupId?: string } | null }>(
  peers: P[],
  myPeerId: string | null | undefined,
  myGroup: string | null | undefined,
): P[] {
  const seen = new Set<string>();
  return peers.filter(peer => {
    if (myPeerId && peer.peerId === myPeerId) return false;
    const ug = peer.value?.userGroupId;
    if (myGroup && ug === myGroup) return false; // another of my own devices
    const id = peerIdentityKey(peer.peerId, ug);
    if (seen.has(id)) return false; // collapse a user's devices to one entry
    seen.add(id);
    return true;
  });
}

/** Deterministic palette color for an arbitrary stable key (peer identity,
 *  calendar docId, …) — same palette the peer dots use. */
export function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
}

export function peerColor(peerId: string, userGroupId?: string | null): string {
  return colorForKey(peerIdentityKey(peerId, userGroupId));
}

// ── The per-document presence store ───────────────────────────────────────────
//
// One entry per open document, shared by every component that cares about it:
// the route (which keeps "viewing" announced), the title bar (peer dots), the
// item-editor sheet (which field is open) and the view itself. They all go
// through the hooks below, so a document type gets presence without wiring any
// of it by hand.
//
// It is a module-level store rather than React context because the pieces are
// not ancestors of one another — a view's own hooks run above the <DocLoader> it
// renders, and container tests mount a view with no route around it.

export type FocusPath = (string | number)[];

/**
 * Who is claiming the device's one `focusedField` slot. An open item editor
 * ('item') is more specific than whatever the view behind it has selected
 * ('view'), so it wins while it is open and hands back when it closes.
 */
export type FocusLayer = 'view' | 'item';

interface DocEntry {
  refs: number;
  peers: Record<string, PeerState<PresenceState>>;
  listeners: Set<() => void>;
  /** Claims per layer, owner → path, oldest first (a re-set claim moves last). */
  focus: Record<FocusLayer, Map<object, FocusPath>>;
  /** JSON of the `focusedField` last sent from this tab; null = none sent yet. */
  sentFocus: string | null;
  /** peerIds seen in this subscription — anyone new missed our earlier sends. */
  known: Set<string>;
  unsubscribe: () => void;
}

const NO_PEERS: Record<string, PeerState<any>> = Object.freeze({}) as Record<string, PeerState<any>>;
const entries = new Map<string, DocEntry>();

/**
 * Only a *visible* tab may write `focusedField`. All tabs of a device share one
 * presence state (one engine, so one Presence object), so the field is a single
 * slot they would otherwise fight over: a background tab opening the same doc, or
 * answering a newcomer, would overwrite what the tab in front of the user says.
 */
function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function effectiveFocus(entry: DocEntry): FocusPath | null {
  for (const layer of ['item', 'view'] as const) {
    let newest: FocusPath | null = null;
    for (const path of entry.focus[layer].values()) newest = path;
    if (newest) return newest;
  }
  return null;
}

/** Send `focusedField` if it changed. `force` re-sends an unchanged value: this
 *  tab cannot know what another tab wrote to the shared slot meanwhile. */
function syncFocus(docId: string, entry: DocEntry, force = false): void {
  if (!isVisible()) return;
  const path = effectiveFocus(entry);
  const key = JSON.stringify(path);
  if (!force && key === entry.sentFocus) return;
  entry.sentFocus = key;
  setPresence(docId, { focusedField: path } as any);
}

/** Our whole state, for the first send and for peers who joined after it. */
function announce(docId: string, entry: DocEntry): void {
  if (!isVisible()) { setPresence(docId, { viewing: true } as any); return; }
  const path = effectiveFocus(entry);
  entry.sentFocus = JSON.stringify(path);
  setPresence(docId, { viewing: true, focusedField: path } as any);
}

function onVisibilityChange(): void {
  if (!isVisible()) return;
  for (const [docId, entry] of entries) syncFocus(docId, entry, true);
}

function acquire(docId: string): () => void {
  let entry = entries.get(docId);
  if (!entry) {
    const created: DocEntry = {
      refs: 0,
      peers: NO_PEERS,
      listeners: new Set(),
      focus: { view: new Map(), item: new Map() },
      sentFocus: null,
      known: new Set(),
      unsubscribe: () => {},
    };
    entry = created;
    if (entries.size === 0 && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    entries.set(docId, created);
    // Subscribe before sending: the engine drops a set-presence for a document
    // nobody is subscribed to.
    created.unsubscribe = subscribePresence(docId, (states: any) => {
      if (entries.get(docId) !== created) return;
      created.peers = states;
      for (const listener of [...created.listeners]) listener();
      // Presence values are only sent when they change, so a peer that joins
      // later (another browser opening the doc, a reloaded tab — always a fresh
      // peerId) has missed ours. Re-announce to newcomers; no echo loop, since
      // we are not new to them-being-new.
      let hasNew = false;
      for (const pid of Object.keys(states)) {
        if (!created.known.has(pid)) { created.known.add(pid); hasNew = true; }
      }
      if (hasNew) announce(docId, created);
    });
    announce(docId, created);
  }
  const held = entry;
  held.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.refs > 0 || entries.get(docId) !== held) return;
    // Another tab may keep the engine's entry alive after we go, so do not leave
    // a path behind in the slot we were writing.
    if (isVisible() && held.sentFocus !== null && held.sentFocus !== 'null') {
      setPresence(docId, { focusedField: null } as any);
    }
    entries.delete(docId);
    if (entries.size === 0 && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    held.unsubscribe();
  };
}

function setFocusClaim(docId: string, layer: FocusLayer, owner: object, path: FocusPath | null): void {
  const entry = entries.get(docId);
  if (!entry) return;
  const claims = entry.focus[layer];
  claims.delete(owner);
  if (path) claims.set(owner, path);
  syncFocus(docId, entry);
}

/** Hold a document's presence open for as long as the caller is mounted. */
function useDocPresenceEntry(docId: string | null | undefined): void {
  useEffect(() => {
    if (!docId) return;
    return acquire(docId);
  }, [docId]);
}

/**
 * Announce "viewing" for a document while mounted, and nothing else. The doc
 * route renders one beside every view, which is what makes presence the default
 * for a document type that never mentions it.
 */
export function ViewingPresence({ docId }: { docId: string | null | undefined }) {
  useDocPresenceEntry(docId);
  return null;
}

/**
 * Announce the document path this component has focused — a selected cell, a
 * caret, the item an editor has open — and withdraw it on unmount. Pass null
 * while nothing is focused. Callers may rebuild `path` every render: it is
 * compared by value.
 *
 * The path is deliberately NOT mirrored into the URL: transient selection state
 * has no business in the address bar.
 */
export function useFocusPath(
  docId: string | null | undefined,
  path: FocusPath | null | undefined,
  layer: FocusLayer = 'view',
): void {
  const owner = useRef({}).current;
  const key = path ? JSON.stringify(path) : null;
  // Declared first so the entry exists by the time the claim below is set.
  useDocPresenceEntry(docId);
  useEffect(() => {
    if (!docId) return;
    setFocusClaim(docId, layer, owner, key ? JSON.parse(key) : null);
  }, [docId, layer, key]);
  // Withdrawn in its own effect, so a path *change* replaces the claim in one
  // step instead of sending a null in between.
  useEffect(() => {
    if (!docId) return;
    return () => setFocusClaim(docId, layer, owner, null);
  }, [docId, layer]);
}

/**
 * A document's peers. Any number of components may call this for the same
 * document: they share one subscription, and the initial state is announced
 * once. To announce what *this* user has focused, use `useFocusPath`. The worker
 * only emits peers whose heartbeats are fresh, so a peer that silently
 * disappears drops out of `peers` (and every dot derived from it) within ~15s
 * without any client-side timers.
 */
export function usePresence(docId: string | null | undefined): {
  peers: Record<string, PeerState<PresenceState>>;
  /** Peers currently viewing the doc — what the title-bar dot list renders. */
  peerList: PeerState<PresenceState>[];
} {
  const [, rerender] = useState(0);
  const peers: Record<string, PeerState<PresenceState>> = (docId && entries.get(docId)?.peers) || NO_PEERS;
  const renderedRef = useRef(peers);
  renderedRef.current = peers;

  useEffect(() => {
    if (!docId) return;
    const release = acquire(docId);
    const entry = entries.get(docId)!;
    const listener = () => rerender(n => n + 1);
    entry.listeners.add(listener);
    // The worker does not replay to a late subscriber, so pick up what the store
    // already holds if it is not what this render showed.
    if (entry.peers !== renderedRef.current) listener();
    return () => {
      entry.listeners.delete(listener);
      release();
    };
  }, [docId]);

  const peerList = useMemo(
    () => Object.values(peers).filter(p => p.value?.viewing),
    [peers],
  );

  return { peers, peerList };
}

/**
 * The peers focused under a document path, keyed by the path segment that
 * follows it: `usePeersAt(docId, ['events'])` is who is in which event,
 * `usePeersAt(docId, ['events', uid])` who is on which of its properties. A peer
 * focused exactly on `basePath` is on none of its children, so it is left out.
 */
export function usePeersAt(
  docId: string | null | undefined,
  basePath: FocusPath | null | undefined,
): Record<string, PeerFieldInfo> {
  const { peers } = usePresence(docId);
  const baseKey = basePath ? JSON.stringify(basePath) : null;
  return useMemo(() => {
    const out: Record<string, PeerFieldInfo> = {};
    if (!baseKey) return out;
    const base: FocusPath = JSON.parse(baseKey);
    for (const peer of Object.values(peers)) {
      const pf = peer.value?.focusedField;
      if (!pf || pf.length <= base.length) continue;
      if (!base.every((seg, i) => pf[i] === seg)) continue;
      const userGroupId = peer.value?.userGroupId;
      out[String(pf[base.length])] = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
    }
    return out;
  }, [peers, baseKey]);
}


export interface PeerFieldInfo {
  color: string;
  peerId: string;
  /** User-group id of the peer, if advertised — used for display name + dedupe. */
  userGroupId?: string;
}

