import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { usePeerList, usePeerTransports } from '../shared/automerge';
import { ConnectionStatus } from '../shared/ConnectionStatus';
import { createDoc, updateDoc, richText, subscribeQuery, fetchDocList, archiveDoc, onDocListUpdated, onUnseenChangesUpdated, getUnseenChanges, HOME_SUMMARY_QUERY } from '../worker-api';
import { getMyAccess, onKeyhiveStateChanged } from '../shared/keyhive-api';
import { PeerDot } from '../shared/presence';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Progress } from '@/components/ui/progress';
import { Fab } from '@/components/ui/fab';
import { AccessIcon } from '@/components/AccessIcon';
import { OverflowMenu, type OverflowMenuItem } from '../shared/OverflowMenu';
import { useLongPress } from '../shared/useLongPress';
import { AccessControlSheet } from '@/components/AccessControl';
import { CreateDocSheet, type ImportKind } from './CreateDocSheet';
import { DocActionsSheet, type DocActionsTarget } from './DocActionsSheet';
import dayjs from 'dayjs';
import relativeTimePlugin from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTimePlugin);
import { a1ToInternal } from '@/doc-plugins/datagrid/helpers';
// Static, not dynamic: SentencesView already imports this, so it is in the main
// chunk regardless and a dynamic import here only earns a build warning.
import { markdownToSpans } from '@/doc-plugins/sentences/markdown';
import { iconForType, docTypeLabel, type DocTypePlugin } from '@/doc-plugins';
import { docUrl } from '@/shared/doc-urls';
import { relativeTime } from '../../shared/relative-time';
import { expandRelativeDates } from '../../shared/relative-dates';
import { settingSet, settingSetSync } from '../idb-storage';

/**
 * A pending import. `json` is a whole document; `markdown` becomes a Sentences
 * document (see `createDocsFromItems`). Also the shape `examples.ts` returns.
 */
export type ImportItem =
  | { kind: 'json'; label: string; read: () => Promise<any> }
  | { kind: 'markdown'; label: string; read: () => Promise<string> };

/** The first `# ` heading, used as an imported Markdown document's title. */
function firstHeading(md: string): string | undefined {
  return /^#[ \t]+(.+?)[ \t]*$/m.exec(md)?.[1];
}

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
        <span className="inline-flex items-center justify-center h-8 w-8 text-muted-foreground">
          <AccessIcon access={entry.access ?? null} style={{ fontSize: 18 }} />
        </span>
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
  const [importStatus, setImportStatus] = useState<{ label: string; progress: number } | null>(null);
  const [listLoading, setListLoading] = useState(true);
  // Bottom sheets: FAB "Create" chooser, long-press per-doc actions, and the
  // Share / Rename follow-ups they open.
  const [createOpen, setCreateOpen] = useState(false);
  const [actionsEntry, setActionsEntry] = useState<DocEntry | null>(null);
  const [shareEntry, setShareEntry] = useState<DocActionsTarget | null>(null);
  const repoPeers = usePeerList();
  const transports = usePeerTransports();

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
      const { docId } = await createDoc({ '@type': 'DataGrid', name, sheets: {} }, { type: 'DataGrid', name });

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

  /**
   * Create one document per payload, sequentially. Shared by the file importer
   * and the "create examples" offer on the empty home page.
   *
   * Two kinds of payload:
   *  - `json`     — a whole document, created as-is.
   *  - `markdown` — a Sentences document. Its structure (headings, lists, marks)
   *                 lives in Automerge block markers and marks, which JSON can't
   *                 carry, so the doc is created empty and filled with one
   *                 `updateSpans` op — the same path SentencesView's own Markdown
   *                 import uses.
   *
   * Every payload passes through `expandRelativeDates` first, so the examples'
   * `{{today+3d}}` / `{{tu@16:30}}` markup becomes real dates at creation time.
   *
   * Serial rather than parallel: each createDoc is a worker round-trip that
   * mints a keyhive doc and enables sharing. A payload that fails is recorded
   * and skipped — it never aborts the rest of the batch.
   */
  const createDocsFromItems = useCallback(async (
    items: ImportItem[],
    verb: string,
  ): Promise<{ created: string[]; failures: string[] }> => {
    const created: string[] = [];
    const failures: string[] = [];
    const many = items.length > 1;
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (many) {
          // Same progress banner the .ics/.xlsx importers use. The yield lets it paint.
          setImportStatus({ label: `${verb} ${i + 1}/${items.length}: ${item.label}`, progress: Math.round((i / items.length) * 100) });
          await new Promise(r => setTimeout(r, 0));
        }
        try {
          if (item.kind === 'markdown') {
            const md = expandRelativeDates(await item.read());
            const name = firstHeading(md) || item.label.replace(/\.md$/i, '') || 'Sentences';
            const { docId } = await createDoc({ '@type': 'Sentences', name, content: '' }, { type: 'Sentences', name });
            // One updateSpans op → one Automerge change → one undo step.
            await updateDoc(docId, (d, richText, ops) => { richText(d, ['content'], ops); }, richText,
              [{ op: 'updateSpans', spans: markdownToSpans(md) }]);
            created.push(docId);
          } else {
            const data = expandRelativeDates(await item.read());
            if (!data || typeof data !== 'object') throw new Error('Invalid JSON: expected an object');
            const name = data.name || item.label.replace(/\.json$/i, '') || 'Imported';
            const type = typeof data['@type'] === 'string' ? data['@type'] : 'unknown';
            const { docId } = await createDoc(data, { type, name });
            created.push(docId);
          }
        } catch (err: any) {
          failures.push(`${item.label}: ${err?.message ?? err}`);
        }
      }
    } finally {
      setImportStatus(null);
    }
    return { created, failures };
  }, []);

  /** Import one document per file — `.json` documents and `.md` as Sentences.
   *  The picker allows multiple files (see `multiple` on the input below), so a
   *  folder can be loaded in one go. */
  const handleImportJson = useCallback(async (e: Event) => {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    if (files.length === 0) return;
    if (jsonInputRef.current) jsonInputRef.current.value = '';
    setError('');
    setMessage('');

    const { created, failures } = await createDocsFromItems(
      files.map(f => /\.md$/i.test(f.name)
        ? { kind: 'markdown' as const, label: f.name, read: () => f.text() }
        : { kind: 'json' as const, label: f.name, read: () => f.text().then(JSON.parse) }),
      'Importing',
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
  }, [createDocsFromItems]);

  /** Offered when the document list is empty — creates the bundled examples/. */
  const [creatingExamples, setCreatingExamples] = useState(false);
  const handleCreateExamples = useCallback(async () => {
    setError('');
    setMessage('');
    setCreatingExamples(true);
    try {
      const { exampleDocs } = await import('./examples');
      const { created, failures } = await createDocsFromItems(exampleDocs(), 'Creating');
      if (failures.length) setError(`Some examples couldn't be created — ${failures.join('; ')}`);
      if (created.length) setMessage(`Created ${created.length} example document${created.length === 1 ? '' : 's'}`);
    } catch (err: any) {
      setError(`Couldn't load the examples: ${err?.message ?? err}`);
    } finally {
      setCreatingExamples(false);
    }
  }, [createDocsFromItems]);

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
    { icon: 'contacts', label: 'Contacts', href: '#/contacts' },
    { icon: 'settings', label: 'Settings', href: '#/settings' },
  ];

  return (
    <div className="max-w-screen-md mx-auto px-2 sm:px-4 pb-28">
      {/* Top app bar */}
      <div className="flex items-center gap-2 min-h-14 pl-2">
        <h1 className="md-title-large font-bold flex-1 min-w-0 truncate">Documents</h1>
        <ConnectionStatus showDot peers={repoPeers.map(peerId => ({ peerId }))} />
        {repoPeers.map(peerId => (
          <PeerDot key={peerId} peerId={peerId} direct={transports[peerId] === 'direct'} />
        ))}
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

      {/* Long-press / kebab → per-doc actions, with Share & Rename follow-ups */}
      <DocActionsSheet
        entry={actionsEntry}
        onOpenChange={open => { if (!open) setActionsEntry(null); }}
        onShare={setShareEntry}
        onRename={e => {
          const name = prompt('Rename', e.name || 'Untitled');
          if (name === null) return;
          const trimmed = name.trim();
          if (!trimmed) return;
          updateDoc(e.documentId, (d, n) => { d.name = n; }, trimmed);
        }}
        onArchive={e => {
          if (confirm(`Archive "${e.name || 'Untitled'}" ${docLabel(e as DocEntry)}?`)) {
            handleArchive(e as DocEntry);
          }
        }}
      />
      {shareEntry && (
        <AccessControlSheet
          docId={shareEntry.documentId}
          access={shareEntry.access}
          open
          onOpenChange={open => { if (!open) setShareEntry(null); }}
        />
      )}
    </div>
  );
}
