/**
 * Access control panel for a document.
 * Shows members, roles, invite link generation, and role management.
 * Rendered as a Sheet (slide-over panel) triggered from the editor title bar.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import {
  getDocMembers,
  getMyAccess,
  changeRole,
  revokeMember,
  generateInvite,
  type MemberInfo,
} from '../../shared/keyhive-api';
import {
  getInviteRecords,
  addInviteRecord,
  removeInviteRecord,
  type InviteRecord,
} from '../invite-storage';
import { encodeInvitePayload } from '../invite/invite-codec';

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
}

interface InviteStatus {
  record: InviteRecord;
  accepted: boolean;
  acceptedBy?: MemberInfo;
}

export function AccessControl({ khDocId, docId, docType, sharingGroupId, onGroupIdChange }: AccessControlProps) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [myAccess, setMyAccess] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<string>('read');
  const [inviteStatuses, setInviteStatuses] = useState<InviteStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  const isAdmin = myAccess?.toLowerCase() === 'admin';

  const checkInvites = useCallback(async (currentMembers?: MemberInfo[]) => {
    if (!khDocId) return;
    const records = getInviteRecords(khDocId);
    if (records.length === 0) { setInviteStatuses([]); return; }
    const current = currentMembers ?? await getDocMembers(khDocId);
    const statuses = records.map(r => {
      const baseline = new Set(r.baselineAgentIds);
      const newMembers = current.filter(
        m => !baseline.has(m.agentId) && m.agentId !== r.inviteSignerAgentId
      );
      return { record: r, accepted: newMembers.length > 0, acceptedBy: newMembers[0] };
    });
    setInviteStatuses(statuses);
  }, [khDocId]);

  const refresh = useCallback(async () => {
    if (!khDocId) return;
    try {
      const [m, a] = await Promise.all([
        getDocMembers(khDocId),
        getMyAccess(khDocId),
      ]);
      // Normalize roles to lowercase to match SelectItem values
      const normalized = m.map((member: MemberInfo) => ({ ...member, role: member.role.toLowerCase() }));
      setMembers(normalized);
      setMyAccess(a);
      await checkInvites(normalized);
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

  const handleGenerateInvite = async () => {
    if (!khDocId) return;
    setLoading(true);
    try {
      const result = await generateInvite(khDocId, sharingGroupId || '', inviteRole);
      // Persist updated groupId if it was recreated
      if (result.groupId && result.groupId !== sharingGroupId) {
        onGroupIdChange?.(result.groupId);
      }
      // Encode invite payload (compressed)
      const seed = new Uint8Array(result.inviteKeyBytes);
      const archive = new Uint8Array(result.archiveBytes);
      const payloadB64 = await encodeInvitePayload(seed, archive);
      const base = window.location.origin + window.location.pathname;
      const inviteUrl = `${base}#/invite/${docId}/${docType ?? 'unknown'}/${payloadB64}`;

      addInviteRecord({
        id: Date.now().toString(),
        khDocId,
        inviteUrl,
        role: inviteRole,
        createdAt: Date.now(),
        inviteSignerAgentId: result.inviteSignerAgentId,
        baselineAgentIds: members.map(m => m.agentId),
      });
      await checkInvites();
      navigator.clipboard.writeText(inviteUrl).catch(() => {});
      setCopiedUrl(inviteUrl);
      setTimeout(() => setCopiedUrl(null), 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDismissInvite = (id: string) => {
    removeInviteRecord(id);
    checkInvites();
  };

  if (!khDocId) {
    return null;
  }

  return (
    <>
      <button
        className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
        title="Share & permissions"
        onClick={() => setOpen(true)}
      >
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
                <span className="text-sm flex-1 truncate" title={member.agentId}>
                  {member.agentId.slice(0, 8)}…
                  {member.isMe && (
                    <span className="text-xs text-muted-foreground ml-1">(you)</span>
                  )}
                </span>
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

          {/* Invite section (admin only) */}
          {isAdmin && (
            <div className="mt-6">
              <h3 className="text-sm font-medium mb-2">Invite</h3>
              <p className="text-xs text-muted-foreground mb-2">
                Generate a one-time invite link. The key is rotated after the recipient claims it,
                so sharing the URL only works once.
              </p>
              <div className="flex items-center gap-2 mb-3">
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
                <Button size="sm" onClick={handleGenerateInvite} disabled={loading}>
                  Generate link
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
                            <span className="text-muted-foreground ml-1">({acceptedBy.agentId.slice(0, 8)}…)</span>
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
                                    onClick={() => {
                                      navigator.clipboard.writeText(record.inviteUrl);
                                      setCopiedUrl(record.inviteUrl);
                                      setTimeout(() => setCopiedUrl(null), 1500);
                                    }}>
                                    Copy
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copied!</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
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
