/**
 * Friends page (`#/friends`): everyone you can share documents with.
 *
 * A row is a Material list item — status dot, name, device/document counts —
 * and tapping it opens the options sheet (rename, remove, shared documents).
 * The FAB opens the QR invite.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Alert } from '@/components/ui/alert';
import { Fab } from '@/components/ui/fab';
import { AddFriendSheet } from '../settings/AddFriendSheet';
import { getDocMembers, getKnownFriends, getIdentity } from '../common/keyhive-api';
import { keyhiveReady } from '../common/automerge';
import { fetchDocList } from '../worker-api';
import { getFriendName, getAllFriendNames, removeFriendName, setFriendName } from '../friend-names';
import { StatusDot } from '../common/presence';
import { BarIconButton } from '../common/DocumentTitleBar';
import { useDeviceStatuses, mostConnectedStatus } from '../common/use-devices';
import { FriendOptionsSheet } from './FriendOptionsSheet';

interface FriendDocInfo {
  docId: string;
  docName: string;
  docType: string;
  role: string;
}

export interface FriendEntry {
  agentId: string;
  isGroup: boolean;
  docs: FriendDocInfo[];
  /** Base64 agent ids of the devices in this friend's user-group. */
  deviceIds: string[];
}

export function Friends({ path }: { path?: string }) {
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [optionsFor, setOptionsFor] = useState<FriendEntry | null>(null);
  const deviceStatuses = useDeviceStatuses();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Ensure worker has pushed contact names before we read the cache
      await keyhiveReady;
      // Our own name is stored in the contact-names cache keyed by our own
      // user-group id (that's how "Your Name" is saved), so we must exclude it
      // below — otherwise we'd list ourselves as a contact.
      const { userGroupId: myGroupId } = await getIdentity();
      const docs = await fetchDocList();
      // getKnownFriends is the source of truth for *who* is a contact — it surfaces
      // received friends even before any doc is shared (mirrors the Share panel). The
      // per-doc member lists then enrich each contact with device counts and the docs
      // they're on. allSettled so a partial failure still renders what we have.
      const [knownResult, ...memberResults] = await Promise.allSettled([
        getKnownFriends(''),
        ...docs.map(d => getDocMembers(d.id)),
      ]);

      const map = new Map<string, FriendEntry>();

      // Seed from keyhive's known contacts (all groups; self already excluded).
      if (knownResult.status === 'fulfilled') {
        for (const m of knownResult.value) {
          if (m.isMe || m.type !== 'group') continue;
          if (!map.has(m.agentId)) {
            map.set(m.agentId, { agentId: m.agentId, isGroup: true, docs: [], deviceIds: m.deviceIds });
          }
        }
      }

      for (let i = 0; i < memberResults.length; i++) {
        const result = memberResults[i];
        if (result.status !== 'fulfilled') continue;
        const doc = docs[i];
        const { members } = result.value;

        for (const m of members) {
          if (m.isMe) continue;
          // Sharing is group-only: a contact is always a user-group. Skip non-group
          // members (e.g. unrevoked invite temp identities) — they aren't contacts.
          if (m.type !== 'group') continue;

          let entry = map.get(m.agentId);
          if (!entry) {
            entry = { agentId: m.agentId, isGroup: true, docs: [], deviceIds: m.deviceIds };
            map.set(m.agentId, entry);
          } else if (m.deviceIds.length > entry.deviceIds.length) {
            // Different docs may have synced different amounts of the group's ops;
            // keep the most complete device list seen.
            entry.deviceIds = m.deviceIds;
          }
          entry.docs.push({
            docId: doc.id,
            docName: doc.name || doc.id.slice(0, 8),
            docType: doc.type || 'unknown',
            role: m.role ?? 'unknown',
          });
        }
      }

      // Include named contacts that aren't members of any document yet. Names are
      // keyed by user-group id, so every stored contact is a group.
      const allNames = getAllFriendNames();
      for (const groupId of Object.keys(allNames)) {
        if (groupId === myGroupId) continue; // never list ourselves
        if (!map.has(groupId)) {
          map.set(groupId, { agentId: groupId, isGroup: true, docs: [], deviceIds: [] });
        }
      }

      const sorted = [...map.values()].sort((a, b) => {
        const nameA = getFriendName(a.agentId);
        const nameB = getFriendName(b.agentId);
        if (nameA && !nameB) return -1;
        if (!nameA && nameB) return 1;
        const keyA = nameA || a.agentId;
        const keyB = nameB || b.agentId;
        return keyA.localeCompare(keyB);
      });

      setFriends(sorted);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const displayNameFor = (agentId: string) => getFriendName(agentId) || `${agentId.slice(0, 8)}…`;

  const handleRemove = (friend: FriendEntry) => {
    setOptionsFor(null);
    if (!confirm(`Remove friend "${displayNameFor(friend.agentId)}"?`)) return;
    removeFriendName(friend.agentId).catch(err => {
      console.error('[Friends] Failed to remove friend:', err);
      setError(`Failed to remove friend: ${err?.message ?? 'storage error'}`);
      refresh();
    });
    setFriends(prev => prev.filter(c => c.agentId !== friend.agentId));
  };

  const handleRename = (friend: FriendEntry) => {
    setOptionsFor(null);
    const next = prompt('Rename', getFriendName(friend.agentId) ?? '');
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    setFriendName(friend.agentId, trimmed)
      .then(() => refresh())
      .catch((err: any) => setError(`Could not save the name: ${err?.message ?? 'storage error'}`));
  };

  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-28">
      <div className="flex items-center gap-1.5 pl-1 min-h-14">
        <a
          href="#/"
          aria-label="Back"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
        </a>
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Friends</h1>
        <BarIconButton icon="refresh" label="Refresh" onClick={refresh} disabled={loading} />
      </div>

      {error && (
        <Alert variant="destructive" className="mb-2 flex items-center justify-between">
          <span>{error}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setError('')}>&times;</button>
        </Alert>
      )}

      {loading && friends.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 px-2">Loading friends…</p>
      )}

      <md-list style={{ background: 'transparent' }}>
        {friends.map(friend => {
          const name = getFriendName(friend.agentId);
          // Devices are only known for friends on a shared doc; otherwise
          // deviceIds is empty and the dot reads offline.
          const status = mostConnectedStatus(deviceStatuses, friend.deviceIds);
          const devices = `${friend.deviceIds.length} ${friend.deviceIds.length === 1 ? 'device' : 'devices'}`;
          const shared = friend.docs.length === 0
            ? 'no shared documents'
            : `${friend.docs.length} ${friend.docs.length === 1 ? 'document' : 'documents'}`;

          return (
            <md-list-item
              key={friend.agentId}
              type="button"
              data-testid="friend-row"
              onClick={() => setOptionsFor(friend)}
            >
              <span slot="start" className="inline-flex items-center justify-center w-6">
                <StatusDot
                  online={status.online}
                  direct={status.transport === 'direct'}
                  label={name || friend.agentId}
                  sizeClass="w-2.5 h-2.5"
                />
              </span>
              <div slot="headline" className={name ? '' : 'text-muted-foreground'} title={friend.agentId}>
                {name || `${friend.agentId.slice(0, 8)}…`}
              </div>
              <div slot="supporting-text">{devices} · {shared}</div>
            </md-list-item>
          );
        })}
      </md-list>

      {!loading && friends.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 px-2">
          No friends yet. Invite one to start sharing documents.
        </p>
      )}

      <FriendOptionsSheet
        friend={optionsFor}
        displayName={optionsFor ? displayNameFor(optionsFor.agentId) : ''}
        onOpenChange={(o) => { if (!o) setOptionsFor(null); }}
        onRename={handleRename}
        onRemove={handleRemove}
      />

      <AddFriendSheet
        open={addFriendOpen}
        onOpenChange={(o) => { setAddFriendOpen(o); if (!o) refresh(); }}
      />

      <Fab icon="person_add" aria-label="Invite a friend" onClick={() => setAddFriendOpen(true)} />
    </div>
  );
}
