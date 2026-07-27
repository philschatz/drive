/**
 * Sharing screen for one document: `#/d/<docId>/share`.
 *
 * Lists everyone the document is shared with, sorted by how well connected they
 * are, and lets an admin add people, change roles and revoke access. Everything
 * destructive or multi-choice happens in a bottom sheet so it can be dismissed.
 *
 * The current user is never listed — leaving a document is Home's Archive
 * action, and your own role already shows next to the document title.
 */

import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { Alert } from '@/components/ui/alert';
import {
  getDocMembers,
  getMyAccess,
  getKnownFriends,
  getIdentity,
  addMember,
  revokeMember,
  changeRole,
  onKeyhiveStateChanged,
} from '../common/keyhive-api';
import type { MemberInfo, MemberRole } from '../../../shared/keyhive-types';
import { getFriendName, setFriendName, mergeCachedFriends } from '../friend-names';
import { useDeviceStatuses, mostConnectedStatus, type DeviceStatus } from '../common/use-devices';
import { StatusDot } from '../common/presence';
import { docUrl } from '../common/doc-urls';
import { AddFriendSheet } from '../settings/AddFriendSheet';
import { AddPeopleSheet } from './AddPeopleSheet';
import { MemberOptionsSheet } from './MemberOptionsSheet';
import { RolePickerSheet } from './RolePickerSheet';

function displayNameFor(agentId: string): string {
  return getFriendName(agentId) || `${agentId.slice(0, 8)}…`;
}

/** Best-connected first, then offline; named contacts before bare ids. */
function connectionRank(status: DeviceStatus): number {
  if (!status.online) return 2;
  return status.transport === 'direct' ? 0 : 1;
}

export function SharingPage({ docId }: { docId?: string; path?: string }) {
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [myAccess, setMyAccess] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [contacts, setContacts] = useState<MemberInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [optionsFor, setOptionsFor] = useState<MemberInfo | null>(null);
  // agentId + current role (absent when inviting someone new).
  const [roleTarget, setRoleTarget] = useState<{ agentId: string; role?: MemberRole } | null>(null);
  // A friend added via the QR sheet, picked up once that sheet closes.
  const pendingGroupIdRef = useRef<string | null>(null);

  const deviceStatuses = useDeviceStatuses();

  // getMyAccess returns keyhive's raw, capitalized string ("Admin"), unlike
  // useAccess which lowercases — compare defensively.
  const isAdmin = myAccess?.toLowerCase() === 'admin';

  const refresh = useCallback(async () => {
    if (!docId) return;
    // allSettled so a failure in one call (e.g. getKnownFriends iterating over
    // docs with incomplete CGKA state) doesn't prevent member list display.
    const [membersResult, accessResult, contactsResult, identityResult] = await Promise.allSettled([
      getDocMembers(docId),
      getMyAccess(docId),
      getKnownFriends(docId),
      getIdentity(),
    ]);

    const loadedMembers = membersResult.status === 'fulfilled' ? membersResult.value.members : [];
    if (membersResult.status === 'fulfilled') setMembers(loadedMembers);
    if (accessResult.status === 'fulfilled') setMyAccess(accessResult.value);

    if (contactsResult.status === 'fulfilled') {
      // Merge in locally-known (named) contacts the worker didn't surface, so
      // this stays consistent with Settings → Contacts even if its IndexedDB
      // view and the in-memory name cache momentarily diverge. Exclude existing
      // members of this doc (already shared) and the current user.
      const exclude = new Set(loadedMembers.map(m => m.agentId));
      if (identityResult.status === 'fulfilled') {
        exclude.add(identityResult.value.agentId);
        if (identityResult.value.userGroupId) exclude.add(identityResult.value.userGroupId);
      }
      setContacts(mergeCachedFriends(contactsResult.value, exclude));
    }

    const firstError = [membersResult, accessResult, contactsResult, identityResult]
      .find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (firstError) setError(firstError.reason?.message ?? 'Unknown error');
    setLoaded(true);
  }, [docId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-fetch when keyhive state changes (e.g. membership ops arriving from peers)
  useEffect(() => onKeyhiveStateChanged(() => refresh()), [refresh]);

  // A first-time user has nobody on the document and nobody to add, so the page
  // and its picker would both be empty — open the QR invite for them. Once only:
  // dismissing it must leave the (empty) page visible rather than reopening.
  const autoInvitedRef = useRef(false);
  const hasOtherMembers = members.some(m => !m.isMe);
  useEffect(() => {
    if (autoInvitedRef.current || !loaded || !isAdmin) return;
    if (myAccess === null || hasOtherMembers || contacts.length > 0) return;
    autoInvitedRef.current = true;
    setInviteOpen(true);
  }, [loaded, isAdmin, myAccess, hasOtherMembers, contacts.length]);

  /** Run a membership mutation with busy/error handling, then refresh. */
  const mutate = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleRename = (member: MemberInfo) => {
    setOptionsFor(null);
    const next = prompt('Rename', getFriendName(member.agentId) ?? '');
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    setFriendName(member.agentId, trimmed)
      .then(() => refresh())
      .catch((err: any) => setError('Could not save the name: ' + (err?.message ?? 'storage error')));
  };

  const handleRemove = (member: MemberInfo) => {
    setOptionsFor(null);
    if (!confirm('Remove this member? Their keys will be rotated.')) return;
    mutate(() => revokeMember(member.agentId, docId!));
  };

  const handlePickRole = (role: MemberRole) => {
    const target = roleTarget;
    setRoleTarget(null);
    if (!target) return;
    // changeRole is revoke-then-re-add with a full CGKA key rotation, so both
    // paths are slow enough to need the busy state.
    mutate(() => target.role
      ? changeRole(target.agentId, docId!, role)
      : addMember(target.agentId, docId!, role));
  };

  if (!docId) return null;

  // The current user is not shown (no self-remove, no own-role display).
  const visibleMembers = members
    .filter(m => !m.isMe)
    .map(member => ({
      member,
      status: mostConnectedStatus(
        deviceStatuses,
        member.type === 'group' ? member.deviceIds : [member.agentId],
      ),
      name: getFriendName(member.agentId),
    }))
    .sort((a, b) => {
      const rank = connectionRank(a.status) - connectionRank(b.status);
      if (rank !== 0) return rank;
      if (a.name && !b.name) return -1;
      if (!a.name && b.name) return 1;
      return (a.name || a.member.agentId).localeCompare(b.name || b.member.agentId);
    });

  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-8">
      {/* Top app bar */}
      <div className="flex items-center gap-1.5 pl-1 min-h-14">
        <a
          href={docUrl(docId)}
          aria-label="Back"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 24 }}>arrow_back</span>
        </a>
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Sharing</h1>
        {isAdmin && (
          <button
            aria-label="Add people"
            title="Add people"
            className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer shrink-0"
            // With no friends left to add, the picker would offer nothing but
            // "Invite a new Friend" — go straight there instead.
            onClick={() => (contacts.length === 0 ? setInviteOpen(true) : setAddOpen(true))}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 24 }}>person_add</span>
          </button>
        )}
      </div>

      {error && (
        <Alert variant="destructive" className="mb-2 flex items-center justify-between">
          <span>{error}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setError(null)}>&times;</button>
        </Alert>
      )}

      {loaded && myAccess === null && members.length === 0 && (
        <div className="mt-4 flex items-center gap-2 p-3 bg-muted rounded text-sm text-muted-foreground">
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>lock</span>
          You no longer have access to this document
        </div>
      )}

      {loaded && visibleMembers.length === 0 && myAccess !== null && (
        <p className="text-xs text-muted-foreground px-2 mt-4">Not shared with anyone yet.</p>
      )}

      <md-list style={{ background: 'transparent' }}>
        {visibleMembers.map(({ member, status, name }) => (
          <md-list-item
            key={member.agentId}
            type="button"
            data-testid="member-row"
            onClick={() => setOptionsFor(member)}
          >
            <span slot="start" className="inline-flex items-center justify-center w-6">
              <StatusDot
                online={status.online}
                direct={status.transport === 'direct'}
                label={name || member.agentId}
                sizeClass="w-2.5 h-2.5"
              />
            </span>
            <div slot="headline" className={name ? '' : 'text-muted-foreground'} title={member.agentId}>
              {name || `${member.agentId.slice(0, 8)}…`}
            </div>
            <span slot="end" className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid="member-transport">
                {!status.online ? 'Offline' : status.transport === 'direct' ? 'P2P' : 'Via relay'}
              </span>
              <span className="text-xs text-muted-foreground capitalize" data-testid="member-role">
                {member.role ?? 'read'}
              </span>
            </span>
          </md-list-item>
        ))}
      </md-list>

      <MemberOptionsSheet
        member={optionsFor}
        displayName={optionsFor ? displayNameFor(optionsFor.agentId) : ''}
        isAdmin={isAdmin}
        busy={busy}
        onOpenChange={(o) => { if (!o) setOptionsFor(null); }}
        onRename={handleRename}
        onChangeRole={(member) => {
          setOptionsFor(null);
          setRoleTarget({ agentId: member.agentId, role: member.role ?? 'read' });
        }}
        onRemove={handleRemove}
      />

      <AddPeopleSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        contacts={contacts}
        onPick={(contact) => {
          setAddOpen(false);
          // Sharing is group-only: every contact is a user-group, so adding the
          // group gives all of that user's devices access.
          if (contact.type !== 'group') {
            setError('This friend has no group — please add them again.');
            return;
          }
          setRoleTarget({ agentId: contact.agentId });
        }}
        onInvite={() => { setAddOpen(false); setInviteOpen(true); }}
      />

      {/* The QR sheet closes itself once the exchange (and naming) is done; we
          ask for a role on close rather than in onAdded so the role picker
          isn't mounted over a sheet that is still animating out. */}
      <AddFriendSheet
        open={inviteOpen}
        onOpenChange={(o) => {
          setInviteOpen(o);
          if (!o) {
            refresh();
            if (pendingGroupIdRef.current) {
              setRoleTarget({ agentId: pendingGroupIdRef.current });
              pendingGroupIdRef.current = null;
            }
          }
        }}
        onAdded={(groupId) => { pendingGroupIdRef.current = groupId; }}
      />

      <RolePickerSheet
        open={!!roleTarget}
        onOpenChange={(o) => { if (!o) setRoleTarget(null); }}
        title={roleTarget ? `Role for ${displayNameFor(roleTarget.agentId)}` : ''}
        value={roleTarget?.role}
        onPick={handlePickRole}
      />
    </div>
  );
}
