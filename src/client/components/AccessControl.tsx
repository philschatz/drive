/**
 * Access control panel for a document.
 * Shows members, roles, invite link generation, and role management.
 * Rendered as a Sheet (slide-over panel) triggered from the editor title bar.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import {
  getDocMembers,
  getMyAccess,
  changeRole,
  revokeMember,
  generateInvite,
  getKnownContacts,
  addMember,
  dismissInvite,
  type MemberInfo,
} from '../shared/keyhive-api';
import type { InviteRecord } from '../invite-storage';
import { getContactName, setContactName } from '../contact-names';
import QRCode from 'qrcode';

/** Copy or share a URL, with fallbacks for mobile browsers (e.g. Firefox Android). */
async function shareOrCopy(url: string): Promise<boolean> {
  // On mobile, prefer the native share sheet
  if (navigator.share) {
    try {
      await navigator.share({ url });
      return true;
    } catch {
      // User cancelled or share failed — fall through to clipboard
    }
  }
  // Try the clipboard API
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // Clipboard API unavailable or denied — fall through
  }
  // Fallback: temporary textarea + execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function InviteQR({ url }: { url: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 1, width: 160 }).then(setSvg).catch(() => {});
  }, [url]);
  if (!svg) return null;
  return <div className="mt-2 flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function EditableName({ agentId, suffix }: { agentId: string; suffix?: any }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const saved = getContactName(agentId);

  const startEdit = () => {
    setDraft(saved || '');
    setEditing(true);
  };

  const commit = () => {
    setContactName(agentId, draft);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        className="text-sm flex-1 border-b border-border bg-transparent outline-none px-0"
        value={draft}
        onInput={(e: any) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e: any) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        autoFocus
        placeholder={agentId.slice(0, 8) + '…'}
      />
    );
  }

  return (
    <span className="text-sm flex-1 truncate group" title={agentId}>
      {saved || `${agentId.slice(0, 8)}…`}
      {suffix}
      <button
        className="ml-1 opacity-0 group-hover:opacity-50 hover:!opacity-100 inline-flex align-middle"
        onClick={(e: any) => { e.stopPropagation(); startEdit(); }}
        title="Set friendly name"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 12 }}>edit</span>
      </button>
    </span>
  );
}

interface AccessControlProps {
  /** Keyhive document ID (base64-encoded). */
  khDocId: string | undefined;
  /** Automerge document ID (for invite URL construction). */
  docId: string;
  /** Document type (Calendar/TaskList/DataGrid) — embedded in invite URL so invitee can redirect correctly. */
  docType?: string;
  /** Sharing group ID (base64-encoded). */
  sharingGroupId?: string;
  /** Called when group ID changes (e.g. recreated after reload). */
  onGroupIdChange?: (groupId: string) => void;
  /** Current access level — shown as icon on the trigger button. */
  access?: string | null;
}

interface InviteStatus {
  record: InviteRecord;
  accepted: boolean;
  acceptedBy?: MemberInfo;
}

function accessIcon(access: string | null | undefined): string {
  if (!access) return 'share';
  switch (access) {
    case 'admin': return 'admin_panel_settings';
    case 'write': return 'edit';
    case 'read': return 'visibility';
    default: return 'share';
  }
}

export function AccessControl({ khDocId, docId, docType, sharingGroupId, onGroupIdChange, access: accessProp }: AccessControlProps) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [myAccess, setMyAccess] = useState<string | null>(null);
  const [contacts, setContacts] = useState<MemberInfo[]>([]);
  const [selectedContact, setSelectedContact] = useState<string>('__new__');
  const [inviteRole, setInviteRole] = useState<string>('read');
  const [inviteStatuses, setInviteStatuses] = useState<InviteStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const isAdmin = myAccess?.toLowerCase() === 'admin';

  const checkInvites = useCallback(async (currentMembers?: MemberInfo[], currentInvites?: InviteRecord[]) => {
    if (!khDocId) return;
    const resolved = currentMembers && currentInvites
      ? { members: currentMembers, invites: currentInvites }
      : await getDocMembers(khDocId);
    const records = currentInvites ?? resolved.invites;
    if (records.length === 0) { setInviteStatuses([]); return; }
    const current = currentMembers ?? resolved.members;
    const statuses = records.map(r => {
      const baseline = new Set(r.baselineAgentIds);
      const newMembers = current.filter(
        m => !baseline.has(m.agentId) && m.agentId !== r.inviteSignerAgentId
      );
      return { record: r, accepted: newMembers.length > 0, acceptedBy: newMembers[0] };
    });
    setInviteStatuses(statuses);

    // Auto-revoke temp invite members once the invite has been claimed.
    // Only the inviter (admin) has the authority to revoke.
    for (const s of statuses) {
      if (!s.accepted) continue;
      const tempStillPresent = current.some(m => m.agentId === s.record.inviteSignerAgentId);
      if (tempStillPresent) {
        revokeMember(s.record.inviteSignerAgentId, khDocId).catch(err =>
          console.warn('[AccessControl] Failed to auto-revoke temp invite member:', err)
        );
      }
    }
  }, [khDocId]);

  const refresh = useCallback(async () => {
    if (!khDocId) return;
    try {
      const [{ members: m, invites }, a, c] = await Promise.all([
        getDocMembers(khDocId),
        getMyAccess(khDocId),
        getKnownContacts(khDocId),
      ]);
      // Normalize roles to lowercase to match SelectItem values
      const normalized = m.map((member: MemberInfo) => ({ ...member, role: member.role.toLowerCase() }));
      setMembers(normalized);
      setMyAccess(a);
      setContacts(c);
      // Reset selection if the previously selected contact is no longer available
      setSelectedContact(prev => {
        if (prev === '__new__') return prev;
        return c.some(ct => ct.agentId === prev) ? prev : (c.length > 0 ? c[0].agentId : '__new__');
      });
      await checkInvites(normalized, invites);
    } catch (err: any) {
      setError(err.message);
    }
  }, [khDocId, checkInvites]);

  useEffect(() => {
    if (open && khDocId) refresh();
  }, [open, khDocId, refresh]);

  const handleChangeRole = async (agentId: string, newRole: string) => {
    if (!khDocId) return;
    setLoading(true);
    try {
      await changeRole(agentId, khDocId, newRole);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (agentId: string) => {
    if (!khDocId) return;
    if (!confirm('Remove this member? Their keys will be rotated.')) return;
    setLoading(true);
    try {
      await revokeMember(agentId, khDocId);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddOrInvite = async () => {
    if (!khDocId) return;
    if (selectedContact === '__new__') {
      await handleGenerateInvite();
      return;
    }
    setLoading(true);
    try {
      await addMember(selectedContact, khDocId, inviteRole);
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateInvite = async () => {
    if (!khDocId) return;
    setLoading(true);
    try {
      const result = await generateInvite(khDocId, sharingGroupId || '', inviteRole, docId, docType ?? 'unknown');
      // Persist updated groupId if it was recreated
      if (result.groupId && result.groupId !== sharingGroupId) {
        onGroupIdChange?.(result.groupId);
      }
      // Worker built the URL and stored the invite record
      await checkInvites();
      const copied = await shareOrCopy(result.inviteUrl);
      if (copied) {
        setCopiedUrl(result.inviteUrl);
        setTimeout(() => setCopiedUrl(null), 1500);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDismissInvite = async (id: string) => {
    if (!khDocId) return;
    const { invites } = await dismissInvite(id, khDocId);
    await checkInvites(undefined, invites);
  };

  if (!khDocId) {
    return null;
  }

  return (
    <>
      <button
        className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
        title={accessProp ? `${accessProp} · Share & permissions` : 'Share & permissions'}
        onClick={() => setOpen(true)}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{accessIcon(accessProp)}</span>
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

          {/* Members list */}
          <div className="mt-4">
            <h3 className="text-sm font-medium mb-2">Members</h3>
            {members.length === 0 && (
              <p className="text-xs text-muted-foreground">No members found.</p>
            )}
            {members.map(member => (
              <div key={member.agentId} className="flex items-center gap-2 py-1.5 border-b border-border">
                <span className="material-symbols-outlined text-muted-foreground" style={{ fontSize: 16 }}>
                  {member.isGroup ? 'group' : 'person'}
                </span>
                <EditableName
                  agentId={member.agentId}
                  suffix={member.isMe ? <span className="text-xs text-muted-foreground ml-1">(you)</span> : undefined}
                />
                {isAdmin ? (
                  <div className="flex items-center gap-1">
                    <Select value={member.role} onValueChange={(val: string) => handleChangeRole(member.agentId, val)}>
                      <SelectTrigger className="h-7 text-xs w-20">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="read">Read</SelectItem>
                        <SelectItem value="write">Write</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <button
                      className="inline-flex items-center justify-center h-7 w-7 rounded text-destructive hover:bg-destructive/10"
                      title="Remove member"
                      onClick={() => handleRevoke(member.agentId)}
                      disabled={loading}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                    </button>
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
              <h3 className="text-sm font-medium mb-2">Add member</h3>
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
                    {contacts.length > 0 && <SelectSeparator />}
                    <SelectItem value="__new__">Invite new person</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger className="h-8 text-xs w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">Read</SelectItem>
                    <SelectItem value="write">Write</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={handleAddOrInvite} disabled={loading}>
                  {selectedContact === '__new__' ? 'Generate link' : 'Add'}
                </Button>
              </div>

              {/* Per-invite status list */}
              {inviteStatuses.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {inviteStatuses.map(({ record, accepted, acceptedBy }) => (
                    <div key={record.id} className="text-xs rounded border border-border p-2">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-muted-foreground capitalize">{record.role} invite</span>
                        <span className="text-muted-foreground">{new Date(record.createdAt).toLocaleDateString()}</span>
                        <button
                          className="text-muted-foreground hover:text-foreground leading-none"
                          onClick={() => handleDismissInvite(record.id)}
                        >
                          &times;
                        </button>
                      </div>
                      {accepted ? (
                        <div className="flex items-center gap-1 text-green-700 dark:text-green-400">
                          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check_circle</span>
                          Accepted — key rotated
                          {acceptedBy && (
                            <span className="text-muted-foreground ml-1">({getContactName(acceptedBy.agentId) || `${acceptedBy.agentId.slice(0, 8)}…`})</span>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1 text-muted-foreground mb-1">
                            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>schedule</span>
                            Pending
                          </div>
                          <div className="flex items-center gap-1">
                            <input
                              className="flex-1 text-xs bg-muted p-1 rounded font-mono truncate"
                              value={record.inviteUrl}
                              readOnly
                              onClick={(e: any) => e.currentTarget.select()}
                            />
                            <TooltipProvider>
                              <Tooltip open={copiedUrl === record.inviteUrl}>
                                <TooltipTrigger asChild>
                                  <Button size="sm" variant="outline"
                                    onClick={async () => {
                                      const copied = await shareOrCopy(record.inviteUrl);
                                      if (copied) {
                                        setCopiedUrl(record.inviteUrl);
                                        setTimeout(() => setCopiedUrl(null), 1500);
                                      }
                                    }}>
                                    Copy
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copied!</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                          <InviteQR url={record.inviteUrl} />
                        </>
                      )}
                    </div>
                  ))}
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
