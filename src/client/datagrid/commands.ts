import {
  sortedEntries, shortId, a1ToInternal, internalToR1C1,
  updateFormulasForDeletion, generateAutofillValues, getAutofillSourceValues,
} from './helpers';
import {
  buildClipboardData, writeClipboard, parseHtmlClipboard,
  getEffectiveRange, type ClipboardEntry, type CellRange,
} from './clipboard';
import type { DataGridDocument, DataGridCell, DataGridCellFormat } from './schema';
import {
  FONT_FAMILIES, FONT_SIZES, NUMBER_FORMATS, PRESET_COLORS, BORDER_PRESETS,
} from './format-presets';

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
  sheetCount: number;
  /** Whether the active sheet currently has hidden/frozen rows/columns —
   * gates the unhide/unfreeze commands. */
  hasHiddenRows: boolean;
  hasHiddenCols: boolean;
  hasFrozenRows: boolean;
  hasFrozenCols: boolean;
  /** Non-null only when resolving context-menu slots */
  contextScope: { type: 'row' | 'col' | 'cell'; indices: number[] } | null;
  /** Format of the currently selected cell (for toggle state in toolbar/menus). */
  currentCellFormat?: DataGridCellFormat;
}

/** Commands that stay enabled on a read-only grid. */
const READ_ONLY_COMMANDS = new Set(['copy', 'conditional-formatting']);

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
  /** Sheet tab that was right-clicked (for sheet context menu). */
  targetSheetId?: string;
  onDeleteSheet?: (id: string) => void;
  onHideSheet?: (id: string) => void;
  onRenameSheet?: (id: string) => void;
  openConditionalFormatPanel?: () => void;
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

export type SlotId =
  | 'edit-menu'
  | 'insert-menu'
  | 'format-menu'
  | 'view-menu'
  | 'toolbar'
  | 'cell-ctx'
  | 'row-ctx'
  | 'col-ctx'
  | 'sheet-ctx';

export type SlotEntry =
  | { kind: 'separator' }
  | {
    kind: 'command';
    id: string;
    label?: string | ((s: GridCommandState) => string);
    icon?: string;
    toolbarDividerBefore?: boolean;
  }
  | {
    kind: 'submenu';
    id: string;
    label: string;
    icon?: string;
    toolbarDividerBefore?: boolean;
    resolve(state: GridCommandState, ctx: GridCommandContext): ResolvedEntry & { kind: 'submenu' };
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
    toolbarDividerBefore?: boolean;
    /** Inline CSS for the menu item (e.g. fontFamily for font previews). */
    style?: Record<string, string>;
    execute(): void;
  }
  | {
    kind: 'submenu';
    id: string;
    label: string;
    icon?: string;
    isEnabled: boolean;
    currentValueLabel?: string;
    toolbarDividerBefore?: boolean;
    children: ResolvedEntry[];
    executeCustom?: (value: string) => void;
  };

export interface ResolvedMenu {
  menuId: SlotId;
  triggerLabel: string;
  entries: ResolvedEntry[];
}

export interface SearchableEntry {
  id: string;
  label: string;
  /** e.g. "Format > Font family" */
  group: string;
  icon?: string;
  shortcut?: string;
  isEnabled: boolean;
  execute(): void;
}

export interface GridCommandsApi {
  toolbar: ResolvedEntry[];
  menus: ResolvedMenu[];
  cellCtx: ResolvedEntry[];
  rowCtx: ResolvedEntry[];
  colCtx: ResolvedEntry[];
  sheetCtx: ResolvedEntry[];
  /** Flat deduplicated list of all searchable commands + submenu children. */
  allSearchable: SearchableEntry[];
  /** Call from handleKeyDown after navigation keys. Returns true if the event was handled. */
  dispatchKey(e: KeyboardEvent, isMod: boolean): boolean;
  /** Execute the paste command with optional native ClipboardEvent data. */
  executePaste(pasteEvent?: ClipboardEvent): void;
}

// ============================================================
// Helpers shared by plugins
// ============================================================

function rowIndices(s: GridCommandState): number[] {
  return s.contextScope?.type === 'row' ? s.contextScope.indices : s.currentRowIndices;
}

function colIndices(s: GridCommandState): number[] {
  return s.contextScope?.type === 'col' ? s.contextScope.indices : s.currentColIndices;
}

/** Type-safe cell read: Automerge returns undefined for missing keys even though the Record type says otherwise. */
export function getCell(cells: Record<string, DataGridCell>, key: string): DataGridCell | undefined {
  return cells[key] as DataGridCell | undefined;
}

/** Write a cell value in place, or create it, or delete it if empty. */
export function setCell(cells: Record<string, DataGridCell>, key: string, stored: string): void {
  const existing = getCell(cells, key);
  if (stored === '') {
    if (existing) delete cells[key];
  } else if (!existing) {
    cells[key] = { value: stored };
  } else if (existing.value !== stored) {
    existing.value = stored;
  }
}

/** Get the active sheet from the context. */
function ctxSheet(_doc: any, ctx: GridCommandContext) {
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
  slots: {
    'edit-menu': [
      { kind: 'command', id: 'undo' },
      { kind: 'command', id: 'redo' },
      { kind: 'separator' },
    ],
    toolbar: [
      { kind: 'command', id: 'undo' },
      { kind: 'command', id: 'redo' },
    ],
  },
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
        const sh = ctxSheet(ctx.sheet, ctx);
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
        const sh = ctxSheet(ctx.sheet, ctx);
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
          const sh = ctxSheet(doc, ctx);
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
    'edit-menu': [
      { kind: 'command', id: 'cut' },
      { kind: 'command', id: 'copy' },
      { kind: 'command', id: 'paste' },
      { kind: 'separator' },
      { kind: 'command', id: 'delete-contents' },
    ],
    toolbar: [
      { kind: 'command', id: 'cut', toolbarDividerBefore: true },
      { kind: 'command', id: 'copy' },
      { kind: 'command', id: 'paste' },
    ],
    'cell-ctx': [
      { kind: 'command', id: 'cut' },
      { kind: 'command', id: 'copy' },
      { kind: 'command', id: 'paste' },
    ],
  },
};

const rowPlugin: GridPlugin = {
  id: 'row',
  commands: [
    {
      id: 'insert-row-above',
      defaultLabel: s => {
        const n = rowIndices(s).length;
        return n > 1 ? `Insert ${n} rows above` : 'Insert 1 row above';
      },
      icon: 'keyboard_arrow_up',
      isEnabled: s => rowIndices(s).length > 0,
      execute: (s, ctx) => {
        const { sheet: doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = rowIndices(s);
        const entries = sortedEntries(sh.rows);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        // Resolve the VISIBLE target row to its position in the full sorted list (H4).
        const minVisIdx = Math.min(...indices);
        const targetId = ctx.visibleRowIds[minVisIdx];
        if (!targetId) return;
        const targetPos = entries.findIndex(([id]) => id === targetId);
        if (targetPos === -1) return;
        const hi = entries[targetPos][1].index;
        const lo = targetPos === 0 ? hi - count : entries[targetPos - 1][1].index;
        const newIds = Array.from({ length: count }, () => shortId());
        ctx.mutate((d, currentSheetId, newIds, lo, hi, count) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.rows[newIds[i]] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1) };
          }
        }, [currentSheetId, newIds, lo, hi, count]);
        setContextMenu(null);
      },
    },
    {
      id: 'insert-row-below',
      defaultLabel: s => {
        const n = rowIndices(s).length;
        return n > 1 ? `Insert ${n} rows below` : 'Insert 1 row below';
      },
      icon: 'keyboard_arrow_down',
      isEnabled: s => rowIndices(s).length > 0,
      execute: (s, ctx) => {
        const { sheet: doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = rowIndices(s);
        const entries = sortedEntries(sh.rows);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        // Resolve the VISIBLE target row to its position in the full sorted list (H4).
        const maxVisIdx = Math.max(...indices);
        const targetId = ctx.visibleRowIds[maxVisIdx];
        if (!targetId) return;
        const targetPos = entries.findIndex(([id]) => id === targetId);
        if (targetPos === -1) return;
        const lo = entries[targetPos][1].index;
        const hi = targetPos >= entries.length - 1 ? lo + count : entries[targetPos + 1][1].index;
        const newIds = Array.from({ length: count }, () => shortId());
        ctx.mutate((d, currentSheetId, newIds, lo, hi, count) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.rows[newIds[i]] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1) };
          }
        }, [currentSheetId, newIds, lo, hi, count]);
        setContextMenu(null);
      },
    },
    {
      id: 'move-rows-up',
      defaultLabel: 'Move up',
      isEnabled: s => s.currentRowIndices.length > 0,
      execute: (_, ctx) => {
        const { sheet: doc, selectedRows, setSelectedRows, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.rows);
        // selectedRows are VISIBLE indices — resolve neighbors through visibleRowIds (H4).
        const indices = [...selectedRows].sort((a, b) => a - b);
        if (indices.length === 0 || indices[0] === 0) return;
        const aboveId = ctx.visibleRowIds[indices[0] - 1];
        if (!aboveId) return;
        const lastVisId = ctx.visibleRowIds[indices[indices.length - 1]];
        const lastPos = entries.findIndex(([id]) => id === lastVisId);
        if (lastPos === -1) return;
        const newIndex = lastPos >= entries.length - 1
          ? entries[lastPos][1].index + 1
          : (entries[lastPos][1].index + entries[lastPos + 1][1].index) / 2;
        ctx.mutate((d, currentSheetId, aboveId, newIndex) => { d.sheets[currentSheetId].rows[aboveId].index = newIndex; }, [currentSheetId, aboveId, newIndex]);
        setSelectedRows(new Set(indices.map(i => i - 1)));
        setContextMenu(null);
      },
    },
    {
      id: 'move-rows-down',
      defaultLabel: 'Move down',
      isEnabled: s => s.currentRowIndices.length > 0,
      execute: (_, ctx) => {
        const { sheet: doc, selectedRows, setSelectedRows, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.rows);
        // selectedRows are VISIBLE indices — resolve neighbors through visibleRowIds (H4).
        const indices = [...selectedRows].sort((a, b) => a - b);
        if (indices.length === 0 || indices[indices.length - 1] >= ctx.visibleRowIds.length - 1) return;
        const belowId = ctx.visibleRowIds[indices[indices.length - 1] + 1];
        if (!belowId) return;
        const firstVisId = ctx.visibleRowIds[indices[0]];
        const firstPos = entries.findIndex(([id]) => id === firstVisId);
        if (firstPos === -1) return;
        const newIndex = firstPos === 0
          ? entries[0][1].index - 1
          : (entries[firstPos - 1][1].index + entries[firstPos][1].index) / 2;
        ctx.mutate((d, currentSheetId, belowId, newIndex) => { d.sheets[currentSheetId].rows[belowId].index = newIndex; }, [currentSheetId, belowId, newIndex]);
        setSelectedRows(new Set(indices.map(i => i + 1)));
        setContextMenu(null);
      },
    },
    {
      id: 'delete-rows',
      defaultLabel: s => {
        const n = rowIndices(s).length;
        return n > 1 ? `Delete ${n} rows` : 'Delete row';
      },
      danger: true,
      icon: 'delete',
      isEnabled: s => rowIndices(s).length > 0,
      execute: (s, ctx) => {
        const { sheet: doc, setSelectedRows, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = rowIndices(s);
        const rowEntries = sortedEntries(sh.rows);
        // Selection indices are in VISIBLE space — resolve through visibleRowIds
        // so a hidden row before the target is never deleted (H4).
        const idsToDelete = indices.map(i => ctx.visibleRowIds[i]).filter(Boolean);
        if (idsToDelete.length === 0) return;
        const deletedSet = new Set(idsToDelete);
        const sortedRowIds = rowEntries.map(([id]) => id);
        const sortedColIds = sortedEntries(sh.columns).map(([id]) => id);
        const rewrites = updateFormulasForDeletion(sh.cells, deletedSet, new Set(), sortedRowIds, sortedColIds);
        ctx.mutate((d, currentSheetId, rewrites: Record<string, string>, idsToDelete) => {
          const ms = d.sheets[currentSheetId];
          for (const [key, newVal] of Object.entries(rewrites)) {
            if (ms.cells[key] && ms.cells[key].value !== newVal) ms.cells[key].value = newVal;
          }
          for (const id of idsToDelete) {
            delete ms.rows[id];
            for (const key of Object.keys(ms.cells)) {
              if (key.startsWith(`${id}:`)) delete ms.cells[key];
            }
          }
        }, [currentSheetId, rewrites, idsToDelete]);
        setSelectedRows(new Set());
        setContextMenu(null);
      },
    },
    {
      id: 'set-row-height',
      defaultLabel: 'Set row height\u2026',
      icon: 'height',
      isEnabled: s => rowIndices(s).length > 0,
      execute: (s, ctx) => {
        const indices = rowIndices(s);
        const ids = indices.map(i => ctx.visibleRowIds[i]).filter(Boolean);
        if (ids.length === 0) return;
        const sh = ctxSheet(ctx.sheet, ctx);
        const currentHeight = sh?.rows[ids[0]]?.height || 28;
        const input = window.prompt('Row height (px):', String(currentHeight));
        if (input === null) return;
        const height = Math.max(16, Math.min(500, parseInt(input, 10)));
        if (isNaN(height)) return;
        ctx.mutate((d, sid, ids, height) => {
          for (const id of ids) d.sheets[sid].rows[id].height = height;
        }, [ctx.currentSheetId, ids, height]);
        ctx.setContextMenu(null);
      },
    },
  ],
  slots: {
    'insert-menu': [
      {
        kind: 'submenu', id: 'rows-submenu', label: 'Rows', icon: 'table_rows',
        resolve: (state, ctx) => ({
          kind: 'submenu', id: 'rows-submenu', label: 'Rows', icon: 'table_rows',
          isEnabled: true,
          children: resolveCommands(['insert-row-above', 'insert-row-below', null, 'move-rows-up', 'move-rows-down', null, 'delete-rows'], state, ctx),
        }),
      },
    ],
    toolbar: [],
    'row-ctx': [
      { kind: 'command', id: 'insert-row-above' },
      { kind: 'command', id: 'insert-row-below' },
      { kind: 'separator' },
      { kind: 'command', id: 'move-rows-up' },
      { kind: 'command', id: 'move-rows-down' },
      { kind: 'separator' },
      { kind: 'command', id: 'set-row-height' },
      { kind: 'separator' },
      { kind: 'command', id: 'delete-rows' },
    ],
    'cell-ctx': [
      { kind: 'separator' },
      { kind: 'command', id: 'insert-row-above' },
    ],
  },
};

const columnPlugin: GridPlugin = {
  id: 'column',
  commands: [
    {
      id: 'insert-col-left',
      defaultLabel: s => {
        const n = colIndices(s).length;
        return n > 1 ? `Insert ${n} columns left` : 'Insert 1 column left';
      },
      icon: 'keyboard_arrow_left',
      isEnabled: s => colIndices(s).length > 0,
      execute: (s, ctx) => {
        const { sheet: doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = colIndices(s);
        const entries = sortedEntries(sh.columns);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        // Resolve the VISIBLE target column to its position in the full sorted list (H4).
        const minVisIdx = Math.min(...indices);
        const targetId = ctx.visibleColIds[minVisIdx];
        if (!targetId) return;
        const targetPos = entries.findIndex(([id]) => id === targetId);
        if (targetPos === -1) return;
        const hi = entries[targetPos][1].index;
        const lo = targetPos === 0 ? hi - count : entries[targetPos - 1][1].index;
        const newIds = Array.from({ length: count }, () => shortId());
        ctx.mutate((d, currentSheetId, newIds, lo, hi, count) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.columns[newIds[i]] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1), name: '' };
          }
        }, [currentSheetId, newIds, lo, hi, count]);
        setContextMenu(null);
      },
    },
    {
      id: 'insert-col-right',
      defaultLabel: s => {
        const n = colIndices(s).length;
        return n > 1 ? `Insert ${n} columns right` : 'Insert 1 column right';
      },
      icon: 'keyboard_arrow_right',
      isEnabled: s => colIndices(s).length > 0,
      execute: (s, ctx) => {
        const { sheet: doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = colIndices(s);
        const entries = sortedEntries(sh.columns);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        // Resolve the VISIBLE target column to its position in the full sorted list (H4).
        const maxVisIdx = Math.max(...indices);
        const targetId = ctx.visibleColIds[maxVisIdx];
        if (!targetId) return;
        const targetPos = entries.findIndex(([id]) => id === targetId);
        if (targetPos === -1) return;
        const lo = entries[targetPos][1].index;
        const hi = targetPos >= entries.length - 1 ? lo + count : entries[targetPos + 1][1].index;
        const newIds = Array.from({ length: count }, () => shortId());
        ctx.mutate((d, currentSheetId, newIds, lo, hi, count) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.columns[newIds[i]] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1), name: '' };
          }
        }, [currentSheetId, newIds, lo, hi, count]);
        setContextMenu(null);
      },
    },
    {
      id: 'move-cols-left',
      defaultLabel: 'Move left',
      isEnabled: s => s.currentColIndices.length > 0,
      execute: (_, ctx) => {
        const { sheet: doc, selectedCols, setSelectedCols, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.columns);
        // selectedCols are VISIBLE indices — resolve neighbors through visibleColIds (H4).
        const indices = [...selectedCols].sort((a, b) => a - b);
        if (indices.length === 0 || indices[0] === 0) return;
        const leftId = ctx.visibleColIds[indices[0] - 1];
        if (!leftId) return;
        const lastVisId = ctx.visibleColIds[indices[indices.length - 1]];
        const lastPos = entries.findIndex(([id]) => id === lastVisId);
        if (lastPos === -1) return;
        const newIndex = lastPos >= entries.length - 1
          ? entries[lastPos][1].index + 1
          : (entries[lastPos][1].index + entries[lastPos + 1][1].index) / 2;
        ctx.mutate((d, currentSheetId, leftId, newIndex) => { d.sheets[currentSheetId].columns[leftId].index = newIndex; }, [currentSheetId, leftId, newIndex]);
        setSelectedCols(new Set(indices.map(i => i - 1)));
        setContextMenu(null);
      },
    },
    {
      id: 'move-cols-right',
      defaultLabel: 'Move right',
      isEnabled: s => s.currentColIndices.length > 0,
      execute: (_, ctx) => {
        const { sheet: doc, selectedCols, setSelectedCols, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.columns);
        // selectedCols are VISIBLE indices — resolve neighbors through visibleColIds (H4).
        const indices = [...selectedCols].sort((a, b) => a - b);
        if (indices.length === 0 || indices[indices.length - 1] >= ctx.visibleColIds.length - 1) return;
        const rightId = ctx.visibleColIds[indices[indices.length - 1] + 1];
        if (!rightId) return;
        const firstVisId = ctx.visibleColIds[indices[0]];
        const firstPos = entries.findIndex(([id]) => id === firstVisId);
        if (firstPos === -1) return;
        const newIndex = firstPos === 0
          ? entries[0][1].index - 1
          : (entries[firstPos - 1][1].index + entries[firstPos][1].index) / 2;
        ctx.mutate((d, currentSheetId, rightId, newIndex) => { d.sheets[currentSheetId].columns[rightId].index = newIndex; }, [currentSheetId, rightId, newIndex]);
        setSelectedCols(new Set(indices.map(i => i + 1)));
        setContextMenu(null);
      },
    },
    {
      id: 'delete-cols',
      defaultLabel: s => {
        const n = colIndices(s).length;
        return n > 1 ? `Delete ${n} columns` : 'Delete column';
      },
      danger: true,
      icon: 'delete',
      isEnabled: s => colIndices(s).length > 0,
      execute: (s, ctx) => {
        const { sheet: doc, setSelectedCols, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = colIndices(s);
        const colEntries = sortedEntries(sh.columns);
        // Selection indices are in VISIBLE space — resolve through visibleColIds
        // so a hidden column before the target is never deleted (H4).
        const idsToDelete = indices.map(i => ctx.visibleColIds[i]).filter(Boolean);
        if (idsToDelete.length === 0) return;
        const deletedSet = new Set(idsToDelete);
        const sortedRowIds = sortedEntries(sh.rows).map(([id]) => id);
        const sortedColIds = colEntries.map(([id]) => id);
        const rewrites = updateFormulasForDeletion(sh.cells, new Set(), deletedSet, sortedRowIds, sortedColIds);
        ctx.mutate((d, currentSheetId, rewrites: Record<string, string>, idsToDelete) => {
          const ms = d.sheets[currentSheetId];
          for (const [key, newVal] of Object.entries(rewrites)) {
            if (ms.cells[key] && ms.cells[key].value !== newVal) ms.cells[key].value = newVal;
          }
          for (const id of idsToDelete) {
            delete ms.columns[id];
            for (const key of Object.keys(ms.cells)) {
              if (key.endsWith(`:${id}`)) delete ms.cells[key];
            }
          }
        }, [currentSheetId, rewrites, idsToDelete]);
        setSelectedCols(new Set());
        setContextMenu(null);
      },
    },
    {
      id: 'set-col-width',
      defaultLabel: 'Set column width\u2026',
      icon: 'width',
      isEnabled: s => colIndices(s).length > 0,
      execute: (s, ctx) => {
        const indices = colIndices(s);
        const ids = indices.map(i => ctx.visibleColIds[i]).filter(Boolean);
        if (ids.length === 0) return;
        const sh = ctxSheet(ctx.sheet, ctx);
        const currentWidth = sh?.columns[ids[0]]?.width || 100;
        const input = window.prompt('Column width (px):', String(currentWidth));
        if (input === null) return;
        const width = Math.max(20, Math.min(2000, parseInt(input, 10)));
        if (isNaN(width)) return;
        ctx.mutate((d, sid, ids, width) => {
          for (const id of ids) d.sheets[sid].columns[id].width = width;
        }, [ctx.currentSheetId, ids, width]);
        ctx.setContextMenu(null);
      },
    },
  ],
  slots: {
    'insert-menu': [
      {
        kind: 'submenu', id: 'cols-submenu', label: 'Columns', icon: 'view_column',
        resolve: (state, ctx) => ({
          kind: 'submenu', id: 'cols-submenu', label: 'Columns', icon: 'view_column',
          isEnabled: true,
          children: resolveCommands(['insert-col-left', 'insert-col-right', null, 'move-cols-left', 'move-cols-right', null, 'delete-cols'], state, ctx),
        }),
      },
    ],
    toolbar: [],
    'col-ctx': [
      { kind: 'command', id: 'insert-col-left' },
      { kind: 'command', id: 'insert-col-right' },
      { kind: 'separator' },
      { kind: 'command', id: 'move-cols-left' },
      { kind: 'command', id: 'move-cols-right' },
      { kind: 'separator' },
      { kind: 'command', id: 'set-col-width' },
      { kind: 'separator' },
      { kind: 'command', id: 'delete-cols' },
    ],
    'cell-ctx': [
      { kind: 'command', id: 'insert-col-left' },
      { kind: 'separator' },
      { kind: 'command', id: 'delete-rows' },
      { kind: 'command', id: 'delete-cols' },
    ],
  },
};

// ============================================================
// Registry (built once at module load — plugins are static)
// ============================================================

const sheetPlugin: GridPlugin = {
  id: 'sheet',
  commands: [
    {
      id: 'add-sheet',
      defaultLabel: 'Add sheet',
      icon: 'add',
      isEnabled: () => true,
      execute: (_, ctx) => {
        const { sheetsMeta, mutate } = ctx;
        if (!sheetsMeta) return;
        const maxIndex = Object.values(sheetsMeta).reduce((max, s) => Math.max(max, s.index), 0);
        const sheetCount = Object.keys(sheetsMeta).length;
        const sid = shortId();
        const cols: Record<string, { index: number; name: string }> = {};
        for (let i = 0; i < 3; i++) cols[shortId()] = { index: i + 1, name: '' };
        const rows: Record<string, { index: number }> = {};
        for (let i = 0; i < 10; i++) rows[shortId()] = { index: i + 1 };
        const newSheet = { '@type': 'Sheet', name: `Sheet ${sheetCount + 1}`, index: maxIndex + 1, columns: cols, rows, cells: {} };
        mutate((d, sid, newSheet) => { d.sheets[sid] = newSheet as any; }, [sid, newSheet]);
        // The DataGrid component will detect the new sheet and switch to it
      },
    },
    {
      id: 'rename-sheet',
      defaultLabel: 'Rename sheet',
      icon: 'edit',
      isEnabled: () => true,
      execute: (_, ctx) => {
        const id = ctx.targetSheetId ?? ctx.currentSheetId;
        ctx.onRenameSheet?.(id);
      },
    },
    {
      id: 'delete-sheet',
      defaultLabel: 'Delete sheet',
      icon: 'delete',
      danger: true,
      isEnabled: s => s.sheetCount > 1,
      execute: (_, ctx) => {
        const id = ctx.targetSheetId ?? ctx.currentSheetId;
        ctx.onDeleteSheet?.(id);
      },
    },
    {
      id: 'hide-sheet',
      defaultLabel: 'Hide sheet',
      icon: 'visibility_off',
      isEnabled: s => s.sheetCount > 1,
      execute: (_, ctx) => {
        const id = ctx.targetSheetId ?? ctx.currentSheetId;
        ctx.onHideSheet?.(id);
      },
    },
  ],
  slots: {
    'insert-menu': [
      { kind: 'separator' },
      { kind: 'command', id: 'add-sheet' },
    ],
    'sheet-ctx': [
      { kind: 'command', id: 'rename-sheet' },
      { kind: 'separator' },
      { kind: 'command', id: 'delete-sheet' },
      { kind: 'command', id: 'hide-sheet' },
    ],
  },
};

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
// Submenu builders for formatting toolbar items
// ============================================================

function buildFontFamilySubmenu(state: GridCommandState, ctx: GridCommandContext): ResolvedEntry & { kind: 'submenu' } {
  return {
    kind: 'submenu', id: 'font-family', label: 'Font family', icon: 'font_download',
    isEnabled: state.hasSelection,
    currentValueLabel: (state.currentCellFormat?.fontFamily && state.currentCellFormat.fontFamily !== 'Arial') ? state.currentCellFormat.fontFamily : 'Default',
    children: [
      {
        kind: 'command', id: 'font-default', label: 'Default', isEnabled: state.hasSelection,
        isChecked: !state.currentCellFormat?.fontFamily || state.currentCellFormat.fontFamily === 'Arial',
        execute: () => applyFormatToSelection(ctx, { fontFamily: undefined })
      },
      ...FONT_FAMILIES.map(f => ({
        kind: 'command' as const, id: `font-${f}`, label: f, isEnabled: state.hasSelection,
        isChecked: state.currentCellFormat?.fontFamily === f,
        style: { fontFamily: f },
        execute: () => applyFormatToSelection(ctx, { fontFamily: f }),
      })),
    ],
  };
}

function buildFontSizeSubmenu(state: GridCommandState, ctx: GridCommandContext): ResolvedEntry & { kind: 'submenu' } {
  return {
    kind: 'submenu', id: 'font-size', label: 'Font size', icon: 'format_size',
    isEnabled: state.hasSelection,
    currentValueLabel: state.currentCellFormat?.fontSize ? String(state.currentCellFormat.fontSize) : 'Default',
    executeCustom: (value: string) => {
      const size = parseInt(value, 10);
      if (size > 0 && size <= 999) applyFormatToSelection(ctx, { fontSize: size });
    },
    children: [
      {
        kind: 'command', id: 'font-size-default', label: 'Default', isEnabled: state.hasSelection,
        isChecked: !state.currentCellFormat?.fontSize,
        execute: () => applyFormatToSelection(ctx, { fontSize: undefined })
      },
      ...FONT_SIZES.map(s => ({
        kind: 'command' as const, id: `font-size-${s}`, label: String(s), isEnabled: state.hasSelection,
        isChecked: state.currentCellFormat?.fontSize === s,
        execute: () => applyFormatToSelection(ctx, { fontSize: s }),
      })),
    ],
  };
}

function buildTextColorSubmenu(state: GridCommandState, ctx: GridCommandContext): ResolvedEntry & { kind: 'submenu' } {
  return {
    kind: 'submenu', id: 'text-color', label: 'Text color', icon: 'format_color_text',
    isEnabled: state.hasSelection,
    executeCustom: (color: string) => applyFormatToSelection(ctx, { textColor: color }),
    children: [
      {
        kind: 'command', id: 'text-color-reset', label: '__reset__', isEnabled: state.hasSelection,
        isChecked: !state.currentCellFormat?.textColor,
        execute: () => applyFormatToSelection(ctx, { textColor: undefined })
      },
      ...PRESET_COLORS.map(c => ({
        kind: 'command' as const, id: `text-color-${c}`, label: c, isEnabled: state.hasSelection,
        isChecked: state.currentCellFormat?.textColor === c,
        execute: () => applyFormatToSelection(ctx, { textColor: c }),
      })),
    ],
  };
}

function buildBgColorSubmenu(state: GridCommandState, ctx: GridCommandContext): ResolvedEntry & { kind: 'submenu' } {
  return {
    kind: 'submenu', id: 'bg-color', label: 'Fill color', icon: 'format_color_fill',
    isEnabled: state.hasSelection,
    executeCustom: (color: string) => applyFormatToSelection(ctx, { bgColor: color }),
    children: [
      {
        kind: 'command', id: 'bg-color-reset', label: '__reset__', isEnabled: state.hasSelection,
        isChecked: !state.currentCellFormat?.bgColor,
        execute: () => applyFormatToSelection(ctx, { bgColor: undefined })
      },
      ...PRESET_COLORS.map(c => ({
        kind: 'command' as const, id: `bg-color-${c}`, label: c, isEnabled: state.hasSelection,
        isChecked: state.currentCellFormat?.bgColor === c,
        execute: () => applyFormatToSelection(ctx, { bgColor: c }),
      })),
    ],
  };
}

function buildNumberFormatSubmenu(state: GridCommandState, ctx: GridCommandContext): ResolvedEntry & { kind: 'submenu' } {
  return {
    kind: 'submenu', id: 'number-format', label: 'Number format', icon: 'tag',
    isEnabled: state.hasSelection,
    currentValueLabel: NUMBER_FORMATS.find(f => f.value === (state.currentCellFormat?.numFmt || 'auto'))?.label || 'Automatic',
    children: NUMBER_FORMATS.map(f => ({
      kind: 'command' as const, id: `num-fmt-${f.value}`, label: f.label, isEnabled: state.hasSelection,
      isChecked: (state.currentCellFormat?.numFmt || 'auto') === f.value,
      shortcut: f.example,
      execute: () => applyFormatToSelection(ctx, { numFmt: f.value === 'auto' ? undefined : f.value }),
    })),
  };
}

function buildBordersSubmenu(state: GridCommandState, ctx: GridCommandContext): ResolvedEntry & { kind: 'submenu' } {
  return {
    kind: 'submenu', id: 'borders', label: 'Borders', icon: 'border_all',
    isEnabled: state.hasSelection,
    children: BORDER_PRESETS.map(preset => ({
      kind: 'command' as const, id: `border-${preset.icon}`, label: preset.label, icon: preset.icon,
      isEnabled: state.hasSelection,
      execute: () => {
        const patch: Partial<DataGridCellFormat> = {};
        const allSides = ['borderTop', 'borderBottom', 'borderLeft', 'borderRight'] as const;
        const sideSet = new Set(preset.sides);
        for (const side of allSides) {
          if (sideSet.has(side)) {
            (patch as any)[side] = { style: 'thin', color: '#000000' };
          } else {
            (patch as any)[side] = undefined;
          }
        }
        applyFormatToSelection(ctx, patch);
      },
    })),
  };
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
    {
      id: 'conditional-formatting',
      defaultLabel: 'Conditional formatting...',
      icon: 'auto_awesome',
      isEnabled: () => true,
      execute: (_, ctx) => ctx.openConditionalFormatPanel?.(),
    },
  ],
  slots: {
    'format-menu': [
      { kind: 'command', id: 'toggle-bold' },
      { kind: 'command', id: 'toggle-italic' },
      { kind: 'command', id: 'toggle-underline' },
      { kind: 'command', id: 'toggle-strikethrough' },
      { kind: 'separator' },
      { kind: 'submenu', id: 'font-family', label: 'Font family', icon: 'font_download', resolve: buildFontFamilySubmenu },
      { kind: 'submenu', id: 'font-size', label: 'Font size', icon: 'format_size', resolve: buildFontSizeSubmenu },
      { kind: 'separator' },
      { kind: 'submenu', id: 'text-color', label: 'Text color', icon: 'format_color_text', resolve: buildTextColorSubmenu },
      { kind: 'submenu', id: 'bg-color', label: 'Fill color', icon: 'format_color_fill', resolve: buildBgColorSubmenu },
      { kind: 'separator' },
      { kind: 'submenu', id: 'number-format', label: 'Number format', icon: 'tag', resolve: buildNumberFormatSubmenu },
      { kind: 'submenu', id: 'borders', label: 'Borders', icon: 'border_all', resolve: buildBordersSubmenu },
      { kind: 'separator' },
      {
        kind: 'submenu', id: 'alignment', label: 'Alignment', icon: 'format_align_left',
        resolve: (state, ctx) => ({
          kind: 'submenu', id: 'alignment', label: 'Alignment', icon: 'format_align_left',
          isEnabled: state.hasSelection,
          children: resolveCommands(['align-left', 'align-center', 'align-right'], state, ctx),
        }),
      },
      { kind: 'separator' },
      { kind: 'command', id: 'clear-formatting' },
      { kind: 'separator' },
      { kind: 'command', id: 'conditional-formatting' },
    ],
    toolbar: [
      { kind: 'command', id: 'toggle-bold', toolbarDividerBefore: true },
      { kind: 'command', id: 'toggle-italic' },
      { kind: 'command', id: 'toggle-underline' },
      { kind: 'command', id: 'toggle-strikethrough' },
      { kind: 'submenu', id: 'font-family', label: 'Font family', icon: 'font_download', toolbarDividerBefore: true, resolve: buildFontFamilySubmenu },
      { kind: 'submenu', id: 'font-size', label: 'Font size', icon: 'format_size', resolve: buildFontSizeSubmenu },
      { kind: 'submenu', id: 'text-color', label: 'Text color', icon: 'format_color_text', resolve: buildTextColorSubmenu },
      { kind: 'submenu', id: 'bg-color', label: 'Fill color', icon: 'format_color_fill', resolve: buildBgColorSubmenu },
      { kind: 'submenu', id: 'number-format', label: 'Number format', icon: 'tag', toolbarDividerBefore: true, resolve: buildNumberFormatSubmenu },
      { kind: 'submenu', id: 'borders', label: 'Borders', icon: 'border_all', resolve: buildBordersSubmenu },
    ],
    'cell-ctx': [
      { kind: 'separator' },
      { kind: 'command', id: 'clear-formatting' },
    ],
  },
};

// ============================================================
// Visibility & Freeze plugin
// ============================================================

const visibilityPlugin: GridPlugin = {
  id: 'visibility',
  commands: [
    {
      id: 'hide-rows',
      defaultLabel: s => {
        const n = rowIndices(s).length;
        return n > 1 ? `Hide ${n} rows` : 'Hide row';
      },
      icon: 'visibility_off',
      isEnabled: s => rowIndices(s).length > 0,
      execute: (s, ctx) => {
        const indices = rowIndices(s);
        const ids = indices.map(i => ctx.visibleRowIds[i]).filter(Boolean);
        if (ids.length === 0) return;
        ctx.mutate((d, sid, ids) => {
          for (const id of ids) d.sheets[sid].rows[id].hidden = true;
        }, [ctx.currentSheetId, ids]);
        ctx.setSelectedRows(new Set());
        ctx.setContextMenu(null);
      },
    },
    {
      id: 'hide-cols',
      defaultLabel: s => {
        const n = colIndices(s).length;
        return n > 1 ? `Hide ${n} columns` : 'Hide column';
      },
      icon: 'visibility_off',
      isEnabled: s => colIndices(s).length > 0,
      execute: (s, ctx) => {
        const indices = colIndices(s);
        const ids = indices.map(i => ctx.visibleColIds[i]).filter(Boolean);
        if (ids.length === 0) return;
        ctx.mutate((d, sid, ids) => {
          for (const id of ids) d.sheets[sid].columns[id].hidden = true;
        }, [ctx.currentSheetId, ids]);
        ctx.setSelectedCols(new Set());
        ctx.setContextMenu(null);
      },
    },
    {
      id: 'unhide-all-rows',
      defaultLabel: 'Unhide all rows',
      icon: 'visibility',
      isEnabled: s => s.hasHiddenRows,
      execute: (_, ctx) => {
        const sh = ctxSheet(ctx.sheet, ctx);
        if (!sh) return;
        const ids = Object.entries(sh.rows).filter(([, r]: [string, any]) => r.hidden).map(([id]) => id);
        if (ids.length === 0) return;
        ctx.mutate((d, sid, ids) => {
          for (const id of ids) delete d.sheets[sid].rows[id].hidden;
        }, [ctx.currentSheetId, ids]);
      },
    },
    {
      id: 'unhide-all-cols',
      defaultLabel: 'Unhide all columns',
      icon: 'visibility',
      isEnabled: s => s.hasHiddenCols,
      execute: (_, ctx) => {
        const sh = ctxSheet(ctx.sheet, ctx);
        if (!sh) return;
        const ids = Object.entries(sh.columns).filter(([, c]: [string, any]) => c.hidden).map(([id]) => id);
        if (ids.length === 0) return;
        ctx.mutate((d, sid, ids) => {
          for (const id of ids) delete d.sheets[sid].columns[id].hidden;
        }, [ctx.currentSheetId, ids]);
      },
    },
    {
      id: 'freeze-rows',
      defaultLabel: 'Freeze rows',
      icon: 'push_pin',
      isEnabled: s => rowIndices(s).length > 0,
      execute: (s, ctx) => {
        const sh = ctxSheet(ctx.sheet, ctx);
        if (!sh) return;
        const indices = rowIndices(s);
        const maxVisIdx = Math.max(...indices);
        const freezeUpToId = ctx.visibleRowIds[maxVisIdx];
        if (!freezeUpToId) return;
        const allEntries = sortedEntries(sh.rows);
        const freezeUpToOrigIdx = allEntries.findIndex(([id]) => id === freezeUpToId);
        const idsToFreeze: string[] = [];
        const idsToUnfreeze: string[] = [];
        for (let i = 0; i < allEntries.length; i++) {
          if (i <= freezeUpToOrigIdx) idsToFreeze.push(allEntries[i][0]);
          else idsToUnfreeze.push(allEntries[i][0]);
        }
        ctx.mutate((d, sid, idsToFreeze, idsToUnfreeze) => {
          for (const id of idsToFreeze) d.sheets[sid].rows[id].frozen = true;
          for (const id of idsToUnfreeze) delete d.sheets[sid].rows[id].frozen;
        }, [ctx.currentSheetId, idsToFreeze, idsToUnfreeze]);
        ctx.setContextMenu(null);
      },
    },
    {
      id: 'unfreeze-rows',
      defaultLabel: 'Unfreeze rows',
      icon: 'push_pin',
      isEnabled: s => s.hasFrozenRows,
      execute: (_, ctx) => {
        const sh = ctxSheet(ctx.sheet, ctx);
        if (!sh) return;
        const ids = Object.entries(sh.rows).filter(([, r]: [string, any]) => r.frozen).map(([id]) => id);
        if (ids.length === 0) return;
        ctx.mutate((d, sid, ids) => {
          for (const id of ids) delete d.sheets[sid].rows[id].frozen;
        }, [ctx.currentSheetId, ids]);
      },
    },
    {
      id: 'freeze-cols',
      defaultLabel: 'Freeze columns',
      icon: 'push_pin',
      isEnabled: s => colIndices(s).length > 0,
      execute: (s, ctx) => {
        const sh = ctxSheet(ctx.sheet, ctx);
        if (!sh) return;
        const indices = colIndices(s);
        const maxVisIdx = Math.max(...indices);
        const freezeUpToId = ctx.visibleColIds[maxVisIdx];
        if (!freezeUpToId) return;
        const allEntries = sortedEntries(sh.columns);
        const freezeUpToOrigIdx = allEntries.findIndex(([id]) => id === freezeUpToId);
        const idsToFreeze: string[] = [];
        const idsToUnfreeze: string[] = [];
        for (let i = 0; i < allEntries.length; i++) {
          if (i <= freezeUpToOrigIdx) idsToFreeze.push(allEntries[i][0]);
          else idsToUnfreeze.push(allEntries[i][0]);
        }
        ctx.mutate((d, sid, idsToFreeze, idsToUnfreeze) => {
          for (const id of idsToFreeze) d.sheets[sid].columns[id].frozen = true;
          for (const id of idsToUnfreeze) delete d.sheets[sid].columns[id].frozen;
        }, [ctx.currentSheetId, idsToFreeze, idsToUnfreeze]);
        ctx.setContextMenu(null);
      },
    },
    {
      id: 'unfreeze-cols',
      defaultLabel: 'Unfreeze columns',
      icon: 'push_pin',
      isEnabled: s => s.hasFrozenCols,
      execute: (_, ctx) => {
        const sh = ctxSheet(ctx.sheet, ctx);
        if (!sh) return;
        const ids = Object.entries(sh.columns).filter(([, c]: [string, any]) => c.frozen).map(([id]) => id);
        if (ids.length === 0) return;
        ctx.mutate((d, sid, ids) => {
          for (const id of ids) delete d.sheets[sid].columns[id].frozen;
        }, [ctx.currentSheetId, ids]);
      },
    },
  ],
  slots: {
    'row-ctx': [
      { kind: 'separator' },
      { kind: 'command', id: 'hide-rows' },
      { kind: 'command', id: 'freeze-rows' },
      { kind: 'command', id: 'unfreeze-rows' },
    ],
    'col-ctx': [
      { kind: 'separator' },
      { kind: 'command', id: 'hide-cols' },
      { kind: 'command', id: 'freeze-cols' },
      { kind: 'command', id: 'unfreeze-cols' },
    ],
    'view-menu': [
      { kind: 'command', id: 'unhide-all-rows' },
      { kind: 'command', id: 'unhide-all-cols' },
      { kind: 'separator' },
      { kind: 'command', id: 'unfreeze-rows' },
      { kind: 'command', id: 'unfreeze-cols' },
    ],
  },
};

const ALL_PLUGINS: GridPlugin[] = [historyPlugin, clipboardPlugin, rowPlugin, columnPlugin, sheetPlugin, formattingPlugin, visibilityPlugin];

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
  'edit-menu': buildSlotList('edit-menu'),
  'insert-menu': buildSlotList('insert-menu'),
  'format-menu': buildSlotList('format-menu'),
  'view-menu': buildSlotList('view-menu'),
  toolbar: buildSlotList('toolbar'),
  'cell-ctx': buildSlotList('cell-ctx'),
  'row-ctx': buildSlotList('row-ctx'),
  'col-ctx': buildSlotList('col-ctx'),
  'sheet-ctx': buildSlotList('sheet-ctx'),
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
  const sh = ctxSheet(doc, ctx);

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
  const sh = ctxSheet(doc, ctx);

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

/** Recursively mark a resolved entry disabled (keeping allowlisted commands). */
function disableResolved(e: ResolvedEntry): ResolvedEntry {
  if (e.kind === 'separator') return e;
  if (e.kind === 'submenu') return { ...e, isEnabled: false, children: e.children.map(disableResolved) };
  return READ_ONLY_COMMANDS.has(e.id) ? e : { ...e, isEnabled: false };
}

function resolveSlot(
  slotId: SlotId,
  state: GridCommandState,
  ctx: GridCommandContext,
): ResolvedEntry[] {
  return SLOT_LISTS[slotId].map((entry): ResolvedEntry => {
    if (entry.kind === 'separator') return { kind: 'separator' };
    if (entry.kind === 'submenu') {
      const sub = entry.resolve(state, ctx);
      // Submenus are all format/mutation widgets — disabled wholesale when read-only.
      return state.canEdit ? sub : (disableResolved(sub) as ResolvedEntry & { kind: 'submenu' });
    }

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
      toolbarDividerBefore: entry.kind === 'command' ? entry.toolbarDividerBefore : undefined,
      execute: () => cmd.execute(state, ctx),
    };
  });
}

export function useGridCommands(
  state: GridCommandState,
  ctx: GridCommandContext,
): GridCommandsApi {
  const toolbar = resolveSlot('toolbar', state, ctx);
  const cellCtx = resolveSlot('cell-ctx', state, ctx);
  const rowCtx = resolveSlot('row-ctx', state, ctx);
  const colCtx = resolveSlot('col-ctx', state, ctx);
  const sheetCtx = resolveSlot('sheet-ctx', state, ctx);

  const menus: ResolvedMenu[] = [
    { menuId: 'edit-menu', triggerLabel: 'Edit', entries: resolveSlot('edit-menu', state, ctx) },
    { menuId: 'insert-menu', triggerLabel: 'Insert', entries: resolveSlot('insert-menu', state, ctx) },
    { menuId: 'format-menu', triggerLabel: 'Format', entries: resolveSlot('format-menu', state, ctx) },
    { menuId: 'view-menu', triggerLabel: 'View', entries: resolveSlot('view-menu', state, ctx) },
  ];

  function dispatchKey(e: KeyboardEvent, isMod: boolean): boolean {
    for (const cmd of KEY_COMMANDS) {
      // Skip paste — handled by the native paste event listener so we get clipboardData
      if (cmd.id === 'paste') continue;
      if (!state.canEdit && !READ_ONLY_COMMANDS.has(cmd.id)) continue;
      for (const shortcut of cmd.shortcuts!) {
        if (matchShortcut(e, isMod, shortcut)) {
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

  // Build flat searchable list from all menus
  const allSearchable: SearchableEntry[] = [];
  const seen = new Set<string>();
  for (const menu of menus) {
    for (const entry of menu.entries) {
      if (entry.kind === 'command' && !seen.has(entry.id)) {
        seen.add(entry.id);
        allSearchable.push({
          id: entry.id, label: entry.label, group: menu.triggerLabel,
          icon: entry.icon, shortcut: entry.shortcut, isEnabled: entry.isEnabled, execute: entry.execute,
        });
      } else if (entry.kind === 'submenu') {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          // Add parent as a non-executable group header (skip)
        }
        for (const child of entry.children) {
          if (child.kind === 'command') {
            const childId = `${entry.id}/${child.id}`;
            if (!seen.has(childId)) {
              seen.add(childId);
              allSearchable.push({
                id: childId, label: child.label, group: `${menu.triggerLabel} > ${entry.label}`,
                icon: child.icon, isEnabled: child.isEnabled, execute: child.execute,
              });
            }
          }
        }
      }
    }
  }

  return { toolbar, menus, cellCtx, rowCtx, colCtx, sheetCtx, allSearchable, dispatchKey, executePaste };
}
