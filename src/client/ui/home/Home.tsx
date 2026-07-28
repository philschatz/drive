import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { usePeerList } from '../common/automerge';
import { ConnectionStatus } from '../common/ConnectionStatus';
import { createDoc, updateDoc, subscribeQuery, fetchDocList, archiveDoc, onDocListUpdated, onUnseenChangesUpdated, getUnseenChanges, HOME_SUMMARY_QUERY } from '../worker-api';
import { getMyAccess, onKeyhiveStateChanged } from '../common/keyhive-api';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Fab } from '@/components/ui/fab';
import { AccessIcon } from '@/components/AccessIcon';
import { OverflowMenu, type OverflowMenuItem } from '../common/OverflowMenu';
import { useLongPress } from '../common/useLongPress';
import { CreateDocSheet, type ImportKind } from './CreateDocSheet';
import { DocActionsSheet } from './DocActionsSheet';
import { RenameSheet } from '../common/RenameSheet';
import dayjs from 'dayjs';
import relativeTimePlugin from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTimePlugin);
import { iconForType, docTypeLabel, type DocTypePlugin } from '@/doc-plugins';
import { docUrl, shareUrl } from '@/common/doc-urls';
import { relativeTime } from '../../../shared/relative-time';
import { settingSet, settingSetSync } from '../../shared/idb-storage';
import type { ImportProgress } from './import-docs';
import { useInstallNudge } from './install-nudge';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface DocEntry {
  type: string;
  documentId: string;
  name: string;
  count: number | null;
  lastUpdated: string | null;
  loading: boolean;
  /** null = no access / revoked, undefined = not yet checked */
  access?: string | null;
}

function applyQueryResult(prev: DocEntry[], docId: string, result: any, lastModified?: number): DocEntry[] {
  return prev.map(e => {
    if (e.documentId !== docId) return e;
    const type = typeof result.type === 'string' ? result.type : 'unknown';
    const count = result.eventCount || result.taskCount || result.cellCount || null;
    const lastUpdated = lastModified ? new Date(lastModified * 1000).toISOString() : e.lastUpdated;
    return { ...e, type, name: result.name || e.name, count, lastUpdated, loading: false };
  });
}

/**
 * One document row: a Material two-line list item.
 * Tap opens the doc; long-press / right-click / Shift+F10 / the trailing kebab
 * opens the per-doc actions sheet (Share / Rename / Archive / View source).
 */
function DocListItem({ entry, unseenFlag, onOpen, onActions }: {
  entry: DocEntry;
  unseenFlag: boolean;
  onOpen: (entry: DocEntry) => void;
  onActions: (entry: DocEntry) => void;
}) {
  const noAccess = entry.access === null;
  const lp = useLongPress({
    onTap: () => onOpen(entry),
    onLongPress: () => onActions(entry),
  });
  const supporting = entry.loading
    ? 'Loading…'
    : noAccess
      ? 'No access'
      : `${relativeTime(entry.lastUpdated)} · (${(entry.count ?? 0).toLocaleString()})`;

  return (
    <md-list-item type="button" data-testid="doc-row" {...lp}>
      <md-icon slot="start">{iconForType(entry.type)}</md-icon>
      <div
        slot="headline"
        className="flex items-center gap-1.5"
        style={noAccess ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}
      >
        <span className="truncate">{entry.name || 'Untitled'}</span>
        {!noAccess && unseenFlag && (
          <span
            data-testid="unseen-dot"
            className="w-2 h-2 rounded-full shrink-0 bg-primary"
            title="New changes since you last viewed this document"
          />
        )}
      </div>
      <div slot="supporting-text" title={entry.lastUpdated || undefined}>{supporting}</div>
      <span slot="end" className="flex items-center gap-0.5">
        {/* Admin gets no glyph — it's the norm (you made the doc); only the levels that
            differ from it (read / edit / no access) are worth calling out. */}
        {entry.access !== 'admin' && (
          <span className="inline-flex items-center justify-center h-8 w-8 text-muted-foreground">
            <AccessIcon access={entry.access ?? null} style={{ fontSize: 18 }} />
          </span>
        )}
        <button
          aria-label={`More actions for ${entry.name || 'Untitled'}`}
          title="More actions"
          className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer text-muted-foreground"
          onClick={(e: MouseEvent) => { e.stopPropagation(); onActions(entry); }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 20 }}>more_vert</span>
        </button>
      </span>
    </md-list-item>
  );
}

export function Home({ path }: { path?: string }) {
  const [entries, setEntries] = useState<DocEntry[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [importStatus, setImportStatus] = useState<ImportProgress | null>(null);
  const [listLoading, setListLoading] = useState(true);
  // Bottom sheets: FAB "Create" chooser, long-press per-doc actions, and the
  // Share / Rename follow-ups they open.
  const [createOpen, setCreateOpen] = useState(false);
  const [actionsEntry, setActionsEntry] = useState<DocEntry | null>(null);
  // Rename runs after the actions sheet closes itself, so it needs its own slot.
  const [renameEntry, setRenameEntry] = useState<{ documentId: string; name: string } | null>(null);
  const repoPeers = usePeerList();

  useEffect(() => { document.title = 'Automerge Documents'; }, []);

  // Reaching Home means the user deliberately left any open document, so forget
  // the "last opened doc" — a later cold PWA launch should land here, not
  // reopen where they were (see src/client/main.tsx).
  useEffect(() => {
    settingSetSync('last-opened-doc', null);
    settingSet('last-opened-doc', null).catch(() => {});
  }, []);

  // Pull the doc list from the worker (the source of truth). Results flow into `entries`
  // via the onDocListUpdated subscription below.
  useEffect(() => {
    fetchDocList().catch((err) => console.warn('[Home] fetchDocList failed:', err)).finally(() => setListLoading(false));
  }, []);

  // Per-doc "new changes since last viewed" flags, computed and pushed by the
  // worker (kept separate from `entries` — one writer instead of three).
  const [unseen, setUnseen] = useState<Record<string, boolean>>(() => getUnseenChanges());
  useEffect(() => onUnseenChangesUpdated(setUnseen), []);

  // Subscribe to worker-pushed doc list updates
  useEffect(() => {
    return onDocListUpdated((list) => {
      setEntries((prev) => {
        const existing = new Map(prev.map((e) => [e.documentId, e]));
        return list.map(
          (e) =>
            existing.get(e.id) ?? {
              documentId: e.id,
              type: e.type || 'unknown',
              name: e.name || e.id.slice(0, 8),
              count: null,
              lastUpdated: null,
              loading: true,
            },
        );
      });
    });
  }, []);

  // Subscribe to doc summaries from the worker
  // Sort IDs so reordering entries doesn't trigger re-subscription
  const docIdKey = entries.map(e => e.documentId).sort().join(',');
  useEffect(() => {
    const docIds = docIdKey ? docIdKey.split(',') : [];
    if (docIds.length === 0) return;
    const unsubs = docIds.map(docId =>
      subscribeQuery(docId, HOME_SUMMARY_QUERY, (result, _heads, lastModified) => {
        if (!result) return;
        setEntries(prev => applyQueryResult(prev, docId, result, lastModified));
      }, undefined, { peek: true, meta: true }) // listing docs ≠ viewing them; meta = keep lastUpdated live
    );

    // Fetch keyhive access for every doc (all docs are encrypted/keyhive-backed).
    const fetchAccessForDocs = () => {
      for (const docId of docIds) {
        getMyAccess(docId).then(access => {
          setEntries(prev => prev.map(e =>
            e.documentId === docId ? { ...e, access: access?.toLowerCase() ?? null } : e
          ));
        }).catch(() => {
          setEntries(prev => prev.map(e =>
            e.documentId === docId ? { ...e, access: null } : e
          ));
        });
      }
    };
    fetchAccessForDocs();

    // Re-fetch access when keyhive state changes (member added/revoked)
    const unsubStateChanged = onKeyhiveStateChanged(fetchAccessForDocs);

    return () => { unsubs.forEach(u => u()); unsubStateChanged(); };
  }, [docIdKey]); // eslint-disable-line react-hooks/exhaustive-deps


  const handleCreate = async (plugin: DocTypePlugin) => {
    // Create immediately as "Untitled" — the doc opens with its title inline-
    // editable (and Rename in the title-bar menu), so no blocking name prompt.
    const { docId } = await createDoc(plugin.createInitialDoc('Untitled'), { type: plugin.type, name: 'Untitled' });
    window.location.hash = docUrl(docId);
  };

  const xlsInputRef = useRef<HTMLInputElement>(null);

  /** XLSX/CSV → DataGrid. The parser (and its exceljs dependency) lives in
   *  import-xlsx.ts, loaded on demand. */
  const handleImportXlsx = useCallback(async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (xlsInputRef.current) xlsInputRef.current.value = '';
    try {
      setImportStatus({ label: 'Creating document...', progress: 0 });
      const { importXlsxFile } = await import('./import-xlsx');
      const docId = await importXlsxFile(file, setImportStatus);
      setImportStatus(null);
      window.location.hash = docUrl(docId);
    } catch (err: any) {
      setImportStatus(null);
      setError('Failed to import: ' + err.message);
    }
  }, []);

  const docLabel = (entry: DocEntry) => docTypeLabel(entry.type);

  const handleArchive = async (entry: DocEntry) => {
    const label = docLabel(entry);
    const capLabel = label.charAt(0).toUpperCase() + label.slice(1);
    setError('');
    // Optimistic removal — the worker's tombstone guarantees it sticks even
    // when the access revoke fails (e.g. a grant a contact issued).
    setEntries(prev => prev.filter(e => e.documentId !== entry.documentId));
    try {
      const { status } = await archiveDoc(entry.documentId);
      setMessage(status === 'revoked'
        ? `${capLabel} archived`
        : `${capLabel} archived on this device — your access couldn't be fully revoked, so it may still appear on your other devices`);
    } catch (err: any) {
      setError(`Failed to archive ${label}: ${err?.message ?? err}`);
    }
  };

  const jsonInputRef = useRef<HTMLInputElement>(null);

  /** Import one document per file — `.json` documents and `.md` as Sentences
   *  (see `createDocsFromItems` in import-docs.ts, loaded on demand). The
   *  picker allows multiple files (see `multiple` on the input below), so a
   *  folder can be loaded in one go. */
  const handleImportJson = useCallback(async (e: Event) => {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    if (files.length === 0) return;
    if (jsonInputRef.current) jsonInputRef.current.value = '';
    setError('');
    setMessage('');

    const { createDocsFromItems } = await import('./import-docs');
    const { created, failures } = await createDocsFromItems(
      files.map(f => /\.md$/i.test(f.name)
        ? { kind: 'markdown' as const, label: f.name, read: () => f.text() }
        : { kind: 'json' as const, label: f.name, read: () => f.text().then(JSON.parse) }),
      'Importing',
      setImportStatus,
    );

    if (failures.length) {
      setError(`Import failed — ${failures.join('; ')}`);
    }
    if (created.length === 1 && !failures.length) {
      // Single document: open it, as before. Types with no registered plugin
      // resolve to the source inspector via DocRoute.
      window.location.hash = docUrl(created[0]);
    } else if (created.length) {
      setMessage(`Imported ${created.length} document${created.length === 1 ? '' : 's'}`);
    }
  }, []);

  /** Offered when the document list is empty — creates the bundled examples/. */
  const [creatingExamples, setCreatingExamples] = useState(false);
  const handleCreateExamples = useCallback(async () => {
    setError('');
    setMessage('');
    setCreatingExamples(true);
    try {
      const [{ exampleDocs }, { createDocsFromItems }] = await Promise.all([
        import('./examples'),
        import('./import-docs'),
      ]);
      const { created, failures } = await createDocsFromItems(exampleDocs(), 'Creating', setImportStatus);
      if (failures.length) setError(`Some examples couldn't be created — ${failures.join('; ')}`);
      if (created.length) setMessage(`Created ${created.length} example document${created.length === 1 ? '' : 's'}`);
    } catch (err: any) {
      setError(`Couldn't load the examples: ${err?.message ?? err}`);
    } finally {
      setCreatingExamples(false);
    }
  }, []);

  const icsInputRef = useRef<HTMLInputElement>(null);

  const handleImportIcs = useCallback(async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (icsInputRef.current) icsInputRef.current.value = '';
    try {
      setImportStatus({ label: 'Reading .ics file...', progress: 0 });
      const text = await file.text();
      setImportStatus({ label: 'Parsing events...', progress: 30 });
      await new Promise(r => setTimeout(r, 0));
      const { icsToEvent } = await import('../doc-plugins/calendar/ics-parser');
      const parsed = icsToEvent(text);
      setImportStatus({ label: 'Saving calendar...', progress: 80 });
      await new Promise(r => setTimeout(r, 0));
      const calName = file.name.replace(/\.ics$/i, '') || 'Imported';
      const events: Record<string, any> = {};
      for (const { uid, event } of parsed) events[uid] = event;
      const { docId } = await createDoc({ '@type': 'Calendar', name: calName, events }, { type: 'Calendar', name: calName });
      setImportStatus(null);
      window.location.hash = docUrl(docId);
    } catch (err: any) {
      setImportStatus(null);
      setError('Import failed: ' + err.message);
    }
  }, []);

  useInstallNudge();

  const sortedEntries = useMemo(() => {
    const indexById = new Map(entries.map((e, i) => [e.documentId, i]));
    const noAccess = (e: DocEntry) => e.access === null;
    return [...entries].sort((a, b) => {
      // No-access (revoked) docs always sink to the bottom
      const aNo = noAccess(a), bNo = noAccess(b);
      if (aNo !== bNo) return aNo ? 1 : -1;

      // Both have lastUpdated: sort newest first, tiebreak by id for stability
      if (a.lastUpdated && b.lastUpdated) {
        const cmp = b.lastUpdated.localeCompare(a.lastUpdated);
        return cmp !== 0 ? cmp : a.documentId.localeCompare(b.documentId);
      }
      // Only one has lastUpdated: it goes first
      if (a.lastUpdated && !b.lastUpdated) return -1;
      if (!a.lastUpdated && b.lastUpdated) return 1;
      // Neither has lastUpdated: preserve localStorage order
      return indexById.get(a.documentId)! - indexById.get(b.documentId)!;
    });
  }, [entries]);

  // The aggregate view is only useful with 2+ calendars to overlay. Count the
  // doc types it renders (see CALENDARISH_TYPES in AllCalendars), excluding
  // revoked docs.
  const calendarCount = useMemo(
    () => entries.filter(e => e.access !== null && (e.type === 'Calendar' || e.type === 'Calendar+Counters')).length,
    [entries],
  );

  // Top-app-bar overflow: app-level destinations that used to be toolbar buttons.
  const homeMenuItems: OverflowMenuItem[] = [
    ...(calendarCount > 1
      ? [{ icon: 'date_range', label: 'All calendars', href: '#/calendars/' }]
      : []),
    { icon: 'group', label: 'Friends', href: '#/friends' },
    { icon: 'settings', label: 'Settings', href: '#/settings' },
  ];

  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-28">
      {/* Top app bar */}
      <div className="flex items-center gap-2 min-h-14 pl-2">
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Documents</h1>
        <ConnectionStatus peers={repoPeers.map(peerId => ({ peerId }))} />
        <OverflowMenu aria-label="Menu" items={homeMenuItems} />
      </div>

      {importStatus && (
        <Alert className="mb-2 flex items-center gap-3">
          <span className="text-sm whitespace-nowrap">{importStatus.label}</span>
          <Progress className="flex-1" value={importStatus.progress} />
        </Alert>
      )}
      {message && (
        <Alert variant="success" className="mb-2 flex items-center justify-between">
          <span>{message}</span>
          <button className="ml-2 text-lg leading-none opacity-50 hover:opacity-100" onClick={() => setMessage('')}>&times;</button>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mb-2 flex items-center justify-between">
          <span>{error}</span>
          <button className="ml-2 text-lg leading-none opacity-50 hover:opacity-100" onClick={() => setError('')}>&times;</button>
        </Alert>
      )}

      {/* Document list */}
      <md-list style={{ background: 'transparent' }}>
        {sortedEntries.map(entry => (
          <DocListItem
            key={entry.documentId}
            entry={entry}
            unseenFlag={!!unseen[entry.documentId]}
            onOpen={e => { window.location.hash = docUrl(e.documentId); }}
            onActions={setActionsEntry}
          />
        ))}
      </md-list>
      {entries.length === 0 && (
        listLoading ? (
          <p className="text-sm text-muted-foreground py-4">Loading documents…</p>
        ) : (
          <div className="py-6 text-center" data-testid="empty-home">
            <p className="md-body-medium text-muted-foreground mb-1">No documents yet.</p>
            <p className="md-body-medium text-muted-foreground mb-4">
              Would you like a few example documents to look through?
            </p>
            <Button variant="outline" onClick={handleCreateExamples} disabled={creatingExamples} data-testid="create-examples">
              <span className="material-symbols-outlined">auto_awesome</span>
              {creatingExamples ? 'Creating examples…' : 'Yes, create examples'}
            </Button>
          </div>
        )
      )}

      {/* Hidden import inputs (targets of the Create sheet's import rows) */}
      <input type="file" ref={icsInputRef} accept=".ics,text/calendar" style={{ display: 'none' }} onChange={handleImportIcs as any} />
      <input type="file" ref={xlsInputRef} accept=".xls,.xlsx,.csv" style={{ display: 'none' }} onChange={handleImportXlsx as any} />
      <input type="file" multiple ref={jsonInputRef} accept=".json,.md,application/json,text/markdown" style={{ display: 'none' }} onChange={handleImportJson as any} />

      <div className="text-xs text-muted-foreground mt-4 text-center">
        <a href={`https://github.com/philschatz/drive/commit/${__APP_VERSION__}`} target="_blank" rel="noopener noreferrer" className="hover:underline">{__APP_VERSION__}</a> · built {dayjs(__BUILD_TIME__).fromNow()}
      </div>

      {/* FAB → Create sheet (doc types + imports) */}
      <Fab icon="add" aria-label="New document" onClick={() => setCreateOpen(true)} />
      <CreateDocSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
        onImport={(kind: ImportKind) => {
          const ref = kind === 'ics' ? icsInputRef : kind === 'xlsx' ? xlsInputRef : jsonInputRef;
          ref.current?.click();
        }}
      />

      {/* Long-press / kebab → per-doc actions, with Rename as a follow-up */}
      <DocActionsSheet
        entry={actionsEntry}
        onOpenChange={open => { if (!open) setActionsEntry(null); }}
        onShare={e => { window.location.hash = shareUrl(e.documentId); }}
        onRename={e => setRenameEntry(e)}
        onArchive={e => {
          if (confirm(`Archive "${e.name || 'Untitled'}" ${docLabel(e as DocEntry)}?`)) {
            handleArchive(e as DocEntry);
          }
        }}
      />

      <RenameSheet
        open={!!renameEntry}
        title="Rename document"
        value={renameEntry?.name || 'Untitled'}
        onRename={name => {
          if (renameEntry) updateDoc(renameEntry.documentId, (d, n) => { d.name = n; }, name);
        }}
        onClose={() => setRenameEntry(null)}
      />
    </div>
  );
}
