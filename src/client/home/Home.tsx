import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { useConnectionStatus, usePeerList, isSyncEnabled, setSyncEnabled } from '../../shared/automerge';
import { createDoc, subscribeQuery, HOME_SUMMARY_QUERY } from '../worker-api';
import { peerColor } from '../../shared/presence';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import dayjs from 'dayjs';
import relativeTimePlugin from 'dayjs/plugin/relativeTime';
import { a1ToInternal } from '@/datagrid/helpers';
import { getDocList, addDocId, removeDocId, updateDocCache } from '@/doc-storage';

type DocType = 'Calendar' | 'TaskList' | 'DataGrid' | 'unknown';

interface DocEntry {
  type: DocType;
  documentId: string;
  name: string;
  count: number | null;
  lastUpdated: string | null;
  loading: boolean;
  peers: string[];
}

dayjs.extend(relativeTimePlugin);

function relativeTime(ts: string | null): string {
  if (!ts) return '';
  return dayjs(ts).fromNow();
}

function viewPathForType(type: DocType, documentId: string): string {
  if (type === 'Calendar') return `#/calendars/${documentId}`;
  if (type === 'TaskList') return `#/tasks/${documentId}`;
  if (type === 'DataGrid') return `#/datagrids/${documentId}`;
  return `#/source/${documentId}`;
}

function iconForType(type: DocType): string {
  if (type === 'Calendar') return 'date_range';
  if (type === 'TaskList') return 'checklist';
  if (type === 'DataGrid') return 'grid_on';
  return 'help';
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
  }));
}

function applyQueryResult(prev: DocEntry[], docId: string, result: any): DocEntry[] {
  return prev.map(e => {
    if (e.documentId !== docId) return e;
    const type = (result.type === 'Calendar' || result.type === 'TaskList' || result.type === 'DataGrid')
      ? result.type as DocType : 'unknown';
    const count = result.eventCount || result.taskCount || result.rowCount || null;
    return { ...e, type, name: result.name || e.name, count, loading: false };
  });
}

export function Home({ path }: { path?: string }) {
  const [entries, setEntries] = useState<DocEntry[]>(initialEntries);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const connected = useConnectionStatus();
  const repoPeers = usePeerList();

  // Subscribe to doc summaries from the worker
  const docIdKey = entries.map(e => e.documentId).join(',');
  useEffect(() => {
    const docIds = docIdKey ? docIdKey.split(',') : [];
    if (docIds.length === 0) return;
    const unsubs = docIds.map(docId =>
      subscribeQuery(docId, HOME_SUMMARY_QUERY, (result) => {
        if (!result) return;
        const type = (result.type === 'Calendar' || result.type === 'TaskList' || result.type === 'DataGrid')
          ? result.type as DocType : 'unknown';
        updateDocCache(docId, { type, name: result.name });
        setEntries(prev => applyQueryResult(prev, docId, result));
      })
    );
    return () => unsubs.forEach(u => u());
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
        }));
      return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
    });
  }, []);

  const handleCreateCalendar = async () => {
    const name = prompt('Calendar name:', 'Untitled');
    if (name === null) return;
    const resolvedName = name || 'Untitled';
    const { docId, khDocId } = await createDoc({ '@type': 'Calendar', name: resolvedName, events: {} });
    addDocId(docId, { type: 'Calendar', name: resolvedName, khDocId });
    setMessage('Calendar created');
    setError('');
    reloadEntries();
  };

  const handleCreateTaskList = async () => {
    const name = prompt('Task list name:', 'Untitled');
    if (name === null) return;
    const resolvedName = name || 'Untitled';
    const { docId, khDocId } = await createDoc({ '@type': 'TaskList', name: resolvedName, tasks: {} });
    addDocId(docId, { type: 'TaskList', name: resolvedName, khDocId });
    setMessage('Task list created');
    setError('');
    reloadEntries();
  };

  const handleCreateDataGrid = async () => {
    const name = prompt('Spreadsheet name:', 'Untitled');
    if (name === null) return;
    const resolvedName = name || 'Untitled';
    const sid = () => Math.random().toString(36).slice(2, 10);
    const sheetId = sid();
    const rows: Record<string, { index: number }> = {};
    for (let i = 1; i <= 10; i++) rows[sid()] = { index: i };
    const { docId, khDocId } = await createDoc({
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
    });
    addDocId(docId, { type: 'DataGrid', name: resolvedName, khDocId });
    setMessage('Spreadsheet created');
    setError('');
    reloadEntries();
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
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const sid = () => Math.random().toString(36).slice(2, 10);
      const name = file.name.replace(/\.(xlsx?|csv)$/i, '') || 'Imported';

      const sheetNameToId = new Map<string, string>();
      const sheetIdToRowColIds = new Map<string, { rowIds: string[]; colIds: string[] }>();
      const sheetDefs: {
        sheetId: string; sheetName: string; hidden: boolean;
        columns: Record<string, { index: number; hidden?: boolean }>;
        rowsMap: Record<string, { index: number; hidden?: boolean }>;
        colIds: string[]; rowIds: string[];
        rows2d: any[][]; ws: any;
      }[] = [];

      for (let si = 0; si < wb.SheetNames.length; si++) {
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
            } else {
              stored = String(val);
            }
            cells[`${rowIds[r]}:${colIds[c]}`] = { value: stored };
          }
        }

        const { hidden } = sheetDefs[si];
        builtSheets.push({ sheetId, sheetName, index: si + 1, hidden, columns, rows: rowsMap, cells });
      }

      const sheets: Record<string, any> = {};
      for (const s of builtSheets) {
        sheets[s.sheetId] = {
          '@type': 'Sheet', name: s.sheetName, index: s.index,
          ...(s.hidden ? { hidden: true } : {}),
          columns: s.columns, rows: s.rows, cells: s.cells,
        };
      }
      const { docId, khDocId } = await createDoc({ '@type': 'DataGrid', name, sheets });
      addDocId(docId, { type: 'DataGrid', name, khDocId });
      alert(`/datagrids/${docId}`)
    } catch (err: any) {
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

  const icsInputRef = useRef<HTMLInputElement>(null);

  const handleImportIcs = useCallback(async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (icsInputRef.current) icsInputRef.current.value = '';
    try {
      const text = await file.text();
      const { icsToEvent } = await import('../../shared/ics-parser');
      const parsed = icsToEvent(text);
      const calName = file.name.replace(/\.ics$/i, '') || 'Imported';
      const events: Record<string, any> = {};
      for (const { uid, event } of parsed) events[uid] = event;
      const { docId, khDocId } = await createDoc({ '@type': 'Calendar', name: calName, events });
      addDocId(docId, { type: 'Calendar', name: calName, khDocId });
      setMessage(`Imported ${parsed.length} event${parsed.length !== 1 ? 's' : ''} into "${calName}"`);
      setError('');
      reloadEntries();
    } catch (err: any) {
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

  const syncOn = isSyncEnabled();

  const sortedEntries = useMemo(() => {
    const indexById = new Map(entries.map((e, i) => [e.documentId, i]));
    return [...entries].sort((a, b) => {
      // Both have lastUpdated: sort newest first
      if (a.lastUpdated && b.lastUpdated) return b.lastUpdated.localeCompare(a.lastUpdated);
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
            title={`Peer ${peerId.slice(0, 8)}`}
          />
        ))}
      </div>

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
          </DropdownMenuContent>
        </DropdownMenu>
        <input type="file" ref={icsInputRef} accept=".ics,text/calendar" style={{ display: 'none' }} onChange={handleImportIcs as any} />
        <input type="file" ref={xlsInputRef} accept=".xls,.xlsx,.csv" style={{ display: 'none' }} onChange={handleImportXlsx as any} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <span className="material-symbols-outlined">upload_file</span> Import
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => icsInputRef.current?.click()}>
              <span className="material-symbols-outlined">date_range</span> Import .ics
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => xlsInputRef.current?.click()}>
              <span className="material-symbols-outlined">grid_on</span> Import .xlsx
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col">
        {sortedEntries.map(entry => {
          const viewPath = viewPathForType(entry.type, entry.documentId);
          const icon = iconForType(entry.type);
          return (
            <div
              key={entry.documentId}
              className="flex items-center gap-2 py-1 px-1 flex-nowrap border-b border-border"
            >
              <span className="material-symbols-outlined" style={{ width: '1.2rem', textAlign: 'center', color: '#666' }}>{icon}</span>
              <a href={viewPath} className="text-sm flex-1 hover:underline flex items-center gap-1">
                {entry.name || 'Untitled'}
                {entry.peers.map(peerId => (
                  <span
                    key={peerId}
                    className="w-2 h-2 rounded-full inline-block shrink-0"
                    style={{ backgroundColor: peerColor(peerId) }}
                    title={`Peer ${peerId.slice(0, 8)} is viewing`}
                  />
                ))}
              </a>
              {entry.loading ? (
                <Progress className="w-16" value={0} title="Loading..." />
              ) : (
                <>
                  <a href={viewPath} className="text-xs text-muted-foreground no-underline" style={{ minWidth: '4rem', textAlign: 'right' }} title={entry.lastUpdated || undefined}>
                    {relativeTime(entry.lastUpdated)}
                  </a>
                  <a href={viewPath} className="text-xs text-muted-foreground no-underline">
                    ({entry.count ?? 0})
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
                className="inline-flex items-center justify-center h-8 w-8 rounded-md text-destructive hover:bg-destructive/10"
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
        <a href="#/settings">
          <Button variant="outline" size="sm">
            <span className="material-symbols-outlined">settings</span> Settings & Devices
          </Button>
        </a>
      </div>

      <div className="flex items-center gap-2 mb-6">
        <span className="text-xs text-muted-foreground">Sync server</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSyncEnabled(!syncOn);
            location.reload();
          }}
        >
          {syncOn ? 'Disable & reload' : 'Enable & reload'}
        </Button>
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
    </div>
  );
}
