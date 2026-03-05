import {
  sortedEntries, shortId, a1ToInternal, internalToR1C1,
  updateFormulasForDeletion, generateAutofillValues, getAutofillSourceValues,
} from './helpers';
import {
  buildClipboardData, writeClipboard, parseHtmlClipboard,
  getEffectiveRange, type ClipboardEntry, type CellRange,
} from './clipboard';
import type { DataGridDocument, DataGridCell } from './schema';
import type HyperFormula from 'hyperformula';

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
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  currentRowIndices: number[];
  currentColIndices: number[];
  sheetCount: number;
  /** Non-null only when resolving context-menu slots */
  contextScope: { type: 'row' | 'col' | 'cell'; indices: number[] } | null;
}

// ============================================================
// GridCommandContext — raw materials for command execute bodies
// ============================================================

export interface GridCommandContext {
  /** Immutable snapshot of the current document. */
  doc: DataGridDocument | null;
  hf: HyperFormula | null;
  currentSheetId: string;
  /** HyperFormula sheet index for the current sheet. */
  hfSheetIndex: number;
  sortedRowIds: string[];
  sortedColIds: string[];
  selectedCell: [number, number] | null;
  selectionAnchor: [number, number] | null;
  currentRowIndices: number[];
  currentColIndices: number[];
  selectedRows: Set<number>;
  selectedCols: Set<number>;
  clipboardRef: { current: ClipboardEntry | null };
  setClipboardSource: (r: CellRange | null) => void;
  /** Apply a mutation to the document. Returns false from fn to skip HyperFormula sync. */
  mutate: (fn: (doc: DataGridDocument) => boolean | void) => void;
  setSelectionAnchor: (anchor: [number, number] | null) => void;
  setSelectedCell: (cell: [number, number]) => void;
  setContextMenu: (m: null) => void;
  setSelectedRows: (rows: Set<number>) => void;
  setSelectedCols: (cols: Set<number>) => void;
  undo: () => void;
  redo: () => void;
  /** Sheet tab that was right-clicked (for sheet context menu). */
  targetSheetId?: string;
  onDeleteSheet?: (id: string) => void;
  onHideSheet?: (id: string) => void;
  onRenameSheet?: (id: string) => void;
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
      execute(): void;
    };

export interface ResolvedMenu {
  menuId: SlotId;
  triggerLabel: string;
  entries: ResolvedEntry[];
}

export interface GridCommandsApi {
  toolbar: ResolvedEntry[];
  menus: ResolvedMenu[];
  cellCtx: ResolvedEntry[];
  rowCtx: ResolvedEntry[];
  colCtx: ResolvedEntry[];
  sheetCtx: ResolvedEntry[];
  /** Call from handleKeyDown after navigation keys. Returns true if the event was handled. */
  dispatchKey(e: KeyboardEvent, isMod: boolean): boolean;
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

/** Get the current sheet from the document using the context's currentSheetId. */
function ctxSheet(doc: DataGridDocument, ctx: GridCommandContext) {
  return doc.sheets[ctx.currentSheetId];
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
        if (!range || !ctx.doc) return;
        const sh = ctxSheet(ctx.doc, ctx);
        const data = buildClipboardData(sh.cells, ctx.hf, range, ctx.sortedRowIds, ctx.sortedColIds, ctx.hfSheetIndex);
        if (!data) return;
        ctx.clipboardRef.current = { values: data.values, mode: 'copy', range };
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
        if (!range || !ctx.doc) return;
        const sh = ctxSheet(ctx.doc, ctx);
        const data = buildClipboardData(sh.cells, ctx.hf, range, ctx.sortedRowIds, ctx.sortedColIds, ctx.hfSheetIndex);
        if (!data) return;
        ctx.clipboardRef.current = { values: data.values, mode: 'cut', range };
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
        const { selectedCell, sortedRowIds, sortedColIds, clipboardRef, mutate,
          setClipboardSource, setSelectionAnchor, setSelectedCell, currentSheetId } = ctx;
        if (!selectedCell) return;
        const [destCol, destRow] = selectedCell;

        if (clipboardRef.current) {
          // Internal paste: use snapshot row/col IDs for bounds, but write via mutate
          const { values, mode, range: srcRange } = clipboardRef.current;
          const { doc } = ctx;
          if (!doc) return;
          const sh = ctxSheet(doc, ctx);
          const freshRowIds = sortedEntries(sh.rows).map(([id]) => id);
          const freshColIds = sortedEntries(sh.columns).map(([id]) => id);

          mutate((d) => {
            const ms = d.sheets[currentSheetId];
            for (let dr = 0; dr < values.length; dr++) {
              for (let dc = 0; dc < values[dr].length; dc++) {
                const r = destRow + dr;
                const c = destCol + dc;
                if (r >= freshRowIds.length || c >= freshColIds.length) continue;
                const val = values[dr][dc];
                const stored = val.startsWith('=')
                  ? a1ToInternal(val, r, c, freshRowIds, freshColIds)
                  : val;
                setCell(ms.cells, `${freshRowIds[r]}:${freshColIds[c]}`, stored);
              }
            }
            if (mode === 'cut') {
              for (let r = srcRange.minRow; r <= srcRange.maxRow; r++) {
                for (let c = srcRange.minCol; c <= srcRange.maxCol; c++) {
                  if (r >= freshRowIds.length || c >= freshColIds.length) continue;
                  const pasteR = destRow + (r - srcRange.minRow);
                  const pasteC = destCol + (c - srcRange.minCol);
                  if (pasteR === r && pasteC === c) continue;
                  delete ms.cells[`${freshRowIds[r]}:${freshColIds[c]}`];
                }
              }
            }
          });

          clipboardRef.current = null;
          setClipboardSource(null);

          const pasteMaxRow = Math.min(destRow + values.length - 1, sortedRowIds.length - 1);
          const pasteMaxCol = Math.min(destCol + (values[0]?.length || 1) - 1, sortedColIds.length - 1);
          setSelectionAnchor([destCol, destRow]);
          setSelectedCell([pasteMaxCol, pasteMaxRow]);
        } else {
          // External paste: read fresh row/col IDs inside mutate so they're in sync
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
            if (!rows?.length) return;

            const finalRows = rows;
            mutate((d) => {
              const ms = d.sheets[currentSheetId];
              const freshRowIds = sortedEntries(ms.rows).map(([id]) => id);
              const freshColIds = sortedEntries(ms.columns).map(([id]) => id);
              for (let dr = 0; dr < finalRows.length; dr++) {
                for (let dc = 0; dc < finalRows[dr].length; dc++) {
                  const r = destRow + dr;
                  const c = destCol + dc;
                  if (r >= freshRowIds.length || c >= freshColIds.length) continue;
                  const val = finalRows[dr][dc];
                  const stored = val.startsWith('=')
                    ? a1ToInternal(val, r, c, freshRowIds, freshColIds)
                    : val;
                  setCell(ms.cells, `${freshRowIds[r]}:${freshColIds[c]}`, stored);
                }
              }
            });

            setClipboardSource(null);

            const pasteMaxRow = Math.min(destRow + rows.length - 1, sortedRowIds.length - 1);
            const pasteMaxCol = Math.min(destCol + (rows[0]?.length || 1) - 1, sortedColIds.length - 1);
            setSelectionAnchor([destCol, destRow]);
            setSelectedCell([pasteMaxCol, pasteMaxRow]);
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
        const { doc, selectedCell, selectionAnchor, sortedRowIds, sortedColIds, currentSheetId } = ctx;
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
          ctx.mutate((d) => {
            const cells = d.sheets[currentSheetId].cells;
            for (let r = range.minRow; r <= range.maxRow; r++) {
              for (let c = range.minCol; c <= range.maxCol; c++) {
                if (r < sortedRowIds.length && c < sortedColIds.length) {
                  delete cells[`${sortedRowIds[r]}:${sortedColIds[c]}`];
                }
              }
            }
          });
        } else {
          if (col >= sortedColIds.length || row >= sortedRowIds.length) return;
          const cellKey = `${sortedRowIds[row]}:${sortedColIds[col]}`;
          ctx.mutate((d) => {
            const cells = d.sheets[currentSheetId].cells;
            if (getCell(cells, cellKey)) delete cells[cellKey];
          });
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
        const { doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = rowIndices(s);
        const entries = sortedEntries(sh.rows);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        const minIdx = Math.min(...indices);
        const hi = entries[minIdx][1].index;
        const lo = minIdx === 0 ? hi - count : entries[minIdx - 1][1].index;
        ctx.mutate((d) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.rows[shortId()] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1) };
          }
        });
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
        const { doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = rowIndices(s);
        const entries = sortedEntries(sh.rows);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        const maxIdx = Math.max(...indices);
        const lo = entries[maxIdx][1].index;
        const hi = maxIdx >= entries.length - 1 ? lo + count : entries[maxIdx + 1][1].index;
        ctx.mutate((d) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.rows[shortId()] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1) };
          }
        });
        setContextMenu(null);
      },
    },
    {
      id: 'move-rows-up',
      defaultLabel: 'Move up',
      isEnabled: s => s.currentRowIndices.length > 0,
      execute: (_, ctx) => {
        const { doc, selectedRows, setSelectedRows, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.rows);
        const indices = [...selectedRows].sort((a, b) => a - b);
        if (indices.length === 0 || indices[0] === 0) return;
        const aboveIdx = indices[0] - 1;
        const aboveId = entries[aboveIdx][0];
        const lastIdx = indices[indices.length - 1];
        const newIndex = lastIdx >= entries.length - 1
          ? entries[lastIdx][1].index + 1
          : (entries[lastIdx][1].index + entries[lastIdx + 1][1].index) / 2;
        ctx.mutate((d) => { d.sheets[currentSheetId].rows[aboveId].index = newIndex; });
        setSelectedRows(new Set(indices.map(i => i - 1)));
        setContextMenu(null);
      },
    },
    {
      id: 'move-rows-down',
      defaultLabel: 'Move down',
      isEnabled: s => s.currentRowIndices.length > 0,
      execute: (_, ctx) => {
        const { doc, selectedRows, setSelectedRows, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.rows);
        const indices = [...selectedRows].sort((a, b) => a - b);
        if (indices.length === 0 || indices[indices.length - 1] >= entries.length - 1) return;
        const belowIdx = indices[indices.length - 1] + 1;
        const belowId = entries[belowIdx][0];
        const firstIdx = indices[0];
        const newIndex = firstIdx === 0
          ? entries[0][1].index - 1
          : (entries[firstIdx - 1][1].index + entries[firstIdx][1].index) / 2;
        ctx.mutate((d) => { d.sheets[currentSheetId].rows[belowId].index = newIndex; });
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
        const { doc, setSelectedRows, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = rowIndices(s);
        const rowEntries = sortedEntries(sh.rows);
        const idsToDelete = indices.filter(i => i < rowEntries.length).map(i => rowEntries[i][0]);
        if (idsToDelete.length === 0) return;
        const deletedSet = new Set(idsToDelete);
        const sortedRowIds = rowEntries.map(([id]) => id);
        const sortedColIds = sortedEntries(sh.columns).map(([id]) => id);
        const rewrites = updateFormulasForDeletion(sh.cells, deletedSet, new Set(), sortedRowIds, sortedColIds);
        ctx.mutate((d) => {
          const ms = d.sheets[currentSheetId];
          for (const [key, newVal] of Object.entries(rewrites)) {
            const cell = getCell(ms.cells, key);
            if (cell && cell.value !== newVal) cell.value = newVal;
          }
          for (const id of idsToDelete) {
            delete ms.rows[id];
            for (const key of Object.keys(ms.cells)) {
              if (key.startsWith(`${id}:`)) delete ms.cells[key];
            }
          }
        });
        setSelectedRows(new Set());
        setContextMenu(null);
      },
    },
  ],
  slots: {
    'insert-menu': [
      { kind: 'command', id: 'insert-row-above' },
      { kind: 'command', id: 'insert-row-below' },
    ],
    toolbar: [
      { kind: 'command', id: 'insert-row-above', toolbarDividerBefore: true, label: 'Insert row above' },
      { kind: 'command', id: 'insert-row-below', label: 'Insert row below' },
    ],
    'row-ctx': [
      { kind: 'command', id: 'insert-row-above' },
      { kind: 'command', id: 'insert-row-below' },
      { kind: 'separator' },
      { kind: 'command', id: 'move-rows-up' },
      { kind: 'command', id: 'move-rows-down' },
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
        const { doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = colIndices(s);
        const entries = sortedEntries(sh.columns);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        const minIdx = Math.min(...indices);
        const hi = entries[minIdx][1].index;
        const lo = minIdx === 0 ? hi - count : entries[minIdx - 1][1].index;
        ctx.mutate((d) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.columns[shortId()] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1), name: '' };
          }
        });
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
        const { doc, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = colIndices(s);
        const entries = sortedEntries(sh.columns);
        if (entries.length === 0) return;
        const count = Math.max(indices.length, 1);
        const maxIdx = Math.max(...indices);
        const lo = entries[maxIdx][1].index;
        const hi = maxIdx >= entries.length - 1 ? lo + count : entries[maxIdx + 1][1].index;
        ctx.mutate((d) => {
          const ms = d.sheets[currentSheetId];
          for (let i = 0; i < count; i++) {
            ms.columns[shortId()] = { index: lo + ((hi - lo) * (i + 1)) / (count + 1), name: '' };
          }
        });
        setContextMenu(null);
      },
    },
    {
      id: 'move-cols-left',
      defaultLabel: 'Move left',
      isEnabled: s => s.currentColIndices.length > 0,
      execute: (_, ctx) => {
        const { doc, selectedCols, setSelectedCols, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.columns);
        const indices = [...selectedCols].sort((a, b) => a - b);
        if (indices.length === 0 || indices[0] === 0) return;
        const leftIdx = indices[0] - 1;
        const leftId = entries[leftIdx][0];
        const lastIdx = indices[indices.length - 1];
        const newIndex = lastIdx >= entries.length - 1
          ? entries[lastIdx][1].index + 1
          : (entries[lastIdx][1].index + entries[lastIdx + 1][1].index) / 2;
        ctx.mutate((d) => { d.sheets[currentSheetId].columns[leftId].index = newIndex; });
        setSelectedCols(new Set(indices.map(i => i - 1)));
        setContextMenu(null);
      },
    },
    {
      id: 'move-cols-right',
      defaultLabel: 'Move right',
      isEnabled: s => s.currentColIndices.length > 0,
      execute: (_, ctx) => {
        const { doc, selectedCols, setSelectedCols, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const entries = sortedEntries(sh.columns);
        const indices = [...selectedCols].sort((a, b) => a - b);
        if (indices.length === 0 || indices[indices.length - 1] >= entries.length - 1) return;
        const rightIdx = indices[indices.length - 1] + 1;
        const rightId = entries[rightIdx][0];
        const firstIdx = indices[0];
        const newIndex = firstIdx === 0
          ? entries[0][1].index - 1
          : (entries[firstIdx - 1][1].index + entries[firstIdx][1].index) / 2;
        ctx.mutate((d) => { d.sheets[currentSheetId].columns[rightId].index = newIndex; });
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
        const { doc, setSelectedCols, setContextMenu, currentSheetId } = ctx;
        if (!doc) return;
        const sh = ctxSheet(doc, ctx);
        const indices = colIndices(s);
        const colEntries = sortedEntries(sh.columns);
        const idsToDelete = indices.filter(i => i < colEntries.length).map(i => colEntries[i][0]);
        if (idsToDelete.length === 0) return;
        const deletedSet = new Set(idsToDelete);
        const sortedRowIds = sortedEntries(sh.rows).map(([id]) => id);
        const sortedColIds = colEntries.map(([id]) => id);
        const rewrites = updateFormulasForDeletion(sh.cells, new Set(), deletedSet, sortedRowIds, sortedColIds);
        ctx.mutate((d) => {
          const ms = d.sheets[currentSheetId];
          for (const [key, newVal] of Object.entries(rewrites)) {
            const cell = getCell(ms.cells, key);
            if (cell && cell.value !== newVal) cell.value = newVal;
          }
          for (const id of idsToDelete) {
            delete ms.columns[id];
            for (const key of Object.keys(ms.cells)) {
              if (key.endsWith(`:${id}`)) delete ms.cells[key];
            }
          }
        });
        setSelectedCols(new Set());
        setContextMenu(null);
      },
    },
  ],
  slots: {
    'insert-menu': [
      { kind: 'separator' },
      { kind: 'command', id: 'insert-col-left' },
      { kind: 'command', id: 'insert-col-right' },
    ],
    toolbar: [
      { kind: 'command', id: 'insert-col-left', label: 'Insert Column Left' },
      { kind: 'command', id: 'insert-col-right', label: 'Insert Column Right' },
    ],
    'col-ctx': [
      { kind: 'command', id: 'insert-col-left' },
      { kind: 'command', id: 'insert-col-right' },
      { kind: 'separator' },
      { kind: 'command', id: 'move-cols-left' },
      { kind: 'command', id: 'move-cols-right' },
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
        const { doc, mutate } = ctx;
        if (!doc) return;
        const maxIndex = Object.values(doc.sheets).reduce((max, s) => Math.max(max, s.index), 0);
        const sheetCount = Object.keys(doc.sheets).length;
        const sid = shortId();
        mutate((d) => {
          const cols: Record<string, { index: number; name: string }> = {};
          for (let i = 0; i < 3; i++) cols[shortId()] = { index: i + 1, name: '' };
          const rows: Record<string, { index: number }> = {};
          for (let i = 0; i < 10; i++) rows[shortId()] = { index: i + 1 };
          d.sheets[sid] = { name: `Sheet ${sheetCount + 1}`, index: maxIndex + 1, columns: cols, rows, cells: {} } as any;
        });
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

const ALL_PLUGINS: GridPlugin[] = [historyPlugin, clipboardPlugin, rowPlugin, columnPlugin, sheetPlugin];

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
  const { doc, mutate, setSelectedRows, setSelectedCols, currentSheetId } = ctx;
  if (!doc) return;
  const sh = ctxSheet(doc, ctx);

  const entries = type === 'row' ? sortedEntries(sh.rows) : sortedEntries(sh.columns);
  const sorted = [...draggedIndices].sort((a, b) => a - b);

  // No-op: drop is within the dragged range
  if (sorted.every(i => dropIndex > i) === false && sorted.every(i => dropIndex <= i) === false) {
    if (dropIndex > sorted[0] && dropIndex <= sorted[sorted.length - 1] + 1) return;
  }

  const remaining = entries.filter((_, i) => !sorted.includes(i));
  let adjustedDrop = dropIndex;
  for (const di of sorted) {
    if (di < dropIndex) adjustedDrop--;
  }
  adjustedDrop = Math.max(0, Math.min(adjustedDrop, remaining.length));

  if (remaining.length === 0) return;

  let prevIndex: number, nextIndex: number;
  if (adjustedDrop === 0) {
    nextIndex = remaining[0][1].index;
    prevIndex = nextIndex - sorted.length - 1;
  } else if (adjustedDrop >= remaining.length) {
    prevIndex = remaining[remaining.length - 1][1].index;
    nextIndex = prevIndex + sorted.length + 1;
  } else {
    prevIndex = remaining[adjustedDrop - 1][1].index;
    nextIndex = remaining[adjustedDrop][1].index;
  }

  const gap = nextIndex - prevIndex;
  const step = gap / (sorted.length + 1);
  const ids = sorted.map(i => entries[i][0]);

  mutate((d) => {
    const ms = d.sheets[currentSheetId];
    const map = type === 'row' ? ms.rows : ms.columns;
    for (let i = 0; i < ids.length; i++) {
      map[ids[i]].index = prevIndex + step * (i + 1);
    }
  });

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
  const { doc, mutate, setSelectionAnchor, setSelectedCell, currentSheetId } = ctx;
  if (!doc) return;
  const sh = ctxSheet(doc, ctx);

  const freshRowIds = sortedEntries(sh.rows).map(([id]) => id);
  const freshColIds = sortedEntries(sh.columns).map(([id]) => id);

  const isVertical = fillRange.minCol === sourceRange.minCol && fillRange.maxCol === sourceRange.maxCol;
  const axis: 'row' | 'col' = isVertical ? 'row' : 'col';
  const direction: 'forward' | 'backward' = isVertical
    ? (fillRange.minRow > sourceRange.maxRow ? 'forward' : 'backward')
    : (fillRange.minCol > sourceRange.maxCol ? 'forward' : 'backward');

  const strips = getAutofillSourceValues(sh.cells, freshRowIds, freshColIds, sourceRange, axis);
  const fillCount = isVertical
    ? (fillRange.maxRow - fillRange.minRow + 1)
    : (fillRange.maxCol - fillRange.minCol + 1);

  // Convert source formulas to R1C1 (position-independent offsets) before cycling
  const r1c1Strips = strips.map((strip, stripIdx) =>
    strip.map((val, srcIdx) => {
      if (!val.startsWith('=')) return val;
      let srcRow: number, srcCol: number;
      if (isVertical) {
        srcRow = sourceRange.minRow + srcIdx;
        srcCol = sourceRange.minCol + stripIdx;
      } else {
        srcRow = sourceRange.minRow + stripIdx;
        srcCol = sourceRange.minCol + srcIdx;
      }
      return internalToR1C1(val, srcRow, srcCol, freshRowIds, freshColIds);
    })
  );

  mutate((d) => {
    const ms = d.sheets[currentSheetId];
    r1c1Strips.forEach((strip, stripIdx) => {
      const filled = generateAutofillValues(strip, fillCount, direction);
      filled.forEach((val, fillIdx) => {
        let r: number, c: number;
        if (isVertical) {
          r = fillRange.minRow + fillIdx;
          c = sourceRange.minCol + stripIdx;
        } else {
          r = sourceRange.minRow + stripIdx;
          c = fillRange.minCol + fillIdx;
        }
        if (r >= freshRowIds.length || c >= freshColIds.length) return;
        const stored = val.startsWith('=')
          ? a1ToInternal(val, r, c, freshRowIds, freshColIds)
          : val;
        setCell(ms.cells, `${freshRowIds[r]}:${freshColIds[c]}`, stored);
      });
    });
  });

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
    const isEnabled = cmd.isEnabled(state);
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
  ];

  function dispatchKey(e: KeyboardEvent, isMod: boolean): boolean {
    for (const cmd of KEY_COMMANDS) {
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

  return { toolbar, menus, cellCtx, rowCtx, colCtx, sheetCtx, dispatchKey };
}
