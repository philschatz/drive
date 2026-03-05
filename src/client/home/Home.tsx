import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { repo, Automerge, Presence, useConnectionStatus, getWsUrl, setWsUrl, findDocWithProgress } from '../../shared/automerge';
import type { DocHandle } from '../../shared/automerge';
import { peerColor } from '../../shared/presence';
import { usePresenceLog, PresenceLogTable } from '../../shared/PresenceLog';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import dayjs from 'dayjs';
import relativeTimePlugin from 'dayjs/plugin/relativeTime';
import { a1ToInternal } from '@/datagrid/helpers';

type DocType = 'Calendar' | 'TaskList' | 'DataGrid' | 'unknown';

interface DocEntry {
  type: DocType;
  documentId: string;
  handle: DocHandle<any> | null;
  name: string;
  count: number | null;
  lastUpdated: number | null;
  progress: number | null;
}

interface DocCache {
  type?: DocType;
  name?: string;
}

type DocMap = Record<string, DocCache>;

const DOC_STORAGE_KEY = 'automerge-doc-ids';

function getDocMap(): DocMap {
  try {
    const raw = JSON.parse(localStorage.getItem(DOC_STORAGE_KEY) || '{}');
    // Migrate from old array format
    if (Array.isArray(raw)) {
      const map: DocMap = {};
      for (const id of raw) map[id] = {};
      localStorage.setItem(DOC_STORAGE_KEY, JSON.stringify(map));
      return map;
    }
    return raw;
  } catch { return {}; }
}

function saveDocMap(map: DocMap) {
  localStorage.setItem(DOC_STORAGE_KEY, JSON.stringify(map));
}

function addDocId(id: string, cache?: DocCache) {
  const map = getDocMap();
  map[id] = cache || map[id] || {};
  saveDocMap(map);
}

function removeDocId(id: string) {
  const map = getDocMap();
  delete map[id];
  saveDocMap(map);
}

function updateDocCache(id: string, cache: DocCache) {
  const map = getDocMap();
  if (!(id in map)) return;
  map[id] = { ...map[id], ...cache };
  saveDocMap(map);
}

// Migrate old per-type storage keys into the unified key
function migrateOldStorageKeys() {
  const oldCalKey = 'automerge-calendar-ids';
  const oldTaskKey = 'automerge-tasklist-ids';
  let calIds: string[] = [];
  let taskIds: string[] = [];
  try { calIds = JSON.parse(localStorage.getItem(oldCalKey) || '[]'); } catch {}
  try { taskIds = JSON.parse(localStorage.getItem(oldTaskKey) || '[]'); } catch {}
  if (calIds.length > 0 || taskIds.length > 0) {
    for (const id of calIds) addDocId(id);
    for (const id of taskIds) addDocId(id);
    localStorage.removeItem(oldCalKey);
    localStorage.removeItem(oldTaskKey);
  }
}

dayjs.extend(relativeTimePlugin);

function getLastChangeTime(doc: any): number | null {
  try {
    const changes = Automerge.getAllChanges(doc);
    if (changes.length === 0) return null;
    const decoded = Automerge.decodeChange(changes[changes.length - 1]);
    const t = decoded.time;
    if (!t || t <= 0) return null;
    return t < 1e12 ? t * 1000 : t;
  } catch {
    return null;
  }
}

function relativeTime(ts: number | null): string {
  if (!ts) return '';
  return dayjs(ts).fromNow();
}

function docTypeFromDoc(doc: any): DocType {
  const t = doc?.['@type'];
  if (t === 'Calendar' || t === 'TaskList' || t === 'DataGrid') return t;
  return 'unknown';
}

function docItemCount(doc: any, type: DocType): number {
  if (type === 'Calendar') return Object.keys(doc?.events || {}).length;
  if (type === 'TaskList') return Object.keys(doc?.tasks || {}).length;
  if (type === 'DataGrid') {
    if (doc?.sheets) return Object.values(doc.sheets).reduce((sum: number, s: any) => sum + Object.keys(s.cells || {}).length, 0);
    return Object.keys(doc?.cells || {}).length;
  }
  return Object.keys(doc || {}).length;
}


function viewPathForEntry(entry: DocEntry): string {
  if (entry.type === 'Calendar') return `#/calendars/${entry.documentId}`;
  if (entry.type === 'TaskList') return `#/tasks/${entry.documentId}`;
  if (entry.type === 'DataGrid') return `#/datagrids/${entry.documentId}`;
  return `#/source/${entry.documentId}`;
}

function iconForType(type: DocType): string {
  if (type === 'Calendar') return 'calendar_month';
  if (type === 'TaskList') return 'checklist';
  if (type === 'DataGrid') return 'grid_on';
  return 'help';
}

function initialEntries(): DocEntry[] {
  migrateOldStorageKeys();
  const docMap = getDocMap();
  return Object.keys(docMap).map(id => ({
    type: (docMap[id].type || 'unknown') as DocType,
    documentId: id,
    handle: null as DocHandle<any> | null,
    name: docMap[id].name || id.slice(0, 8),
    count: null as number | null,
    lastUpdated: null as number | null,
    progress: 0 as number | null,
  }));
}

export function Home({ path }: { path?: string }) {
  const [entries, setEntries] = useState<DocEntry[]>(initialEntries);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [docPeers, setDocPeers] = useState<Record<string, { peerId: string; color: string }[]>>({});
  const presenceMapRef = useRef<Map<string, { presence: Presence<{ viewing: boolean }, any>; cleanup: () => void }>>(new Map());
  const { entries: presenceLog, clear: clearLog, attachToPresence } = usePresenceLog();
  const connected = useConnectionStatus();
  const resolvedIdsRef = useRef(new Set<string>());

  const resolveOne = useCallback(async (documentId: string) => {
    if (resolvedIdsRef.current.has(documentId)) return;
    resolvedIdsRef.current.add(documentId);
    try {
      const resolved = await findDocWithProgress(documentId, (pct) => {
        setEntries(prev => prev.map(e =>
          e.documentId === documentId ? { ...e, progress: pct } : e
        ));
      });
      const doc = resolved.doc() as any;
      if (!doc) return; // entry stays as-is (stale)
      const type = docTypeFromDoc(doc);
      const name = doc.name || '';
      updateDocCache(documentId, { type, name });
      setEntries(prev => prev.map(e =>
        e.documentId === documentId
          ? { ...e, type, name, handle: resolved, count: docItemCount(doc, type), lastUpdated: getLastChangeTime(doc), progress: null }
          : e
      ));
    } catch {
      setEntries(prev => prev.map(e =>
        e.documentId === documentId ? { ...e, progress: null } : e
      ));
    }
  }, []);

  const loadAll = useCallback(() => {
    const docMap = getDocMap();
    const ids = Object.keys(docMap);
    if (ids.length === 0) return;
    // Add entries from cache for any IDs not already in the list
    setEntries(prev => {
      const existing = new Set(prev.map(e => e.documentId));
      const newEntries = ids
        .filter(id => !existing.has(id))
        .map(id => ({
          type: (docMap[id].type || 'unknown') as DocType,
          documentId: id,
          handle: null as DocHandle<any> | null,
          name: docMap[id].name || id.slice(0, 8),
          count: null as number | null,
          lastUpdated: null as number | null,
          progress: 0 as number | null,
        }));
      return newEntries.length > 0 ? [...prev, ...newEntries] : prev;
    });
    // Resolve each sequentially, yielding between loads
    (async () => {
      for (const id of ids) await resolveOne(id);
    })();
  }, [resolveOne]);

  // On mount, resolve entries one at a time, yielding between each so the browser stays responsive
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const e of entries) {
        if (cancelled) break;
        await resolveOne(e.documentId);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubs: (() => void)[] = [];
    for (const entry of entries) {
      if (!entry.handle) continue;
      const onChange = () => {
        const doc = entry.handle!.doc();
        if (!doc) return;
        const name = doc.name || '';
        const type = docTypeFromDoc(doc);
        updateDocCache(entry.documentId, { type, name });
        setEntries(prev => prev.map(e =>
          e.documentId === entry.documentId
            ? {
                ...e,
                type,
                name,
                count: docItemCount(doc, type),
                lastUpdated: Date.now(),
              }
            : e
        ));
      };
      entry.handle!.on('change', onChange);
      unsubs.push(() => entry.handle!.off('change', onChange));
    }
    return () => unsubs.forEach(fn => fn());
  }, [entries.map(e => e.documentId).join(',')]);

  // Presence: observe who is viewing each document (broadcast viewing: false so we don't count as a viewer)
  useEffect(() => {
    const map = presenceMapRef.current;
    const currentIds = new Set(entries.map(e => e.documentId));

    for (const [docId, { cleanup }] of map) {
      if (!currentIds.has(docId)) {
        cleanup();
        map.delete(docId);
      }
    }

    for (const entry of entries) {
      if (!entry.handle) continue;
      if (map.has(entry.documentId)) continue;
      const presence = new Presence<{ viewing: boolean }, any>({ handle: entry.handle });
      presence.start({ initialState: { viewing: false }, heartbeatMs: 5000, peerTtlMs: 15000 });

      const update = () => {
        const states = presence.getPeerStates().getStates();
        const peers = Object.values(states)
          .filter((s: any) => s.value.viewing)
          .map((s: any) => ({ peerId: s.peerId, color: peerColor(s.peerId) }));
        setDocPeers(prev => {
          if (peers.length === 0 && !prev[entry.documentId]) return prev;
          return { ...prev, [entry.documentId]: peers };
        });
      };
      presence.on('update', update);
      presence.on('goodbye', update);
      presence.on('pruning', update);
      presence.on('snapshot', update);

      attachToPresence(presence, undefined, entry.documentId);

      const onVisibility = () => {
        if (document.hidden) presence.stop();
        else presence.start({ initialState: { viewing: false } });
      };
      document.addEventListener('visibilitychange', onVisibility);

      map.set(entry.documentId, {
        presence,
        cleanup: () => {
          presence.stop();
          document.removeEventListener('visibilitychange', onVisibility);
        },
      });
    }

    return () => {
      for (const { cleanup } of map.values()) cleanup();
      map.clear();
    };
  }, [entries.map(e => e.documentId).join(',')]);

  const handleCreateCalendar = async () => {
    const handle = repo.create();
    handle.change((d: any) => {
      d['@type'] = 'Calendar';
      d.name = 'Untitled';
      d.events = {};
    });
    addDocId(handle.documentId);
    setMessage('Calendar created');
    setError('');
    await loadAll();
  };

  const handleCreateTaskList = async () => {
    const handle = repo.create();
    handle.change((d: any) => {
      d['@type'] = 'TaskList';
      d.name = 'Untitled';
      d.tasks = {};
    });
    addDocId(handle.documentId);
    setMessage('Task list created');
    setError('');
    await loadAll();
  };

  const handleCreateDataGrid = async () => {
    const handle = repo.create();
    const sid = () => Math.random().toString(36).slice(2, 10);
    const sheetId = sid();
    const colA = sid();
    const colB = sid();
    const colC = sid();
    handle.change((d: any) => {
      d['@type'] = 'DataGrid';
      d.name = 'Untitled';
      const sheet: any = {
        '@type': 'Sheet',
        name: 'Sheet 1',
        index: 1,
        columns: {
          [colA]: { index: 1 },
          [colB]: { index: 2 },
          [colC]: { index: 3 },
        },
        rows: {} as any,
        cells: {},
      };
      for (let i = 1; i <= 10; i++) {
        sheet.rows[sid()] = { index: i };
      }
      d.sheets = { [sheetId]: sheet };
    });
    addDocId(handle.documentId);
    setMessage('Spreadsheet created');
    setError('');
    await loadAll();
  };

  const xlsInputRef = useRef<HTMLInputElement>(null);

  /** Google Sheets wraps functions unsupported by Excel as
   *  IFERROR(__xludf.DUMMYFUNCTION("REAL_FORMULA"),"fallback").
   *  Detect and unwrap to get the original formula. */
  const unwrapDummyFunction = (f: string): string => {
    const prefix = 'IFERROR(__xludf.DUMMYFUNCTION("';
    if (!f.toUpperCase().startsWith(prefix.toUpperCase())) return f;
    // Find the closing `")` of the DUMMYFUNCTION string argument.
    // Inside the string, `""` is an escaped quote.
    let i = prefix.length;
    let inner = '';
    while (i < f.length) {
      if (f[i] === '"') {
        if (f[i + 1] === '"') { inner += '"'; i += 2; }
        else break; // closing quote
      } else { inner += f[i]; i++; }
    }
    return inner || f;
  };

  const handleImportXlsx = useCallback(async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    // Reset input so the same file can be re-imported
    if (xlsInputRef.current) xlsInputRef.current.value = '';

    try {
      const XLSX = await import('xlsx');
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const sid = () => Math.random().toString(36).slice(2, 10);
      const name = file.name.replace(/\.(xlsx?|csv)$/i, '') || 'Imported';

      // First pass: generate IDs and parse sheet structure
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

      // Second pass: convert all cells and formulas (before creating the document)
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
              // Skip cells whose formula is just a quoted string literal (e.g. ="hello") —
              // these are spill/computed values from a dynamic array formula in another cell.
              if (/^"[^"]*"$/.test(formula)) continue;
              try {
                stored = a1ToInternal('=' + formula, r, c, rowIds, colIds, lookupSheetId, lookupSheetRowColIds);
              } catch {
                // Formula can't be parsed (unsupported syntax, missing sheet, etc.) — use computed value
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

      // All parsing succeeded — now create the document
      const handle = repo.create();
      handle.change((d: any) => {
        d['@type'] = 'DataGrid';
        d.name = name;
        d.sheets = {};
      });
      for (const s of builtSheets) {
        const sheetJson = JSON.stringify({
          '@type': 'Sheet', name: s.sheetName, index: s.index,
          ...(s.hidden ? { hidden: true } : {}),
          columns: s.columns, rows: s.rows, cells: s.cells,
        });
        handle.change((d: any) => {
          d.sheets[s.sheetId] = JSON.parse(sheetJson);
        });
      }

      addDocId(handle.documentId);
      // location.href = `/datagrids/${handle.documentId}`;
      console.log(`/datagrids/${handle.documentId}`, handle.doc())
      alert(`/datagrids/${handle.documentId}`)
    } catch (err: any) {
      setError('Failed to import: ' + err.message);
    }
  }, []);

  const handleDelete = (entry: DocEntry) => {
    const label = entry.type === 'Calendar' ? 'calendar' : entry.type === 'TaskList' ? 'task list' : entry.type === 'DataGrid' ? 'spreadsheet' : 'document';
    if (!confirm(`Delete "${entry.name || 'Untitled'}" ${label}?`)) return;
    if (entry.handle) repo.delete(entry.documentId as any);
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
      const handle = repo.create();
      const calName = file.name.replace(/\.ics$/i, '') || 'Imported';
      handle.change((d: any) => {
        d['@type'] = 'Calendar';
        d.name = calName;
        d.events = {};
        for (const { uid, event } of parsed) {
          d.events[uid] = event;
        }
      });
      addDocId(handle.documentId);
      setMessage(`Imported ${parsed.length} event${parsed.length !== 1 ? 's' : ''} into "${calName}"`);
      setError('');
      await loadAll();
    } catch (err: any) {
      setError('Import failed: ' + err.message);
    }
  }, [loadAll]);

  const defaultWsUrl = location.protocol === 'http:'
    ? `ws://${location.host}`
    : 'wss://sync.automerge.org';
  const savedWsUrl = getWsUrl();
  const [wsInput, setWsInput] = useState(() => savedWsUrl || defaultWsUrl);
  const wsIsSet = !!savedWsUrl;

  const sorted = [...entries].sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

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

      <div className="flex flex-col">
        {sorted.map(entry => {
          const viewPath = viewPathForEntry(entry);
          const icon = iconForType(entry.type);
          return (
            <div
              key={entry.documentId}
              className="flex items-center gap-2 py-1 px-1 flex-nowrap border-b border-border"
            >
              <span className="material-symbols-outlined" style={{ width: '1.2rem', textAlign: 'center', color: '#666' }}>{icon}</span>
              <a href={viewPath} className={`text-sm flex-1 hover:underline${!entry.handle && entry.progress == null ? ' text-muted-foreground' : ''}`}>
                {entry.name || 'Untitled'}{!entry.handle && entry.progress == null ? ' (stale)' : ''}
              </a>
              {(docPeers[entry.documentId] || []).map(p => (
                <div
                  key={p.peerId}
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: p.color }}
                  title={`Peer ${p.peerId.slice(0, 8)} is viewing`}
                />
              ))}
              {entry.progress != null ? (
                <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden" title={`Loading ${entry.progress}%`}>
                  <div className="h-full bg-foreground/30 rounded-full transition-all" style={{ width: `${entry.progress}%` }} />
                </div>
              ) : (
                <>
                  <a href={viewPath} className="text-xs text-muted-foreground no-underline" style={{ minWidth: '4rem', textAlign: 'right' }}>
                    {relativeTime(entry.lastUpdated)}
                  </a>
                  <a href={viewPath} className="text-xs text-muted-foreground no-underline">
                    ({entry.count ?? 0})
                  </a>
                </>
              )}
              {entry.handle && (
                <a
                  href={`#/source/${entry.documentId}`}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  title="View Source"
                >
                  <span className="material-symbols-outlined">code</span>
                </a>
              )}
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
        {sorted.length === 0 && (
          <p className="text-sm text-muted-foreground py-4">No documents yet.</p>
        )}
      </div>

      <div className="flex items-center gap-2 mt-4 mb-2 flex-wrap">
        <a href="#/calendars/">
          <Button variant="outline">
            <span className="material-symbols-outlined">date_range</span> All calendars
          </Button>
        </a>
        <Button variant="outline" onClick={handleCreateCalendar}>
          <span className="material-symbols-outlined">add</span> New calendar
        </Button>
        <Button variant="outline" onClick={handleCreateTaskList}>
          <span className="material-symbols-outlined">add</span> New task list
        </Button>
        <Button variant="outline" onClick={handleCreateDataGrid}>
          <span className="material-symbols-outlined">add</span> New spreadsheet
        </Button>
        <input type="file" ref={icsInputRef} accept=".ics,text/calendar" style={{ display: 'none' }} onChange={handleImportIcs as any} />
        <Button variant="outline" onClick={() => icsInputRef.current?.click()}>
          <span className="material-symbols-outlined">upload_file</span> Import .ics
        </Button>
        <input type="file" ref={xlsInputRef} accept=".xls,.xlsx,.csv" style={{ display: 'none' }} onChange={handleImportXlsx as any} />
        <Button variant="outline" onClick={() => xlsInputRef.current?.click()}>
          <span className="material-symbols-outlined">upload_file</span> Import .xlsx
        </Button>
      </div>
      <form
        className="flex items-center gap-2 mb-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (wsIsSet) {
            setWsUrl('');
          } else {
            setWsUrl(wsInput);
          }
          location.reload();
        }}
      >
        <span className="text-xs text-muted-foreground shrink-0">Sync server</span>
        <input
          type="url"
          placeholder="wss://sync.automerge.org"
          value={wsInput}
          onInput={(e) => setWsInput((e.target as HTMLInputElement).value)}
          className="border border-border rounded px-2 py-1 text-sm flex-1 max-w-xs"
          disabled={wsIsSet}
        />
        <button type="submit" className="border border-border rounded px-3 py-1 text-sm hover:bg-accent">
          {wsIsSet ? 'Remove & reload' : 'Set & reload'}
        </button>
      </form>

      <PresenceLogTable entries={presenceLog} onClear={clearLog} showDocId />
    </div>
  );
}
