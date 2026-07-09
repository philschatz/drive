/**
 * Bridge between IronCalc's `Model` (a self-contained, index-based WASM workbook)
 * and our Automerge CRDT document (`sheets/rows/columns/cells` keyed by random IDs).
 *
 * IronCalc owns the *editing surface*; our Automerge doc remains the *source of truth*.
 * Two directions:
 *
 *  - Local edits: IronCalc mutates its Model. We monkeypatch the Model's mutating
 *    methods so each edit is mirrored into the Automerge doc (converting A1 formulas
 *    to our position-independent internal `{R{id}C{id}}` format via helpers.ts).
 *  - Remote edits: the doc subscription hands us fresh state; we diff it into the
 *    Model idempotently and bump `refreshId` so `<IronCalc>` redraws. A *structural*
 *    remote change (row/col/sheet added or removed) triggers a full Model rebuild.
 *
 * Because our cells are keyed by row/column *ID* (not position), inserting a row is
 * just a new ID at a position — existing cells keep their keys, and internal-format
 * formulas (which reference IDs) stay valid without rewriting.
 *
 * Not persisted in this MVP (session-only): cell formatting/styles, column widths,
 * row heights, sheet colors, frozen panes. See CLAUDE.md / the plan for rationale.
 */
import { init as initWasm, Model } from '@ironcalc/workbook';
import {
  a1ToInternal, internalToA1, shortId,
  updateFormulasForDeletion, rewriteFormulasForSheetDeletion,
} from './helpers';
import { evaluateConditionalFormats } from './formatting';
import type { ConditionalFormatRule, DataGridCellFormat, FormatRange } from './schema';
import { updateDoc } from '../worker-api';

// ── Default sheet dimensions ────────────────────────────────────────────────
// A freshly created sheet starts with this many rows/columns so it presents a
// usable grid immediately (matching the first sheet of a new spreadsheet).
export const DEFAULT_SHEET_ROWS = 10;
export const DEFAULT_SHEET_COLS = 3;

/** Build the row/column ID lists + doc-shaped `rows`/`columns` maps for a new sheet. */
export function buildDefaultGrid(): {
  rowIds: string[]; colIds: string[];
  rows: Record<string, { index: number }>; columns: Record<string, { index: number }>;
} {
  const rowIds: string[] = [], colIds: string[] = [];
  const rows: Record<string, { index: number }> = {};
  const columns: Record<string, { index: number }> = {};
  for (let i = 1; i <= DEFAULT_SHEET_ROWS; i++) { const id = shortId(); rowIds.push(id); rows[id] = { index: i }; }
  for (let i = 1; i <= DEFAULT_SHEET_COLS; i++) { const id = shortId(); colIds.push(id); columns[id] = { index: i }; }
  return { rowIds, colIds, rows, columns };
}

// ── WASM init (once) ──────────────────────────────────────────────────────────
let wasmReady: Promise<void> | null = null;
export function ensureWasm(): Promise<void> {
  if (!wasmReady) wasmReady = initWasm().then(() => undefined);
  return wasmReady;
}

// ── Local mirror of the parts of the doc we need for conversions ───────────────
export interface SheetState {
  name: string;
  index: number;
  /** Row IDs in display order (sorted by fractional index). */
  rowIds: string[];
  /** Column IDs in display order. */
  colIds: string[];
  /** cellKey ("rowId:colId") → stored value (internal format for formulas). */
  cells: Record<string, string>;
  /** Conditional-format rules (by id), applied to the Model as static styles. */
  conditionalFormats?: Record<string, ConditionalFormatRule>;
  /** Persisted cell/row/column formatting as FormatRange entries (by id, index-ordered). */
  formats?: Record<string, FormatRange>;
  /** colId → pixel width (only columns with a stored width). */
  colWidths: Record<string, number>;
  /** rowId → pixel height (only rows with a stored height). */
  rowHeights: Record<string, number>;
  /** Count of contiguous frozen rows / columns from the top-left. */
  frozenRows: number;
  frozenCols: number;
}
export interface DocState {
  name: string;
  /** Sheet IDs in display order. */
  sheetIds: string[];
  sheets: Record<string, SheetState>;
}

/** Shape returned by DOC_QUERY (see DataGrid host). */
export const DOC_QUERY =
  '{ name: (.name // "Spreadsheet"), sheets: (.sheets | to_entries | sort_by(.value.index) | map({ key: .key, value: { ' +
  'name: (.value.name // "Sheet"), index: .value.index, ' +
  'rowMeta: (.value.rows | to_entries | sort_by(.value.index) | map({id: .key, height: .value.height, frozen: .value.frozen})), ' +
  'colMeta: (.value.columns | to_entries | sort_by(.value.index) | map({id: .key, width: .value.width, frozen: .value.frozen})), ' +
  'conditionalFormats: (.value.conditionalFormats // {}), ' +
  'formats: (.value.formats // {}), ' +
  'cells: (.value.cells // {}) } }) | from_entries) }';

interface RawRowMeta { id: string; height?: number; frozen?: boolean }
interface RawColMeta { id: string; width?: number; frozen?: boolean }
interface RawSheet { name: string; index: number; rowMeta: RawRowMeta[]; colMeta: RawColMeta[]; cells: Record<string, { value: string }>; conditionalFormats?: Record<string, ConditionalFormatRule>; formats?: Record<string, FormatRange> }
interface RawDoc { name: string; sheets: Record<string, RawSheet> }

/** Normalize a DOC_QUERY result into a DocState (defensive against nulls). */
export function toDocState(raw: RawDoc | null): DocState {
  if (!raw || !raw.sheets) return { name: 'Spreadsheet', sheetIds: [], sheets: {} };
  // jq `from_entries` preserves insertion order → already sorted by index.
  const sheetIds = Object.keys(raw.sheets);
  const sheets: Record<string, SheetState> = {};
  for (const sid of sheetIds) {
    const s = raw.sheets[sid];
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.cells || {})) cells[k] = v?.value ?? '';
    const rowMeta = s.rowMeta || [], colMeta = s.colMeta || [];
    const rowHeights: Record<string, number> = {};
    for (const m of rowMeta) if (typeof m.height === 'number') rowHeights[m.id] = m.height;
    const colWidths: Record<string, number> = {};
    for (const m of colMeta) if (typeof m.width === 'number') colWidths[m.id] = m.width;
    let frozenRows = 0; for (const m of rowMeta) { if (m.frozen) frozenRows++; else break; }
    let frozenCols = 0; for (const m of colMeta) { if (m.frozen) frozenCols++; else break; }
    sheets[sid] = {
      name: s.name, index: s.index,
      rowIds: rowMeta.map((m) => m.id), colIds: colMeta.map((m) => m.id),
      cells, conditionalFormats: s.conditionalFormats, formats: s.formats,
      colWidths, rowHeights, frozenRows, frozenCols,
    };
  }
  return { name: raw.name, sheetIds, sheets };
}

// ── Bridge ─────────────────────────────────────────────────────────────────────

export interface BridgeCallbacks {
  /** Called (throttled by the host via refreshId) when the Model changed and IronCalc should redraw. */
  onModelChanged: () => void;
  /** Broadcast this device's focused cell for presence, or null to clear. */
  onFocus: (path: (string | number)[] | null) => void;
}

export class DataGridBridge {
  readonly model: Model;
  private docId: string;
  private state: DocState;
  private cb: BridgeCallbacks;
  private destroyed = false;
  /** Guards against re-entrant mirroring while we drive the model from remote state. */
  private applyingRemote = false;
  /** Per-sheet set of cellKeys currently styled by conditional formatting (to clear on un-match). */
  private cfStyled = new Map<string, Set<string>>();

  constructor(docId: string, initial: DocState, cb: BridgeCallbacks, readOnly: boolean) {
    this.docId = docId;
    this.state = initial;
    this.cb = cb;
    this.model = new Model('Workbook', 'en', 'UTC');
    this.seed();
    if (!readOnly) this.patchMutators();
    this.patchSelection();
  }

  destroy(): void {
    this.destroyed = true;
    try { this.model.free(); } catch { /* already freed */ }
  }

  // ── Index ↔ ID mapping helpers (positions are IronCalc's; 0-based here) ──────
  private sheetIdAt(i: number): string | undefined { return this.state.sheetIds[i]; }
  private sheetIndexOf(sid: string): number { return this.state.sheetIds.indexOf(sid); }

  private sheetNameLookup = (sid: string): string | undefined => this.state.sheets[sid]?.name;
  private nameToSheetId = (name: string): string | undefined => {
    for (const sid of this.state.sheetIds) if (this.state.sheets[sid]?.name === name) return sid;
    return undefined;
  };
  private sheetRowColLookup = (sid: string): { rowIds: string[]; colIds: string[] } | undefined => {
    const s = this.state.sheets[sid];
    return s ? { rowIds: s.rowIds, colIds: s.colIds } : undefined;
  };

  /** stored (internal) → A1 for feeding IronCalc. */
  private toInput(stored: string, rowIdx: number, colIdx: number, s: SheetState): string {
    if (!stored.startsWith('=')) return stored;
    return internalToA1(stored, rowIdx, colIdx, s.rowIds, s.colIds, this.sheetNameLookup, this.sheetRowColLookup);
  }
  /** A1 input → stored (internal) for writing to the doc. */
  private toStored(input: string, rowIdx: number, colIdx: number, s: SheetState): string {
    if (!input.startsWith('=')) return input;
    return a1ToInternal(input, rowIdx, colIdx, s.rowIds, s.colIds, this.nameToSheetId,
      (sid) => { const l = this.sheetRowColLookup(sid); return l ? { rowIds: l.rowIds, colIds: l.colIds } : undefined; });
  }

  // ── Seed the Model from doc state ────────────────────────────────────────────
  private seed(): void {
    this.model.pauseEvaluation();
    this.state.sheetIds.forEach((sid, i) => {
      const s = this.state.sheets[sid];
      if (i > 0) this.model.newSheet();
      try { this.model.renameSheet(i, s.name); } catch { /* name clash — leave default */ }
      for (const [key, stored] of Object.entries(s.cells)) {
        if (stored === '') continue;
        const sep = key.indexOf(':');
        const rowId = key.slice(0, sep), colId = key.slice(sep + 1);
        const r = s.rowIds.indexOf(rowId), c = s.colIds.indexOf(colId);
        if (r < 0 || c < 0) continue;
        try { this.model.setUserInput(i, r + 1, c + 1, this.toInput(stored, r, c, s)); } catch { /* skip bad cell */ }
      }
    });
    this.model.resumeEvaluation();
    this.model.evaluate();
    this.model.setSelectedSheet(0);
    this.applyStoredFormats();
    this.applyStoredLayout();
    this.applyConditionalFormats();
  }

  /** Ensure the sheet has at least `n` rows/cols in the ID list, writing new entries to the doc. */
  private ensureRows(sid: string, n: number): void {
    const s = this.state.sheets[sid];
    if (s.rowIds.length >= n) return;
    const start = s.rowIds.length;
    const base = start > 0 ? this.rowIndexAt(sid, start - 1) : 0;
    const added: Array<[string, number]> = [];
    for (let i = start; i < n; i++) { const id = shortId(); s.rowIds.push(id); added.push([id, base + (i - start) + 1]); }
    updateDoc(this.docId, (d, sid, added) => {
      for (const [id, index] of added) d.sheets[sid].rows[id] = { index };
    }, sid, added);
  }
  private ensureCols(sid: string, n: number): void {
    const s = this.state.sheets[sid];
    if (s.colIds.length >= n) return;
    const start = s.colIds.length;
    const base = start > 0 ? this.colIndexAt(sid, start - 1) : 0;
    const added: Array<[string, number]> = [];
    for (let i = start; i < n; i++) { const id = shortId(); s.colIds.push(id); added.push([id, base + (i - start) + 1]); }
    updateDoc(this.docId, (d, sid, added) => {
      for (const [id, index] of added) d.sheets[sid].columns[id] = { index };
    }, sid, added);
  }
  // We don't keep row/col fractional indices locally; approximate from position for new appends.
  private rowIndexAt(_sid: string, pos: number): number { return pos + 1; }
  private colIndexAt(_sid: string, pos: number): number { return pos + 1; }

  // ── Local edits → Automerge (monkeypatched Model mutators) ──────────────────
  private patchMutators(): void {
    const m = this.model as any;
    const wrap = (name: string, after: (args: any[], ret: any) => void) => {
      const fn = m[name];
      if (typeof fn !== 'function') { console.warn(`[bridge] Model has no method '${name}'; skipping mirror`); return; }
      const orig = fn.bind(m);
      m[name] = (...args: any[]) => {
        const ret = orig(...args);
        if (!this.applyingRemote && !this.destroyed) { try { after(args, ret); } catch (e) { console.error(`[bridge] mirror ${name} failed`, e); } }
        return ret;
      };
    };

    wrap('setUserInput', ([sheet, row, col, input]) => this.mirrorSetCell(sheet, row, col, input));

    // The runtime Model (workbook's bundled 0.5.x wasm) exposes SINGULAR insert/delete
    // (one row/col at a time) — not the plural forms in @ironcalc/wasm@0.7's .d.ts.
    wrap('insertRow', ([sheet, row]) => this.mirrorInsertRows(sheet, row, 1));
    wrap('insertColumn', ([sheet, col]) => this.mirrorInsertColumns(sheet, col, 1));
    wrap('deleteRow', ([sheet, row]) => this.mirrorDeleteRows(sheet, row, 1));
    wrap('deleteColumn', ([sheet, col]) => this.mirrorDeleteColumns(sheet, col, 1));

    wrap('renameSheet', ([sheet, name]) => this.mirrorRenameSheet(sheet, name));
    wrap('newSheet', () => this.mirrorNewSheet());
    wrap('deleteSheet', ([sheet]) => this.mirrorDeleteSheet(sheet));

    // Formatting → persisted FormatRange entries (the CF-applied styles set the
    // guard, so those derived styles are not mirrored back as user formatting).
    wrap('updateRangeStyle', ([area, path, value]) => this.mirrorSetStyle(area, path, value));
    wrap('rangeClearFormatting', ([sheet, sr, sc, er, ec]) => this.mirrorClearFormatting(sheet, sr, sc, er, ec));

    // Column width / row height / frozen panes → persisted on the row/col entries.
    wrap('setColumnsWidth', ([sheet, cs, ce, w]) => this.mirrorSetColumnsWidth(sheet, cs, ce, w));
    wrap('setRowsHeight', ([sheet, rs, re, h]) => this.mirrorSetRowsHeight(sheet, rs, re, h));
    wrap('setFrozenRowsCount', ([sheet, count]) => this.mirrorSetFrozen(sheet, 'rows', count));
    wrap('setFrozenColumnsCount', ([sheet, count]) => this.mirrorSetFrozen(sheet, 'cols', count));

    // Multi-cell ops: forward, then read the affected range back out of the model.
    wrap('rangeClearContents', ([s, sr, sc, er, ec]) => this.reconcileRange(s, sr, sc, er, ec));
    wrap('rangeClearAll', ([s, sr, sc, er, ec]) => this.reconcileRange(s, sr, sc, er, ec));
    wrap('pasteCsvText', ([area, csv]) => {
      const rows = String(csv).split('\n');
      const nRows = rows.length, nCols = Math.max(1, ...rows.map(r => r.split('\t').length));
      this.reconcileRange(area.sheet, area.row, area.column, area.row + nRows - 1, area.column + nCols - 1);
    });
    wrap('pasteFromClipboard', ([_src, _range, clipboard]) => {
      const v = this.model.getSelectedView();
      const [r0, c0] = [v.range[0], v.range[1]];
      const dims = clipboardDims(clipboard);
      this.reconcileRange(v.sheet, r0, c0, r0 + dims.rows - 1, c0 + dims.cols - 1);
    });
    wrap('autoFillRows', ([area, toRow]) => {
      const r0 = Math.min(area.row, toRow), r1 = Math.max(area.row + area.height - 1, toRow);
      this.reconcileRange(area.sheet, r0, area.column, r1, area.column + area.width - 1);
    });
    wrap('autoFillColumns', ([area, toCol]) => {
      const c0 = Math.min(area.column, toCol), c1 = Math.max(area.column + area.width - 1, toCol);
      this.reconcileRange(area.sheet, area.row, c0, area.row + area.height - 1, c1);
    });
  }

  private mirrorSetCell(sheet: number, row: number, col: number, input: string): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    this.ensureRows(sid, row); this.ensureCols(sid, col);
    const s = this.state.sheets[sid];
    const rowId = s.rowIds[row - 1], colId = s.colIds[col - 1];
    if (!rowId || !colId) return;
    const key = `${rowId}:${colId}`;
    const stored = this.toStored(input, row - 1, col - 1, s);
    if (stored === '') { delete s.cells[key]; }
    else { s.cells[key] = stored; }
    updateDoc(this.docId, (d, sid, key, stored) => {
      const cells = d.sheets[sid].cells;
      if (stored === '') { if (cells[key]) delete cells[key]; }
      else if (!cells[key]) cells[key] = { value: stored };
      else if (cells[key].value !== stored) cells[key].value = stored;
    }, sid, key, stored);
  }

  /** Read cells [r0..r1]x[c0..c1] (1-based, inclusive) out of the model into the doc. */
  private reconcileRange(sheet: number, r0: number, c0: number, r1: number, c1: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    this.ensureRows(sid, r1); this.ensureCols(sid, c1);
    const s = this.state.sheets[sid];
    const sets: Array<[string, string]> = [];
    const dels: string[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const rowId = s.rowIds[r - 1], colId = s.colIds[c - 1];
        if (!rowId || !colId) continue;
        const key = `${rowId}:${colId}`;
        let content = '';
        try { content = this.model.getCellContent(sheet, r, c); } catch { content = ''; }
        const stored = this.toStored(content, r - 1, c - 1, s);
        if (stored === '') { if (s.cells[key] !== undefined) { delete s.cells[key]; dels.push(key); } }
        else if (s.cells[key] !== stored) { s.cells[key] = stored; sets.push([key, stored]); }
      }
    }
    if (!sets.length && !dels.length) return;
    updateDoc(this.docId, (d, sid, sets, dels) => {
      const cells = d.sheets[sid].cells;
      for (const [key, val] of sets) { if (!cells[key]) cells[key] = { value: val }; else cells[key].value = val; }
      for (const key of dels) if (cells[key]) delete cells[key];
    }, sid, sets, dels);
  }

  private mirrorInsertRows(sheet: number, row: number, count: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const s = this.state.sheets[sid];
    // Insert `count` new row IDs at position `row` (1-based). Existing cells keep their keys.
    const ids: string[] = [];
    for (let k = 0; k < Math.max(1, count); k++) ids.push(shortId());
    const pos = Math.max(0, Math.min(row - 1, s.rowIds.length));
    s.rowIds.splice(pos, 0, ...ids);
    const rows = s.rowIds.map((rid, i) => [rid, i + 1] as [string, number]);
    updateDoc(this.docId, (d, sid, ids, rows) => {
      for (const id of ids) d.sheets[sid].rows[id] = { index: 0 };
      for (const [rid, index] of rows) if (d.sheets[sid].rows[rid]) d.sheets[sid].rows[rid].index = index;
    }, sid, ids, rows);
  }
  private mirrorInsertColumns(sheet: number, col: number, count: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const s = this.state.sheets[sid];
    const ids: string[] = [];
    for (let k = 0; k < Math.max(1, count); k++) ids.push(shortId());
    const pos = Math.max(0, Math.min(col - 1, s.colIds.length));
    s.colIds.splice(pos, 0, ...ids);
    const cols = s.colIds.map((cid, i) => [cid, i + 1] as [string, number]);
    updateDoc(this.docId, (d, sid, ids, cols) => {
      for (const id of ids) d.sheets[sid].columns[id] = { index: 0 };
      for (const [cid, index] of cols) if (d.sheets[sid].columns[cid]) d.sheets[sid].columns[cid].index = index;
    }, sid, ids, cols);
  }
  private mirrorDeleteRows(sheet: number, row: number, count: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const s = this.state.sheets[sid];
    const removed = s.rowIds.slice(row - 1, row - 1 + Math.max(1, count)).filter(Boolean);
    if (!removed.length) return;
    const removedSet = new Set(removed);
    s.rowIds.splice(row - 1, removed.length);
    const rewrites = updateFormulasForDeletion(mapCells(s.cells), removedSet, new Set(), s.rowIds.concat(removed), s.colIds);
    for (const key of Object.keys(s.cells)) if (removedSet.has(key.slice(0, key.indexOf(':')))) delete s.cells[key];
    for (const [key, val] of Object.entries(rewrites)) s.cells[key] = val;
    updateDoc(this.docId, (d, sid, removed, rewrites) => {
      const sheet = d.sheets[sid];
      for (const rowId of removed) {
        delete sheet.rows[rowId];
        for (const key of Object.keys(sheet.cells)) if (key.startsWith(rowId + ':')) delete sheet.cells[key];
      }
      for (const key in rewrites) if (sheet.cells[key]) sheet.cells[key].value = rewrites[key];
    }, sid, removed, rewrites);
  }
  private mirrorDeleteColumns(sheet: number, col: number, count: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const s = this.state.sheets[sid];
    const removed = s.colIds.slice(col - 1, col - 1 + Math.max(1, count)).filter(Boolean);
    if (!removed.length) return;
    const removedSet = new Set(removed);
    s.colIds.splice(col - 1, removed.length);
    const rewrites = updateFormulasForDeletion(mapCells(s.cells), new Set(), removedSet, s.rowIds, s.colIds.concat(removed));
    for (const key of Object.keys(s.cells)) if (removedSet.has(key.slice(key.indexOf(':') + 1))) delete s.cells[key];
    for (const [key, val] of Object.entries(rewrites)) s.cells[key] = val;
    updateDoc(this.docId, (d, sid, removed, rewrites) => {
      const sheet = d.sheets[sid];
      for (const colId of removed) {
        delete sheet.columns[colId];
        for (const key of Object.keys(sheet.cells)) if (key.endsWith(':' + colId)) delete sheet.cells[key];
      }
      for (const key in rewrites) if (sheet.cells[key]) sheet.cells[key].value = rewrites[key];
    }, sid, removed, rewrites);
  }

  private mirrorRenameSheet(sheet: number, name: string): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    this.state.sheets[sid].name = name;
    updateDoc(this.docId, (d, sid, name) => { d.sheets[sid].name = name; }, sid, name);
  }
  private mirrorNewSheet(): void {
    const sid = shortId();
    const index = this.state.sheetIds.length + 1;
    const name = `Sheet ${index}`;
    const { rowIds, colIds, rows, columns } = buildDefaultGrid();
    this.state.sheetIds.push(sid);
    this.state.sheets[sid] = { name, index, rowIds, colIds, cells: {}, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0 };
    // IronCalc named it "Sheet N" too; keep in sync best-effort.
    try { this.model.renameSheet(this.state.sheetIds.length - 1, name); } catch { /* ignore */ }
    updateDoc(this.docId, (d, sid, name, index, rows, columns) => {
      d.sheets[sid] = { '@type': 'Sheet', name, index, columns, rows, cells: {} };
    }, sid, name, index, rows, columns);
  }
  private mirrorDeleteSheet(sheet: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const rewrites = rewriteFormulasForSheetDeletion(sheetsForRewrite(this.state), sid);
    this.state.sheetIds.splice(sheet, 1);
    delete this.state.sheets[sid];
    for (const [osid, cellRewrites] of Object.entries(rewrites)) {
      const os = this.state.sheets[osid]; if (!os) continue;
      for (const [key, val] of Object.entries(cellRewrites)) os.cells[key] = val;
    }
    updateDoc(this.docId, (d, sid, rewrites) => {
      delete d.sheets[sid];
      for (const osid in rewrites) {
        const os = d.sheets[osid]; if (!os) continue;
        for (const key in rewrites[osid]) if (os.cells[key]) os.cells[key].value = rewrites[osid][key];
      }
    }, sid, rewrites);
  }

  // ── Formatting / layout → persisted on the doc (mirrors IronCalc mutators) ───
  // The doc is the source of truth; local state refreshes on the change round-trip
  // (applyRemoteCells → applyStored*), so these only mutate the doc.
  private mirrorSetStyle(area: { sheet: number; row: number; column: number; width: number; height: number }, path: string, value: string): void {
    const patch = stylePathToPatch(path, value);
    if (!patch) return; // unsupported path (e.g. font.size_delta) — not persisted
    const sid = this.sheetIdAt(area.sheet); if (!sid) return;
    const s = this.state.sheets[sid];
    // Clamp the range end to the tracked rows/cols (IronCalc's grid shows more
    // rows/cols than the doc materializes; formatting beyond them can't persist).
    const bounds = {
      rangeRowStart: s.rowIds[area.row - 1], rangeRowEnd: s.rowIds[Math.min(area.row + area.height - 2, s.rowIds.length - 1)],
      rangeColStart: s.colIds[area.column - 1], rangeColEnd: s.colIds[Math.min(area.column + area.width - 2, s.colIds.length - 1)],
    };
    if (!bounds.rangeRowStart || !bounds.rangeRowEnd || !bounds.rangeColStart || !bounds.rangeColEnd) return;
    const newId = shortId();
    // NB: this callback runs in the worker (updateDoc serializes it), so it must be
    // self-contained — it inlines the doc-mutations.ts `applyFormatPatch` logic.
    updateDoc(this.docId, (d, sid, b, patch, newId) => {
      const ms = d.sheets[sid];
      if (!ms.formats) ms.formats = {};
      let existingId: string | null = null;
      for (const id in ms.formats) {
        const f = ms.formats[id];
        if (f.rangeRowStart === b.rangeRowStart && f.rangeRowEnd === b.rangeRowEnd && f.rangeColStart === b.rangeColStart && f.rangeColEnd === b.rangeColEnd) { existingId = id; break; }
      }
      if (existingId) {
        const range = ms.formats[existingId];
        if (!range.format) range.format = {};
        for (const k in patch) { if (patch[k] === undefined) delete range.format[k]; else range.format[k] = patch[k]; }
        if (Object.keys(range.format).length === 0) delete ms.formats[existingId];
      } else {
        let maxIndex = 0;
        for (const id in ms.formats) if (ms.formats[id].index > maxIndex) maxIndex = ms.formats[id].index;
        ms.formats[newId] = { index: maxIndex + 1, rangeRowStart: b.rangeRowStart, rangeRowEnd: b.rangeRowEnd, rangeColStart: b.rangeColStart, rangeColEnd: b.rangeColEnd, format: { ...patch } };
      }
    }, sid, bounds, patch, newId);
  }

  private mirrorClearFormatting(sheet: number, sr: number, sc: number, er: number, ec: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const s = this.state.sheets[sid];
    const r0 = Math.min(sr, er) - 1, r1 = Math.max(sr, er) - 1;
    const c0 = Math.min(sc, ec) - 1, c1 = Math.max(sc, ec) - 1;
    const rowIds = s.rowIds, colIds = s.colIds;
    updateDoc(this.docId, (d, sid, rowIds, colIds, r0, r1, c0, c1) => {
      const ms = d.sheets[sid]; if (!ms.formats) return;
      for (const id in ms.formats) {
        const fr = ms.formats[id];
        const fr0 = rowIds.indexOf(fr.rangeRowStart), fr1 = rowIds.indexOf(fr.rangeRowEnd);
        const fc0 = colIds.indexOf(fr.rangeColStart), fc1 = colIds.indexOf(fr.rangeColEnd);
        if (fr0 < 0 || fr1 < 0 || fc0 < 0 || fc1 < 0) continue;
        if (fr0 >= r0 && fr1 <= r1 && fc0 >= c0 && fc1 <= c1) delete ms.formats[id];
      }
    }, sid, rowIds, colIds, r0, r1, c0, c1);
  }

  private mirrorSetColumnsWidth(sheet: number, colStart: number, colEnd: number, width: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const colIds = this.state.sheets[sid].colIds.slice(colStart - 1, colEnd);
    if (!colIds.length) return;
    updateDoc(this.docId, (d, sid, colIds, width) => {
      const cols = d.sheets[sid].columns;
      for (const cid of colIds) if (cols[cid]) cols[cid].width = width;
    }, sid, colIds, width);
  }
  private mirrorSetRowsHeight(sheet: number, rowStart: number, rowEnd: number, height: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const rowIds = this.state.sheets[sid].rowIds.slice(rowStart - 1, rowEnd);
    if (!rowIds.length) return;
    updateDoc(this.docId, (d, sid, rowIds, height) => {
      const rows = d.sheets[sid].rows;
      for (const rid of rowIds) if (rows[rid]) rows[rid].height = height;
    }, sid, rowIds, height);
  }
  private mirrorSetFrozen(sheet: number, which: 'rows' | 'cols', count: number): void {
    const sid = this.sheetIdAt(sheet); if (!sid) return;
    const s = this.state.sheets[sid];
    const ids = which === 'rows' ? s.rowIds : s.colIds;
    updateDoc(this.docId, (d, sid, ids, count, which) => {
      const map = which === 'rows' ? d.sheets[sid].rows : d.sheets[sid].columns;
      ids.forEach((id: string, i: number) => { const e = map[id]; if (!e) return; if (i < count) e.frozen = true; else delete e.frozen; });
    }, sid, ids, count, which);
  }

  // ── Selection → presence ─────────────────────────────────────────────────────
  private patchSelection(): void {
    const m = this.model as any;
    const emit = () => {
      if (this.destroyed) return;
      try {
        const v = this.model.getSelectedView();
        const sid = this.sheetIdAt(v.sheet); if (!sid) { this.cb.onFocus(null); return; }
        const s = this.state.sheets[sid];
        const rowId = s?.rowIds[v.row - 1], colId = s?.colIds[v.column - 1];
        this.cb.onFocus(rowId && colId ? ['sheets', sid, 'cells', `${rowId}:${colId}`] : null);
      } catch { /* selection not ready */ }
    };
    // Wrap every selection-changing entry point — direct set (mouse) AND keyboard
    // navigation (arrows, page, shift-expand, tab/enter go through these) — so the
    // selection callback fires however the user moves.
    const selectionMethods = [
      'setSelectedCell', 'setSelectedRange', 'setSelectedSheet',
      'onArrowUp', 'onArrowDown', 'onArrowLeft', 'onArrowRight',
      'onExpandSelectedRange', 'onPageUp', 'onPageDown', 'onAreaSelecting',
    ];
    for (const name of selectionMethods) {
      const fn = m[name];
      if (typeof fn !== 'function') continue;
      const orig = fn.bind(m);
      m[name] = (...args: any[]) => { const r = orig(...args); emit(); return r; };
    }
  }

  // ── Remote edits → Model ─────────────────────────────────────────────────────
  /** True if the row/col/sheet ID structure differs (needs a full rebuild). */
  structurallyDiffers(next: DocState): boolean {
    if (next.sheetIds.length !== this.state.sheetIds.length) return true;
    for (let i = 0; i < next.sheetIds.length; i++) {
      const a = this.state.sheets[this.state.sheetIds[i]];
      const b = next.sheets[next.sheetIds[i]];
      if (!a || !b) return true;
      if (a.rowIds.length !== b.rowIds.length || a.colIds.length !== b.colIds.length) return true;
      for (let r = 0; r < a.rowIds.length; r++) if (a.rowIds[r] !== b.rowIds[r]) return true;
      for (let c = 0; c < a.colIds.length; c++) if (a.colIds[c] !== b.colIds[c]) return true;
      if (a.name !== b.name) return true;
    }
    return false;
  }

  /** Idempotently apply a non-structural remote update (cell values only). */
  applyRemoteCells(next: DocState): void {
    this.applyingRemote = true;
    let changed = 0;
    try {
      this.model.pauseEvaluation();
      next.sheetIds.forEach((sid, i) => {
        const nextS = next.sheets[sid];
        const prevS = this.state.sheets[sid];
        if (!nextS || !prevS) return;
        // Apply/overwrite cells present in next.
        for (const [key, stored] of Object.entries(nextS.cells)) {
          const sep = key.indexOf(':');
          const r = nextS.rowIds.indexOf(key.slice(0, sep));
          const c = nextS.colIds.indexOf(key.slice(sep + 1));
          if (r < 0 || c < 0) continue;
          const wantA1 = this.toInput(stored, r, c, nextS);
          let cur = '';
          try { cur = this.model.getCellContent(i, r + 1, c + 1); } catch { cur = ''; }
          if (cur !== wantA1) { try { this.model.setUserInput(i, r + 1, c + 1, wantA1); changed++; } catch { /* skip */ } }
        }
        // Clear cells that existed before but are gone now.
        for (const key of Object.keys(prevS.cells)) {
          if (nextS.cells[key] !== undefined) continue;
          const sep = key.indexOf(':');
          const r = nextS.rowIds.indexOf(key.slice(0, sep));
          const c = nextS.colIds.indexOf(key.slice(sep + 1));
          if (r < 0 || c < 0) continue;
          try { if (this.model.getCellContent(i, r + 1, c + 1) !== '') { this.model.setUserInput(i, r + 1, c + 1, ''); changed++; } } catch { /* skip */ }
        }
      });
      this.model.resumeEvaluation();
      if (changed) this.model.evaluate();
    } finally {
      this.applyingRemote = false;
    }
    this.state = next;
    this.applyStoredFormats();
    this.applyStoredLayout();
    const cfChanged = this.applyConditionalFormats();
    if (changed || cfChanged) this.cb.onModelChanged();
  }

  /** Replace the tracked state (used after a rebuild). */
  setState(next: DocState): void { this.state = next; }

  // ── Conditional formatting → static Model styles ─────────────────────────────
  /**
   * IronCalc has no native conditional formatting, so we evaluate each sheet's
   * rules and push the resulting styles into the Model via `updateRangeStyle`.
   * Cells that matched before but no longer match are cleared. Re-run whenever
   * cell values or rules change (see seed/applyRemoteCells).
   */
  applyConditionalFormats(): boolean {
    const prevApplying = this.applyingRemote;
    this.applyingRemote = true;
    let changed = false;
    try {
      this.state.sheetIds.forEach((sid, i) => {
        const s = this.state.sheets[sid];
        const rules = s.conditionalFormats;
        const prev = this.cfStyled.get(sid) ?? new Set<string>();
        const next = new Set<string>();
        if (rules && Object.keys(rules).length) {
          for (const [rowId, colId] of cellsInRules(rules, s.rowIds, s.colIds)) {
            const r = s.rowIds.indexOf(rowId), c = s.colIds.indexOf(colId);
            if (r < 0 || c < 0) continue;
            let value = '';
            try {
              value = this.model.getCellContent(i, r + 1, c + 1);
              if (value.startsWith('=')) value = this.model.getFormattedCellValue(i, r + 1, c + 1);
            } catch { value = ''; }
            const fmt = evaluateConditionalFormats(rules, rowId, colId, value, s.rowIds, s.colIds);
            if (!fmt) continue;
            this.applyFormat({ sheet: i, row: r + 1, column: c + 1, width: 1, height: 1 }, fmt);
            next.add(`${rowId}:${colId}`);
          }
        }
        for (const key of prev) {
          if (next.has(key)) continue;
          const sep = key.indexOf(':');
          const r = s.rowIds.indexOf(key.slice(0, sep)), c = s.colIds.indexOf(key.slice(sep + 1));
          if (r < 0 || c < 0) continue;
          try { this.model.rangeClearFormatting(i, r + 1, c + 1, r + 1, c + 1); } catch { /* ignore */ }
        }
        // The styled set changed (matches added/removed) → the view needs a redraw.
        if (next.size !== prev.size || [...next].some((k) => !prev.has(k))) changed = true;
        if (next.size) this.cfStyled.set(sid, next); else this.cfStyled.delete(sid);
      });
    } finally {
      this.applyingRemote = prevApplying;
    }
    return changed;
  }

  /** Apply a DataGridCellFormat to a Model range via IronCalc's style paths. */
  private applyFormat(area: { sheet: number; row: number; column: number; width: number; height: number }, fmt: DataGridCellFormat): void {
    const m = this.model as any;
    const set = (path: string, val: string) => { try { m.updateRangeStyle(area, path, val); } catch { /* ignore */ } };
    if (fmt.bold !== undefined) set('font.b', String(!!fmt.bold));
    if (fmt.italic !== undefined) set('font.i', String(!!fmt.italic));
    if (fmt.underline !== undefined) set('font.u', String(!!fmt.underline));
    if (fmt.strikethrough !== undefined) set('font.strike', String(!!fmt.strikethrough));
    if (fmt.textColor) set('font.color', fmt.textColor);
    if (fmt.bgColor) set('fill.fg_color', fmt.bgColor);
    if (fmt.numFmt) set('num_fmt', fmt.numFmt);
    if (fmt.hAlign) set('alignment.horizontal', fmt.hAlign);
    if (fmt.vAlign) set('alignment.vertical', fmt.vAlign);
    if (fmt.wrapText !== undefined) set('alignment.wrap_text', String(!!fmt.wrapText));
  }

  /** Re-apply persisted FormatRange styles (index order) to the Model. Idempotent. */
  applyStoredFormats(): void {
    const prevApplying = this.applyingRemote;
    this.applyingRemote = true;
    try {
      this.state.sheetIds.forEach((sid, i) => {
        const fmts = this.state.sheets[sid]?.formats;
        if (!fmts) return;
        const s = this.state.sheets[sid];
        for (const fr of Object.values(fmts).sort((a, b) => a.index - b.index)) {
          const r0 = s.rowIds.indexOf(fr.rangeRowStart), r1 = s.rowIds.indexOf(fr.rangeRowEnd);
          const c0 = s.colIds.indexOf(fr.rangeColStart), c1 = s.colIds.indexOf(fr.rangeColEnd);
          if (r0 < 0 || r1 < 0 || c0 < 0 || c1 < 0) continue;
          this.applyFormat({ sheet: i, row: r0 + 1, column: c0 + 1, width: c1 - c0 + 1, height: r1 - r0 + 1 }, fr.format);
        }
      });
    } finally {
      this.applyingRemote = prevApplying;
    }
  }

  /** Re-apply persisted column widths, row heights, and frozen panes to the Model. */
  applyStoredLayout(): void {
    const prevApplying = this.applyingRemote;
    this.applyingRemote = true;
    const m = this.model as any;
    try {
      this.state.sheetIds.forEach((sid, i) => {
        const s = this.state.sheets[sid];
        for (const [colId, w] of Object.entries(s.colWidths)) {
          const c = s.colIds.indexOf(colId); if (c < 0) continue;
          try { m.setColumnsWidth(i, c + 1, c + 1, w); } catch { /* ignore */ }
        }
        for (const [rowId, h] of Object.entries(s.rowHeights)) {
          const r = s.rowIds.indexOf(rowId); if (r < 0) continue;
          try { m.setRowsHeight(i, r + 1, r + 1, h); } catch { /* ignore */ }
        }
        try { m.setFrozenRowsCount(i, s.frozenRows); } catch { /* ignore */ }
        try { m.setFrozenColumnsCount(i, s.frozenCols); } catch { /* ignore */ }
      });
    } finally {
      this.applyingRemote = prevApplying;
    }
  }
}

/** Map an IronCalc updateRangeStyle (path, value) to a DataGridCellFormat patch. */
function stylePathToPatch(path: string, value: string): Partial<DataGridCellFormat> | null {
  switch (path) {
    case 'font.b': return { bold: value === 'true' };
    case 'font.i': return { italic: value === 'true' };
    case 'font.u': return { underline: value === 'true' };
    case 'font.strike': return { strikethrough: value === 'true' };
    case 'font.color': return { textColor: value };
    case 'fill.fg_color': return { bgColor: value };
    case 'num_fmt': return { numFmt: value };
    case 'alignment.horizontal': return { hAlign: value };
    case 'alignment.vertical': return { vAlign: value };
    case 'alignment.wrap_text': return { wrapText: value === 'true' };
    default: return null; // e.g. font.size_delta — not persisted
  }
}

/** Expand every rule's ranges into a deduped list of [rowId, colId] cell pairs. */
function cellsInRules(
  rules: Record<string, ConditionalFormatRule>, rowIds: string[], colIds: string[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const rule of Object.values(rules)) {
    for (const range of Object.values(rule.ranges || {})) {
      let r0 = rowIds.indexOf(range.rangeRowStart), r1 = rowIds.indexOf(range.rangeRowEnd);
      let c0 = colIds.indexOf(range.rangeColStart), c1 = colIds.indexOf(range.rangeColEnd);
      if (r0 < 0 || r1 < 0 || c0 < 0 || c1 < 0) continue;
      if (r0 > r1) [r0, r1] = [r1, r0];
      if (c0 > c1) [c0, c1] = [c1, c0];
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const key = `${rowIds[r]}:${colIds[c]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([rowIds[r], colIds[c]]);
      }
    }
  }
  return out;
}

// ── small pure helpers ─────────────────────────────────────────────────────────
function mapCells(cells: Record<string, string>): Record<string, { value: string }> {
  const out: Record<string, { value: string }> = {};
  for (const [k, v] of Object.entries(cells)) out[k] = { value: v };
  return out;
}
function sheetsForRewrite(state: DocState): Record<string, { cells: Record<string, { value: string }> }> {
  const out: Record<string, { cells: Record<string, { value: string }> }> = {};
  for (const sid of state.sheetIds) out[sid] = { cells: mapCells(state.sheets[sid].cells) };
  return out;
}
function clipboardDims(clipboard: any): { rows: number; cols: number } {
  try {
    const rowKeys = clipboard instanceof Map ? [...clipboard.keys()] : Object.keys(clipboard?.data ?? clipboard ?? {});
    let cols = 1;
    const rowsMap = clipboard instanceof Map ? clipboard : (clipboard?.data ?? clipboard);
    for (const rk of rowKeys) {
      const rowVal = rowsMap instanceof Map ? rowsMap.get(rk) : rowsMap[rk];
      const n = rowVal instanceof Map ? rowVal.size : Object.keys(rowVal ?? {}).length;
      if (n > cols) cols = n;
    }
    return { rows: Math.max(1, rowKeys.length), cols };
  } catch { return { rows: 1, cols: 1 }; }
}
