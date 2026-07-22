/**
 * Access control panel for a document.
 * Shows members, roles, and role management, and lets admins share with a contact.
 * Rendered as a Sheet (slide-over panel) triggered from the editor title bar.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { DeleteButton } from '@/components/ui/delete-button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getDocMembers,
  getMyAccess,
  changeRole,
  revokeMember,
  getKnownContacts,
  getIdentity,
  addMember,
  onKeyhiveStateChanged,
  type MemberInfo,
} from '../shared/keyhive-api';
import { getContactName, mergeCachedContacts } from '../contact-names';
import { EditableName } from './EditableName';
import { accessTitle } from './AccessIcon';

interface AccessControlProps {
  /** Automerge document ID. */
  docId: string;
  /** Current access level — shown as icon on the trigger button. */
  access?: string | null;
}

export function AccessControl({ docId, access: accessProp }: AccessControlProps) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [myAccess, setMyAccess] = useState<string | null>(accessProp ?? null);
  const [loaded, setLoaded] = useState(false);
  const [contacts, setContacts] = useState<MemberInfo[]>([]);
  const [selectedContact, setSelectedContact] = useState<string>('');
  const [inviteRole, setInviteRole] = useState<string>('read');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = myAccess?.toLowerCase() === 'admin';

  const refresh = useCallback(async () => {
    // Use allSettled so a failure in one call (e.g. getKnownContacts iterating
    // over docs with incomplete CGKA state) doesn't prevent member list display.
    const [membersResult, accessResult, contactsResult, identityResult] = await Promise.allSettled([
      getDocMembers(docId),
      getMyAccess(docId),
      getKnownContacts(docId),
      getIdentity(),
    ]);

    const members = membersResult.status === 'fulfilled' ? membersResult.value.members : [];
    if (membersResult.status === 'fulfilled') {
      setMembers(membersResult.value.members);
    }

    if (accessResult.status === 'fulfilled') {
      setMyAccess(accessResult.value);
    }

    if (contactsResult.status === 'fulfilled') {
      // Merge in locally-known (named) contacts that getKnownContacts didn't surface,
      // so the Share panel stays consistent with Settings → Contacts even if the
      // worker's IndexedDB view and the in-memory name cache momentarily diverge.
      // Exclude existing members of this doc (already shared) and the current user.
      const exclude = new Set(members.map(m => m.agentId));
      if (identityResult.status === 'fulfilled') {
        exclude.add(identityResult.value.agentId);
        if (identityResult.value.userGroupId) exclude.add(identityResult.value.userGroupId);
      }
      const c = mergeCachedContacts(contactsResult.value, exclude);
      setContacts(c);
      setSelectedContact(prev => {
        if (prev && c.some(ct => ct.agentId === prev)) return prev;
        return c.length > 0 ? c[0].agentId : '';
      });
    }

    const firstError = [membersResult, accessResult, contactsResult, identityResult]
      .find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (firstError) setError(firstError.reason?.message ?? 'Unknown error');
    setLoaded(true);
  }, [docId]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Re-fetch when keyhive state changes (e.g. membership ops arriving from peers)
  useEffect(() => {
    if (!open) return;
    return onKeyhiveStateChanged(() => refresh());
  }, [open, refresh]);

  const handleChangeRole = async (member: MemberInfo, newRole: string) => {
    // Self-demotion from admin is hard to undo: without admin you can no longer
    // manage sharing (or restore your own role). Make it deliberate.
    if (member.isMe && member.role === 'admin' && newRole !== 'admin') {
      const ok = confirm(
        `Reduce your own access from admin to ${newRole}? ` +
        'You will no longer be able to manage sharing or restore your own access.'
      );
      if (!ok) return; // controlled Select snaps back to the current role
    }
    setLoading(true);
    try {
      await changeRole(member.agentId, docId, newRole);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (agentId: string) => {
    setLoading(true);
    try {
      await revokeMember(agentId, docId);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    const contact = contacts.find(c => c.agentId === selectedContact);
    if (!contact) return;
    // Sharing is group-only: every contact is a user-group, so adding the group
    // gives all of that user's devices access.
    if (contact.type !== 'group') {
      setError('This contact has no group — please re-add them as a friend.');
      return;
    }
    setLoading(true);
    try {
      await addMember(contact.agentId, docId, inviteRole);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
        title={accessProp === undefined
          ? 'Share & permissions'
          : accessProp === null
            ? 'No access · Share & permissions'
            : `${accessTitle(accessProp)} access · Share & permissions`}
        onClick={() => setOpen(true)}
      >
        {/* Generic share glyph — the access level shows as a text badge next to
            the title (EditorTitleBar), not on this button. */}
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>share</span>
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Share & Permissions</SheetTitle>
          </SheetHeader>

          {error && (
            <div className="text-sm text-destructive mt-2 p-2 bg-destructive/10 rounded">
              {error}
              <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setError(null)}>&times;</button>
            </div>
          )}

          {loaded && myAccess === null && members.length === 0 && (
            <div className="mt-4 flex items-center gap-2 p-3 bg-muted rounded text-sm text-muted-foreground">
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>lock</span>
              You no longer have access to this document
            </div>
          )}

          {/* Members list */}
          <div className="mt-4">
            <h3 className="text-sm font-medium mb-2">Members</h3>
            {members.length === 0 && (
              <p className="text-xs text-muted-foreground">No members found.</p>
            )}
            {members.map(member => (
              <div key={member.agentId} className="flex items-center gap-2 py-1.5 border-b border-border">
                <span
                  className="material-symbols-outlined text-muted-foreground"
                  style={{ fontSize: 16 }}
                  title={member.type === 'group' ? 'User (all their devices)' : 'Single device'}
                >
                  {member.type === 'group' ? 'group' : 'smartphone'}
                </span>
                <EditableName
                  agentId={member.agentId}
                  suffix={member.isMe ? <span className="text-xs text-muted-foreground ml-1">(you)</span> : undefined}
                />
                {isAdmin ? (
                  <div className="flex items-center gap-1">
                    <Select value={member.role ?? 'read'} onValueChange={(val: string) => handleChangeRole(member, val)}>
                      <SelectTrigger className="h-7 text-xs w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="read">Read</SelectItem>
                        <SelectItem value="edit">Edit</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <DeleteButton
                      className="rounded"
                      iconSize={14}
                      tooltip="Remove member"
                      confirmMessage="Remove this member? Their keys will be rotated."
                      onConfirm={() => handleRevoke(member.agentId)}
                      disabled={loading}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground capitalize">{member.role}</span>
                )}
              </div>
            ))}
          </div>

          {/* Add member section (admin only) */}
          {isAdmin && (
            <div className="mt-6">
              <h3 className="text-sm font-medium mb-2">Share with a contact</h3>
              {contacts.length === 0 ? (
                <p className="text-xs text-muted-foreground mb-3">
                  <a href="#/add-friend" className="underline">Add a friend</a>
                </p>
              ) : (
                <div className="flex items-center gap-2 mb-3">
                  <Select value={selectedContact} onValueChange={setSelectedContact}>
                    <SelectTrigger className="h-8 text-xs flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[...contacts]
                        .map(c => ({ contact: c, name: getContactName(c.agentId) }))
                        .sort((a, b) => {
                          if (a.name && !b.name) return -1;
                          if (!a.name && b.name) return 1;
                          const aKey = a.name || a.contact.agentId;
                          const bKey = b.name || b.contact.agentId;
                          return aKey.localeCompare(bKey);
                        })
                        .map(({ contact: c, name }) => (
                          <SelectItem key={c.agentId} value={c.agentId} className={name ? '' : 'text-muted-foreground'} title={c.agentId}>
                            {name || `${c.agentId.slice(0, 8)}…`}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Select value={inviteRole} onValueChange={setInviteRole}>
                    <SelectTrigger className="h-8 text-xs w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">Read</SelectItem>
                      <SelectItem value="edit">Edit</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={handleAdd} disabled={loading || !selectedContact}>
                    Add
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* My access */}
          <div className="mt-6 text-xs text-muted-foreground">
            Your role: <span className="capitalize font-medium">{myAccess || 'unknown'}</span>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
