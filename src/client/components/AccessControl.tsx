/**
 * Access control panel for a document.
 * Shows members, roles, invite link generation, and role management.
 * Rendered as a Sheet (slide-over panel) triggered from the editor title bar.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  getDocMembers,
  getMyAccess,
  changeRole,
  revokeMember,
  generateInvite,
  type MemberInfo,
} from '../../shared/keyhive-api';

interface AccessControlProps {
  /** Keyhive document ID (base64-encoded). */
  khDocId: string | undefined;
  /** Automerge document ID (for invite URL construction). */
  docId: string;
  /** Auth companion document ID (for invite URL construction). */
  authDocId?: string;
}

export function AccessControl({ khDocId, docId, authDocId }: AccessControlProps) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [myAccess, setMyAccess] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<string>('write');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = myAccess === 'admin';

  const refresh = useCallback(async () => {
    if (!khDocId) return;
    try {
      const [m, a] = await Promise.all([
        getDocMembers(khDocId),
        getMyAccess(khDocId),
      ]);
      setMembers(m);
      setMyAccess(a);
    } catch (err: any) {
      setError(err.message);
    }
  }, [khDocId]);

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
    setInviteUrl(null);
    try {
      const result = await generateInvite(khDocId, inviteRole);
      const keyB64 = btoa(String.fromCharCode(...result.inviteKeyBytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const base = window.location.origin + window.location.pathname;
      const url = `${base}#/invite/${docId}/${authDocId || ''}/${keyB64}`;
      setInviteUrl(url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyInvite = () => {
    if (inviteUrl) {
      navigator.clipboard.writeText(inviteUrl);
    }
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
                  {member.agentId.slice(0, 12)}...
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
              <div className="flex items-center gap-2 mb-2">
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger className="h-8 text-xs w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">Read</SelectItem>
                    <SelectItem value="write">Write</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={handleGenerateInvite} disabled={loading}>
                  Generate link
                </Button>
              </div>
              {inviteUrl && (
                <div className="flex items-center gap-2">
                  <input
                    className="flex-1 text-xs bg-muted p-1.5 rounded border border-border font-mono truncate"
                    value={inviteUrl}
                    readOnly
                    onClick={(e: any) => e.currentTarget.select()}
                  />
                  <Button size="sm" variant="outline" onClick={copyInvite}>
                    Copy
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
