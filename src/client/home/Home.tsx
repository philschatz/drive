import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { useConnectionStatus, usePeerList } from '../shared/automerge';
import { createDoc, updateDoc, subscribeQuery, HOME_SUMMARY_QUERY } from '../worker-api';
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
import { RelayLogPanel } from './RelayLogPanel';

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
  const showUnencrypted = localStorage.getItem('showUnencrypted') === 'true';
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
      const sid = () => Math.random().toString(36).slice(2, 10);
      const name = file.name.replace(/\.(xlsx?|csv)$/i, '') || 'Imported';

      // Create the document before parsing
      setImportStatus({ label: 'Creating document...', progress: 0 });
      const { docId } = await createDoc({ '@type': 'DataGrid', name, sheets: {} }, createSecure);
      addDocId(docId, { type: 'DataGrid', name, encrypted: createSecure });

      setImportStatus({ label: 'Reading file...', progress: 2 });
      await new Promise(r => setTimeout(r, 0));

      const [{ Buffer: BufferPolyfill }, ExcelJS] = await Promise.all([
        import('buffer/'),
        import('exceljs'),
      ]);
      if (typeof globalThis.Buffer === 'undefined') {
        (globalThis as any).Buffer = BufferPolyfill;
      }
      const buffer = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);

      const sheetNameToId = new Map<string, string>();
      const sheetIdToRowColIds = new Map<string, {
        rowIds: string[]; colIds: string[];
        onMissingRow: (idx: number) => string;
        onMissingCol: (idx: number) => string;
      }>();
      const sheetDefs: {
        sheetId: string; sheetName: string; hidden: boolean;
        columns: Record<string, { index: number; width?: number; hidden?: boolean; frozen?: boolean }>;
        rowsMap: Record<string, { index: number; hidden?: boolean; frozen?: boolean }>;
        colIds: string[]; rowIds: string[];
        rows2d: any[][]; ws: any;
      }[] = [];

      for (const ws of wb.worksheets) {
        const sheetName = ws.name;
        const sheetId = sid();
        sheetNameToId.set(sheetName, sheetId);

        // Build 2D row data from ExcelJS
        const rows2d: any[][] = [];
        ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
          const rowData: any[] = [];
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            rowData[colNumber - 1] = cell.value;
          });
          rows2d[rowNumber - 1] = rowData;
        });
        // Fill any gaps (eachRow skips fully empty rows)
        const rowCount = ws.rowCount || Math.max(rows2d.length, 1);
        for (let i = 0; i < rowCount; i++) {
          if (!rows2d[i]) rows2d[i] = [];
        }

        const colCount = Math.max(ws.columnCount || 0, rows2d.reduce((max, row) => Math.max(max, row?.length || 0), 0), 1);
        const columns: Record<string, { index: number; width?: number; hidden?: boolean; frozen?: boolean }> = {};
        const colIds: string[] = [];
        for (let c = 0; c < colCount; c++) {
          const cid = sid();
          colIds.push(cid);
          const col: { index: number; width?: number; hidden?: boolean; frozen?: boolean } = { index: c + 1 };
          const wsCol = ws.getColumn(c + 1);
          if (wsCol?.hidden) col.hidden = true;
          // ExcelJS width is in characters; convert to pixels (~7px per character + 12px padding)
          if (wsCol?.width) col.width = Math.round(wsCol.width * 7 + 12);
          columns[cid] = col;
        }

        const rowsMap: Record<string, { index: number; hidden?: boolean; frozen?: boolean }> = {};
        const rowIds: string[] = [];
        for (let r = 0; r < rowCount; r++) {
          const rid = sid();
          rowIds.push(rid);
          const row: { index: number; hidden?: boolean; frozen?: boolean } = { index: r + 1 };
          const wsRow = ws.getRow(r + 1);
          if (wsRow?.hidden) row.hidden = true;
          rowsMap[rid] = row;
        }

        // Import frozen pane information
        const frozenView = Array.isArray(ws.views) && ws.views.find((v: any) => v.state === 'frozen') as any;
        if (frozenView) {
          const xSplit: number = typeof frozenView.xSplit === 'number' ? frozenView.xSplit : 0;
          const ySplit: number = typeof frozenView.ySplit === 'number' ? frozenView.ySplit : 0;
          for (let c = 0; c < xSplit && c < colIds.length; c++) columns[colIds[c]].frozen = true;
          for (let r = 0; r < ySplit && r < rowIds.length; r++) rowsMap[rowIds[r]].frozen = true;
        }

        const sheetHidden = ws.state === 'hidden' || ws.state === 'veryHidden';
        const onMissingRow = (idx: number) => {
          while (rowIds.length <= idx) {
            const rid = sid();
            rowsMap[rid] = { index: rowIds.length + 1 };
            rowIds.push(rid);
          }
          return rowIds[idx];
        };
        const onMissingCol = (idx: number) => {
          while (colIds.length <= idx) {
            const cid = sid();
            columns[cid] = { index: colIds.length + 1 };
            colIds.push(cid);
          }
          return colIds[idx];
        };
        sheetIdToRowColIds.set(sheetId, { rowIds, colIds, onMissingRow, onMissingCol });
        sheetDefs.push({ sheetId, sheetName, hidden: sheetHidden, columns, rowsMap, colIds, rowIds, rows2d, ws });
      }

      const lookupSheetId = (n: string) => sheetNameToId.get(n);
      const lookupSheetRowColIds = (id: string) => sheetIdToRowColIds.get(id);

      const totalRows = sheetDefs.reduce((sum, sd) => sum + sd.rows2d.length, 0);
      let processedRows = 0;
      const BATCH_SIZE = 2000;
      const sentRowCounts = new Map<string, number>();
      const sentColCounts = new Map<string, number>();

      // Helper: extract ARGB color as #RRGGBB
      const argbToHex = (color: any): string | undefined => {
        if (!color) return undefined;
        const argb = color.argb;
        if (argb && typeof argb === 'string' && argb.length >= 6) {
          const hex = argb.slice(-6);
          if (hex !== '000000') return '#' + hex;
        }
        return undefined;
      };

      // Helper: map ExcelJS border to our format
      const mapBorder = (b: any) => {
        if (!b?.style) return undefined;
        const border: Record<string, string> = { style: b.style };
        const c = argbToHex(b.color);
        if (c) border.color = c;
        return border;
      };

      // Helper: map ExcelJS conditional formatting operator to our conditionType
      const operatorMap: Record<string, string> = {
        greaterThan: 'gt', lessThan: 'lt', equal: 'eq', notEqual: 'neq',
        greaterThanOrEqual: 'gte', lessThanOrEqual: 'lte',
      };

      // Helper: parse an A1 ref string (e.g. "A1:C10") into a range using row/col ID arrays
      const parseExcelRef = (ref: string, rowIds: string[], colIds: string[]) => {
        const m = ref.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
        if (!m) return null;
        const letterToIdx = (s: string) => {
          let idx = 0;
          for (let i = 0; i < s.length; i++) idx = idx * 26 + (s.toUpperCase().charCodeAt(i) - 64);
          return idx - 1;
        };
        const c1 = letterToIdx(m[1]);
        const r1 = parseInt(m[2], 10) - 1;
        const c2 = m[3] ? letterToIdx(m[3]) : c1;
        const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
        if (r1 >= rowIds.length || r2 >= rowIds.length || c1 >= colIds.length || c2 >= colIds.length) return null;
        if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null;
        return {
          rangeRowStart: rowIds[r1], rangeRowEnd: rowIds[r2],
          rangeColStart: colIds[c1], rangeColEnd: colIds[c2],
        };
      };

      // Parse each sheet and stream directly into the document
      for (let si = 0; si < sheetDefs.length; si++) {
        const { sheetId, sheetName, columns, rowsMap, colIds, rowIds, rows2d, ws } = sheetDefs[si];
        const processedRowsBefore = processedRows;

        const { hidden } = sheetDefs[si];
        await updateDoc(
          docId,
          (d, sid, sheet) => { (d as any).sheets[sid] = sheet; },
          sheetId, {
            '@type': 'Sheet', name: sheetName, index: si + 1,
            ...(hidden ? { hidden: true } : {}),
            columns, rows: rowsMap, cells: {},
          },
        );
        sentRowCounts.set(sheetId, rowIds.length);
        sentColCounts.set(sheetId, colIds.length);

        const cellFormats: { r: number; c: number; fmt: Record<string, any> }[] = [];
        let cellBatch: Record<string, { value: string }> = {};
        let batchCount = 0;

        for (let r = 0; r < rows2d.length; r++) {
          const row = rows2d[r];
          if (!row) continue;
          for (let c = 0; c < row.length; c++) {
            const cell = ws.getCell(r + 1, c + 1);

            // Extract formatting
            if (cell.style) {
              const s = cell.style;
              const fmt: Record<string, any> = {};
              if (s.font?.bold) fmt.bold = true;
              if (s.font?.italic) fmt.italic = true;
              if (s.font?.underline) fmt.underline = true;
              if (s.font?.strike) fmt.strikethrough = true;
              if (s.font?.name) fmt.fontFamily = s.font.name;
              if (s.font?.size) fmt.fontSize = s.font.size;
              const textColor = argbToHex(s.font?.color);
              if (textColor) fmt.textColor = textColor;
              if (s.fill && (s.fill as any).type === 'pattern') {
                const bgColor = argbToHex((s.fill as any).fgColor);
                if (bgColor) fmt.bgColor = bgColor;
              }
              if (s.alignment?.horizontal && s.alignment.horizontal !== 'general') fmt.hAlign = s.alignment.horizontal;
              if (s.alignment?.vertical) fmt.vAlign = s.alignment.vertical;
              if (s.alignment?.wrapText) fmt.wrapText = true;
              if (s.numFmt) fmt.numFmt = s.numFmt;
              if (s.border?.top) { const b = mapBorder(s.border.top); if (b) fmt.borderTop = b; }
              if (s.border?.bottom) { const b = mapBorder(s.border.bottom); if (b) fmt.borderBottom = b; }
              if (s.border?.left) { const b = mapBorder(s.border.left); if (b) fmt.borderLeft = b; }
              if (s.border?.right) { const b = mapBorder(s.border.right); if (b) fmt.borderRight = b; }
              if (Object.keys(fmt).length > 0) cellFormats.push({ r, c, fmt });
            }

            // Extract cell value
            const formula = cell.formula || cell.sharedFormula;
            const val = row[c];
            if (formula) {
              const unwrapped = unwrapDummyFunction(formula);
              if (/^"[^"]*"$/.test(unwrapped)) continue;
              let stored: string;
              try {
                const sheetLookup = sheetIdToRowColIds.get(sheetId)!;
                stored = a1ToInternal('=' + unwrapped, r, c, rowIds, colIds, lookupSheetId, lookupSheetRowColIds, sheetLookup.onMissingRow, sheetLookup.onMissingCol);
              } catch {
                stored = val != null ? String(val) : '';
              }
              if (stored) cellBatch[`${rowIds[r]}:${colIds[c]}`] = { value: stored };
            } else if (val != null && val !== '') {
              let stored: string;
              if (val instanceof Date) {
                const mm = String(val.getMonth() + 1).padStart(2, '0');
                const dd = String(val.getDate()).padStart(2, '0');
                const yyyy = val.getFullYear();
                stored = `${mm}/${dd}/${yyyy}`;
              } else if (typeof val === 'object' && val !== null && 'result' in val) {
                // ExcelJS formula result objects
                stored = String(val.result ?? '');
              } else {
                stored = String(val);
              }
              if (stored) cellBatch[`${rowIds[r]}:${colIds[c]}`] = { value: stored };
            } else {
              continue;
            }
            batchCount++;

            // Flush batch when full
            if (batchCount >= BATCH_SIZE) {
              const truncName = sheetName.slice(0, 20);
              const rowLabel = rows2d.length < 2000
                ? `row ${r + 1} / ${rows2d.length}`
                : `${Math.round(r / 1000)}k / ${Math.round(rows2d.length / 1000)}k rows`;
              processedRows = processedRowsBefore + r;
              setImportStatus({
                label: `Importing "${truncName}" — ${rowLabel}`,
                progress: totalRows > 0 ? Math.round(5 + (processedRows / totalRows) * 90) : 50,
              });
              await updateDoc(
                docId,
                (d, sid, cells) => {
                  for (const [k, v] of Object.entries(cells)) (d as any).sheets[sid].cells[k] = v;
                },
                sheetId, cellBatch,
              );
              cellBatch = {};
              batchCount = 0;
              await new Promise(r => setTimeout(r, 0));
            }
          }
        }
        processedRows = processedRowsBefore + rows2d.length;

        // Flush remaining cells
        if (batchCount > 0) {
          await updateDoc(
            docId,
            (d, sid, cells) => {
              for (const [k, v] of Object.entries(cells)) (d as any).sheets[sid].cells[k] = v;
            },
            sheetId, cellBatch,
          );
        }

        // Coalesce per-cell formats into FormatRange entries
        if (cellFormats.length > 0) {
          const formats: Record<string, any> = {};
          const byKey = new Map<string, { r: number; c: number }[]>();
          for (const { r, c, fmt } of cellFormats) {
            const key = JSON.stringify(fmt);
            let list = byKey.get(key);
            if (!list) { list = []; byKey.set(key, list); }
            list.push({ r, c });
          }
          let fmtIndex = 1;
          for (const [key, positions] of byKey) {
            const fmt = JSON.parse(key);
            positions.sort((a, b) => a.r - b.r || a.c - b.c);
            const rowSpans: { r: number; cStart: number; cEnd: number }[] = [];
            let cur = { r: positions[0].r, cStart: positions[0].c, cEnd: positions[0].c };
            for (let i = 1; i < positions.length; i++) {
              const p = positions[i];
              if (p.r === cur.r && p.c === cur.cEnd + 1) {
                cur.cEnd = p.c;
              } else {
                rowSpans.push({ ...cur });
                cur = { r: p.r, cStart: p.c, cEnd: p.c };
              }
            }
            rowSpans.push(cur);
            const merged: { rStart: number; rEnd: number; cStart: number; cEnd: number }[] = [];
            for (const span of rowSpans) {
              const prev = merged.length > 0 ? merged[merged.length - 1] : null;
              if (prev && prev.cStart === span.cStart && prev.cEnd === span.cEnd && prev.rEnd + 1 === span.r) {
                prev.rEnd = span.r;
              } else {
                merged.push({ rStart: span.r, rEnd: span.r, cStart: span.cStart, cEnd: span.cEnd });
              }
            }
            for (const rect of merged) {
              formats[sid()] = {
                index: fmtIndex++,
                rangeRowStart: rowIds[rect.rStart],
                rangeRowEnd: rowIds[rect.rEnd],
                rangeColStart: colIds[rect.cStart],
                rangeColEnd: colIds[rect.cEnd],
                format: fmt,
              };
            }
          }
          await updateDoc(
            docId,
            (d, sid, fmts) => { (d as any).sheets[sid].formats = fmts; },
            sheetId, formats,
          );
        }

        // Import conditional formatting rules
        const condFormattings = (ws as any).conditionalFormattings;
        if (condFormattings && Array.isArray(condFormattings) && condFormattings.length > 0) {
          const condRules: Record<string, any> = {};
          let cfIndex = 1;

          for (const cf of condFormattings) {
            const ref = cf.ref || '';
            for (const xlRule of (cf.rules || [])) {
              // Map ExcelJS rule type/operator to our conditionType
              let conditionType: string | null = null;
              let conditionValue: string | undefined;

              if (xlRule.type === 'cellIs' && xlRule.operator && operatorMap[xlRule.operator]) {
                conditionType = operatorMap[xlRule.operator];
                conditionValue = xlRule.formulae?.[0]?.toString();
              } else if (xlRule.type === 'containsText') {
                conditionType = 'textContains';
                conditionValue = xlRule.text;
              } else if (xlRule.type === 'beginsWith') {
                conditionType = 'textStartsWith';
                conditionValue = xlRule.text;
              } else if (xlRule.type === 'endsWith') {
                conditionType = 'textEndsWith';
                conditionValue = xlRule.text;
              } else if (xlRule.type === 'expression') {
                conditionType = 'customFormula';
                const rawFormula = xlRule.formulae?.[0]?.toString();
                if (rawFormula) {
                  try {
                    const sheetLookup = sheetIdToRowColIds.get(sheetId)!;
                    conditionValue = a1ToInternal('=' + rawFormula, 0, 0, rowIds, colIds, lookupSheetId, lookupSheetRowColIds, sheetLookup.onMissingRow, sheetLookup.onMissingCol);
                  } catch {
                    conditionValue = rawFormula;
                  }
                }
              }

              if (!conditionType) continue;

              // Parse ref into ranges (space-separated in Excel, e.g. "A1:C10 E1:E20")
              const ranges: Record<string, any> = {};
              const refs = ref.split(/[\s,]+/);
              for (const r of refs) {
                const parsed = parseExcelRef(r.trim(), rowIds, colIds);
                if (parsed) ranges[sid()] = parsed;
              }
              if (Object.keys(ranges).length === 0) continue;

              // Extract style from rule
              const format: Record<string, any> = {};
              const style = xlRule.style;
              if (style?.font?.bold) format.bold = true;
              if (style?.font?.italic) format.italic = true;
              if (style?.font?.underline) format.underline = true;
              if (style?.font?.strike) format.strikethrough = true;
              if (style?.font?.name) format.fontFamily = style.font.name;
              if (style?.font?.size) format.fontSize = style.font.size;
              const textColor = argbToHex(style?.font?.color);
              if (textColor) format.textColor = textColor;
              // DXF fills use bgColor (not fgColor) for the cell background
              if (style?.fill) {
                const bgColor = argbToHex((style.fill as any).fgColor) || argbToHex((style.fill as any).bgColor);
                if (bgColor) format.bgColor = bgColor;
              }
              if (style?.numFmt) format.numFmt = style.numFmt;
              if (style?.alignment?.horizontal && style.alignment.horizontal !== 'general') format.hAlign = style.alignment.horizontal;
              if (style?.alignment?.vertical) format.vAlign = style.alignment.vertical;
              if (style?.alignment?.wrapText) format.wrapText = true;
              if (style?.border?.top) { const b = mapBorder(style.border.top); if (b) format.borderTop = b; }
              if (style?.border?.bottom) { const b = mapBorder(style.border.bottom); if (b) format.borderBottom = b; }
              if (style?.border?.left) { const b = mapBorder(style.border.left); if (b) format.borderLeft = b; }
              if (style?.border?.right) { const b = mapBorder(style.border.right); if (b) format.borderRight = b; }

              condRules[sid()] = {
                index: cfIndex++,
                ranges,
                conditionType,
                ...(conditionValue !== undefined ? { conditionValue } : {}),
                format,
              };
            }
          }

          if (Object.keys(condRules).length > 0) {
            await updateDoc(
              docId,
              (d, sid, rules) => { (d as any).sheets[sid].conditionalFormats = rules; },
              sheetId, condRules,
            );
          }
        }

      }

      // Final pass: sync rows/columns auto-created by cross-sheet formula refs
      for (const sd of sheetDefs) {
        const sentRows = sentRowCounts.get(sd.sheetId) ?? 0;
        const sentCols = sentColCounts.get(sd.sheetId) ?? 0;
        if (sd.rowIds.length > sentRows || sd.colIds.length > sentCols) {
          const newRows: Record<string, { index: number }> = {};
          const newCols: Record<string, { index: number }> = {};
          for (let i = sentRows; i < sd.rowIds.length; i++) newRows[sd.rowIds[i]] = sd.rowsMap[sd.rowIds[i]];
          for (let i = sentCols; i < sd.colIds.length; i++) newCols[sd.colIds[i]] = sd.columns[sd.colIds[i]];
          await updateDoc(
            docId,
            (d, sid, nr, nc) => {
              for (const [k, v] of Object.entries(nr)) (d as any).sheets[sid].rows[k] = v;
              for (const [k, v] of Object.entries(nc)) (d as any).sheets[sid].columns[k] = v;
            },
            sd.sheetId, newRows, newCols,
          );
        }
      }

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

      <RelayLogPanel />

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
