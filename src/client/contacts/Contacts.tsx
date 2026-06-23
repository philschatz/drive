import { useState, useEffect, useCallback } from 'preact/hooks';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { EditableName } from '@/components/EditableName';
import { getDocMembers, type MemberInfo } from '../shared/keyhive-api';
import { keyhiveReady } from '../shared/automerge';
import { getContactName, getAllContactNames, removeContactName } from '../contact-names';
import { getDocList } from '../doc-storage';
import { type DocType, viewPathForType, iconForType } from '../shared/doc-type-helpers';

interface ContactDocInfo {
  docId: string;
  docName: string;
  docType: DocType;
  role: string;
}

interface ContactEntry {
  agentId: string;
  isGroup: boolean;
  docs: ContactDocInfo[];
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
      const docs = getDocList().filter(d => d.encrypted);
      const results = await Promise.allSettled(
        docs.map(d => getDocMembers(d.id))
      );

      const map = new Map<string, ContactEntry>();

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status !== 'fulfilled') continue;
        const doc = docs[i];
        const { members } = result.value;

        for (const m of members) {
          if (m.isMe) continue;
          if (!m.isIndividual && !m.isGroup) continue;

          let entry = map.get(m.agentId);
          if (!entry) {
            entry = { agentId: m.agentId, isGroup: m.isGroup, docs: [] };
            map.set(m.agentId, entry);
          }
          entry.docs.push({
            docId: doc.id,
            docName: doc.name || doc.id.slice(0, 8),
            docType: (doc.type || 'unknown') as DocType,
            role: m.role.toLowerCase(),
          });
        }
      }

      // Include named contacts that aren't members of any document yet
      const allNames = getAllContactNames();
      for (const agentId of Object.keys(allNames)) {
        if (!map.has(agentId)) {
          map.set(agentId, { agentId, isGroup: false, docs: [] });
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
    const name = getContactName(contact.agentId) || contact.agentId.slice(0, 12);
    if (!confirm(`Remove contact "${name}"?`)) return;
    removeContactName(contact.agentId);
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
                <EditableName agentId={contact.agentId} />
                <button
                  className="inline-flex items-center justify-center h-6 w-6 rounded-md text-destructive hover:bg-destructive/10 ml-auto"
                  title="Remove contact"
                  onClick={() => handleDelete(contact)}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                </button>
              </div>
              <div className="ml-6 mt-1 flex flex-col gap-0.5">
                {contact.docs.length === 0 && (
                  <span className="text-xs text-muted-foreground italic">No shared documents</span>
                )}
                {visibleDocs.map(d => (
                  <div key={d.docId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{iconForType(d.docType)}</span>
                    <a href={viewPathForType(d.docType, d.docId)} className="hover:underline hover:text-foreground">
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
