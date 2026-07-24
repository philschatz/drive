import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button, buttonVariants } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { DeleteButton } from '@/components/ui/delete-button';
import { EditableUserName } from '@/components/EditableUserName';
import { getDocMembers, getKnownContacts, getIdentity } from '../shared/keyhive-api';
import { keyhiveReady } from '../shared/automerge';
import { fetchDocList } from '../worker-api';
import { getContactName, getAllContactNames, removeContactName } from '../contact-names';
import { iconForType } from '../doc-plugins';
import { docUrl } from '../shared/doc-urls';

interface ContactDocInfo {
  docId: string;
  docName: string;
  docType: string;
  role: string;
}

interface ContactEntry {
  agentId: string;
  isGroup: boolean;
  docs: ContactDocInfo[];
  /** Base64 agent ids of the devices in this contact's user-group. */
  deviceIds: string[];
}

export function Contacts({ path }: { path?: string }) {
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (agentId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

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
      // getKnownContacts is the source of truth for *who* is a contact — it surfaces
      // received friends even before any doc is shared (mirrors the Share panel). The
      // per-doc member lists then enrich each contact with device counts and the docs
      // they're on. allSettled so a partial failure still renders what we have.
      const [knownResult, ...memberResults] = await Promise.allSettled([
        getKnownContacts(''),
        ...docs.map(d => getDocMembers(d.id)),
      ]);

      const map = new Map<string, ContactEntry>();

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
      const allNames = getAllContactNames();
      for (const groupId of Object.keys(allNames)) {
        if (groupId === myGroupId) continue; // never list ourselves
        if (!map.has(groupId)) {
          map.set(groupId, { agentId: groupId, isGroup: true, docs: [], deviceIds: [] });
        }
      }

      const sorted = [...map.values()].sort((a, b) => {
        const nameA = getContactName(a.agentId);
        const nameB = getContactName(b.agentId);
        if (nameA && !nameB) return -1;
        if (!nameA && nameB) return 1;
        const keyA = nameA || a.agentId;
        const keyB = nameB || b.agentId;
        return keyA.localeCompare(keyB);
      });

      setContacts(sorted);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDelete = (contact: ContactEntry) => {
    removeContactName(contact.agentId).catch(err => {
      console.error('[Contacts] Failed to remove contact:', err);
      setError(`Failed to remove contact: ${err?.message ?? 'storage error'}`);
      refresh();
    });
    setContacts(prev => prev.filter(c => c.agentId !== contact.agentId));
  };

  const COLLAPSED_LIMIT = 3;

  return (
    <div className="max-w-screen-md mx-auto p-4">
      <div className="flex items-center gap-2 mb-4">
        <a
          href="#/"
          className="inline-flex items-center justify-center h-9 w-9 rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </a>
        <h1 className="text-2xl font-bold">Contacts</h1>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading} title="Refresh">
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
        </Button>
        <a href="#/add-friend" className={`${buttonVariants({ variant: 'outline', size: 'sm' })} ml-auto`}>
          <span className="material-symbols-outlined mr-1" style={{ fontSize: 16 }}>person_add</span>
          Add Friend
        </a>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-2 flex items-center justify-between">
          <span>{error}</span>
          <button className="ml-2 opacity-50 hover:opacity-100" onClick={() => setError('')}>&times;</button>
        </Alert>
      )}

      {loading && contacts.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">Loading contacts...</p>
      )}

      <div className="flex flex-col">
        {contacts.map(contact => {
          const isExpanded = expanded.has(contact.agentId);
          const visibleDocs = isExpanded ? contact.docs : contact.docs.slice(0, COLLAPSED_LIMIT);
          const hiddenCount = contact.docs.length - COLLAPSED_LIMIT;

          return (
            <div key={contact.agentId} className="py-2 border-b border-border">
              <div className="flex items-center gap-2">
                <span
                  className="material-symbols-outlined text-muted-foreground"
                  style={{ fontSize: 16 }}
                  title={contact.isGroup ? 'User (all their devices)' : 'Single device'}
                >
                  {contact.isGroup ? 'group' : 'smartphone'}
                </span>
                <EditableUserName agentId={contact.agentId} />
                <span
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"
                  title={`Devices:\n${contact.deviceIds
                    .map(id => getContactName(id) || `${id.slice(0, 8)}…`)
                    .join('\n')}`}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>smartphone</span>
                  {contact.deviceIds.length}
                </span>
                <DeleteButton
                  className="h-6 w-6 ml-auto"
                  tooltip="Remove contact"
                  confirmMessage={`Remove contact "${getContactName(contact.agentId) || contact.agentId.slice(0, 12)}"?`}
                  onConfirm={() => handleDelete(contact)}
                />
              </div>
              <div className="ml-6 mt-1 flex flex-col gap-0.5">
                {contact.docs.length === 0 && (
                  <span className="text-xs text-muted-foreground italic">No shared documents</span>
                )}
                {visibleDocs.map(d => (
                  <div key={d.docId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{iconForType(d.docType)}</span>
                    <a href={docUrl(d.docId)} className="hover:underline hover:text-foreground">
                      {d.docName}
                    </a>
                    <span className="capitalize">({d.role})</span>
                  </div>
                ))}
                {!isExpanded && hiddenCount > 0 && (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground text-left"
                    onClick={() => toggleExpanded(contact.agentId)}
                  >
                    and {hiddenCount} more...
                  </button>
                )}
                {isExpanded && contact.docs.length > COLLAPSED_LIMIT && (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground text-left"
                    onClick={() => toggleExpanded(contact.agentId)}
                  >
                    show less
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!loading && contacts.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">No contacts yet. Share a document to discover contacts.</p>
      )}
    </div>
  );
}
