import {
  sortedEntries, shortId, a1ToInternal, internalToR1C1,
  updateFormulasForDeletion, generateAutofillValues, getAutofillSourceValues,
} from './helpers';
import {
  buildClipboardData, writeClipboard, parseHtmlClipboard,
  getEffectiveRange, type ClipboardEntry, type CellRange,
} from './clipboard';
import type { DataGridDocument, DataGridCellFormat } from '../../../../shared/schemas/datagrid';
import { applyFreezeCount } from './sheet-actions';

// ============================================================
// Shortcut — canonical keyboard shortcut definition
// Derives both the display string and the event matcher from one place.
// ============================================================

export interface Shortcut {
  key: string;       // e.g. 'z', 'Delete', 'c'
  mod?: boolean;     // true = require Ctrl/Meta; false = require none; undefined = don't check
  shift?: boolean;   // true = require Shift; false = require none; undefined = don't check
  alt?: boolean;     // true = require Alt; false = require none; undefined = don't check
  display?: string;  // Override auto-generated display string
}

/**
 * How long the paste shortcut waits for the browser's own `paste` event before
 * falling back to the async Clipboard API. Long enough that a dispatched event
 * always wins the race (it follows keydown immediately), short enough to feel
 * instant when none is coming.
 */
export const PASTE_FALLBACK_MS = 50;

export function matchShortcut(e: KeyboardEvent, isMod: boolean, s: Shortcut): boolean {
  if (s.mod !== undefined && s.mod !== isMod) return false;
  if (s.shift !== undefined && s.shift !== e.shiftKey) return false;
  if (s.alt !== undefined && s.alt !== e.altKey) return false;
  return e.key === s.key;
}

export function shortcutDisplay(s: Shortcut): string {
  if (s.display) return s.display;
  const parts: string[] = [];
  if (s.mod) parts.push('Ctrl');
  if (s.alt) parts.push('Alt');
  if (s.shift) parts.push('Shift');
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
  parts.push(key);
  return parts.join('+');
}

// ============================================================
// GridCommandState — what commands need for enabled/label computation
// ============================================================

export interface GridCommandState {
  /** False when the grid is read-only (view access / older version): every
   * command except the READ_ONLY_COMMANDS allowlist resolves disabled. */
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  currentRowIndices: number[];
  currentColIndices: number[];
  /** Whether the active sheet currently has frozen rows/columns —
   * gates the unfreeze commands. */
  hasFrozenRows: boolean;
  hasFrozenCols: boolean;
  /** Non-null only when resolving context-menu slots */
  contextScope: { type: 'row' | 'col' | 'cell'; indices: number[] } | null;
  /** Format of the currently selected cell (for toggle state). */
  currentCellFormat?: DataGridCellFormat;
}

/** Commands that stay enabled on a read-only grid. */
const READ_ONLY_COMMANDS = new Set(['copy']);

// ============================================================
// GridCommandContext — raw materials for command execute bodies
// ============================================================

export interface GridCommandContext {
  /** Immutable snapshot of the active sheet. */
  sheet: any | null;
  /** Lightweight metadata for all sheets (name, index, hidden, sorted row/col IDs). */
  sheetsMeta: Record<string, { name: string; index: number; hidden?: boolean; rows?: string[]; cols?: string[] }> | null;
  computedValues: Map<string, string | number> | null;
  spillTargets: Set<string>;
  currentSheetId: string;
  sortedRowIds: string[];
  sortedColIds: string[];
  visibleRowIds: string[];
  visibleColIds: string[];
  selectedCell: [number, number] | null;
  selectionAnchor: [number, number] | null;
  currentRowIndices: number[];
  currentColIndices: number[];
  selectedRows: Set<number>;
  selectedCols: Set<number>;
  clipboardRef: { current: ClipboardEntry | null };
  setClipboardSource: (r: CellRange | null) => void;
  /** Apply a mutation to the document. */
  mutate: (fn: (doc: DataGridDocument, ...args: any[]) => void, args: unknown[]) => void;
  setSelectionAnchor: (anchor: [number, number] | null) => void;
  setSelectedCell: (cell: [number, number]) => void;
  setContextMenu: (m: null) => void;
  setSelectedRows: (rows: Set<number>) => void;
  setSelectedCols: (cols: Set<number>) => void;
  undo: () => void;
  redo: () => void;
  /** Native paste event clipboard data (set by paste event listener). */
  pasteEvent?: ClipboardEvent;
  /**
   * The user pressed the paste shortcut. Schedules a *deferred* `executePaste()`
   * with no ClipboardEvent, which the grid's paste listener cancels if the
   * browser's own event arrives first (it is the better source). This is what
   * makes Ctrl+V work at all in a browser or focus state where no native paste
   * event is ever dispatched.
   */
  onPasteShortcut?: () => void;
  /** Open the row-height / column-width sheet for the current selection. */
  openResizeSheet?: (kind: 'row' | 'col') => void;
  formatCache?: Map<string, DataGridCellFormat>;
}

// ============================================================
// Command / Plugin types
// ============================================================

export interface GridCommand {
  id: string;
  defaultLabel: string | ((state: GridCommandState) => string);
  /** Material Symbols icon name, e.g. "undo" */
  icon?: string;
  /** Keyboard shortcuts. Primary (first) is shown in menus. */
  shortcuts?: Shortcut[];
  /** Red styling for destructive actions */
  danger?: boolean;
  /** If set, renders as a toggle (checkbox item / active-variant button) */
  toggle?: { isChecked(state: GridCommandState): boolean };
  isEnabled(state: GridCommandState): boolean;
  execute(state: GridCommandState, ctx: GridCommandContext): void;
}

export type SlotId = 'cell-ctx' | 'row-ctx' | 'col-ctx';

export type SlotEntry =
  | { kind: 'separator' }
  | {
    kind: 'command';
    id: string;
    label?: string | ((s: GridCommandState) => string);
    icon?: string;
  };

export interface GridPlugin {
  id: string;
  commands: GridCommand[];
  slots: Partial<Record<SlotId, SlotEntry[]>>;
}

// ============================================================
// Resolved types (consumed by renderers)
// ============================================================

export type ResolvedEntry =
  | { kind: 'separator' }
  | {
    kind: 'command';
    id: string;
    label: string;
    icon?: string;
    shortcut?: string;
    isEnabled: boolean;
    isChecked?: boolean;
    danger?: boolean;
    execute(): void;
  };

export interface GridCommandsApi {
  cellCtx: ResolvedEntry[];
  rowCtx: ResolvedEntry[];
  colCtx: ResolvedEntry[];
  /** Call from handleKeyDown after navigation keys. Returns true if the event was handled. */
  dispatchKey(e: KeyboardEvent, isMod: boolean): boolean;
  /** Execute the paste command with optional native ClipboardEvent data. */
  executePaste(pasteEvent?: ClipboardEvent): void;
  /** Resolve a single command id into an executable entry (read-only gated),
   * for ad-hoc surfaces like the bottom bar's quick actions. */
  resolveById(id: string): ResolvedEntry & { kind: 'command' };
}

// ============================================================
// Helpers shared by plugins
// ============================================================

/** Selection indices for an axis, honoring the context-menu scope. */
function lineIndices(axis: 'row' | 'col', s: GridCommandState): number[] {
  return s.contextScope?.type === axis
    ? s.contextScope.indices
    : (axis === 'row' ? s.currentRowIndices : s.currentColIndices);
}

/** Visible ids for an axis. */
function lineVisibleIds(axis: 'row' | 'col', ctx: GridCommandContext): string[] {
  return axis === 'row' ? ctx.visibleRowIds : ctx.visibleColIds;
}

/** The sheet's row/column map for an axis. */
function lineMap(axis: 'row' | 'col', sheet: any): Record<string, any> {
  return axis === 'row' ? sheet.rows : sheet.columns;
}

/** The sheet's row/column map as sorted entries for an axis. */
function lineEntries(axis: 'row' | 'col', sheet: any): Array<[string, any]> {
  return sortedEntries(lineMap(axis, sheet));
}

/** The currently selected index set for an axis. */
function lineSelected(axis: 'row' | 'col', ctx: GridCommandContext): Set<number> {
  return axis === 'row' ? ctx.selectedRows : ctx.selectedCols;
}

/** Replace an axis's selected-index set. */
function lineSetSelected(axis: 'row' | 'col', ctx: GridCommandContext, next: Set<number>): void {
  if (axis === 'row') ctx.setSelectedRows(next);
  else ctx.setSelectedCols(next);
}

/** Get the active sheet from the context. */
function ctxSheet(ctx: GridCommandContext) {
  return ctx.sheet;
}

// ============================================================
// Plugins
// ============================================================

const historyPlugin: GridPlugin = {
  id: 'history',
  commands: [
    {
      id: 'undo',
      defaultLabel: 'Undo',
      icon: 'undo',
      shortcuts: [{ key: 'z', mod: true, shift: false }],
      isEnabled: s => s.canUndo,
      execute: (_, ctx) => ctx.undo(),
    },
    {
      id: 'redo',
      defaultLabel: 'Redo',
      icon: 'redo',
      shortcuts: [
        { key: 'z', mod: true, shift: true, display: 'Ctrl+Shift+Z' },
        { key: 'y', mod: true },
      ],
      isEnabled: s => s.canRedo,
      execute: (_, ctx) => ctx.redo(),
    },
  ],
  slots: {},
};

const clipboardPlugin: GridPlugin = {
  id: 'clipboard',
  commands: [
    {
      id: 'copy',
      defaultLabel: 'Copy',
      icon: 'content_copy',
      shortcuts: [{ key: 'c', mod: true }],
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => {
        const range = getEffectiveRange(ctx.selectedCell, ctx.selectionAnchor);
        if (!range || !ctx.sheet) return;
        const sh = ctxSheet(ctx);
        // Range is VISIBLE-space: index cell keys via visibleRow/ColIds; use the full
        // sorted lists for R1C1/format resolution so hidden rows/cols aren't copied (H4).
        const data = buildClipboardData(sh.cells, ctx.computedValues, range, ctx.visibleRowIds, ctx.visibleColIds, ctx.currentSheetId, ctx.formatCache, ctx.sortedRowIds, ctx.sortedColIds);
        if (!data) return;
        ctx.clipboardRef.current = { values: data.values, formats: data.formats, mode: 'copy', range };
        ctx.setClipboardSource(range);
        writeClipboard(data.tsv, data.html);
      },
    },
    {
      id: 'cut',
      defaultLabel: 'Cut',
      icon: 'content_cut',
      shortcuts: [{ key: 'x', mod: true }],
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => {
        const range = getEffectiveRange(ctx.selectedCell, ctx.selectionAnchor);
        if (!range || !ctx.sheet) return;
        const sh = ctxSheet(ctx);
        // Range is VISIBLE-space: index cell keys via visibleRow/ColIds; use the full
        // sorted lists for R1C1/format resolution so hidden rows/cols aren't cut (H4).
        const data = buildClipboardData(sh.cells, ctx.computedValues, range, ctx.visibleRowIds, ctx.visibleColIds, ctx.currentSheetId, ctx.formatCache, ctx.sortedRowIds, ctx.sortedColIds);
        if (!data) return;
        ctx.clipboardRef.current = { values: data.values, formats: data.formats, mode: 'cut', range };
        ctx.setClipboardSource(range);
        writeClipboard(data.tsv, data.html);
      },
    },
    {
      id: 'paste',
      defaultLabel: 'Paste',
      icon: 'content_paste',
      shortcuts: [{ key: 'v', mod: true }],
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => {
        const { selectedCell, clipboardRef, mutate,
          setClipboardSource, setSelectionAnchor, setSelectedCell, currentSheetId } = ctx;
        if (!selectedCell) return;
        const [destCol, destRow] = selectedCell;

        if (clipboardRef.current) {
          // Internal paste: pre-compute everything outside mutate
          const { values, formats: clipFormats, mode, range: srcRange } = clipboardRef.current;
          const { sheet: doc } = ctx;
          if (!doc) return;
          const sh = ctxSheet(ctx);
          const rowEntries = sortedEntries(sh.rows);
          const colEntries = sortedEntries(sh.columns);
          const fullRowIds = rowEntries.map(([id]) => id);
          const fullColIds = colEntries.map(([id]) => id);
          // destCol/destRow (from selectedCell) are VISIBLE indices — write keys in
          // visible id space; resolve A1/R1C1 refs in full id space (H4).
          const visRowIds = ctx.visibleRowIds;
          const visColIds = ctx.visibleColIds;

          const neededRows = destRow + values.length;
          const neededCols = destCol + (values[0]?.length || 0);
          const lastRowIdx = rowEntries.length > 0 ? rowEntries[rowEntries.length - 1][1].index : 0;
          const lastColIdx = colEntries.length > 0 ? colEntries[colEntries.length - 1][1].index : 0;
          const newRowEntries: Array<[string, { index: number }]> = [];
          const newColEntries: Array<[string, { index: number; name: string }]> = [];
          for (let i = visRowIds.length; i < neededRows; i++) {
            newRowEntries.push([shortId(), { index: lastRowIdx + (i - visRowIds.length + 1) }]);
          }
          for (let i = visColIds.length; i < neededCols; i++) {
            newColEntries.push([shortId(), { index: lastColIdx + (i - visColIds.length + 1), name: '' }]);
          }
          const newRowIds = newRowEntries.map(([id]) => id);
          const newColIds = newColEntries.map(([id]) => id);
          // Visible id space (for cell keys) and full id space (for ref conversion),
          // both extended with the newly-appended rows/cols.
          const allRowIds = [...visRowIds, ...newRowIds];
          const allColIds = [...visColIds, ...newColIds];
          const refRowIds = [...fullRowIds, ...newRowIds];
          const refColIds = [...fullColIds, ...newColIds];

          const cellWrites: Array<[string, string]> = [];
          for (let dr = 0; dr < values.length; dr++) {
            for (let dc = 0; dc < values[dr].length; dc++) {
              const r = destRow + dr;
              const c = destCol + dc;
              if (r >= allRowIds.length || c >= allColIds.length) continue;
              const rowId = allRowIds[r];
              const colId = allColIds[c];
              const val = values[dr][dc];
              const stored = val.startsWith('=')
                ? a1ToInternal(val, refRowIds.indexOf(rowId), refColIds.indexOf(colId), refRowIds, refColIds)
                : val;
              cellWrites.push([`${rowId}:${colId}`, stored]);
            }
          }
          const cutDeletes: string[] = [];
          if (mode === 'cut') {
            for (let r = srcRange.minRow; r <= srcRange.maxRow; r++) {
              for (let c = srcRange.minCol; c <= srcRange.maxCol; c++) {
                if (r >= allRowIds.length || c >= allColIds.length) continue;
                const pasteR = destRow + (r - srcRange.minRow);
                const pasteC = destCol + (c - srcRange.minCol);
                if (pasteR === r && pasteC === c) continue;
                cutDeletes.push(`${allRowIds[r]}:${allColIds[c]}`);
              }
            }
          }

          // Build format ranges from clipboard formats
          const pasteFormatRanges: Array<[string, any]> = [];
          if (clipFormats) {
            // Compute max existing format index
            let maxFmtIdx = 0;
            if (sh.formats) {
              for (const f of Object.values(sh.formats)) {
                if ((f as any).index > maxFmtIdx) maxFmtIdx = (f as any).index;
              }
            }
            // Group cells by identical format, then coalesce into rectangles
            const byKey = new Map<string, { r: number; c: number }[]>();
            for (let dr = 0; dr < clipFormats.length; dr++) {
              for (let dc = 0; dc < clipFormats[dr].length; dc++) {
                const fmt = clipFormats[dr][dc];
                if (!fmt) continue;
                const r = destRow + dr;
                const c = destCol + dc;
                if (r >= allRowIds.length || c >= allColIds.length) continue;
                const key = JSON.stringify(fmt);
                let list = byKey.get(key);
                if (!list) { list = []; byKey.set(key, list); }
                list.push({ r, c });
              }
            }
            let fmtIdx = maxFmtIdx + 1;
            for (const [key, positions] of byKey) {
              const fmt = JSON.parse(key);
              positions.sort((a, b) => a.r - b.r || a.c - b.c);
              // Row-based spans
              const rowSpans: { r: number; cStart: number; cEnd: number }[] = [];
              let cur = { r: positions[0].r, cStart: positions[0].c, cEnd: positions[0].c };
              for (let i = 1; i < positions.length; i++) {
                const p = positions[i];
                if (p.r === cur.r && p.c === cur.cEnd + 1) { cur.cEnd = p.c; }
                else { rowSpans.push({ ...cur }); cur = { r: p.r, cStart: p.c, cEnd: p.c }; }
              }
              rowSpans.push(cur);
              // Merge vertically
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
                pasteFormatRanges.push([shortId(), {
                  index: fmtIdx++,
                  rangeRowStart: allRowIds[rect.rStart],
                  rangeRowEnd: allRowIds[rect.rEnd],
                  rangeColStart: allColIds[rect.cStart],
                  rangeColEnd: allColIds[rect.cEnd],
                  format: fmt,
                }]);
              }
            }
          }

          mutate((d, currentSheetId, newRowEntries, newColEntries, cellWrites, cutDeletes, pasteFormatRanges) => {
            const ms = d.sheets[currentSheetId];
            for (const [id, entry] of newRowEntries) ms.rows[id] = entry;
            for (const [id, entry] of newColEntries) ms.columns[id] = entry;
            for (const [key, stored] of cellWrites) {
              if (stored === '') { delete ms.cells[key]; }
              else if (!ms.cells[key]) { ms.cells[key] = { value: stored }; }
              else { ms.cells[key].value = stored; }
            }
            for (const key of cutDeletes) delete ms.cells[key];
            if (pasteFormatRanges.length > 0) {
              if (!ms.formats) ms.formats = {};
              for (const [id, entry] of pasteFormatRanges) ms.formats[id] = entry;
            }
          }, [currentSheetId, newRowEntries, newColEntries, cellWrites, cutDeletes, pasteFormatRanges]);

          clipboardRef.current = null;
          setClipboardSource(null);

          const pasteMaxRow = destRow + values.length - 1;
          const pasteMaxCol = destCol + (values[0]?.length || 1) - 1;
          setSelectionAnchor([destCol, destRow]);
          setSelectedCell([pasteMaxCol, pasteMaxRow]);
        } else {
          // External paste: try native paste event data first, then async Clipboard API
          const doPaste = (rows: string[][]) => {

            const finalRows = rows;
            // Pre-compute everything outside mutate using the ctx.sheet snapshot.
            // ctx.sheet IS the active sheet object (has .rows/.columns/.cells) —
            // it is NOT the whole document, so do not index `.sheets` here (H5).
            const extSh = ctx.sheet;
            if (!extSh) return;
            const extRowEntries = sortedEntries(extSh.rows);
            const extColEntries = sortedEntries(extSh.columns);
            const extFullRowIds = extRowEntries.map(([id]) => id);
            const extFullColIds = extColEntries.map(([id]) => id);
            // destCol/destRow are VISIBLE indices — write keys in visible id space;
            // resolve A1/R1C1 refs in full id space (H4).
            const extVisRowIds = ctx.visibleRowIds;
            const extVisColIds = ctx.visibleColIds;
            const extNeededRows = destRow + finalRows.length;
            const maxPasteCols = Math.max(...finalRows.map(r => r.length));
            const extNeededCols = destCol + maxPasteCols;
            const extLastRowIdx = extRowEntries.length > 0 ? extRowEntries[extRowEntries.length - 1][1].index : 0;
            const extLastColIdx = extColEntries.length > 0 ? extColEntries[extColEntries.length - 1][1].index : 0;
            const extNewRowEntries: Array<[string, { index: number }]> = [];
            const extNewColEntries: Array<[string, { index: number; name: string }]> = [];
            for (let i = extVisRowIds.length; i < extNeededRows; i++) {
              extNewRowEntries.push([shortId(), { index: extLastRowIdx + (i - extVisRowIds.length + 1) }]);
            }
            for (let i = extVisColIds.length; i < extNeededCols; i++) {
              extNewColEntries.push([shortId(), { index: extLastColIdx + (i - extVisColIds.length + 1), name: '' }]);
            }
            const extNewRowIds = extNewRowEntries.map(([id]) => id);
            const extNewColIds = extNewColEntries.map(([id]) => id);
            const extAllRowIds = [...extVisRowIds, ...extNewRowIds];
            const extAllColIds = [...extVisColIds, ...extNewColIds];
            const extRefRowIds = [...extFullRowIds, ...extNewRowIds];
            const extRefColIds = [...extFullColIds, ...extNewColIds];
            const extCellWrites: Array<[string, string]> = [];
            for (let dr = 0; dr < finalRows.length; dr++) {
              for (let dc = 0; dc < finalRows[dr].length; dc++) {
                const r = destRow + dr;
                const c = destCol + dc;
                if (r >= extAllRowIds.length || c >= extAllColIds.length) continue;
                const rowId = extAllRowIds[r];
                const colId = extAllColIds[c];
                const val = finalRows[dr][dc];
                const stored = val.startsWith('=')
                  ? a1ToInternal(val, extRefRowIds.indexOf(rowId), extRefColIds.indexOf(colId), extRefRowIds, extRefColIds)
                  : val;
                extCellWrites.push([`${rowId}:${colId}`, stored]);
              }
            }
            mutate((d, currentSheetId, extNewRowEntries, extNewColEntries, extCellWrites) => {
              const ms = d.sheets[currentSheetId];
              for (const [id, entry] of extNewRowEntries) ms.rows[id] = entry;
              for (const [id, entry] of extNewColEntries) ms.columns[id] = entry;
              for (const [key, stored] of extCellWrites) {
                if (stored === '') { delete ms.cells[key]; }
                else if (!ms.cells[key]) { ms.cells[key] = { value: stored }; }
                else { ms.cells[key].value = stored; }
              }
            }, [currentSheetId, extNewRowEntries, extNewColEntries, extCellWrites]);

            setClipboardSource(null);

            const pasteMaxRow = destRow + rows.length - 1;
            const pasteMaxCol = destCol + (rows[0]?.length || 1) - 1;
            setSelectionAnchor([destCol, destRow]);
            setSelectedCell([pasteMaxCol, pasteMaxRow]);
          };

          // Try native paste event data first (synchronous, no permissions needed)
          const pe = ctx.pasteEvent;
          if (pe?.clipboardData) {
            let rows: string[][] | null = null;
            const html = pe.clipboardData.getData('text/html');
            if (html) rows = parseHtmlClipboard(html);
            if (!rows) {
              const text = pe.clipboardData.getData('text/plain');
              if (text) rows = text.split('\n').map(l => l.split('\t'));
            }
            if (rows?.length) { doPaste(rows); return; }
          }

          // Fallback: async Clipboard API
          (async () => {
            let rows: string[][] | null = null;
            try {
              const items = await navigator.clipboard.read();
              for (const item of items) {
                if (!rows && item.types.includes('text/html')) {
                  rows = parseHtmlClipboard(await (await item.getType('text/html')).text());
                }
                if (!rows && item.types.includes('text/plain')) {
                  const text = await (await item.getType('text/plain')).text();
                  if (text) rows = text.split('\n').map(l => l.split('\t'));
                }
              }
            } catch {
              try {
                const text = await navigator.clipboard.readText();
                if (text) rows = text.split('\n').map(l => l.split('\t'));
              } catch { /* denied */ }
            }
            if (rows?.length) doPaste(rows);
          })();
        }
      },
    },
    {
      id: 'delete-contents',
      defaultLabel: 'Delete',
      icon: 'delete',
      shortcuts: [{ key: 'Delete' }, { key: 'Backspace' }],
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => {
        // Selection is in VISIBLE space — resolve cell keys through visibleRow/ColIds
        // so Delete never clears a hidden row/column's cell (H4).
        const { sheet: doc, selectedCell, selectionAnchor, visibleRowIds, visibleColIds, currentSheetId, spillTargets } = ctx;
        if (!selectedCell || !doc) return;
        const [col, row] = selectedCell;
        const anchor = selectionAnchor;
        const range = anchor ? {
          minCol: Math.min(col, anchor[0]),
          maxCol: Math.max(col, anchor[0]),
          minRow: Math.min(row, anchor[1]),
          maxRow: Math.max(row, anchor[1]),
        } : null;

        if (range && (range.minCol !== range.maxCol || range.minRow !== range.maxRow)) {
          ctx.mutate((d, currentSheetId, range, visRowIds, visColIds, spillKeys) => {
            const cells = d.sheets[currentSheetId].cells;
            for (let r = range.minRow; r <= range.maxRow; r++) {
              for (let c = range.minCol; c <= range.maxCol; c++) {
                if (r < visRowIds.length && c < visColIds.length) {
                  const key = `${visRowIds[r]}:${visColIds[c]}`;
                  if (spillKeys.has(`${currentSheetId}:${key}`)) continue;
                  delete cells[key];
                }
              }
            }
          }, [currentSheetId, range, visibleRowIds, visibleColIds, spillTargets]);
        } else {
          if (col >= visibleColIds.length || row >= visibleRowIds.length) return;
          const cellKey = `${visibleRowIds[row]}:${visibleColIds[col]}`;
          if (spillTargets.has(`${currentSheetId}:${cellKey}`)) return;
          ctx.mutate((d, currentSheetId, cellKey) => {
            if (d.sheets[currentSheetId].cells[cellKey]) delete d.sheets[currentSheetId].cells[cellKey];
          }, [currentSheetId, cellKey]);
        }
      },
    },
  ],
  slots: {
    'cell-ctx': [
      { kind: 'command', id: 'cut' },
      { kind: 'command', id: 'copy' },
      { kind: 'command', id: 'paste' },
    ],
  },
};

/**
 * Autofill a whole row/column selection by continuing the pattern of the
 * neighbours before it — the same result as dragging the fill handle of the
 * filled block immediately above (rows) or to the left (columns) across the
 * selection. The source is that block's contiguous non-empty run, so
 * `5, 10` continues as `15` while a lone value is copied.
 */
function autofillFromNeighbour(
  s: GridCommandState,
  ctx: GridCommandContext,
  kind: 'row' | 'col',
): void {
  const indices = lineIndices(kind, s);
  if (indices.length === 0) return;
  const start = Math.min(...indices);
  const end = Math.max(...indices);
  if (start <= 0) return; // nothing before it to extend
  const lastCol = ctx.visibleColIds.length - 1;
  const lastRow = ctx.visibleRowIds.length - 1;
  if (lastCol < 0 || lastRow < 0) return;

  // Walk back over the filled run that precedes the selection.
  const cells = ctx.sheet?.cells ?? {};
  const hasContent = (i: number) => {
    if (kind === 'row') {
      const rowId = ctx.visibleRowIds[i];
      return ctx.visibleColIds.some(colId => (cells[`${rowId}:${colId}`]?.value ?? '') !== '');
    }
    const colId = ctx.visibleColIds[i];
    return ctx.visibleRowIds.some(rowId => (cells[`${rowId}:${colId}`]?.value ?? '') !== '');
  };
  let sourceStart = start - 1;
  while (sourceStart > 0 && hasContent(sourceStart - 1)) sourceStart--;

  const source = kind === 'row'
    ? { minCol: 0, maxCol: lastCol, minRow: sourceStart, maxRow: start - 1 }
    : { minCol: sourceStart, maxCol: start - 1, minRow: 0, maxRow: lastRow };
  const fill = kind === 'row'
    ? { minCol: 0, maxCol: lastCol, minRow: start, maxRow: end }
    : { minCol: start, maxCol: end, minRow: 0, maxRow: lastRow };
  commitAutofill(ctx, source, fill);
  ctx.setContextMenu(null);
}

// ============================================================
// linePlugin — row/column plugin factory
//
// Rows and columns differ only by naming/ordering words, the sheet map they
// operate on, the entry shape (columns carry a name), the cell-key match, and
// their cell-ctx entries. One factory covers both, plus the hide/freeze halves
// that used to live in a separate visibility plugin. Mutate callbacks are
// serialized via fn.toString(), so they never close over factory params — the
// axis string is passed as an arg and branched on inside, as commitReorder does.
// ============================================================

interface LineAxisConfig {
  axis: 'row' | 'col';
  /** Command-id fragments — shorter than the label nouns ('col', not 'column'). */
  idNoun: string;
  idPlural: string;
  /** Label nouns ('column' reads better than 'col'). */
  noun: string;
  plural: string;
  /** Words/icons for the two insert commands (before = above/left). */
  insert: { beforeWord: string; afterWord: string; beforeIcon: string; afterIcon: string };
  /** Words for the two move commands (before = up/left). */
  moveBefore: string;
  moveAfter: string;
  /** Resize-sheet command (label/icon differ per axis). */
  resize: { id: string; label: string; icon: string };
  /** cell-ctx entries — NOT pure mirrors (columns' includes delete-rows). */
  cellCtx: SlotEntry[];
}

function linePlugin(cfg: LineAxisConfig): GridPlugin {
  const { axis } = cfg;
  const isRow = axis === 'row';
  const pluralVerb = (verb: string, n: number) => n > 1 ? `${verb} ${n} ${cfg.plural}` : `${verb} ${cfg.noun}`;
  const insertLabel = (n: number, word: string) =>
    n > 1 ? `Insert ${n} ${cfg.plural} ${word}` : `Insert 1 ${cfg.noun} ${word}`;
  const id = {
    autofill: `autofill-${cfg.idPlural}`,
    insertBefore: `insert-${cfg.idNoun}-${cfg.insert.beforeWord}`,
    insertAfter: `insert-${cfg.idNoun}-${cfg.insert.afterWord}`,
    moveBefore: `move-${cfg.idPlural}-${cfg.moveBefore}`,
    moveAfter: `move-${cfg.idPlural}-${cfg.moveAfter}`,
    delete: `delete-${cfg.idPlural}`,
    hide: `hide-${cfg.idPlural}`,
    freeze: `freeze-${cfg.idPlural}`,
    unfreeze: `unfreeze-${cfg.idPlural}`,
  };

  return {
    id: isRow ? 'row' : 'column',
    commands: [
      {
        id: id.autofill,
        defaultLabel: 'Autofill',
        icon: 'stat_minus_1',
        // Needs a line before it to extend from.
        isEnabled: s => lineIndices(axis, s).length > 0 && Math.min(...lineIndices(axis, s)) > 0,
        execute: (s, ctx) => autofillFromNeighbour(s, ctx, axis),
      },
      {
        id: id.insertBefore,
        defaultLabel: s => insertLabel(lineIndices(axis, s).length, cfg.insert.beforeWord),
        icon: cfg.insert.beforeIcon,
        isEnabled: s => lineIndices(axis, s).length > 0,
        execute: (s, ctx) => {
          const { sheet: doc, setContextMenu, currentSheetId } = ctx;
          if (!doc) return;
          const indices = lineIndices(axis, s);
          const entries = lineEntries(axis, ctxSheet(ctx));
          if (entries.length === 0) return;
          const count = Math.max(indices.length, 1);
          // Resolve the VISIBLE target to its position in the full sorted list (H4).
          const minVisIdx = Math.min(...indices);
          const targetId = lineVisibleIds(axis, ctx)[minVisIdx];
          if (!targetId) return;
          const targetPos = entries.findIndex(([id]) => id === targetId);
          if (targetPos === -1) return;
          const hi = entries[targetPos][1].index;
          const lo = targetPos === 0 ? hi - count : entries[targetPos - 1][1].index;
          const newIds = Array.from({ length: count }, () => shortId());
          ctx.mutate((d, currentSheetId, axis, newIds, lo, hi, count) => {
            const ms = d.sheets[currentSheetId];
            const map = axis === 'row' ? ms.rows : ms.columns;
            for (let i = 0; i < count; i++) {
              const entry: any = { index: lo + ((hi - lo) * (i + 1)) / (count + 1) };
              if (axis === 'col') entry.name = '';
              map[newIds[i]] = entry;
            }
          }, [currentSheetId, axis, newIds, lo, hi, count]);
          setContextMenu(null);
        },
      },
      {
        id: id.insertAfter,
        defaultLabel: s => insertLabel(lineIndices(axis, s).length, cfg.insert.afterWord),
        icon: cfg.insert.afterIcon,
        isEnabled: s => lineIndices(axis, s).length > 0,
        execute: (s, ctx) => {
          const { sheet: doc, setContextMenu, currentSheetId } = ctx;
          if (!doc) return;
          const indices = lineIndices(axis, s);
          const entries = lineEntries(axis, ctxSheet(ctx));
          if (entries.length === 0) return;
          const count = Math.max(indices.length, 1);
          // Resolve the VISIBLE target to its position in the full sorted list (H4).
          const maxVisIdx = Math.max(...indices);
          const targetId = lineVisibleIds(axis, ctx)[maxVisIdx];
          if (!targetId) return;
          const targetPos = entries.findIndex(([id]) => id === targetId);
          if (targetPos === -1) return;
          const lo = entries[targetPos][1].index;
          const hi = targetPos >= entries.length - 1 ? lo + count : entries[targetPos + 1][1].index;
          const newIds = Array.from({ length: count }, () => shortId());
          ctx.mutate((d, currentSheetId, axis, newIds, lo, hi, count) => {
            const ms = d.sheets[currentSheetId];
            const map = axis === 'row' ? ms.rows : ms.columns;
            for (let i = 0; i < count; i++) {
              const entry: any = { index: lo + ((hi - lo) * (i + 1)) / (count + 1) };
              if (axis === 'col') entry.name = '';
              map[newIds[i]] = entry;
            }
          }, [currentSheetId, axis, newIds, lo, hi, count]);
          setContextMenu(null);
        },
      },
      {
        id: id.moveBefore,
        defaultLabel: isRow ? 'Move up' : 'Move left',
        isEnabled: s => (isRow ? s.currentRowIndices : s.currentColIndices).length > 0,
        execute: (_, ctx) => {
          const { sheet: doc, setContextMenu, currentSheetId } = ctx;
          if (!doc) return;
          const entries = lineEntries(axis, ctxSheet(ctx));
          // Selection is in VISIBLE space — resolve neighbors through visible ids (H4).
          const indices = [...lineSelected(axis, ctx)].sort((a, b) => a - b);
          if (indices.length === 0 || indices[0] === 0) return;
          const beforeId = lineVisibleIds(axis, ctx)[indices[0] - 1];
          if (!beforeId) return;
          const lastVisId = lineVisibleIds(axis, ctx)[indices[indices.length - 1]];
          const lastPos = entries.findIndex(([id]) => id === lastVisId);
          if (lastPos === -1) return;
          const newIndex = lastPos >= entries.length - 1
            ? entries[lastPos][1].index + 1
            : (entries[lastPos][1].index + entries[lastPos + 1][1].index) / 2;
          ctx.mutate((d, currentSheetId, axis, beforeId, newIndex) => {
            const map = axis === 'row' ? d.sheets[currentSheetId].rows : d.sheets[currentSheetId].columns;
            map[beforeId].index = newIndex;
          }, [currentSheetId, axis, beforeId, newIndex]);
          lineSetSelected(axis, ctx, new Set(indices.map(i => i - 1)));
          setContextMenu(null);
        },
      },
      {
        id: id.moveAfter,
        defaultLabel: isRow ? 'Move down' : 'Move right',
        isEnabled: s => (isRow ? s.currentRowIndices : s.currentColIndices).length > 0,
        execute: (_, ctx) => {
          const { sheet: doc, setContextMenu, currentSheetId } = ctx;
          if (!doc) return;
          const entries = lineEntries(axis, ctxSheet(ctx));
          // Selection is in VISIBLE space — resolve neighbors through visible ids (H4).
          const indices = [...lineSelected(axis, ctx)].sort((a, b) => a - b);
          if (indices.length === 0 || indices[indices.length - 1] >= lineVisibleIds(axis, ctx).length - 1) return;
          const afterId = lineVisibleIds(axis, ctx)[indices[indices.length - 1] + 1];
          if (!afterId) return;
          const firstVisId = lineVisibleIds(axis, ctx)[indices[0]];
          const firstPos = entries.findIndex(([id]) => id === firstVisId);
          if (firstPos === -1) return;
          const newIndex = firstPos === 0
            ? entries[0][1].index - 1
            : (entries[firstPos - 1][1].index + entries[firstPos][1].index) / 2;
          ctx.mutate((d, currentSheetId, axis, afterId, newIndex) => {
            const map = axis === 'row' ? d.sheets[currentSheetId].rows : d.sheets[currentSheetId].columns;
            map[afterId].index = newIndex;
          }, [currentSheetId, axis, afterId, newIndex]);
          lineSetSelected(axis, ctx, new Set(indices.map(i => i + 1)));
          setContextMenu(null);
        },
      },
      {
        id: id.delete,
        defaultLabel: s => pluralVerb('Delete', lineIndices(axis, s).length),
        danger: true,
        icon: 'delete',
        isEnabled: s => lineIndices(axis, s).length > 0,
        execute: (s, ctx) => {
          const { sheet: doc, setContextMenu, currentSheetId } = ctx;
          if (!doc) return;
          const indices = lineIndices(axis, s);
          // Selection indices are in VISIBLE space — resolve through visible ids
          // so a hidden line before the target is never deleted (H4).
          const idsToDelete = indices.map(i => lineVisibleIds(axis, ctx)[i]).filter(Boolean);
          if (idsToDelete.length === 0) return;
          const deletedSet = new Set(idsToDelete);
          const sh = ctxSheet(ctx);
          const sortedRowIds = sortedEntries(sh.rows).map(([id]) => id);
          const sortedColIds = sortedEntries(sh.columns).map(([id]) => id);
          const rewrites = updateFormulasForDeletion(
            sh.cells,
            isRow ? deletedSet : new Set(),
            isRow ? new Set() : deletedSet,
            sortedRowIds, sortedColIds,
          );
          ctx.mutate((d, currentSheetId, axis, rewrites: Record<string, string>, idsToDelete) => {
            const ms = d.sheets[currentSheetId];
            const map = axis === 'row' ? ms.rows : ms.columns;
            for (const [key, newVal] of Object.entries(rewrites)) {
              if (ms.cells[key] && ms.cells[key].value !== newVal) ms.cells[key].value = newVal;
            }
            for (const id of idsToDelete) {
              delete map[id];
              for (const key of Object.keys(ms.cells)) {
                if (axis === 'row' ? key.startsWith(`${id}:`) : key.endsWith(`:${id}`)) delete ms.cells[key];
              }
            }
          }, [currentSheetId, axis, rewrites, idsToDelete]);
          lineSetSelected(axis, ctx, new Set());
          setContextMenu(null);
        },
      },
      {
        id: id.hide,
        defaultLabel: s => pluralVerb('Hide', lineIndices(axis, s).length),
        icon: 'visibility_off',
        isEnabled: s => lineIndices(axis, s).length > 0,
        execute: (s, ctx) => {
          const indices = lineIndices(axis, s);
          const ids = indices.map(i => lineVisibleIds(axis, ctx)[i]).filter(Boolean);
          if (ids.length === 0) return;
          ctx.mutate((d, sid, axis, ids) => {
            const map = axis === 'row' ? d.sheets[sid].rows : d.sheets[sid].columns;
            for (const id of ids) map[id].hidden = true;
          }, [ctx.currentSheetId, axis, ids]);
          lineSetSelected(axis, ctx, new Set());
          ctx.setContextMenu(null);
        },
      },
      {
        id: id.freeze,
        defaultLabel: `Freeze ${cfg.plural}`,
        icon: 'push_pin',
        isEnabled: s => lineIndices(axis, s).length > 0,
        execute: (s, ctx) => {
          // Freeze the visible prefix up to the selection's last line.
          applyFreezeCount(ctx.mutate, ctx.currentSheetId, axis, Math.max(...lineIndices(axis, s)) + 1);
          ctx.setContextMenu(null);
        },
      },
      {
        id: id.unfreeze,
        defaultLabel: `Unfreeze ${cfg.plural}`,
        icon: 'push_pin',
        isEnabled: s => (isRow ? s.hasFrozenRows : s.hasFrozenCols),
        execute: (_, ctx) => {
          applyFreezeCount(ctx.mutate, ctx.currentSheetId, axis, 0);
          ctx.setContextMenu(null);
        },
      },
      {
        id: cfg.resize.id,
        defaultLabel: cfg.resize.label,
        icon: cfg.resize.icon,
        // The value is picked in a bottom sheet (ResizeSheet), which applies it
        // through applyItemSize.
        isEnabled: s => lineIndices(axis, s).length > 0,
        execute: (_, ctx) => ctx.openResizeSheet?.(axis),
      },
    ],
    slots: {
      [isRow ? 'row-ctx' : 'col-ctx']: [
        { kind: 'command', id: id.insertBefore },
        { kind: 'command', id: id.insertAfter },
        { kind: 'separator' },
        { kind: 'command', id: id.moveBefore },
        { kind: 'command', id: id.moveAfter },
        { kind: 'separator' },
        { kind: 'command', id: cfg.resize.id },
        { kind: 'separator' },
        { kind: 'command', id: id.delete },
        { kind: 'separator' },
        { kind: 'command', id: id.hide },
        { kind: 'command', id: id.freeze },
        { kind: 'command', id: id.unfreeze },
      ],
      'cell-ctx': cfg.cellCtx,
    },
  };
}

const ROW_AXIS: LineAxisConfig = {
  axis: 'row',
  idNoun: 'row',
  idPlural: 'rows',
  noun: 'row',
  plural: 'rows',
  insert: { beforeWord: 'above', afterWord: 'below', beforeIcon: 'keyboard_arrow_up', afterIcon: 'keyboard_arrow_down' },
  moveBefore: 'up',
  moveAfter: 'down',
  resize: { id: 'set-row-height', label: 'Resize rows\u2026', icon: 'height' },
  cellCtx: [
    { kind: 'separator' },
    { kind: 'command', id: 'insert-row-above' },
  ],
};

const COL_AXIS: LineAxisConfig = {
  axis: 'col',
  idNoun: 'col',
  idPlural: 'cols',
  noun: 'column',
  plural: 'columns',
  insert: { beforeWord: 'left', afterWord: 'right', beforeIcon: 'keyboard_arrow_left', afterIcon: 'keyboard_arrow_right' },
  moveBefore: 'left',
  moveAfter: 'right',
  resize: { id: 'set-col-width', label: 'Resize columns\u2026', icon: 'width' },
  cellCtx: [
    { kind: 'command', id: 'insert-col-left' },
    { kind: 'separator' },
    { kind: 'command', id: 'delete-rows' },
    { kind: 'command', id: 'delete-cols' },
  ],
};

const rowPlugin = linePlugin(ROW_AXIS);
const columnPlugin = linePlugin(COL_AXIS);

// ============================================================
// Formatting helpers
// ============================================================

function getSelectionRowColIds(ctx: GridCommandContext): { rowIds: string[]; colIds: string[] } {
  // Selection is in VISIBLE space — resolve through visibleRow/ColIds so formatting
  // targets the selected visible cells, not misaligned full-list entries (H4).
  const { selectedCell, selectionAnchor, visibleRowIds, visibleColIds, selectedRows, selectedCols } = ctx;
  if (!selectedCell) return { rowIds: [], colIds: [] };

  const range = getEffectiveRange(selectedCell, selectionAnchor) ?? {
    minRow: selectedCell[1], maxRow: selectedCell[1],
    minCol: selectedCell[0], maxCol: selectedCell[0],
  };

  const minRow = selectedRows.size > 0 ? Math.min(...selectedRows) : range.minRow;
  const maxRow = selectedRows.size > 0 ? Math.max(...selectedRows) : range.maxRow;
  const minCol = selectedCols.size > 0 ? Math.min(...selectedCols) : range.minCol;
  const maxCol = selectedCols.size > 0 ? Math.max(...selectedCols) : range.maxCol;

  const rowIds: string[] = [];
  for (let r = minRow; r <= maxRow; r++) {
    if (r < visibleRowIds.length) rowIds.push(visibleRowIds[r]);
  }
  const colIds: string[] = [];
  for (let c = minCol; c <= maxCol; c++) {
    if (c < visibleColIds.length) colIds.push(visibleColIds[c]);
  }
  return { rowIds, colIds };
}

/** Apply a format patch to the selection, reusing an existing FormatRange if one matches. */
export function applyFormatToSelection(ctx: GridCommandContext, patch: Partial<DataGridCellFormat>): void {
  const { rowIds, colIds } = getSelectionRowColIds(ctx);
  if (rowIds.length === 0 || colIds.length === 0) return;

  const rangeRowStart = rowIds[0];
  const rangeRowEnd = rowIds[rowIds.length - 1];
  const rangeColStart = colIds[0];
  const rangeColEnd = colIds[colIds.length - 1];

  const sheet = ctx.sheet;
  const formats = sheet?.formats;

  // Look for an existing FormatRange with the exact same bounds
  let existingId: string | null = null;
  if (formats) {
    for (const [id, f] of Object.entries(formats)) {
      const r = f as any;
      if (r.rangeRowStart === rangeRowStart && r.rangeRowEnd === rangeRowEnd &&
        r.rangeColStart === rangeColStart && r.rangeColEnd === rangeColEnd) {
        existingId = id;
        break;
      }
    }
  }

  if (existingId) {
    // Merge patch into the existing range's format
    ctx.mutate((d: any, currentSheetId: string, existingId: string, patch: any) => {
      const ms = d.sheets[currentSheetId];
      const range = ms.formats?.[existingId];
      if (!range) return;
      if (!range.format) range.format = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          delete range.format[k];
        } else {
          range.format[k] = v;
        }
      }
      // Clean up: if format is now empty, remove the range entirely
      if (Object.keys(range.format).length === 0) {
        delete ms.formats[existingId];
      }
    }, [ctx.currentSheetId, existingId, patch]);
  } else {
    // Create a new FormatRange
    let maxIndex = 0;
    if (formats) {
      for (const f of Object.values(formats)) {
        if ((f as any).index > maxIndex) maxIndex = (f as any).index;
      }
    }
    const newId = shortId();
    ctx.mutate((d: any, currentSheetId: string, newId: string, entry: any) => {
      const ms = d.sheets[currentSheetId];
      if (!ms.formats) ms.formats = {};
      ms.formats[newId] = entry;
    }, [ctx.currentSheetId, newId, {
      index: maxIndex + 1,
      rangeRowStart,
      rangeRowEnd,
      rangeColStart,
      rangeColEnd,
      format: { ...patch },
    }]);
  }
}

/** Remove all formatting from the selection by adding a FormatRange that resets all properties. */
function clearFormatFromSelection(ctx: GridCommandContext): void {
  // Delete all format ranges that fall entirely within the selection
  const { rowIds, colIds } = getSelectionRowColIds(ctx);
  if (rowIds.length === 0 || colIds.length === 0) return;

  const sheet = ctx.sheet;
  const formats = sheet?.formats;
  if (!formats) return;

  const rowIdSet = new Set(rowIds);
  const colIdSet = new Set(colIds);
  const allRowIds = ctx.sortedRowIds;
  const allColIds = ctx.sortedColIds;

  // Find format ranges entirely within selection to delete
  const toDelete: string[] = [];
  for (const [id, range] of Object.entries(formats)) {
    const r = range as any;
    const rStart = allRowIds.indexOf(r.rangeRowStart);
    const rEnd = allRowIds.indexOf(r.rangeRowEnd);
    const cStart = allColIds.indexOf(r.rangeColStart);
    const cEnd = allColIds.indexOf(r.rangeColEnd);
    if (rStart === -1 || rEnd === -1 || cStart === -1 || cEnd === -1) continue;

    // Check if this range is entirely within the selection
    let allInside = true;
    for (let ri = rStart; ri <= rEnd && allInside; ri++) {
      if (!rowIdSet.has(allRowIds[ri])) allInside = false;
    }
    for (let ci = cStart; ci <= cEnd && allInside; ci++) {
      if (!colIdSet.has(allColIds[ci])) allInside = false;
    }
    if (allInside) toDelete.push(id);
  }

  if (toDelete.length > 0) {
    ctx.mutate((d: any, currentSheetId: string, toDelete: string[]) => {
      const ms = d.sheets[currentSheetId];
      if (!ms.formats) return;
      for (const id of toDelete) delete ms.formats[id];
    }, [ctx.currentSheetId, toDelete]);
  }
}

// ============================================================
// Formatting plugin
// ============================================================

const formattingPlugin: GridPlugin = {
  id: 'formatting',
  commands: [
    {
      id: 'toggle-bold',
      defaultLabel: 'Bold',
      icon: 'format_bold',
      shortcuts: [{ key: 'b', mod: true }],
      toggle: { isChecked: s => !!s.currentCellFormat?.bold },
      isEnabled: s => s.hasSelection,
      execute: (s, ctx) => {
        applyFormatToSelection(ctx, { bold: !s.currentCellFormat?.bold || undefined });
      },
    },
    {
      id: 'toggle-italic',
      defaultLabel: 'Italic',
      icon: 'format_italic',
      shortcuts: [{ key: 'i', mod: true }],
      toggle: { isChecked: s => !!s.currentCellFormat?.italic },
      isEnabled: s => s.hasSelection,
      execute: (s, ctx) => {
        applyFormatToSelection(ctx, { italic: !s.currentCellFormat?.italic || undefined });
      },
    },
    {
      id: 'toggle-underline',
      defaultLabel: 'Underline',
      icon: 'format_underlined',
      shortcuts: [{ key: 'u', mod: true }],
      toggle: { isChecked: s => !!s.currentCellFormat?.underline },
      isEnabled: s => s.hasSelection,
      execute: (s, ctx) => {
        applyFormatToSelection(ctx, { underline: !s.currentCellFormat?.underline || undefined });
      },
    },
    {
      id: 'toggle-strikethrough',
      defaultLabel: 'Strikethrough',
      icon: 'format_strikethrough',
      shortcuts: [{ key: '5', mod: true }],
      toggle: { isChecked: s => !!s.currentCellFormat?.strikethrough },
      isEnabled: s => s.hasSelection,
      execute: (s, ctx) => {
        applyFormatToSelection(ctx, { strikethrough: !s.currentCellFormat?.strikethrough || undefined });
      },
    },
    {
      id: 'align-left',
      defaultLabel: 'Align left',
      icon: 'format_align_left',
      toggle: { isChecked: s => s.currentCellFormat?.hAlign === 'left' },
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => applyFormatToSelection(ctx, { hAlign: 'left' }),
    },
    {
      id: 'align-center',
      defaultLabel: 'Align center',
      icon: 'format_align_center',
      toggle: { isChecked: s => s.currentCellFormat?.hAlign === 'center' },
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => applyFormatToSelection(ctx, { hAlign: 'center' }),
    },
    {
      id: 'align-right',
      defaultLabel: 'Align right',
      icon: 'format_align_right',
      toggle: { isChecked: s => s.currentCellFormat?.hAlign === 'right' },
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => applyFormatToSelection(ctx, { hAlign: 'right' }),
    },
    {
      id: 'clear-formatting',
      defaultLabel: 'Clear formatting',
      icon: 'format_clear',
      shortcuts: [{ key: '\\', mod: true }],
      isEnabled: s => s.hasSelection,
      execute: (_, ctx) => clearFormatFromSelection(ctx),
    },
  ],
  slots: {
    'cell-ctx': [
      { kind: 'separator' },
      { kind: 'command', id: 'clear-formatting' },
    ],
  },
};

// ============================================================
// Visibility & Freeze plugin
// ============================================================


// ============================================================
// Registry (built once at module load — plugins are static)
// ============================================================

const ALL_PLUGINS: GridPlugin[] = [historyPlugin, clipboardPlugin, rowPlugin, columnPlugin, formattingPlugin];

const COMMAND_REGISTRY = new Map<string, GridCommand>();
for (const plugin of ALL_PLUGINS) {
  for (const cmd of plugin.commands) {
    COMMAND_REGISTRY.set(cmd.id, cmd);
  }
}

/** Commands that have keyboard shortcuts, in registration order */
const KEY_COMMANDS: GridCommand[] = [];
for (const plugin of ALL_PLUGINS) {
  for (const cmd of plugin.commands) {
    if (cmd.shortcuts?.length) KEY_COMMANDS.push(cmd);
  }
}

function buildSlotList(slotId: SlotId): SlotEntry[] {
  const result: SlotEntry[] = [];
  for (const plugin of ALL_PLUGINS) {
    const entries = plugin.slots[slotId];
    if (entries) result.push(...entries);
  }
  return result;
}

const SLOT_LISTS: Record<SlotId, SlotEntry[]> = {
  'cell-ctx': buildSlotList('cell-ctx'),
  'row-ctx': buildSlotList('row-ctx'),
  'col-ctx': buildSlotList('col-ctx'),
};

// ============================================================
// commitReorder — standalone reorder function for drag-to-reorder
// ============================================================

/** Reorder rows or columns by drag, placing draggedIndices before dropIndex. */
export function commitReorder(
  ctx: GridCommandContext,
  type: 'row' | 'col',
  draggedIndices: number[],
  dropIndex: number,
): void {
  const { sheet: doc, mutate, setSelectedRows, setSelectedCols, currentSheetId } = ctx;
  if (!doc) return;
  const sh = ctxSheet(ctx);

  // draggedIndices/dropIndex are VISIBLE indices; operate in visible id space and
  // bound the new float indices by the nearest VISIBLE neighbors (H4). Hidden
  // rows/cols interspersed keep their positions and never affect the visible drop.
  const entries = type === 'row' ? sortedEntries(sh.rows) : sortedEntries(sh.columns);
  const indexById = new Map(entries.map(([id, e]) => [id, e.index]));
  const visibleIds = type === 'row' ? ctx.visibleRowIds : ctx.visibleColIds;
  const sorted = [...draggedIndices].sort((a, b) => a - b);

  // No-op: drop is within the dragged range
  if (sorted.every(i => dropIndex > i) === false && sorted.every(i => dropIndex <= i) === false) {
    if (dropIndex > sorted[0] && dropIndex <= sorted[sorted.length - 1] + 1) return;
  }

  const ids = sorted.map(i => visibleIds[i]).filter(Boolean);
  if (ids.length === 0) return;
  const remaining = visibleIds.filter((_, i) => !sorted.includes(i));
  let adjustedDrop = dropIndex;
  for (const di of sorted) {
    if (di < dropIndex) adjustedDrop--;
  }
  adjustedDrop = Math.max(0, Math.min(adjustedDrop, remaining.length));

  if (remaining.length === 0) return;

  let prevIndex: number, nextIndex: number;
  if (adjustedDrop === 0) {
    nextIndex = indexById.get(remaining[0])!;
    prevIndex = nextIndex - ids.length - 1;
  } else if (adjustedDrop >= remaining.length) {
    prevIndex = indexById.get(remaining[remaining.length - 1])!;
    nextIndex = prevIndex + ids.length + 1;
  } else {
    prevIndex = indexById.get(remaining[adjustedDrop - 1])!;
    nextIndex = indexById.get(remaining[adjustedDrop])!;
  }

  const gap = nextIndex - prevIndex;
  const step = gap / (ids.length + 1);

  mutate((d, currentSheetId, type, ids, prevIndex, step) => {
    const ms = d.sheets[currentSheetId];
    const map = type === 'row' ? ms.rows : ms.columns;
    for (let i = 0; i < ids.length; i++) {
      map[ids[i]].index = prevIndex + step * (i + 1);
    }
  }, [currentSheetId, type, ids, prevIndex, step]);

  const newIndices = new Set(sorted.map((_, i) => adjustedDrop + i));
  if (type === 'row') setSelectedRows(newIndices);
  else setSelectedCols(newIndices);
}

// ============================================================
// commitAutofill — write generated autofill values into the fill range
// ============================================================

/** Autofill: generate values from sourceRange and write them into fillRange. */
export function commitAutofill(
  ctx: GridCommandContext,
  sourceRange: CellRange,
  fillRange: CellRange,
): void {
  const { sheet: doc, mutate, setSelectionAnchor, setSelectedCell, currentSheetId, sheetsMeta } = ctx;
  if (!doc) return;
  const sh = ctxSheet(ctx);

  // sourceRange/fillRange are VISIBLE-space: read/write cells via visibleRow/ColIds,
  // but resolve A1/R1C1 refs against the FULL sorted lists (matching displayed labels
  // and commitCellValue) so hidden rows/cols are never touched (H4).
  const fullRowIds = sortedEntries(sh.rows).map(([id]) => id);
  const fullColIds = sortedEntries(sh.columns).map(([id]) => id);
  const visRowIds = ctx.visibleRowIds;
  const visColIds = ctx.visibleColIds;

  // Build cross-sheet lookup functions for formula conversion
  const sheetNameLookup = sheetsMeta
    ? (sheetId: string) => sheetsMeta[sheetId]?.name
    : undefined;
  const nameToIdMap = new Map<string, string>();
  if (sheetsMeta) {
    for (const [id, s] of Object.entries(sheetsMeta)) nameToIdMap.set(s.name, id);
  }
  const lookupSheetId = nameToIdMap.size > 0 ? (name: string) => nameToIdMap.get(name) : undefined;
  const lookupSheetRowColIds = sheetsMeta
    ? (sheetId: string) => {
      const s = sheetsMeta[sheetId];
      if (!s?.rows || !s?.cols) return undefined;
      return { rowIds: s.rows, colIds: s.cols };
    }
    : undefined;

  const isVertical = fillRange.minCol === sourceRange.minCol && fillRange.maxCol === sourceRange.maxCol;
  const axis: 'row' | 'col' = isVertical ? 'row' : 'col';
  const direction: 'forward' | 'backward' = isVertical
    ? (fillRange.minRow > sourceRange.maxRow ? 'forward' : 'backward')
    : (fillRange.minCol > sourceRange.maxCol ? 'forward' : 'backward');

  const strips = getAutofillSourceValues(sh.cells, visRowIds, visColIds, sourceRange, axis);
  const fillCount = isVertical
    ? (fillRange.maxRow - fillRange.minRow + 1)
    : (fillRange.maxCol - fillRange.minCol + 1);

  // Convert source formulas to R1C1 (position-independent offsets) before cycling.
  // R1C1 anchors use the source cell's FULL index (via its visible id).
  const r1c1Strips = strips.map((strip, stripIdx) =>
    strip.map((val, srcIdx) => {
      if (!val.startsWith('=')) return val;
      let srcVisRow: number, srcVisCol: number;
      if (isVertical) {
        srcVisRow = sourceRange.minRow + srcIdx;
        srcVisCol = sourceRange.minCol + stripIdx;
      } else {
        srcVisRow = sourceRange.minRow + stripIdx;
        srcVisCol = sourceRange.minCol + srcIdx;
      }
      const srcRowId = visRowIds[srcVisRow];
      const srcColId = visColIds[srcVisCol];
      if (srcRowId === undefined || srcColId === undefined) return val;
      return internalToR1C1(val, fullRowIds.indexOf(srcRowId), fullColIds.indexOf(srcColId), fullRowIds, fullColIds, sheetNameLookup, lookupSheetRowColIds);
    })
  );

  // Pre-compute all cell writes
  const cellWrites: Array<[string, string]> = [];
  r1c1Strips.forEach((strip, stripIdx) => {
    const filled = generateAutofillValues(strip, fillCount, direction);
    filled.forEach((val, fillIdx) => {
      let visR: number, visC: number;
      if (isVertical) {
        visR = fillRange.minRow + fillIdx;
        visC = sourceRange.minCol + stripIdx;
      } else {
        visR = sourceRange.minRow + stripIdx;
        visC = fillRange.minCol + fillIdx;
      }
      if (visR >= visRowIds.length || visC >= visColIds.length) return;
      const rowId = visRowIds[visR];
      const colId = visColIds[visC];
      const stored = val.startsWith('=')
        ? a1ToInternal(val, fullRowIds.indexOf(rowId), fullColIds.indexOf(colId), fullRowIds, fullColIds, lookupSheetId, lookupSheetRowColIds)
        : val;
      cellWrites.push([`${rowId}:${colId}`, stored]);
    });
  });

  mutate((d, currentSheetId, cellWrites) => {
    const ms = d.sheets[currentSheetId];
    for (const [key, stored] of cellWrites) {
      if (stored === '') { delete ms.cells[key]; }
      else if (!ms.cells[key]) { ms.cells[key] = { value: stored }; }
      else { ms.cells[key].value = stored; }
    }
  }, [currentSheetId, cellWrites]);

  // Extend selection to cover source + fill range
  const totalRange = {
    minCol: Math.min(sourceRange.minCol, fillRange.minCol),
    maxCol: Math.max(sourceRange.maxCol, fillRange.maxCol),
    minRow: Math.min(sourceRange.minRow, fillRange.minRow),
    maxRow: Math.max(sourceRange.maxRow, fillRange.maxRow),
  };
  setSelectionAnchor([totalRange.minCol, totalRange.minRow]);
  setSelectedCell([totalRange.maxCol, totalRange.maxRow]);
}

// ============================================================
// useGridCommands hook
// ============================================================

/** Resolve a list of command IDs (null = separator) into ResolvedEntry[]. */
function resolveCommands(
  ids: (string | null)[],
  state: GridCommandState,
  ctx: GridCommandContext,
): ResolvedEntry[] {
  return ids.map((id): ResolvedEntry => {
    if (id === null) return { kind: 'separator' };
    const cmd = COMMAND_REGISTRY.get(id);
    if (!cmd) throw new Error(`Unknown command id: "${id}"`);
    const rawLabel = cmd.defaultLabel;
    const label = typeof rawLabel === 'function' ? rawLabel(state) : rawLabel;
    const isEnabled = cmd.isEnabled(state);
    const isChecked = cmd.toggle ? cmd.toggle.isChecked(state) : undefined;
    const shortcut = cmd.shortcuts?.[0] ? shortcutDisplay(cmd.shortcuts[0]) : undefined;
    return {
      kind: 'command', id: cmd.id, label, icon: cmd.icon, isEnabled, isChecked,
      shortcut, danger: cmd.danger, execute: () => cmd.execute(state, ctx),
    };
  });
}

function resolveSlot(
  slotId: SlotId,
  state: GridCommandState,
  ctx: GridCommandContext,
): ResolvedEntry[] {
  return SLOT_LISTS[slotId].map((entry): ResolvedEntry => {
    if (entry.kind === 'separator') return { kind: 'separator' };

    const cmd = COMMAND_REGISTRY.get(entry.id);
    if (!cmd) throw new Error(`Unknown command id: "${entry.id}"`);

    const rawLabel = entry.label ?? cmd.defaultLabel;
    const label = typeof rawLabel === 'function' ? rawLabel(state) : rawLabel;
    const icon = entry.icon ?? cmd.icon;
    const isEnabled = cmd.isEnabled(state) && (state.canEdit || READ_ONLY_COMMANDS.has(cmd.id));
    const isChecked = cmd.toggle ? cmd.toggle.isChecked(state) : undefined;
    const shortcut = cmd.shortcuts?.[0] ? shortcutDisplay(cmd.shortcuts[0]) : undefined;

    return {
      kind: 'command',
      id: cmd.id,
      label,
      icon,
      isEnabled,
      isChecked,
      shortcut,
      danger: cmd.danger,
      execute: () => cmd.execute(state, ctx),
    };
  });
}

export function useGridCommands(
  state: GridCommandState,
  ctx: GridCommandContext,
): GridCommandsApi {
  const cellCtx = resolveSlot('cell-ctx', state, ctx);
  const rowCtx = resolveSlot('row-ctx', state, ctx);
  const colCtx = resolveSlot('col-ctx', state, ctx);

  function dispatchKey(e: KeyboardEvent, isMod: boolean): boolean {
    for (const cmd of KEY_COMMANDS) {
      if (!state.canEdit && !READ_ONLY_COMMANDS.has(cmd.id)) continue;
      for (const shortcut of cmd.shortcuts!) {
        if (matchShortcut(e, isMod, shortcut)) {
          // Paste is the one shortcut handled indirectly, for two reasons.
          //
          // It must NOT preventDefault: the browser's own native `paste` event is
          // the better source — it carries clipboardData synchronously and needs
          // no clipboard-read permission — and preventing the default here would
          // suppress it. keydown also runs *before* that event, so pasting inline
          // here would both beat the good source and then paste a second time.
          //
          // But a native event does not always arrive (Firefox fires no clipboard
          // event at a non-editable element, and the grid's listener is bound to a
          // conditionally-rendered container), and `executePaste` is otherwise
          // only ever called from that listener — so Ctrl+V would silently do
          // nothing at all while Ctrl+C kept working. Hence a *deferred* fallback,
          // which the listener cancels if the real event shows up.
          if (cmd.id === 'paste') {
            ctx.onPasteShortcut?.();
            return true;
          }
          e.preventDefault();
          cmd.execute(state, ctx);
          return true;
        }
      }
    }
    return false;
  }

  function executePaste(pasteEvent?: ClipboardEvent): void {
    if (!state.canEdit) return;
    const pasteCmd = COMMAND_REGISTRY.get('paste');
    if (!pasteCmd) return;
    ctx.pasteEvent = pasteEvent;
    pasteCmd.execute(state, ctx);
    ctx.pasteEvent = undefined;
  }

  function resolveById(id: string): ResolvedEntry & { kind: 'command' } {
    const entry = resolveCommands([id], state, ctx)[0] as ResolvedEntry & { kind: 'command' };
    // Same read-only gate as resolveSlot.
    if (!state.canEdit && !READ_ONLY_COMMANDS.has(id)) entry.isEnabled = false;
    return entry;
  }

  return { cellCtx, rowCtx, colCtx, dispatchKey, executePaste, resolveById };
}
