import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { useConnectionStatus, usePeerList } from '../shared/automerge';
import { createDoc, subscribeQuery, HOME_SUMMARY_QUERY } from '../worker-api';
import { getMyAccess, onKeyhiveStateChanged } from '../shared/keyhive-api';
import { getCachedAccess } from '../shared/useAccess';
import { peerColor, peerDisplayName } from '../shared/presence';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import dayjs from 'dayjs';
import relativeTimePlugin from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTimePlugin);
import { a1ToInternal } from '@/datagrid/helpers';
import { getDocList, addDocId, removeDocId, updateDocCache, onDocListUpdated } from '@/doc-storage';
import { type DocType, viewPathForType, iconForType } from '@/shared/doc-type-helpers';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface DocEntry {
  type: DocType;
  documentId: string;
  name: string;
  count: number | null;
  lastUpdated: string | null;
  loading: boolean;
  peers: string[];
  encrypted?: boolean;
  /** null = no access / revoked, undefined = not yet checked */
  access?: string | null;
}

function relativeTime(ts: string | null): string {
  if (!ts) return '';
  return dayjs(ts).fromNow();
}

function initialEntries(): DocEntry[] {
  return getDocList().map(e => ({
    type: (e.type || 'unknown') as DocType,
    documentId: e.id,
    name: e.name || e.id.slice(0, 8),
    count: null,
    lastUpdated: null,
    loading: true,
    peers: [],
    encrypted: e.encrypted,
    access: e.encrypted ? getCachedAccess(e.id) : undefined,
  }));
}

function applyQueryResult(prev: DocEntry[], docId: string, result: any, lastModified?: number): DocEntry[] {
  return prev.map(e => {
    if (e.documentId !== docId) return e;
    const type = (result.type === 'Calendar' || result.type === 'TaskList' || result.type === 'DataGrid')
      ? result.type as DocType : 'unknown';
    const count = result.eventCount || result.taskCount || result.cellCount || null;
    const lastUpdated = lastModified ? new Date(lastModified * 1000).toISOString() : e.lastUpdated;
    return { ...e, type, name: result.name || e.name, count, lastUpdated, loading: false };
  });
}

export function Home({ path }: { path?: string }) {
  const [entries, setEntries] = useState<DocEntry[]>(initialEntries);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [importStatus, setImportStatus] = useState<{ label: string; progress: number } | null>(null);
  const connected = useConnectionStatus();
  const repoPeers = usePeerList();
  const showUnencrypted = localStorage.getItem('showUnencrypted') !== 'false';
  const createSecure = !showUnencrypted;

  useEffect(() => { document.title = 'Automerge Documents'; }, []);

  // Subscribe to worker-pushed doc list updates (IDB → localStorage cache)
  useEffect(() => {
    return onDocListUpdated((list) => {
      setEntries((prev) => {
        const existing = new Map(prev.map((e) => [e.documentId, e]));
        return list.map(
          (e) =>
            existing.get(e.id) ?? {
              documentId: e.id,
              type: (e.type || 'unknown') as DocType,
              name: e.name || e.id.slice(0, 8),
              count: null,
              lastUpdated: null,
              loading: true,
              peers: [],
              encrypted: e.encrypted,
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
        const type = (result.type === 'Calendar' || result.type === 'TaskList' || result.type === 'DataGrid')
          ? result.type as DocType : 'unknown';
        updateDocCache(docId, { type, name: result.name });
        setEntries(prev => applyQueryResult(prev, docId, result, lastModified));
      })
    );

    // Fetch keyhive access for encrypted docs
    const fetchAccessForDocs = () => {
      for (const docId of docIds) {
        const entry = getDocList().find(e => e.id === docId);
        if (entry?.encrypted) {
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
      }
    };
    fetchAccessForDocs();

    // Re-fetch access when keyhive state changes (member added/revoked)
    const unsubStateChanged = onKeyhiveStateChanged(fetchAccessForDocs);

    return () => { unsubs.forEach(u => u()); unsubStateChanged(); };
  }, [docIdKey]); // eslint-disable-line react-hooks/exhaustive-deps


  const reloadEntries = useCallback(() => {
    const docList = getDocList();
    if (docList.length === 0) return;
    setEntries(prev => {
      const existing = new Set(prev.map(e => e.documentId));
      const newEntries: DocEntry[] = docList
        .filter(e => !existing.has(e.id))
        .map(e => ({
          type: (e.type || 'unknown') as DocType,
          documentId: e.id,
          name: e.name || e.id.slice(0, 8),
          count: null,
          lastUpdated: null,
          loading: true,
          peers: [],
          encrypted: e.encrypted,
        }));
      return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
    });
  }, []);

  const handleCreateCalendar = async () => {
    const name = prompt('Calendar name:', 'Untitled');
    if (name === null) return;
    const resolvedName = name || 'Untitled';
    const { docId } = await createDoc({ '@type': 'Calendar', name: resolvedName, events: {} }, createSecure);
    addDocId(docId, { type: 'Calendar', name: resolvedName, encrypted: createSecure });
    window.location.hash = viewPathForType('Calendar', docId);
  };

  const handleCreateTaskList = async () => {
    const name = prompt('Task list name:', 'Untitled');
    if (name === null) return;
    const resolvedName = name || 'Untitled';
    const { docId } = await createDoc({ '@type': 'TaskList', name: resolvedName, tasks: {} }, createSecure);
    addDocId(docId, { type: 'TaskList', name: resolvedName, encrypted: createSecure });
    window.location.hash = viewPathForType('TaskList', docId);
  };

  const handleCreateDataGrid = async () => {
    const name = prompt('Spreadsheet name:', 'Untitled');
    if (name === null) return;
    const resolvedName = name || 'Untitled';
    const sid = () => Math.random().toString(36).slice(2, 10);
    const sheetId = sid();
    const rows: Record<string, { index: number }> = {};
    for (let i = 1; i <= 10; i++) rows[sid()] = { index: i };
    const { docId } = await createDoc({
      '@type': 'DataGrid',
      name: resolvedName,
      sheets: {
        [sheetId]: {
          '@type': 'Sheet',
          name: 'Sheet 1',
          index: 1,
          columns: { [sid()]: { index: 1 }, [sid()]: { index: 2 }, [sid()]: { index: 3 } },
          rows,
          cells: {},
        },
      },
    }, createSecure);
    addDocId(docId, { type: 'DataGrid', name: resolvedName, encrypted: createSecure });
    window.location.hash = viewPathForType('DataGrid', docId);
  };

  const xlsInputRef = useRef<HTMLInputElement>(null);

  /** Google Sheets wraps functions unsupported by Excel as
   *  IFERROR(__xludf.DUMMYFUNCTION("REAL_FORMULA"),"fallback").
   *  Detect and unwrap to get the original formula. */
  const unwrapDummyFunction = (f: string): string => {
    const prefix = 'IFERROR(__xludf.DUMMYFUNCTION("';
    if (!f.toUpperCase().startsWith(prefix.toUpperCase())) return f;
    let i = prefix.length;
    let inner = '';
    while (i < f.length) {
      if (f[i] === '"') {
        if (f[i + 1] === '"') { inner += '"'; i += 2; }
        else break;
      } else { inner += f[i]; i++; }
    }
    return inner || f;
  };

  const handleImportXlsx = useCallback(async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (xlsInputRef.current) xlsInputRef.current.value = '';

    try {
      setImportStatus({ label: 'Reading file...', progress: 0 });
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
      const sid = () => Math.random().toString(36).slice(2, 10);
      const name = file.name.replace(/\.(xlsx?|csv)$/i, '') || 'Imported';
      const totalSheets = wb.SheetNames.length;

      const sheetNameToId = new Map<string, string>();
      const sheetIdToRowColIds = new Map<string, { rowIds: string[]; colIds: string[] }>();
      const sheetDefs: {
        sheetId: string; sheetName: string; hidden: boolean;
        columns: Record<string, { index: number; hidden?: boolean }>;
        rowsMap: Record<string, { index: number; hidden?: boolean }>;
        colIds: string[]; rowIds: string[];
        rows2d: any[][]; ws: any;
      }[] = [];

      for (let si = 0; si < totalSheets; si++) {
        const sheetName = wb.SheetNames[si];
        const ws = wb.Sheets[sheetName];
        const rows2d: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const sheetId = sid();
        sheetNameToId.set(sheetName, sheetId);

        const colCount = rows2d.reduce((max, row) => Math.max(max, row.length), 0) || 1;
        const wsCols = ws['!cols'] || [];
        const columns: Record<string, { index: number; hidden?: boolean }> = {};
        const colIds: string[] = [];
        for (let c = 0; c < colCount; c++) {
          const cid = sid();
          colIds.push(cid);
          const col: { index: number; hidden?: boolean } = { index: c + 1 };
          if (wsCols[c]?.hidden) col.hidden = true;
          columns[cid] = col;
        }

        const wsRows = ws['!rows'] || [];
        const rowsMap: Record<string, { index: number; hidden?: boolean }> = {};
        const rowIds: string[] = [];
        const rowCount = Math.max(rows2d.length, 1);
        for (let r = 0; r < rowCount; r++) {
          const rid = sid();
          rowIds.push(rid);
          const row: { index: number; hidden?: boolean } = { index: r + 1 };
          if (wsRows[r]?.hidden) row.hidden = true;
          rowsMap[rid] = row;
        }

        const sheetHidden = !!(wb as any).Workbook?.Sheets?.[si]?.Hidden;
        sheetIdToRowColIds.set(sheetId, { rowIds, colIds });
        sheetDefs.push({ sheetId, sheetName, hidden: sheetHidden, columns, rowsMap, colIds, rowIds, rows2d, ws });
      }

      const lookupSheetId = (n: string) => sheetNameToId.get(n);
      const lookupSheetRowColIds = (id: string) => sheetIdToRowColIds.get(id);

      const builtSheets: {
        sheetId: string; sheetName: string; index: number; hidden: boolean;
        columns: Record<string, { index: number; hidden?: boolean }>;
        rows: Record<string, { index: number; hidden?: boolean }>;
        cells: Record<string, { value: string }>;
      }[] = [];

      for (let si = 0; si < sheetDefs.length; si++) {
        setImportStatus({ label: `Processing sheet ${si + 1}/${totalSheets}...`, progress: Math.round(((si) / totalSheets) * 90) });
        await new Promise(r => setTimeout(r, 0)); // yield to UI

        const { sheetId, sheetName, columns, rowsMap, colIds, rowIds, rows2d, ws } = sheetDefs[si];
        const cells: Record<string, { value: string }> = {};
        const ref = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;

        for (let r = 0; r < rows2d.length; r++) {
          const row = rows2d[r];
          for (let c = 0; c < row.length; c++) {
            const val = row[c];
            if (val == null || val === '') continue;
            const cellAddr = XLSX.utils.encode_cell({ r: (ref?.s.r ?? 0) + r, c: (ref?.s.c ?? 0) + c });
            const wsCell = ws[cellAddr];
            let stored: string;
            if (wsCell?.f) {
              const formula = unwrapDummyFunction(wsCell.f);
              if (/^"[^"]*"$/.test(formula)) continue;
              try {
                stored = a1ToInternal('=' + formula, r, c, rowIds, colIds, lookupSheetId, lookupSheetRowColIds);
              } catch {
                stored = String(val);
              }
            } else if (val instanceof Date) {
              const mm = String(val.getMonth() + 1).padStart(2, '0');
              const dd = String(val.getDate()).padStart(2, '0');
              const yyyy = val.getFullYear();
              stored = `${mm}/${dd}/${yyyy}`;
            } else if (wsCell?.t === 'n' && wsCell.z && XLSX.SSF.is_date(wsCell.z) && wsCell.w) {
              stored = wsCell.w;
            } else {
              stored = String(val);
            }
            cells[`${rowIds[r]}:${colIds[c]}`] = { value: stored };
          }
        }

        const { hidden } = sheetDefs[si];
        builtSheets.push({ sheetId, sheetName, index: si + 1, hidden, columns, rows: rowsMap, cells });
      }

      setImportStatus({ label: 'Saving document...', progress: 95 });
      await new Promise(r => setTimeout(r, 0));

      const sheets: Record<string, any> = {};
      for (const s of builtSheets) {
        sheets[s.sheetId] = {
          '@type': 'Sheet', name: s.sheetName, index: s.index,
          ...(s.hidden ? { hidden: true } : {}),
          columns: s.columns, rows: s.rows, cells: s.cells,
        };
      }
      const { docId } = await createDoc({ '@type': 'DataGrid', name, sheets }, createSecure);
      addDocId(docId, { type: 'DataGrid', name, encrypted: createSecure });
      setImportStatus(null);
      window.location.hash = viewPathForType('DataGrid', docId);
    } catch (err: any) {
      setImportStatus(null);
      setError('Failed to import: ' + err.message);
    }
  }, []);

  const handleDelete = async (entry: DocEntry) => {
    const label = entry.type === 'Calendar' ? 'calendar' : entry.type === 'TaskList' ? 'task list' : entry.type === 'DataGrid' ? 'spreadsheet' : 'document';
    if (!confirm(`Delete "${entry.name || 'Untitled'}" ${label}?`)) return;
    removeDocId(entry.documentId);
    setMessage(`${label.charAt(0).toUpperCase() + label.slice(1)} deleted`);
    setError('');
    setEntries(prev => prev.filter(e => e.documentId !== entry.documentId));
  };

  const jsonInputRef = useRef<HTMLInputElement>(null);

  const handleImportJson = useCallback(async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (jsonInputRef.current) jsonInputRef.current.value = '';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('Invalid JSON: expected an object');
      const name = data.name || file.name.replace(/\.json$/i, '') || 'Imported';
      const { docId } = await createDoc(data, createSecure);
      const type = (data['@type'] === 'Calendar' || data['@type'] === 'TaskList' || data['@type'] === 'DataGrid')
        ? data['@type'] as DocType : 'unknown';
      addDocId(docId, { type, name, encrypted: createSecure });
      window.location.hash = viewPathForType(type, docId);
    } catch (err: any) {
      setError('Import failed: ' + err.message);
    }
  }, [reloadEntries]);

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
      const { icsToEvent } = await import('../shared/ics-parser');
      const parsed = icsToEvent(text);
      setImportStatus({ label: 'Saving calendar...', progress: 80 });
      await new Promise(r => setTimeout(r, 0));
      const calName = file.name.replace(/\.ics$/i, '') || 'Imported';
      const events: Record<string, any> = {};
      for (const { uid, event } of parsed) events[uid] = event;
      const { docId } = await createDoc({ '@type': 'Calendar', name: calName, events }, createSecure);
      addDocId(docId, { type: 'Calendar', name: calName, encrypted: createSecure });
      setImportStatus(null);
      window.location.hash = viewPathForType('Calendar', docId);
    } catch (err: any) {
      setImportStatus(null);
      setError('Import failed: ' + err.message);
    }
  }, [reloadEntries]);

  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as any).standalone === true;

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  };

  const sortedEntries = useMemo(() => {
    const indexById = new Map(entries.map((e, i) => [e.documentId, i]));
    return [...entries].sort((a, b) => {
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

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h1 className="text-2xl font-bold">Automerge Documents</h1>
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: connected ? '#4caf50' : '#f44336' }}
          title={connected ? 'Connected to server' : 'Disconnected from server'}
        />
        <span className="text-xs text-muted-foreground">{connected ? 'Connected' : 'Disconnected'}</span>
        {repoPeers.map(peerId => (
          <span
            key={peerId}
            className="w-2 h-2 rounded-full inline-block shrink-0"
            style={{ backgroundColor: peerColor(peerId) }}
            title={peerDisplayName(peerId)}
          />
        ))}
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

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <a href="#/calendars/">
          <Button variant="outline">
            <span className="material-symbols-outlined">date_range</span> All calendars
          </Button>
        </a>
        <a href="#/contacts">
          <Button variant="outline">
            <span className="material-symbols-outlined">contacts</span> Contacts
          </Button>
        </a>
        <a href="#/settings">
          <Button variant="outline">
            <span className="material-symbols-outlined">settings</span> Settings
          </Button>
        </a>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <span className="material-symbols-outlined">add</span> New
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={handleCreateCalendar}>
              <span className="material-symbols-outlined">date_range</span> Calendar
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCreateTaskList}>
              <span className="material-symbols-outlined">checklist</span> Task list
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleCreateDataGrid}>
              <span className="material-symbols-outlined">grid_on</span> Spreadsheet
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => icsInputRef.current?.click()}>
              <span className="material-symbols-outlined">date_range</span> Import .ics
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => xlsInputRef.current?.click()}>
              <span className="material-symbols-outlined">grid_on</span> Import .xlsx
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => jsonInputRef.current?.click()}>
              <span className="material-symbols-outlined">code</span> Import .json
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                const next = !showUnencrypted;
                localStorage.setItem('showUnencrypted', String(next));
                location.reload();
              }}
              title="Enable unencrypted documents and the insecure sync server"
            >
              <span className="material-symbols-outlined">{showUnencrypted ? 'check_box' : 'check_box_outline_blank'}</span>
              <span className="material-symbols-outlined" style={{ fontSize: '1rem' }}>{showUnencrypted ? 'visibility' : 'lock'}</span>
              Unencrypted
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input type="file" ref={icsInputRef} accept=".ics,text/calendar" style={{ display: 'none' }} onChange={handleImportIcs as any} />
        <input type="file" ref={xlsInputRef} accept=".xls,.xlsx,.csv" style={{ display: 'none' }} onChange={handleImportXlsx as any} />
        <input type="file" ref={jsonInputRef} accept=".json,application/json" style={{ display: 'none' }} onChange={handleImportJson as any} />
      </div>

      <div className="flex flex-col">
        {sortedEntries.map(entry => {
          const disabled = !showUnencrypted && !entry.encrypted;
          const noEntryAccess = entry.encrypted && entry.access === null;
          const viewPath = viewPathForType(entry.type, entry.documentId);
          const icon = iconForType(entry.type);
          return (
            <div
              key={entry.documentId}
              className={`flex items-center gap-2 py-1 px-1 flex-nowrap border-b border-border${disabled ? ' opacity-40 pointer-events-none' : ''}`}
            >
              <span className="material-symbols-outlined" style={{ width: '1rem', textAlign: 'center', color: '#999', fontSize: '0.9rem' }} title={entry.encrypted ? 'Encrypted' : 'Unencrypted'}>
                {entry.encrypted ? 'lock' : 'visibility'}
              </span>
              <span className="material-symbols-outlined" style={{ width: '1.2rem', textAlign: 'center', color: '#666' }}>{icon}</span>
              <a href={viewPath} className="text-sm flex-1 hover:underline flex items-center gap-1" style={noEntryAccess ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>
                {entry.name || 'Untitled'}
                {entry.peers.map(peerId => (
                  <span
                    key={peerId}
                    className="w-2 h-2 rounded-full inline-block shrink-0"
                    style={{ backgroundColor: peerColor(peerId) }}
                    title={`${peerDisplayName(peerId)} is viewing`}
                  />
                ))}
              </a>
              {entry.loading ? (
                <Progress className="w-16" value={0} title="Loading..." />
              ) : entry.encrypted && entry.access === null ? (
                <span className="text-xs text-muted-foreground flex items-center gap-1" title="You no longer have access to updates">
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>lock</span>
                  No access
                </span>
              ) : (
                <>
                  <a href={viewPath} className="text-xs text-muted-foreground no-underline" style={{ minWidth: '4rem', textAlign: 'right' }} title={entry.lastUpdated || undefined}>
                    {relativeTime(entry.lastUpdated)}
                  </a>
                  <a href={viewPath} className="text-xs text-muted-foreground no-underline">
                    ({(entry.count ?? 0).toLocaleString()})
                  </a>
                </>
              )}
              <a
                href={`#/source/${entry.documentId}`}
                className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                title="View Source"
              >
                <span className="material-symbols-outlined">code</span>
              </a>
              <button
                className="inline-flex items-center justify-center h-8 w-8 rounded-md text-destructive hover:bg-destructive/10 cursor-pointer"
                title="Delete"
                onClick={() => handleDelete(entry)}
              >
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
          );
        })}
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">No documents yet.</p>
        )}
      </div>

      <div className="flex items-center gap-2 mb-2">
        {installPrompt ? (
          <Button variant="outline" size="sm" onClick={handleInstall}>
            <span className="material-symbols-outlined">install_mobile</span> Add to Homescreen
          </Button>
        ) : !isStandalone && (
          <span className="text-xs text-muted-foreground">
            Install: use your browser's <em>"Add to Home screen"</em> or <em>"Install app"</em> menu option
          </span>
        )}
      </div>

      <div className="text-xs text-muted-foreground mt-4 text-center">
        <a href={`https://github.com/philschatz/drive/commit/${__APP_VERSION__}`} target="_blank" rel="noopener noreferrer" className="hover:underline">{__APP_VERSION__}</a> · built {dayjs(__BUILD_TIME__).fromNow()}
      </div>
    </div>
  );
}
