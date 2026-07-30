import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { subscribeQuery, updateDoc, getWorkerPeerId, getWorkerUserGroupId } from '../../worker-api';
import { peerColor, usePresence } from '../../common/presence';
import { DocumentTitleBar } from '../../common/DocumentTitleBar';
import { peerDisplayName, type PeerFieldInfo } from '../../common/presence';
import { useGridCommands, commitReorder, commitAutofill, applyFormatToSelection, PASTE_FALLBACK_MS, type GridCommandState, type GridCommandContext } from './commands';
import { CommandContextMenuContent } from './CommandBar';
import { FocusTopBar } from './FocusTopBar';
import { ConditionalFormatSheet } from './ConditionalFormatSheet';
import { FormatSheet } from './FormatSheet';
import { ColorSheet, type ColorTarget } from './ColorSheet';
import { PickerSheet } from '@/common/PickerSheet';
import { NUMBER_FORMAT_OPTIONS, FONT_FAMILY_OPTIONS } from './format-presets';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import {
  sortedEntries, colIndexToLetter, shortId,
  a1ToInternal, internalToA1,
  getDisplayValue,
} from './helpers';
import { type FormulaEditorApi, type FormulaHighlight, isRange } from './FormulaEditor';
import { BottomEditorBar, type AggregateChip } from './BottomEditorBar';
import { FormulaInsertSheet } from './FormulaInsertSheet';
import { computeSelectionAggregates } from './aggregates';
import { pointToCell, buildRowOffsets, rowAtOffset } from './grid-geometry';
import { useHideOnScroll } from '../../common/useHideOnScroll';
import { buildFormatCache, buildIndexMaps, formatToCss, formatDisplayValue, isAccountingFormat, resolveConditionalFormat } from './formatting';
import type { DataGridCellFormat } from '../../../../shared/schemas/datagrid';
import { SheetTabsBar } from './SheetTabsBar';
import { SheetListSheet } from './SheetListSheet';
import { SheetOptionsSheet } from './SheetOptionsSheet';
import { applyFreezeCount, effectiveFrozenCount, applyItemSize } from './sheet-actions';
import { HeaderContextMenu, type HeaderMenuPage } from './HeaderContextMenu';
import { ResizeSheet } from './ResizeSheet';
import { useUndoRedo } from '../../common/useUndoRedo';
import { useDocumentHistory } from '../../common/useDocumentHistory';
import { useCanEdit } from '../../common/useCanEdit';
import { pushDocHash } from '../../common/doc-urls';
import { useFocusPathSync } from '../../common/useFocusPathSync';
import { HistorySlider } from '../../common/HistorySlider';
import { useDocumentValidation } from '../../common/useDocumentValidation';
import { DocLoader } from '../../common/useDocument';
import { createHfBridge, type HfBridge, type MCResults, type CondFormatResults } from './hf-bridge';
import { sendHfPort } from '../../worker-api';
import { DistributionPanel } from './DistributionPanel';
import { formatDistValue } from './helpers';
import './datagrid.css';

// Lightweight metadata query — returns doc name and each sheet's name/index/hidden plus row/col ordering (no cell data)
const META_QUERY = '{ "@type": .["@type"], name: (.name // "Spreadsheet"), sheets: (.sheets | to_entries | map({ key: .key, value: { name: .value.name, index: .value.index, hidden: .value.hidden, rows: (.value.rows | to_entries | sort_by(.value.index) | map(.key)), cols: (.value.columns | to_entries | sort_by(.value.index) | map(.key)) } }) | from_entries) }';

// Active sheet query template — returns the full sheet object for the current sheet
function sheetQuery(sheetId: string): string {
  return `.sheets["${sheetId}"]`;
}

// Custom function names from hf-functions.ts (for autocomplete).
// HyperFormula built-in names are loaded lazily to avoid importing HF on the main thread.
const CUSTOM_FN_NAMES = [
  'BERNOULLI', 'BETA', 'BINOMIAL', 'CAUCHY', 'CONCAT', 'EXPONENTIAL',
  'GAMMA', 'LOGNORMAL', 'NORMAL', 'PERT', 'POISSON', 'SORT',
  'TRIANGULAR', 'UNIFORM', 'UNIQUE', 'WEIBULL',
];

export function DataGrid({ docId, sheetId, readOnly }: { docId?: string; sheetId?: string; readOnly?: boolean; path?: string }) {
  // Read initial sheet from URL — prefer router-provided sheetId, fall back to parsing hash
  const initialSheetId = sheetId
    || (docId ? window.location.hash.match(/\/sheets\/([^/?#]+)/)?.[1] : undefined);
  const [gridName, setGridName] = useState('Spreadsheet');
  const [, setTick] = useState(0);
  const [selectedCell, setSelectedCell] = useState<[number, number] | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<[number, number] | null>(null);
  const [editingCell, setEditingCell] = useState<[number, number] | null>(null);
  const [editValue, setEditValue] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selectedCols, setSelectedCols] = useState<Set<number>>(new Set());
  // Mirrors of the header selections, so the (identity-stable) context-menu and
  // long-press handlers always see the current selection.
  const selectedRowsRef = useRef(selectedRows);
  selectedRowsRef.current = selectedRows;
  const selectedColsRef = useRef(selectedCols);
  selectedColsRef.current = selectedCols;
  const [contextMenu, setContextMenu] = useState<{
    type: 'row' | 'col' | 'cell';
    indices: number[];
  } | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    type: 'row' | 'col';
    index: number;
  } | null>(null);
  const [resizingCol, setResizingCol] = useState<{ index: number; width: number } | null>(null);
  const [formulaRefHighlights, setFormulaRefHighlights] = useState<FormulaHighlight[]>([]);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  // Measured height of the sticky <thead>. Frozen rows stick *below* it, so
  // assuming ROW_HEIGHT here (the header is shorter) pushed the pinned rows
  // down over their neighbours and let unfrozen rows scroll up behind them.
  const [headerHeight, setHeaderHeight] = useState(20);
  const ROW_HEIGHT = 28;
  const OVERSCAN = 15;
  const [rawDoc, setRawDoc] = useState<any>(null);
  // Lightweight metadata: doc name + per-sheet { name, index, hidden }
  const docMetaRef = useRef<{ '@type': string; name: string; sheets: Record<string, { name: string; index: number; hidden?: boolean; rows?: string[]; cols?: string[] }> } | null>(null);
  // Full data for the currently active sheet only
  const activeSheetRef = useRef<any>(null);
  const { peers, peerList, broadcast } = usePresence(docId);
  const validationErrors = useDocumentValidation(docId);
  const { undo, redo, canUndo, canRedo, onHeadsUpdate } = useUndoRedo(docId!);
  const history = useDocumentHistory(docId!);
  const { canEdit, canEditRef, noAccess } = useCanEdit(docId, readOnly, history);
  const hfBridgeRef = useRef<HfBridge | null>(null);
  const computedValuesRef = useRef<Map<string, string | number>>(new Map());
  const errorMessagesRef = useRef<Map<string, string>>(new Map());
  const spillTargetsRef = useRef<Set<string>>(new Set());
  const activeSheetUnsubRef = useRef<(() => void) | null>(null);
  const [syncing, setSyncing] = useState(false);
  const editFromBarRef = useRef(false);
  /** Imperative handle on the bottom-bar CodeMirror editor. */
  const formulaApiRef = useRef<FormulaEditorApi | null>(null);
  /** Set when an edit starts from the grid (typing/Enter/dbl-click) so the
   * post-render effect focuses the bottom editor after the value synced. */
  const pendingEditorFocusRef = useRef(false);
  const [formulaInsertOpen, setFormulaInsertOpen] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const lastClickedRowRef = useRef<number | null>(null);
  const lastClickedColRef = useRef<number | null>(null);
  const dragRef = useRef<{ type: 'row' | 'col'; indices: number[] } | null>(null);
  const justDraggedRef = useRef(false);
  const cellDragRef = useRef<{ anchor: [number, number] } | null>(null);
  /** Touch drag that started inside the selection — resizes it (see the
   * touch-action CSS on .selected/.in-range cells). */
  const touchSelRef = useRef<{ pointerId: number; startX: number; startY: number; startCell: [number, number]; active: boolean } | null>(null);
  const autofillDragRef = useRef<{ sourceRange: { minCol: number; maxCol: number; minRow: number; maxRow: number } } | null>(null);
  const dispatchKeyRef = useRef<((e: KeyboardEvent, isMod: boolean) => boolean) | null>(null);
  /** Pending Ctrl+V fallback, cancelled by a real paste event (see below). */
  const pasteFallbackTimerRef = useRef<number | null>(null);
  const commandCtxRef = useRef<GridCommandContext | null>(null);
  const executePasteRef = useRef<((e?: ClipboardEvent) => void) | null>(null);

  // Ctrl/Cmd+V fallback, for the browsers and focus states where no native paste
  // event is ever dispatched (Firefox fires no clipboard event at a non-editable
  // element). Deferred, so the native event — which arrives just after keydown —
  // gets first refusal and cancels this; only if none shows up do we paste from
  // the async Clipboard API, which may prompt for clipboard-read permission.
  const handlePasteShortcut = useCallback(() => {
    if (pasteFallbackTimerRef.current !== null) clearTimeout(pasteFallbackTimerRef.current);
    pasteFallbackTimerRef.current = window.setTimeout(() => {
      pasteFallbackTimerRef.current = null;
      executePasteRef.current?.();
    }, PASTE_FALLBACK_MS);
  }, []);

  const [autofillTarget, setAutofillTarget] = useState<{ minCol: number; maxCol: number; minRow: number; maxRow: number } | null>(null);
  const [clipboardSource, setClipboardSource] = useState<{ minRow: number; maxRow: number; minCol: number; maxCol: number } | null>(null);
  const [condFormatOpen, setCondFormatOpen] = useState(false);
  const [sheetListOpen, setSheetListOpen] = useState(false);
  const [sheetOptionsOpen, setSheetOptionsOpen] = useState(false);
  const [formatSheetOpen, setFormatSheetOpen] = useState(false);
  const [numFmtOpen, setNumFmtOpen] = useState(false);
  const [fontFamilyOpen, setFontFamilyOpen] = useState(false);
  /** Which colour the colour-only sheet is editing (null = closed). */
  const [colorTarget, setColorTarget] = useState<ColorTarget | null>(null);
  /** Anchored row/column header menu (long-press or right-click). */
  const [headerMenu, setHeaderMenu] = useState<{ kind: 'row' | 'col'; anchor: HTMLElement; page: HeaderMenuPage } | null>(null);
  const [resizeKind, setResizeKind] = useState<'row' | 'col' | null>(null);
  const longPressRef = useRef<{ timer: number; startX: number; startY: number } | null>(null);
  const clipboardRef = useRef<{
    values: string[][];
    formats: (DataGridCellFormat | undefined)[][];
    mode: 'copy' | 'cut';
    range: { minRow: number; maxRow: number; minCol: number; maxCol: number };
  } | null>(null);

  const [mcResults, setMcResults] = useState<MCResults | null>(null);
  const condFormatResultsRef = useRef<CondFormatResults | null>(null);

  const [currentSheetId, setCurrentSheetId] = useState<string | null>(null);

  // Memoize sorted IDs from the active sheet
  const meta = docMetaRef.current;
  const currentSheet = activeSheetRef.current;
  // Fall back to first sheet if currentSheetId doesn't exist in metadata
  const effectiveSheetId = meta?.sheets && currentSheetId && !meta.sheets[currentSheetId]
    ? Object.keys(meta.sheets)[0] ?? currentSheetId
    : currentSheetId;

  const sortedColIds = useMemo(() => {
    if (!currentSheet?.columns) return [];
    return sortedEntries(currentSheet.columns).map(([id]: [string, any]) => id);
  }, [currentSheet?.columns]);

  const sortedRowIds = useMemo(() => {
    if (!currentSheet?.rows) return [];
    return sortedEntries(currentSheet.rows).map(([id]: [string, any]) => id);
  }, [currentSheet?.rows]);

  // Visible (non-hidden) row/col IDs — used for rendering and selection
  const visibleColIds = useMemo(() => {
    if (!currentSheet?.columns) return [];
    return sortedColIds.filter(id => !currentSheet.columns[id]?.hidden);
  }, [currentSheet?.columns, sortedColIds]);

  const visibleRowIds = useMemo(() => {
    if (!currentSheet?.rows) return [];
    return sortedRowIds.filter(id => !currentSheet.rows[id]?.hidden);
  }, [currentSheet?.rows, sortedRowIds]);

  // Mirrors for the identity-stable header menu / long-press handlers.
  const visibleColIdsRef = useRef(visibleColIds);
  visibleColIdsRef.current = visibleColIds;
  const visibleRowIdsRef = useRef(visibleRowIds);
  visibleRowIdsRef.current = visibleRowIds;

  // Maps visible index → original (full sorted) index for label computation
  const visibleColOriginalIndices = useMemo(() => {
    return visibleColIds.map(id => sortedColIds.indexOf(id));
  }, [visibleColIds, sortedColIds]);

  const visibleRowOriginalIndices = useMemo(() => {
    return visibleRowIds.map(id => sortedRowIds.indexOf(id));
  }, [visibleRowIds, sortedRowIds]);

  // Hidden-gap indicators: detect where hidden rows/cols exist between visible ones
  const colHiddenGaps = useMemo(() => {
    const gaps: Array<{ beforeVisualIndex: number; hiddenIds: string[] }> = [];
    for (let ci = 0; ci <= visibleColIds.length; ci++) {
      const prevOrig = ci === 0 ? -1 : visibleColOriginalIndices[ci - 1];
      const nextOrig = ci < visibleColIds.length ? visibleColOriginalIndices[ci] : sortedColIds.length;
      if (nextOrig - prevOrig > 1) {
        const hiddenIds: string[] = [];
        for (let o = prevOrig + 1; o < nextOrig; o++) hiddenIds.push(sortedColIds[o]);
        gaps.push({ beforeVisualIndex: ci, hiddenIds });
      }
    }
    return gaps;
  }, [visibleColIds, visibleColOriginalIndices, sortedColIds]);

  const rowHiddenGaps = useMemo(() => {
    const gaps: Array<{ beforeVisualIndex: number; hiddenIds: string[] }> = [];
    for (let ri = 0; ri <= visibleRowIds.length; ri++) {
      const prevOrig = ri === 0 ? -1 : visibleRowOriginalIndices[ri - 1];
      const nextOrig = ri < visibleRowIds.length ? visibleRowOriginalIndices[ri] : sortedRowIds.length;
      if (nextOrig - prevOrig > 1) {
        const hiddenIds: string[] = [];
        for (let o = prevOrig + 1; o < nextOrig; o++) hiddenIds.push(sortedRowIds[o]);
        gaps.push({ beforeVisualIndex: ri, hiddenIds });
      }
    }
    return gaps;
  }, [visibleRowIds, visibleRowOriginalIndices, sortedRowIds]);

  // Frozen row/col counts — a number on the sheet, clamped to what exists.
  const frozenColCount = useMemo(
    () => effectiveFrozenCount(currentSheet?.frozenCols, visibleColIds),
    [currentSheet?.frozenCols, visibleColIds],
  );

  const frozenRowCount = useMemo(
    () => effectiveFrozenCount(currentSheet?.frozenRows, visibleRowIds),
    [currentSheet?.frozenRows, visibleRowIds],
  );

  const formatCache = useMemo(() => {
    return buildFormatCache(currentSheet?.formats, sortedRowIds, sortedColIds);
  }, [currentSheet?.formats, sortedRowIds, sortedColIds]);

  // Precompute id → index maps once per render for conditional-format resolution
  // (avoids O(rules × ranges × rows) indexOf scans per cell).
  const { rowIdxMap: cfRowIdxMap, colIdxMap: cfColIdxMap } = useMemo(
    () => buildIndexMaps(sortedRowIds, sortedColIds),
    [sortedRowIds, sortedColIds],
  );

  const columnDefs = useMemo(() => {
    if (!currentSheet?.columns) return [];
    return sortedEntries(currentSheet.columns)
      .filter(([, col]: [string, any]) => !col.hidden)
      .map(([id, col]: [string, any]) => ({ id, ...col }));
  }, [currentSheet?.columns]);

  // Cumulative offsets for frozen columns (for CSS sticky left values)
  const frozenColOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 48; // row header width
    for (let i = 0; i < frozenColCount; i++) {
      offsets.push(acc);
      acc += columnDefs[i]?.width || 100;
    }
    return offsets;
  }, [frozenColCount, columnDefs]);

  // Rows can carry individual heights, so scroll/virtualization math runs off
  // cumulative offsets instead of a constant row height.
  const rowHeights = useMemo(
    () => visibleRowIds.map(id => currentSheet?.rows?.[id]?.height || ROW_HEIGHT),
    [visibleRowIds, currentSheet?.rows],
  );
  const rowOffsets = useMemo(() => buildRowOffsets(rowHeights), [rowHeights]);

  const frozenRowOffsets = useMemo(() => {
    const offsets: number[] = [];
    for (let i = 0; i < frozenRowCount; i++) offsets.push(headerHeight + rowOffsets[i]);
    return offsets;
  }, [frozenRowCount, headerHeight, rowOffsets]);

  // Sheet ordering for tabs — derived from lightweight metadata
  const sheetOrder = useMemo(() => {
    if (!meta?.sheets) return [];
    return sortedEntries(meta.sheets).map(([id, s]: [string, any]) => ({ id, name: s.name, hidden: s.hidden }));
  }, [meta?.sheets]);
  const visibleSheetIds = useMemo(() => sheetOrder.filter(s => !s.hidden).map(s => s.id), [sheetOrder]);

  const sheetNameLookup = useCallback((sheetId: string) => {
    return meta?.sheets?.[sheetId]?.name;
  }, [meta?.sheets]);

  const sheetIdLookup = useCallback((name: string) => {
    if (!meta?.sheets) return undefined;
    const lower = name.toLowerCase();
    for (const [id, s] of Object.entries(meta.sheets)) {
      if (s.name.toLowerCase() === lower) return id;
    }
    return undefined;
  }, [meta?.sheets]);

  // Provides row/col ordering for any sheet using metadata (for cross-sheet ref display)
  const sheetRowColLookup = useCallback((sheetId: string) => {
    const sheet = meta?.sheets?.[sheetId];
    if (!sheet) return undefined;
    // For the active sheet, use the full currentSheet data (most up-to-date)
    if (sheetId === effectiveSheetId && currentSheet) {
      return {
        rowIds: sortedEntries(currentSheet.rows).map(([rid]: [string, any]) => rid),
        colIds: sortedEntries(currentSheet.columns).map(([cid]: [string, any]) => cid),
      };
    }
    // For other sheets, use row/col ordering from metadata
    if (sheet.rows && sheet.cols) {
      return { rowIds: sheet.rows, colIds: sheet.cols };
    }
    return undefined;
  }, [meta?.sheets, effectiveSheetId, currentSheet]);

  // Single gateway for all document mutations.
  // HF worker is notified of changes via its automerge subscription — no explicit sync needed.
  const mutate = useCallback((fn: (d: any, ...args: any[]) => void, args: unknown[]) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, fn, ...args);
    setTick(t => t + 1);
  }, [docId]);

  // Write a cell value to the Automerge doc and send to HF worker for immediate evaluation.
  const commitCellValue = useCallback((col: number, row: number, value: string) => {
    if (!canEditRef.current || !docId) return;
    if (col >= visibleColIds.length || row >= visibleRowIds.length || !currentSheetId) return;
    const rowId = visibleRowIds[row];
    const colId = visibleColIds[col];
    const cellKey = `${rowId}:${colId}`;
    const sid = currentSheetId;
    // A1 conversion uses original position in full sorted list
    const origRow = sortedRowIds.indexOf(rowId);
    const origCol = sortedColIds.indexOf(colId);
    const stored = value.startsWith('=')
      ? a1ToInternal(value, origRow, origCol, sortedRowIds, sortedColIds, sheetIdLookup, sheetRowColLookup)
      : value;
    updateDoc(docId, (d, sid, cellKey, stored) => {
      const existing = d.sheets[sid].cells[cellKey];
      if (stored === '') { if (existing) delete d.sheets[sid].cells[cellKey]; }
      else if (!existing) { d.sheets[sid].cells[cellKey] = { value: stored }; }
      else if (existing.value !== stored) { existing.value = stored; }
    }, sid, cellKey, stored);
    // Send to HF worker for immediate formula re-evaluation
    hfBridgeRef.current?.setCellContents(sid, rowId, colId, stored);
    setTick(t => t + 1);
  }, [visibleColIds, visibleRowIds, sortedColIds, sortedRowIds, currentSheetId, sheetIdLookup, sheetRowColLookup, docId]);

  // Start editing a cell
  const startEditing = useCallback((col: number, row: number) => {
    if (!canEditRef.current) return;
    const sh = activeSheetRef.current;
    if (!sh || !currentSheetId) return;
    const rowId = visibleRowIds[row];
    const colId = visibleColIds[col];
    if (spillTargetsRef.current.has(`${currentSheetId}:${rowId}:${colId}`)) return;
    const raw = sh.cells[`${rowId}:${colId}`]?.value || '';
    // A1 display uses original position in full sorted list
    const origRow = sortedRowIds.indexOf(rowId);
    const origCol = sortedColIds.indexOf(colId);
    const display = raw.startsWith('=') ? internalToA1(raw, origRow, origCol, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup) : raw;
    setEditingCell([col, row]);
    setEditValue(display);
  }, [visibleColIds, visibleRowIds, sortedColIds, sortedRowIds, currentSheetId, sheetNameLookup, sheetRowColLookup]);

  // Commit editing
  const commitEdit = useCallback(() => {
    editFromBarRef.current = false;
    if (editCancelledRef.current) { editCancelledRef.current = false; return; }
    if (!editingCell) return;
    const [col, row] = editingCell;
    commitCellValue(col, row, editValue);
    setEditingCell(null);
  }, [editingCell, editValue, commitCellValue]);

  // Cancel editing — set a ref flag so the blur handler's stale closure
  // doesn't race and call commitEdit after the cancel.
  const editCancelledRef = useRef(false);
  const cancelEdit = useCallback(() => {
    editFromBarRef.current = false;
    editCancelledRef.current = true;
    setEditingCell(null);
  }, []);

  const selectCell = useCallback((col: number, row: number) => {
    setSelectedCell([col, row]);
    setSelectionAnchor(null);
    setSelectedRows(new Set());
    setSelectedCols(new Set());
    tableRef.current?.focus();
  }, []);

  const scrollCellIntoView = useCallback((col: number, row: number) => {
    const el = tableRef.current;
    if (!el) return;

    // Vertical: account for sticky header + frozen rows
    const stickyTop = headerHeight + rowOffsets[frozenRowCount];

    const cellTop = rowOffsets[row] ?? 0;
    const cellBottom = rowOffsets[row + 1] ?? cellTop + ROW_HEIGHT;
    const visibleTop = el.scrollTop + stickyTop;
    const visibleBottom = el.scrollTop + el.clientHeight;

    if (cellTop < visibleTop) {
      el.scrollTop = Math.max(0, cellTop - stickyTop);
    } else if (cellBottom > visibleBottom) {
      el.scrollTop = cellBottom - el.clientHeight;
    }

    // Horizontal: account for sticky row header + frozen columns
    const ROW_HEADER_WIDTH = 48;
    const frozenColsWidth = frozenColOffsets.length > 0
      ? frozenColOffsets[frozenColOffsets.length - 1] - ROW_HEADER_WIDTH + ((columnDefs[frozenColCount - 1]?.width as number) || 100)
      : 0;
    const stickyLeft = ROW_HEADER_WIDTH + frozenColsWidth;

    let cellLeft = ROW_HEADER_WIDTH;
    for (let i = 0; i < col; i++) {
      cellLeft += (columnDefs[i]?.width as number) || 100;
    }
    const cellRight = cellLeft + ((columnDefs[col]?.width as number) || 100);
    const visibleLeft = el.scrollLeft + stickyLeft;
    const visibleRight = el.scrollLeft + el.clientWidth;

    if (cellLeft < visibleLeft) {
      el.scrollLeft = Math.max(0, cellLeft - stickyLeft);
    } else if (cellRight > visibleRight) {
      el.scrollLeft = cellRight - el.clientWidth;
    }
  }, [columnDefs, frozenRowCount, frozenColCount, frozenColOffsets, headerHeight, rowOffsets]);

  // Compute normalized selection rectangle
  const selectionRange = useMemo(() => {
    if (!selectedCell) return null;
    if (!selectionAnchor) return null;
    return {
      minCol: Math.min(selectedCell[0], selectionAnchor[0]),
      maxCol: Math.max(selectedCell[0], selectionAnchor[0]),
      minRow: Math.min(selectedCell[1], selectionAnchor[1]),
      maxRow: Math.max(selectedCell[1], selectionAnchor[1]),
    };
  }, [selectedCell, selectionAnchor]);

  const isMultiSelect = selectionAnchor !== null && selectedCell !== null && (selectionAnchor[0] !== selectedCell[0] || selectionAnchor[1] !== selectedCell[1]);

  // Autofill handle: show at bottom-right of selection when not editing (and editable)
  const autofillHandleCell = useMemo(() => {
    if (editingCell || !canEdit) return null;
    if (selectionRange && isMultiSelect) return [selectionRange.maxCol, selectionRange.maxRow] as [number, number];
    if (selectedCell) return selectedCell;
    return null;
  }, [editingCell, canEdit, selectionRange, isMultiSelect, selectedCell]);

  // -- Header selection handlers --

  const handleRowHeaderClick = useCallback((ri: number, e: MouseEvent) => {
    if (justDraggedRef.current) return;
    setSelectedCols(new Set());
    setSelectedCell(null);
    setContextMenu(null);
    if (e.shiftKey && lastClickedRowRef.current != null) {
      const from = Math.min(lastClickedRowRef.current, ri);
      const to = Math.max(lastClickedRowRef.current, ri);
      const range = new Set<number>();
      for (let i = from; i <= to; i++) range.add(i);
      setSelectedRows(range);
    } else {
      setSelectedRows(new Set([ri]));
      lastClickedRowRef.current = ri;
    }
  }, []);

  const handleColHeaderClick = useCallback((ci: number, e: MouseEvent) => {
    if (justDraggedRef.current) return;
    setSelectedRows(new Set());
    setSelectedCell(null);
    setContextMenu(null);
    if (e.shiftKey && lastClickedColRef.current != null) {
      const from = Math.min(lastClickedColRef.current, ci);
      const to = Math.max(lastClickedColRef.current, ci);
      const range = new Set<number>();
      for (let i = from; i <= to; i++) range.add(i);
      setSelectedCols(range);
    } else {
      setSelectedCols(new Set([ci]));
      lastClickedColRef.current = ci;
    }
  }, []);

  // -- Drag-to-reorder --

  const doReorder = useCallback((type: 'row' | 'col', draggedIndices: number[], dropIndex: number) => {
    if (!canEditRef.current) return;
    if (commandCtxRef.current) commitReorder(commandCtxRef.current, type, draggedIndices, dropIndex);
  }, []);

  const handleHeaderMouseDown = useCallback((type: 'row' | 'col', index: number, e: MouseEvent) => {
    if (e.button !== 0) return;

    const currentSelected = type === 'row' ? selectedRows : selectedCols;
    const indices = currentSelected.has(index)
      ? [...currentSelected].sort((a, b) => a - b)
      : [index];

    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const onMouseMove = (me: MouseEvent) => {
      if (!dragging) {
        const dx = Math.abs(me.clientX - startX);
        const dy = Math.abs(me.clientY - startY);
        if (dx < 5 && dy < 5) return;
        dragging = true;

        if (!currentSelected.has(index)) {
          if (type === 'row') {
            setSelectedRows(new Set([index]));
            lastClickedRowRef.current = index;
          } else {
            setSelectedCols(new Set([index]));
            lastClickedColRef.current = index;
          }
          dragRef.current = { type, indices: [index] };
        } else {
          dragRef.current = { type, indices };
        }
        document.body.style.cursor = 'grabbing';
      }

      const el = document.elementFromPoint(me.clientX, me.clientY);
      if (!el) return;
      const attr = type === 'row' ? 'data-row-index' : 'data-col-index';
      const header = el.closest(`[${attr}]`);
      if (header) {
        const targetIdx = Number(header.getAttribute(attr));
        const rect = header.getBoundingClientRect();
        const mid = type === 'row'
          ? (rect.top + rect.bottom) / 2
          : (rect.left + rect.right) / 2;
        const pos = type === 'row' ? me.clientY : me.clientX;
        const dropIdx = pos < mid ? targetIdx : targetIdx + 1;
        setDropIndicator({ type, index: dropIdx });
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';

      if (dragging && dragRef.current) {
        justDraggedRef.current = true;
        setTimeout(() => { justDraggedRef.current = false; }, 0);

        setDropIndicator(prev => {
          if (prev && dragRef.current) {
            doReorder(dragRef.current.type, dragRef.current.indices, prev.index);
          }
          return null;
        });
      }
      dragRef.current = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [selectedRows, selectedCols, doReorder]);

  // -- Column resize --

  const handleResizeMouseDown = useCallback((ci: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = (columnDefs[ci]?.width as number) || 100;

    const onMouseMove = (me: MouseEvent) => {
      const newWidth = Math.max(40, startWidth + me.clientX - startX);
      setResizingCol({ index: ci, width: newWidth });
    };

    const onMouseUp = (me: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';

      const finalWidth = Math.max(40, startWidth + me.clientX - startX);
      setResizingCol(null);

      if (ci < visibleColIds.length && currentSheetId) {
        const colId = visibleColIds[ci];
        const sid = currentSheetId;
        mutate((d, sid, colId, finalWidth) => { d.sheets[sid].columns[colId].width = finalWidth; }, [sid, colId, finalWidth]);
      }
    };

    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [columnDefs, visibleColIds, mutate, currentSheetId]);

  const autoFitColumn = useCallback((ci: number) => {
    const container = tableRef.current;
    if (!container || ci >= visibleColIds.length || !currentSheetId) return;
    const cells = container.querySelectorAll<HTMLElement>(`td[data-cell-col="${ci}"] > span`);
    if (cells.length === 0) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const style = getComputedStyle(cells[0]);
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const padding = 12; // 6px padding each side from .datagrid-cell > span
    let maxWidth = 40;
    cells.forEach(cell => {
      const w = ctx.measureText(cell.textContent || '').width + padding + 2;
      if (w > maxWidth) maxWidth = w;
    });
    const colId = visibleColIds[ci];
    const sid = currentSheetId;
    mutate((d, sid, colId, width) => { d.sheets[sid].columns[colId].width = width; }, [sid, colId, Math.ceil(maxWidth)]);
  }, [visibleColIds, mutate, currentSheetId]);

  // Unhide specific hidden rows/columns (used by gap buttons)
  const unhideColumns = useCallback((ids: string[]) => {
    if (!currentSheetId || !canEditRef.current) return;
    mutate((d, sid, ids) => {
      for (const id of ids) delete d.sheets[sid].columns[id].hidden;
    }, [currentSheetId, ids]);
  }, [mutate, currentSheetId]);

  const unhideRows = useCallback((ids: string[]) => {
    if (!currentSheetId || !canEditRef.current) return;
    mutate((d, sid, ids) => {
      for (const id of ids) delete d.sheets[sid].rows[id].hidden;
    }, [currentSheetId, ids]);
  }, [mutate, currentSheetId]);

  // -- Sheet management handlers --

  const handleSelectSheet = useCallback((id: string, skipUrlUpdate = false) => {
    if (id === currentSheetId) return;
    if (editingCell) commitEdit();
    hfBridgeRef.current?.switchSheet(id);
    // Swap the active sheet subscription
    if (docId) {
      activeSheetUnsubRef.current?.();
      activeSheetRef.current = null;
      activeSheetUnsubRef.current = subscribeQuery(docId, sheetQuery(id), (sheetResult) => {
        activeSheetRef.current = sheetResult;
        setTick(t => t + 1);
      });
    }
    setCurrentSheetId(id);
    setSelectedCell(null);
    setSelectionAnchor(null);
    setEditingCell(null);
    setSelectedRows(new Set());
    setSelectedCols(new Set());
    setContextMenu(null);
    setClipboardSource(null);
    setFormulaRefHighlights([]);
    // Push history so back button navigates between sheets
    if (!skipUrlUpdate && docId) {
      pushDocHash(docId, `sheets/${id}`);
    }
  }, [currentSheetId, editingCell, commitEdit, docId]);

  const handleAddSheet = useCallback(() => {
    const m = docMetaRef.current;
    if (!m || !docId) return;
    const maxIndex = Object.values(m.sheets).reduce((max, s) => Math.max(max, s.index), 0);
    const sheetCount = Object.keys(m.sheets).length;
    const sid = shortId();
    const cols: Record<string, { index: number; name: string }> = {};
    for (let i = 0; i < 3; i++) cols[shortId()] = { index: i + 1, name: '' };
    const rows: Record<string, { index: number }> = {};
    for (let i = 0; i < 10; i++) rows[shortId()] = { index: i + 1 };
    const newSheet = { '@type': 'Sheet', name: `Sheet ${sheetCount + 1}`, index: maxIndex + 1, columns: cols, rows, cells: {} };
    updateDoc(docId, (d, sid, newSheet) => { d.sheets[sid] = newSheet as any; }, sid, newSheet);
    // Optimistically update metadata so the tab appears immediately
    docMetaRef.current = { ...m, sheets: { ...m.sheets, [sid]: { name: newSheet.name, index: newSheet.index, rows: [], cols: [] } } };
    setTick(t => t + 1);
    handleSelectSheet(sid);
  }, [docId, handleSelectSheet]);

  const handleRenameSheet = useCallback((id: string, name: string) => {
    mutate((d, id, name) => { d.sheets[id].name = name; }, [id, name]);
  }, [mutate]);

  const handleDeleteSheet = useCallback((id: string) => {
    const m = docMetaRef.current;
    if (!m || !docId) return;
    if (Object.keys(m.sheets).length <= 1) return;
    const remaining = sortedEntries(m.sheets).filter(([sid]: [string, any]) => sid !== id);
    // Rewrite cross-sheet formula refs + delete runs in the worker where full doc is available
    updateDoc(docId, (d, deletedId) => {
      const pattern = new RegExp(`S\\{${deletedId}\\}`, 'g');
      for (const [sheetId, sheet] of Object.entries(d.sheets)) {
        if (sheetId === deletedId) continue;
        for (const [, cell] of Object.entries((sheet as any).cells || {})) {
          if ((cell as any).value?.includes(`S{${deletedId}}`)) {
            (cell as any).value = (cell as any).value.replace(pattern, 'S{#REF!}');
          }
        }
      }
      delete d.sheets[deletedId];
    }, id);
    if (id === currentSheetId) {
      const nextId = remaining.length > 0 ? remaining[0][0] : null;
      setCurrentSheetId(nextId);
      if (nextId) hfBridgeRef.current?.switchSheet(nextId);
      setSelectedCell(null); setSelectionAnchor(null); setEditingCell(null);
      setSelectedRows(new Set()); setSelectedCols(new Set()); setClipboardSource(null);
    }
  }, [docId, currentSheetId]);

  const handleHideSheet = useCallback((id: string) => {
    const m = docMetaRef.current;
    if (!m) return;
    const visibleCount = Object.values(m.sheets).filter(s => !s.hidden).length;
    if (visibleCount <= 1) return;
    mutate((d, id) => { d.sheets[id].hidden = true; }, [id]);
    docMetaRef.current = { ...m, sheets: { ...m.sheets, [id]: { ...m.sheets[id], hidden: true } } };
    if (id === currentSheetId) {
      const order = sortedEntries(m.sheets);
      const firstVisible = order.find(([sid, s]: [string, any]) => sid !== id && !s.hidden);
      if (firstVisible) handleSelectSheet(firstVisible[0]);
    }
  }, [mutate, currentSheetId, handleSelectSheet]);

  const handleUnhideSheet = useCallback((id: string) => {
    mutate((d, id) => { d.sheets[id].hidden = false; }, [id]);
    const m = docMetaRef.current;
    if (m?.sheets[id]) {
      docMetaRef.current = { ...m, sheets: { ...m.sheets, [id]: { ...m.sheets[id], hidden: false } } };
    }
  }, [mutate]);

  const handleReorderSheet = useCallback((draggedId: string, dropIndex: number) => {
    const m = docMetaRef.current;
    if (!m) return;
    const order = sortedEntries(m.sheets);
    // Remove dragged from order for calculating neighbors
    const filtered = order.filter(([id]) => id !== draggedId);
    let newIdx: number;
    if (filtered.length === 0) return;
    if (dropIndex <= 0) {
      newIdx = filtered[0][1].index - 1;
    } else if (dropIndex >= filtered.length) {
      newIdx = filtered[filtered.length - 1][1].index + 1;
    } else {
      newIdx = (filtered[dropIndex - 1][1].index + filtered[dropIndex][1].index) / 2;
    }
    mutate((d, draggedId, newIdx) => { d.sheets[draggedId].index = newIdx; }, [draggedId, newIdx]);
  }, [mutate]);

  // Move a sheet one step among the *visible* tabs (hidden sheets are hopped
  // over). Reuses the reorder index-midpoint math via handleReorderSheet.
  const handleMoveSheet = useCallback((id: string, dir: -1 | 1) => {
    const m = docMetaRef.current;
    if (!m) return;
    const order = sortedEntries(m.sheets);
    const visible = order.filter(([, s]: [string, any]) => !s.hidden).map(([sid]) => sid);
    const vi = visible.indexOf(id);
    const ni = vi + dir;
    if (vi < 0 || ni < 0 || ni >= visible.length) return;
    const neighborId = visible[ni];
    const filtered = order.filter(([sid]) => sid !== id);
    const nIdx = filtered.findIndex(([sid]) => sid === neighborId);
    handleReorderSheet(id, dir < 0 ? nIdx : nIdx + 1);
  }, [handleReorderSheet]);

  // -- Context menu handlers --

  /**
   * Open the header context menu (long-press on touch, right-click on desktop),
   * selecting the pressed row/column first unless it's already in the selection.
   * Both triggers pass the header element so the menu can anchor to it.
   */
  const openHeaderMenu = useCallback((kind: 'row' | 'col', index: number, anchor: HTMLElement) => {
    const lastCol = visibleColIdsRef.current.length - 1;
    const lastRow = visibleRowIdsRef.current.length - 1;
    if (kind === 'row') {
      const indices = selectedRowsRef.current.has(index)
        ? [...selectedRowsRef.current].sort((a, b) => a - b)
        : [index];
      if (!selectedRowsRef.current.has(index)) {
        setSelectedRows(new Set([index]));
        setSelectedCols(new Set());
        lastClickedRowRef.current = index;
      }
      // Span the rows as a cell range too, so the range-based commands
      // (Cut / Copy / Clear / formatting) act on the whole row.
      setSelectionAnchor([0, indices[0]]);
      setSelectedCell([Math.max(0, lastCol), indices[indices.length - 1]]);
      setContextMenu({ type: 'row', indices });
    } else {
      const indices = selectedColsRef.current.has(index)
        ? [...selectedColsRef.current].sort((a, b) => a - b)
        : [index];
      if (!selectedColsRef.current.has(index)) {
        setSelectedCols(new Set([index]));
        setSelectedRows(new Set());
        lastClickedColRef.current = index;
      }
      setSelectionAnchor([indices[0], 0]);
      setSelectedCell([indices[indices.length - 1], Math.max(0, lastRow)]);
      setContextMenu({ type: 'col', indices });
    }
    setHeaderMenu({ kind, anchor, page: 'main' });
  }, []);

  const handleRowContextMenu = useCallback((ri: number, e: MouseEvent) => {
    // The grid-wide Radix context menu handles cells; headers use their own
    // anchored menu, so keep the event away from the Radix trigger either way.
    e.preventDefault();
    e.stopPropagation();
    if (!canEditRef.current) {
      // Read-only: selecting via right-click still works, but no menu opens.
      if (!selectedRowsRef.current.has(ri)) {
        setSelectedRows(new Set([ri]));
        setSelectedCols(new Set());
        setSelectedCell(null);
      }
      return;
    }
    openHeaderMenu('row', ri, e.currentTarget as HTMLElement);
  }, [openHeaderMenu]);

  const handleColContextMenu = useCallback((ci: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canEditRef.current) {
      if (!selectedColsRef.current.has(ci)) {
        setSelectedCols(new Set([ci]));
        setSelectedRows(new Set());
        setSelectedCell(null);
      }
      return;
    }
    openHeaderMenu('col', ci, e.currentTarget as HTMLElement);
  }, [openHeaderMenu]);

  /**
   * Long-press on a header (touch only) opens the same menu. Kept inline rather
   * than via useLongPress because headers already own pointer/mouse handlers for
   * drag-to-reorder, and the press must abort as soon as a drag starts.
   */
  const headerLongPress = useCallback((kind: 'row' | 'col', index: number) => ({
    onPointerDown: (e: any) => {
      if (e.pointerType === 'mouse' || !canEditRef.current) return;
      const anchor = e.currentTarget as HTMLElement;
      const startX = e.clientX;
      const startY = e.clientY;
      const timer = window.setTimeout(() => {
        longPressRef.current = null;
        openHeaderMenu(kind, index, anchor);
      }, 450);
      longPressRef.current = { timer, startX, startY };
    },
    onPointerMove: (e: any) => {
      const lp = longPressRef.current;
      if (!lp) return;
      if (Math.abs(e.clientX - lp.startX) + Math.abs(e.clientY - lp.startY) > 10) {
        clearTimeout(lp.timer);
        longPressRef.current = null;
      }
    },
    onPointerUp: () => {
      if (longPressRef.current) clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    },
    onPointerCancel: () => {
      if (longPressRef.current) clearTimeout(longPressRef.current.timer);
      longPressRef.current = null;
    },
  }), [openHeaderMenu]);

  // Focus the bottom-bar editor after grid-initiated edits (typing, Enter,
  // double-click). Runs post-render so FormulaEditor's value-sync effect has
  // already pushed editValue into CodeMirror (child effects run first).
  useEffect(() => {
    if (editingCell && pendingEditorFocusRef.current) {
      pendingEditorFocusRef.current = false;
      formulaApiRef.current?.focus();
    }
  }, [editingCell]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (editingCell) { cancelEdit(); return; }
      if (selectionAnchor) { setSelectionAnchor(null); return; }
      // Nothing to cancel — leave focus mode (deselect the cell).
      setSelectedCell(null);
      return;
    }
    if (editingCell) return;
    if (!selectedCell) return;
    const [col, row] = selectedCell;
    const mod = e.ctrlKey || e.metaKey;

    if (dispatchKeyRef.current?.(e, mod)) return;

    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      setSelectionAnchor(null);
      startEditing(col, row);
      pendingEditorFocusRef.current = true;
      return;
    }
    if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (!selectionAnchor) setSelectionAnchor([col, row]);
      let nc = col, nr = row;
      if (e.key === 'ArrowRight') nc = Math.min(col + 1, visibleColIds.length - 1);
      else if (e.key === 'ArrowLeft') nc = Math.max(col - 1, 0);
      else if (e.key === 'ArrowDown') nr = Math.min(row + 1, visibleRowIds.length - 1);
      else if (e.key === 'ArrowUp') nr = Math.max(row - 1, 0);
      setSelectedCell([nc, nr]);
      scrollCellIntoView(nc, nr);
      return;
    }

    let newCol = col, newRow = row;
    if (e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); newCol = Math.min(col + 1, visibleColIds.length - 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); newCol = Math.max(col - 1, 0); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); newRow = Math.min(row + 1, visibleRowIds.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); newRow = Math.max(row - 1, 0); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (spillTargetsRef.current.has(`${currentSheetId}:${visibleRowIds[row]}:${visibleColIds[col]}`)) return;
      if (!canEditRef.current) return;
      e.preventDefault();
      setSelectionAnchor(null);
      setEditingCell([col, row]);
      setEditValue(e.key);
      pendingEditorFocusRef.current = true;
      return;
    }
    else return;

    if (newCol !== col || newRow !== row) {
      selectCell(newCol, newRow);
      scrollCellIntoView(newCol, newRow);
    }
  }, [editingCell, selectedCell, selectionAnchor, selectionRange, visibleColIds, visibleRowIds, startEditing, selectCell, cancelEdit, scrollCellIntoView]);

  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Track scroll position and viewport height for row virtualization.
  // The container scrolls (not the page), so we listen on the container element.
  // Depends on gridMounted because the datagrid-container div is conditionally
  // rendered, so tableRef.current may be null on first render.
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const handleScroll = () => {
      setScrollTop(el.scrollTop);
    };
    const thead = el.querySelector('thead');
    const updateHeight = () => {
      setViewportHeight(el.clientHeight);
      // Frozen rows stick below the header, so its real height (font/zoom
      // dependent) is load-bearing — never assume ROW_HEIGHT.
      if (thead) {
        const h = thead.getBoundingClientRect().height;
        if (h > 0) setHeaderHeight(h);
      }
    };
    updateHeight();
    el.addEventListener('scroll', handleScroll, { passive: true });
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    if (thead) ro.observe(thead);
    return () => {
      el.removeEventListener('scroll', handleScroll);
      ro.disconnect();
    };
  }, [!!rawDoc && columnDefs.length > 0]);

  // Mouse drag for cell range selection
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!cellDragRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const td = el?.closest('[data-cell-col]') as HTMLElement | null;
      if (!td) return;
      const col = parseInt(td.dataset.cellCol!, 10);
      const row = parseInt(td.dataset.cellRow!, 10);
      if (isNaN(col) || isNaN(row)) return;
      const anchor = cellDragRef.current.anchor;
      if (col !== anchor[0] || row !== anchor[1]) {
        setSelectionAnchor(anchor);
        setSelectedCell([col, row]);
      } else {
        setSelectionAnchor(null);
        setSelectedCell(anchor);
      }
    };
    const onMouseUp = () => {
      cellDragRef.current = null;
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Autofill drag: document-level mousemove/mouseup
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!autofillDragRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const td = el?.closest('[data-cell-col]') as HTMLElement | null;
      if (!td) return;
      const col = parseInt(td.dataset.cellCol!, 10);
      const row = parseInt(td.dataset.cellRow!, 10);
      if (isNaN(col) || isNaN(row)) return;

      const src = autofillDragRef.current.sourceRange;

      // Determine which axis the mouse has moved beyond
      const beyondRow = row > src.maxRow ? row - src.maxRow : row < src.minRow ? src.minRow - row : 0;
      const beyondCol = col > src.maxCol ? col - src.maxCol : col < src.minCol ? src.minCol - col : 0;

      if (beyondRow === 0 && beyondCol === 0) {
        setAutofillTarget(null);
        return;
      }

      // Fill in whichever axis the mouse is furthest beyond
      if (beyondRow >= beyondCol) {
        // Vertical fill
        if (row > src.maxRow) {
          setAutofillTarget({ minCol: src.minCol, maxCol: src.maxCol, minRow: src.maxRow + 1, maxRow: row });
        } else {
          setAutofillTarget({ minCol: src.minCol, maxCol: src.maxCol, minRow: row, maxRow: src.minRow - 1 });
        }
      } else {
        // Horizontal fill
        if (col > src.maxCol) {
          setAutofillTarget({ minRow: src.minRow, maxRow: src.maxRow, minCol: src.maxCol + 1, maxCol: col });
        } else {
          setAutofillTarget({ minRow: src.minRow, maxRow: src.maxRow, minCol: col, maxCol: src.minCol - 1 });
        }
      }
    };

    const onMouseUp = () => {
      if (!autofillDragRef.current) return;
      const src = autofillDragRef.current.sourceRange;
      autofillDragRef.current = null;

      // Use functional update to read current autofillTarget without stale closure
      setAutofillTarget(prev => {
        if (prev && commandCtxRef.current && canEditRef.current) {
          commitAutofill(commandCtxRef.current, src, prev);
        }
        return null;
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);


  // Peer presence cell map — keyed by "col:row", first peer wins. Skips the
  // local user's own devices (same convention as Sentences' remote cursors).
  const peerCellMap = useMemo(() => {
    const map: Record<string, PeerFieldInfo> = {};
    const myPeerId = getWorkerPeerId();
    const myGroup = getWorkerUserGroupId();
    for (const peer of Object.values(peers)) {
      if (myPeerId && peer.peerId === myPeerId) continue;
      if (myGroup && peer.value?.userGroupId === myGroup) continue;
      const pf = peer.value?.focusedField;
      if (!pf || pf.length < 4 || pf[0] !== 'sheets' || pf[1] !== currentSheetId || pf[2] !== 'cells') continue;
      const cellKey = String(pf[3]);
      const sep = cellKey.indexOf(':');
      if (sep === -1) continue;
      const rowId = cellKey.slice(0, sep);
      const colId = cellKey.slice(sep + 1);
      const col = visibleColIds.indexOf(colId);
      const row = visibleRowIds.indexOf(rowId);
      if (col >= 0 && row >= 0) {
        const key = `${col}:${row}`;
        if (!map[key]) {
          const userGroupId = peer.value?.userGroupId;
          map[key] = { color: peerColor(peer.peerId, userGroupId), peerId: peer.peerId, userGroupId };
        }
      }
    }
    return map;
  }, [peers, visibleColIds, visibleRowIds, currentSheetId]);

  // Load document, init presence, and set up HF bridge
  useEffect(() => {
    if (!docId) return;

    let mounted = true;

    // Set up HF bridge for formula evaluation
    const bridge = createHfBridge(sendHfPort);
    hfBridgeRef.current = bridge;
    const unsubValues = bridge.onComputedValues((values, spillTargets, errors) => {
      computedValuesRef.current = values;
      errorMessagesRef.current = errors;
      spillTargetsRef.current = spillTargets;
      if (mounted) setTick(t => t + 1);
    });
    const unsubMC = bridge.onMCResults((results) => {
      if (mounted) setMcResults(results);
    });
    const unsubCF = bridge.onCondFormatResults((results) => {
      condFormatResultsRef.current = results;
      if (mounted) setTick(t => t + 1);
    });

    // Helper to subscribe to a sheet's full data
    const subscribeToSheet = (sid: string) => {
      activeSheetUnsubRef.current?.();
      activeSheetRef.current = null;
      activeSheetUnsubRef.current = subscribeQuery(docId, sheetQuery(sid), (sheetResult) => {
        if (!mounted) return;
        activeSheetRef.current = sheetResult;
        setTick(t => t + 1);
      });
    };

    // Subscription 1: lightweight metadata (doc name + sheet list)
    const unsubMeta = subscribeQuery(docId, META_QUERY, (result, heads) => {
      if (!mounted || !result) return;

      if (!docMetaRef.current) {
        // First load — determine which sheet to show and subscribe to it
        const order = sortedEntries(result.sheets);
        const firstSheetId = order.length > 0 ? order[0][0] : null;
        const validInitial = initialSheetId && result.sheets[initialSheetId] ? initialSheetId : null;
        const activeSheet = validInitial ?? firstSheetId;
        setCurrentSheetId(activeSheet);
        if (activeSheet) {
          bridge.watch(docId, activeSheet);
          subscribeToSheet(activeSheet);
        }
      }

      setRawDoc(result);
      docMetaRef.current = result;
      if (result.name) setGridName(result.name);
      document.title = (result.name || 'Spreadsheet') + ' - Spreadsheet';
      history.onNewHeads(heads);
      onHeadsUpdate(heads);
      setTick(t => t + 1);
    });

    return () => {
      mounted = false;
      unsubMeta();
      activeSheetUnsubRef.current?.();
      activeSheetUnsubRef.current = null;
      unsubValues();
      unsubMC();
      unsubCF();
      bridge.destroy();
      hfBridgeRef.current = null;
    };
  }, [docId]);

  // Automerge path to the focused cell (drives presence and the Edit Source link)
  const focusPath: (string | number)[] | undefined = useMemo(() => {
    if (!currentSheetId) return undefined;
    if (!selectedCell || visibleRowIds.length === 0 || visibleColIds.length === 0) return ['sheets', currentSheetId];
    const [col, row] = selectedCell;
    if (row >= visibleRowIds.length || col >= visibleColIds.length) return ['sheets', currentSheetId];
    return ['sheets', currentSheetId, 'cells', `${visibleRowIds[row]}:${visibleColIds[col]}`];
  }, [selectedCell, visibleRowIds, visibleColIds, currentSheetId]);

  // Broadcast the selected cell as presence. Only a real cell counts — a
  // sheet-only path (length 2) means nothing is selected, so peers see null.
  useFocusPathSync(focusPath && focusPath.length > 2 ? focusPath : null, broadcast);

  // Handle sheetId prop changes from back/forward navigation
  useEffect(() => {
    if (!sheetId || sheetId === currentSheetId) return;
    handleSelectSheet(sheetId, /* skipUrlUpdate */ true);
  }, [sheetId]);

  // Send conditional format rules with customFormula to HF worker for evaluation
  useEffect(() => {
    const bridge = hfBridgeRef.current;
    if (!bridge) return;
    const condFormats = currentSheet?.conditionalFormats;
    if (!condFormats) {
      bridge.evalCondFormats([]);
      return;
    }
    const rules = Object.entries(condFormats)
      .filter(([, rule]: [string, any]) => rule.conditionType === 'customFormula')
      .map(([id, rule]: [string, any]) => ({
        id,
        conditionType: rule.conditionType,
        conditionValue: rule.conditionValue,
        ranges: Object.values(rule.ranges).map((r: any) => ({
          rangeRowStart: r.rangeRowStart, rangeRowEnd: r.rangeRowEnd,
          rangeColStart: r.rangeColStart, rangeColEnd: r.rangeColEnd,
        })),
      }));
    bridge.evalCondFormats(rules);
  }, [currentSheet?.conditionalFormats]);

  // Formula bar value
  const formulaBarValue = useMemo(() => {
    if (!selectedCell || !currentSheet) return '';
    const [col, row] = selectedCell;
    if (row >= visibleRowIds.length || col >= visibleColIds.length) return '';
    const rowId = visibleRowIds[row];
    const colId = visibleColIds[col];
    const spillKey = `${effectiveSheetId}:${rowId}:${colId}`;
    if (spillTargetsRef.current.has(spillKey)) {
      const computed = computedValuesRef.current?.get(spillKey);
      return computed != null ? String(computed) : '';
    }
    const raw = currentSheet.cells[`${rowId}:${colId}`]?.value || '';
    // A1 display uses original position in full sorted list
    const origRow = sortedRowIds.indexOf(rowId);
    const origCol = sortedColIds.indexOf(colId);
    return raw.startsWith('=') ? internalToA1(raw, origRow, origCol, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup) : raw;
  }, [selectedCell, currentSheet, visibleRowIds, visibleColIds, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup, effectiveSheetId]);

  const formulaNames = CUSTOM_FN_NAMES;

  // Build a map of cell positions → formula ref highlight info (for coloring grid cells)
  // All refs get a colored dashed border; only the cursor-active ref also gets a background fill.
  type CellRefInfo = {
    color: string;
    active: boolean;
    top: boolean; right: boolean; bottom: boolean; left: boolean;
  };
  const refHighlightMap = useMemo(() => {
    if (!editingCell) return new Map<string, CellRefInfo>();
    const map = new Map<string, CellRefInfo>();
    for (const h of formulaRefHighlights) {
      const active = !!h.active;
      if (isRange(h)) {
        for (let r = h.minRow; r <= h.maxRow; r++) {
          for (let c = h.minCol; c <= h.maxCol; c++) {
            map.set(`${c}:${r}`, {
              color: h.color, active,
              top: r === h.minRow, bottom: r === h.maxRow,
              left: c === h.minCol, right: c === h.maxCol,
            });
          }
        }
      } else {
        map.set(`${h.col}:${h.row}`, { color: h.color, active, top: true, right: true, bottom: true, left: true });
      }
    }
    return map;
  }, [formulaRefHighlights, editingCell]);

  const doc2 = activeSheetRef.current;
  const computedValues = computedValuesRef.current;
  const errorMessages = errorMessagesRef.current;

  const currentRowIndices = useMemo(() => {
    if (selectedRows.size > 0) return [...selectedRows].sort((a, b) => a - b);
    if (selectedCell) return [selectedCell[1]];
    return [];
  }, [selectedRows, selectedCell]);

  const currentColIndices = useMemo(() => {
    if (selectedCols.size > 0) return [...selectedCols].sort((a, b) => a - b);
    if (selectedCell) return [selectedCell[0]];
    return [];
  }, [selectedCols, selectedCell]);

  const currentCellFormat = useMemo(() => {
    if (!selectedCell) return undefined;
    const origRow = visibleRowOriginalIndices[selectedCell[1]];
    const origCol = visibleColOriginalIndices[selectedCell[0]];
    if (origRow == null || origCol == null) return undefined;
    return formatCache.get(`${origRow}:${origCol}`);
  }, [selectedCell, formatCache, visibleRowOriginalIndices, visibleColOriginalIndices]);

  const commandState: GridCommandState = {
    canEdit,
    canUndo,
    canRedo,
    hasSelection: selectedCell !== null,
    currentRowIndices,
    currentColIndices,
    hasFrozenRows: frozenRowCount > 0,
    hasFrozenCols: frozenColCount > 0,
    contextScope: contextMenu
      ? { type: contextMenu.type, indices: contextMenu.indices }
      : null,
    currentCellFormat,
  };
  const commandCtx: GridCommandContext = {
    sheet: doc2 ?? null,
    sheetsMeta: meta?.sheets ?? null,
    computedValues: computedValuesRef.current,
    spillTargets: spillTargetsRef.current,
    currentSheetId: currentSheetId ?? '',
    sortedRowIds,
    sortedColIds,
    visibleRowIds,
    visibleColIds,
    selectedCell,
    selectionAnchor,
    currentRowIndices,
    currentColIndices,
    selectedRows,
    selectedCols,
    clipboardRef,
    setClipboardSource,
    mutate,
    setSelectionAnchor,
    setSelectedCell,
    setContextMenu,
    setSelectedRows,
    setSelectedCols,
    undo,
    redo,
    formatCache,
    openResizeSheet: (kind) => { setHeaderMenu(null); setResizeKind(kind); },
    onPasteShortcut: handlePasteShortcut,
  };
  commandCtxRef.current = commandCtx;
  const commands = useGridCommands(commandState, commandCtx);
  dispatchKeyRef.current = commands.dispatchKey;
  executePasteRef.current = commands.executePaste;

  const gridMounted = !!rawDoc && columnDefs.length > 0;

  // Native paste event listener — the preferred source, because it carries
  // clipboardData synchronously and needs no clipboard-read permission.
  //
  // Bound to `document`, not to the container, and with no deps. It used to be
  // `el.addEventListener` gated on `gridMounted`, which could never fire: the
  // container renders behind `columnDefs.length > 0 && doc2` (and `doc2` is a
  // ref, so it is not even reactive), while gridMounted watches `rawDoc`. Any
  // render where gridMounted flipped true before the container existed left
  // `tableRef.current` null, the effect bailed, and — gridMounted never changing
  // again — the listener was never attached for the rest of the session. That is
  // invisible for copy, which lives entirely in keydown, so it presented as
  // "copy works, paste doesn't". A document listener has no element to miss.
  useEffect(() => {
    const handlePaste = (e: Event) => {
      const ce = e as ClipboardEvent;
      const el = tableRef.current;
      // Only the grid's own paste. A paste into the bottom editor bar's
      // CodeMirror (or any other field) must be left entirely alone.
      if (!el || !(ce.target instanceof Node) || !el.contains(ce.target)) return;
      // The real event won the race with the keyboard fallback below.
      if (pasteFallbackTimerRef.current !== null) {
        clearTimeout(pasteFallbackTimerRef.current);
        pasteFallbackTimerRef.current = null;
      }
      ce.preventDefault();
      executePasteRef.current?.(ce);
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  useEffect(() => () => {
    if (pasteFallbackTimerRef.current !== null) clearTimeout(pasteFallbackTimerRef.current);
  }, []);

  const focusMode = selectedCell !== null;

  // Scroll-direction chrome hiding (overview mode only): scrolling down hides
  // the top bar and sheet tabs, scrolling up reveals them.
  const chromeHidden = useHideOnScroll(tableRef, gridMounted) && !focusMode;

  // Effective selection rectangle (single cell = 1×1) — drives the corner
  // decorations and the inside-the-selection touch-resize gesture.
  const selRect = selectedCell
    ? (selectionRange ?? { minCol: selectedCell[0], maxCol: selectedCell[0], minRow: selectedCell[1], maxRow: selectedCell[1] })
    : null;

  const exitFocusMode = () => {
    commitEdit();
    setSelectedCell(null);
    setSelectionAnchor(null);
    setEditingCell(null);
  };

  // Formula preview — last computed value of the cell being edited, shown as
  // an overlay above the bottom editor.
  let editorPreviewValue: string | undefined;
  if (editingCell && editValue.startsWith('=') && effectiveSheetId) {
    const cached = computedValues.get(`${effectiveSheetId}:${visibleRowIds[editingCell[1]]}:${visibleColIds[editingCell[0]]}`);
    if (cached != null) editorPreviewValue = String(cached);
  }

  // Aggregates over a numeric multi-cell selection (Sum/Avg/Min/Max/Count),
  // formatted with the shared numFmt when every numeric cell agrees on one.
  // They replace the (single-cell) editor in the bottom bar — never while an
  // edit is in progress.
  let aggregateChips: AggregateChip[] | null = null;
  if (focusMode && selectionRange && isMultiSelect && !editingCell && doc2) {
    const cells: { display: string; numFmt?: string }[] = [];
    const MAX_AGG_CELLS = 5000; // bound the per-render work on huge selections
    outer: for (let r = selectionRange.minRow; r <= selectionRange.maxRow; r++) {
      for (let c = selectionRange.minCol; c <= selectionRange.maxCol; c++) {
        if (cells.length >= MAX_AGG_CELLS) break outer;
        const rowId = visibleRowIds[r];
        const colId = visibleColIds[c];
        if (!rowId || !colId) continue;
        const raw = doc2.cells[`${rowId}:${colId}`]?.value || '';
        const display = getDisplayValue(computedValues, raw, effectiveSheetId ?? '', rowId, colId);
        const numFmt = formatCache.get(`${visibleRowOriginalIndices[r]}:${visibleColOriginalIndices[c]}`)?.numFmt;
        cells.push({ display, numFmt });
      }
    }
    const agg = computeSelectionAggregates(cells);
    if (agg) {
      const fmt = (n: number) => {
        const s = String(Number(n.toFixed(6))); // trim float noise
        return agg.numFmt ? formatDisplayValue(s, agg.numFmt) : s;
      };
      aggregateChips = [
        { label: 'Sum', value: fmt(agg.sum) },
        { label: 'Avg', value: fmt(agg.avg) },
        { label: 'Min', value: fmt(agg.min) },
        { label: 'Max', value: fmt(agg.max) },
        { label: 'Count', value: String(agg.count) },
      ];
    }
  }

  // Rows/columns the resize sheet applies to, and the size it should show
  // (the first target's stored value, or null when it uses the default).
  const resizeTargetIds = (() => {
    if (!resizeKind) return [] as string[];
    const indices = resizeKind === 'row' ? currentRowIndices : currentColIndices;
    const ids = resizeKind === 'row' ? visibleRowIds : visibleColIds;
    return indices.map(i => ids[i]).filter(Boolean);
  })();
  const resizeCurrentSize = (() => {
    if (!resizeKind || !doc2 || resizeTargetIds.length === 0) return null;
    const item = resizeKind === 'row' ? doc2.rows[resizeTargetIds[0]] : doc2.columns[resizeTargetIds[0]];
    const size = resizeKind === 'row' ? item?.height : item?.width;
    return typeof size === 'number' ? size : null;
  })();

  // Insert a function from the formula sheet: start a formula if the cell
  // isn't being edited, else insert at the cursor.
  const insertFunction = (name: string) => {
    if (!canEditRef.current || !selectedCell) return;
    if (!editingCell) {
      setEditingCell([...selectedCell] as [number, number]);
      setEditValue(`=${name}(`);
      pendingEditorFocusRef.current = true;
    } else {
      formulaApiRef.current?.insertText((editValue.trim() ? '' : '=') + name + '(');
    }
  };

  return (
    <DocLoader docId={docId}>
    <div className={'datagrid-page' + (chromeHidden ? ' chrome-hidden' : '')}>
      <div className="datagrid-top-chrome">
      {focusMode ? (
        <FocusTopBar
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undo}
          onRedo={redo}
          onDone={exitFocusMode}
          onOpenFormat={canEdit ? () => setFormatSheetOpen(true) : undefined}
        />
      ) : (
      <DocumentTitleBar
        icon="grid_on"
        title={gridName}
        titleEditable={canEdit}
        onRename={(value) => {
          const name = value.trim() || 'Spreadsheet';
          setGridName(name);
          if (docId) updateDoc(docId, (d, name) => { d.name = name; }, name);
          document.title = name + ' - Spreadsheet';
        }}
        docId={docId}
        peers={peerList}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        hasValidationErrors={validationErrors.length > 0}
        sourcePath={focusPath}
        onUndo={canEdit ? undo : undefined}
        onRedo={canEdit ? redo : undefined}
        canUndo={canUndo}
        canRedo={canRedo}
        // The bar sits above the grid's own scroll container in a fixed-height
        // flex column, so .datagrid-top-chrome positions and hides it.
        sticky={false}
      />
      )}
      </div>
      <HistorySlider history={history} />
      <div className="datagrid-body">
      <div className="datagrid-main" style={noAccess ? { opacity: 0.4, pointerEvents: 'none' as const } : undefined}>

      {columnDefs.length > 0 && doc2 && (
        <>
          {syncing && (
            <div className="hf-sync-bar">
              <div className="hf-sync-bar-fill" />
            </div>
          )}

          {/* Grid table + sheet tabs wrapper */}
          <div className="datagrid-wrapper">
          <ContextMenu modal={false} onOpenChange={(open: boolean) => { if (!open) setContextMenu(null); }}>
          <ContextMenuTrigger asChild>
          <div className="datagrid-container" ref={tableRef} tabIndex={0}>
            <table className="datagrid-table" style={{ width: columnDefs.reduce((sum, col, i) => sum + ((resizingCol?.index === i ? resizingCol.width : col.width) || 100), 48) }}>
              <thead>
                <tr>
                  <th
                    className="datagrid-row-header datagrid-corner-header"
                    style={frozenColCount > 0 || frozenRowCount > 0 ? { position: 'sticky', left: 0, top: 0, zIndex: 4 } : undefined}
                    title="Select all cells"
                    onClick={() => {
                      if (visibleColIds.length === 0 || visibleRowIds.length === 0) return;
                      setContextMenu(null);
                      setSelectedRows(new Set());
                      setSelectedCols(new Set());
                      setSelectedCell([0, 0]);
                      setSelectionAnchor([visibleColIds.length - 1, visibleRowIds.length - 1]);
                    }}
                  />
                  {columnDefs.map((col, ci) => {
                    const isColSelected = selectedCols.has(ci);
                    let dropClass = '';
                    if (dropIndicator?.type === 'col') {
                      if (dropIndicator.index === ci) dropClass = ' drop-left';
                      else if (dropIndicator.index === ci + 1 && ci === columnDefs.length - 1) dropClass = ' drop-right';
                    }
                    const isFrozenCol = ci < frozenColCount;
                    const isLastFrozenCol = ci === frozenColCount - 1;
                    const gap = colHiddenGaps.find(g => g.beforeVisualIndex === ci);
                    const frozenStyle = isFrozenCol ? { position: 'sticky' as const, left: frozenColOffsets[ci], zIndex: 3 } : undefined;
                    return (
                      <>
                        {gap && (
                          <th key={`unhide-col-${ci}`} className="datagrid-col-unhide" onClick={() => unhideColumns(gap.hiddenIds)} title={`Show ${gap.hiddenIds.length} hidden column${gap.hiddenIds.length > 1 ? 's' : ''}`}>
                            <span className="material-symbols-outlined" style={{ fontSize: '0.75rem' }}>unfold_more</span>
                          </th>
                        )}
                        <th
                          key={col.id}
                          className={'datagrid-col-header' + (isColSelected ? ' selected' : selectedCell && selectedCell[0] === ci ? ' active' : '') + dropClass + (isLastFrozenCol ? ' frozen-col-last' : '')}
                          style={{ width: (resizingCol?.index === ci ? resizingCol.width : col.width) || 100, ...frozenStyle }}
                          data-col-index={ci}
                          onClick={(e: any) => handleColHeaderClick(ci, e)}
                          onContextMenu={(e: any) => handleColContextMenu(ci, e)}
                          onMouseDown={(e: any) => handleHeaderMouseDown('col', ci, e)}
                          {...headerLongPress('col', ci)}
                        >
                          {colIndexToLetter(visibleColOriginalIndices[ci])}
                          <div className="col-resize-handle" onMouseDown={(e: any) => handleResizeMouseDown(ci, e)} onDblClick={(e: any) => { e.stopPropagation(); autoFitColumn(ci); }} />
                        </th>
                      </>
                    );
                  })}
                  {/* Trailing unhide button if columns are hidden at the end */}
                  {colHiddenGaps.find(g => g.beforeVisualIndex === columnDefs.length) && (
                    <th className="datagrid-col-unhide" onClick={() => unhideColumns(colHiddenGaps.find(g => g.beforeVisualIndex === columnDefs.length)!.hiddenIds)}>
                      <span className="material-symbols-outlined" style={{ fontSize: '0.75rem' }}>unfold_more</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const totalRows = visibleRowIds.length;
                  // Row positions come from the cumulative offsets, so rows with
                  // custom heights stay aligned with the scroll position.
                  const firstVisible = rowAtOffset(rowOffsets, scrollTop);
                  // Always render frozen rows (they're sticky and must stay in the DOM)
                  const startRow = Math.max(frozenRowCount, firstVisible - OVERSCAN);
                  const lastVisible = rowAtOffset(rowOffsets, scrollTop + viewportHeight);
                  const endRow = Math.min(totalRows, lastVisible + 1 + OVERSCAN);
                  // Build row indices: frozen rows first (always rendered), then virtualized window
                  const rowIndicesToRender: number[] = [];
                  for (let i = 0; i < frozenRowCount && i < totalRows; i++) rowIndicesToRender.push(i);
                  // Spacer insertion point: after frozen rows, before virtualized rows
                  const spacerHeight = startRow > frozenRowCount ? rowOffsets[startRow] - rowOffsets[frozenRowCount] : 0;
                  for (let i = startRow; i < endRow; i++) rowIndicesToRender.push(i);
                  let spacerInserted = false;
                  return (
                    <>
                      {rowIndicesToRender.map((ri) => {
                  const rowId = visibleRowIds[ri];
                  // Insert spacer between frozen rows and virtualized rows
                  const needSpacer = !spacerInserted && ri >= frozenRowCount && spacerHeight > 0;
                  if (needSpacer) spacerInserted = true;
                  const isRowSelected = selectedRows.has(ri);
                  let dropClass = '';
                  if (dropIndicator?.type === 'row') {
                    if (dropIndicator.index === ri) dropClass = ' drop-above';
                    else if (dropIndicator.index === ri + 1 && ri === visibleRowIds.length - 1) dropClass = ' drop-below';
                  }
                  const isFrozenRow = ri < frozenRowCount;
                  const isLastFrozenRow = ri === frozenRowCount - 1;
                  const frozenRowTop = isFrozenRow ? frozenRowOffsets[ri] : undefined;
                  const rowGap = rowHiddenGaps.find(g => g.beforeVisualIndex === ri);
                  return (
                    <>
                      {needSpacer && (
                        <tr key="frozen-spacer" style={{ height: spacerHeight + 'px' }}>
                          <td colSpan={visibleColIds.length + 1} />
                        </tr>
                      )}
                      {rowGap && (
                        <tr key={`unhide-row-${ri}`} className="datagrid-row-unhide-tr">
                          <td className="datagrid-row-unhide" colSpan={visibleColIds.length + 1} onClick={() => unhideRows(rowGap.hiddenIds)} title={`Show ${rowGap.hiddenIds.length} hidden row${rowGap.hiddenIds.length > 1 ? 's' : ''}`}>
                            <span className="material-symbols-outlined" style={{ fontSize: '0.75rem' }}>unfold_more</span>
                          </td>
                        </tr>
                      )}
                    <tr key={rowId} style={{ height: rowHeights[ri] + 'px' }}>
                      <td
                        className={'datagrid-row-header' + (isRowSelected ? ' selected' : selectedCell && selectedCell[1] === ri ? ' active' : '') + dropClass + (isLastFrozenRow ? ' frozen-row-last' : '')}
                        // Pinned in both axes: above plain row headers (which scroll
                        // beneath it) but below the column headers. See the z-index
                        // ladder in datagrid.css.
                        style={isFrozenRow ? { position: 'sticky', left: 0, top: frozenRowTop, zIndex: 5 } : undefined}
                        data-row-index={ri}
                        onClick={(e: any) => handleRowHeaderClick(ri, e)}
                        onContextMenu={(e: any) => handleRowContextMenu(ri, e)}
                        onMouseDown={(e: any) => handleHeaderMouseDown('row', ri, e)}
                        {...headerLongPress('row', ri)}
                      >
                        {visibleRowOriginalIndices[ri] + 1}
                      </td>
                      {visibleColIds.map((colId, ci) => {
                        const isSelected = selectedCell && selectedCell[0] === ci && selectedCell[1] === ri;
                        const isEditing = editingCell && editingCell[0] === ci && editingCell[1] === ri;
                        const peers = peerCellMap[`${ci}:${ri}`];
                        const refInfo = refHighlightMap.get(`${ci}:${ri}`);
                        const rawValue = currentSheet?.cells[`${rowId}:${colId}`]?.value || '';
                        let display = getDisplayValue(computedValues, rawValue, effectiveSheetId ?? '', rowId, colId);
                        const cellFmt = formatCache.get(`${visibleRowOriginalIndices[ri]}:${visibleColOriginalIndices[ci]}`);
                        const mcKey = `${effectiveSheetId}:${rowId}:${colId}`;
                        const isEvaluating = rawValue.startsWith('=') && !computedValues?.has(mcKey);
                        const mcStats = mcResults?.cells.get(mcKey);
                        const isMcSource = mcResults?.sources.has(mcKey);
                        if (mcStats && !display.startsWith('#')) {
                          display = formatDistValue(mcStats.mean, mcStats.stdev);
                        }
                        const inRange = selectionRange && ci >= selectionRange.minCol && ci <= selectionRange.maxCol && ri >= selectionRange.minRow && ri <= selectionRange.maxRow;
                        const inAutofillTarget = autofillTarget && ci >= autofillTarget.minCol && ci <= autofillTarget.maxCol && ri >= autofillTarget.minRow && ri <= autofillTarget.maxRow;
                        const showAutofillHandle = autofillHandleCell && autofillHandleCell[0] === ci && autofillHandleCell[1] === ri && !autofillDragRef.current;

                        // Apply cell formatting first (lowest priority)
                        const cellStyle: Record<string, string> = {};
                        const fmtCss = formatToCss(cellFmt);
                        if (fmtCss) Object.assign(cellStyle, fmtCss);
                        // Resolve conditional formatting BEFORE number formatting
                        // (conditions compare raw numeric values, not formatted strings)
                        if (currentSheet?.conditionalFormats) {
                          const condFmt = resolveConditionalFormat(
                            currentSheet.conditionalFormats, rowId, colId, display,
                            cfRowIdxMap, cfColIdxMap, condFormatResultsRef.current,
                          );
                          if (condFmt) {
                            const condCss = formatToCss(condFmt);
                            if (condCss) Object.assign(cellStyle, condCss);
                          }
                        }
                        // Auto-right-align numeric values if no explicit alignment is set
                        // (numeric check uses the pre-numFmt display — after numFmt, values
                        // like "$1,234.00" would not parse as Number).
                        if (!cellStyle.textAlign && display !== '' && !isNaN(Number(display))) {
                          cellStyle.textAlign = 'right';
                        }
                        // Apply number formatting AFTER conditional format resolution
                        if (cellFmt?.numFmt) display = formatDisplayValue(display, cellFmt.numFmt);
                        // UI overlays (peer, ref-highlight, clipboard) override formatting
                        if (peers) cellStyle.boxShadow = `inset 0 0 0 2px ${peers.color}`;
                        if (refInfo) {
                          const c = refInfo.color;
                          const dash = `2px dashed ${c}`;
                          const none = '1px solid var(--md-sys-color-outline-variant)';
                          cellStyle.borderTop = refInfo.top ? dash : none;
                          cellStyle.borderRight = refInfo.right ? dash : none;
                          cellStyle.borderBottom = refInfo.bottom ? dash : none;
                          cellStyle.borderLeft = refInfo.left ? dash : none;
                          if (refInfo.active) cellStyle.background = `${c}18`;
                        }
                        if (clipboardSource && ci >= clipboardSource.minCol && ci <= clipboardSource.maxCol && ri >= clipboardSource.minRow && ri <= clipboardSource.maxRow) {
                          const dash = '2px dashed var(--md-sys-color-primary)';
                          const none = '1px solid var(--md-sys-color-outline-variant)';
                          cellStyle.borderTop = ri === clipboardSource.minRow ? dash : none;
                          cellStyle.borderBottom = ri === clipboardSource.maxRow ? dash : none;
                          cellStyle.borderLeft = ci === clipboardSource.minCol ? dash : none;
                          cellStyle.borderRight = ci === clipboardSource.maxCol ? dash : none;
                        }

                        // Frozen cell positioning (highest priority — overlays everything)
                        const isFrozenCol = ci < frozenColCount;
                        const isLastFrozenCol = ci === frozenColCount - 1;
                        const isSpillTarget = spillTargetsRef.current.has(`${effectiveSheetId}:${rowId}:${colId}`);
                        if (isFrozenCol || isFrozenRow) {
                          cellStyle.position = 'sticky';
                          // Frozen cells need an opaque backdrop so scrolled content
                          // doesn't show through — but only when nothing has already
                          // painted one. `formatToCss` writes the `backgroundColor`
                          // longhand, so testing only the `background` shorthand here
                          // missed it and then clobbered it (the shorthand resets
                          // background-color), leaving formatted frozen cells white.
                          if (!cellStyle.background && !cellStyle.backgroundColor && !isSpillTarget) {
                            cellStyle.backgroundColor = 'var(--md-sys-color-surface)';
                          }
                          if (isFrozenCol) {
                            cellStyle.left = `${frozenColOffsets[ci]}px`;
                          }
                          if (isFrozenRow) {
                            cellStyle.top = `${frozenRowTop}px`;
                          }
                          // z-index: frozen col+row intersection > frozen row > frozen col > normal
                          cellStyle.zIndex = isFrozenCol && isFrozenRow ? '3' : '2';
                        }

                        const frozenClass = (isLastFrozenCol ? ' frozen-col-last' : '') + (isLastFrozenRow ? ' frozen-row-last' : '');

                        return (
                          <td
                            key={colId}
                            className={'datagrid-cell' + (isSelected && !refInfo && !isEditing ? ' selected' : '') + (isEditing ? ' editing' : '') + (inRange && isMultiSelect ? ' in-range' : '') + (inAutofillTarget ? ' autofill-target' : '') + (isRowSelected || selectedCols.has(ci) ? ' header-selected' : '') + (peers ? ' peer-focused' : '') + (refInfo ? ' formula-ref-highlight' : '') + (isMcSource ? ' dist-source' : mcStats ? ' dist-dependent' : '') + (spillTargetsRef.current.has(`${effectiveSheetId}:${rowId}:${colId}`) ? ' spill-target' : '') + (isEvaluating ? ' evaluating' : '') + frozenClass}
                            style={Object.keys(cellStyle).length > 0 ? cellStyle : undefined}
                            title={mcStats ? `μ=${mcStats.mean.toFixed(2)} σ=${mcStats.stdev.toFixed(2)} [P5=${mcStats.p5.toFixed(2)}, P95=${mcStats.p95.toFixed(2)}]` : peers ? `${peerDisplayName(peers.peerId, peers.userGroupId)} is editing` : undefined}
                            data-cell-col={ci}
                            data-cell-row={ri}
                            onMouseDown={(e: any) => {
                              if (e.button !== 0) return;
                              if (isEditing) return; // clicking the cell being edited keeps the edit
                              if (editingCell) commitEdit();
                              // Suppress the native drag-select (which would otherwise
                              // smear a text selection across the page once the pointer
                              // leaves the table); focus is set explicitly below.
                              e.preventDefault();
                              if (e.shiftKey && selectedCell) {
                                if (!selectionAnchor) setSelectionAnchor([...selectedCell] as [number, number]);
                                setSelectedCell([ci, ri]);
                                tableRef.current?.focus();
                              } else {
                                selectCell(ci, ri);
                                cellDragRef.current = { anchor: [ci, ri] };
                              }
                            }}
                            onDblClick={() => {
                              startEditing(ci, ri);
                              pendingEditorFocusRef.current = true;
                            }}
                            // Touch drag starting inside the selection resizes it; the
                            // touch-action CSS on .selected/.in-range keeps the browser
                            // from hijacking these drags for scrolling. Mouse keeps the
                            // existing mousedown drag-select path.
                            onPointerDown={(e: any) => {
                              if (e.pointerType === 'mouse') return;
                              if (editingCell) return;
                              const inSel = selRect && ci >= selRect.minCol && ci <= selRect.maxCol && ri >= selRect.minRow && ri <= selRect.maxRow;
                              if (!inSel) return;
                              touchSelRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startCell: [ci, ri], active: false };
                              e.currentTarget.setPointerCapture(e.pointerId);
                            }}
                            onPointerMove={(e: any) => {
                              const ts = touchSelRef.current;
                              if (!ts || e.pointerId !== ts.pointerId) return;
                              if (!ts.active) {
                                // Small move threshold so a plain tap still just selects
                                if (Math.abs(e.clientX - ts.startX) + Math.abs(e.clientY - ts.startY) < 8) return;
                                ts.active = true;
                                setSelectionAnchor(ts.startCell);
                              }
                              const el = tableRef.current;
                              if (!el) return;
                              const rect = el.getBoundingClientRect();
                              setSelectedCell(pointToCell(e.clientX, e.clientY, {
                                containerLeft: rect.left,
                                containerTop: rect.top,
                                scrollLeft: el.scrollLeft,
                                scrollTop: el.scrollTop,
                                colWidths: columnDefs.map((c: any) => c.width || 100),
                                rowOffsets,
                                headerHeight,
                                rowHeaderWidth: 48,
                                frozenRowCount,
                                frozenColCount,
                              }));
                            }}
                            onPointerUp={(e: any) => {
                              const ts = touchSelRef.current;
                              if (!ts || ts.pointerId !== e.pointerId) return;
                              touchSelRef.current = null;
                              // A captured tap without movement doesn't produce compat
                              // mouse events (touch-action: none) — collapse the
                              // selection to the tapped cell ourselves.
                              if (!ts.active) selectCell(ts.startCell[0], ts.startCell[1]);
                            }}
                            onPointerCancel={(e: any) => {
                              if (touchSelRef.current?.pointerId === e.pointerId) touchSelRef.current = null;
                            }}
                            onContextMenu={() => {
                              if (!isSelected && !inRange) selectCell(ci, ri);
                              setContextMenu({ type: 'cell', indices: [] });
                            }}
                          >
                            {isEditing ? (
                              // Editing happens in the bottom editor bar; the cell
                              // itself just mirrors the in-progress text.
                              <span className="datagrid-cell-editing-text">{editValue}</span>
                            ) : isAccountingFormat(cellFmt?.numFmt) && !display.startsWith('#') ? (
                              <span className="datagrid-cell-accounting">
                                <span className="acct-symbol">$</span>
                                <span className="acct-value">{display}</span>
                              </span>
                            ) : (
                              <span className={display.startsWith('#') ? 'datagrid-cell-error' : rawValue.startsWith('=') ? 'datagrid-formula' : ''} title={display.startsWith('#') ? (errorMessages.get(`${effectiveSheetId}:${rowId}:${colId}`) || display) : undefined}>{display}</span>
                            )}
                            {showAutofillHandle && (
                              <div
                                className="autofill-handle"
                                onMouseDown={(e: any) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  const src = selectionRange && isMultiSelect
                                    ? selectionRange
                                    : { minCol: ci, maxCol: ci, minRow: ri, maxRow: ri };
                                  autofillDragRef.current = { sourceRange: src };
                                }}
                              />
                            )}
                            {/* Corner decorations — purely visual (pointer-events: none):
                                hint that the selection can be resized by dragging from
                                inside it. Formula refs get matching corners in their
                                (shared-palette) color. */}
                            {selRect && !editingCell && ci === selRect.minCol && ri === selRect.minRow && (
                              <div className="selection-handle handle-tl" />
                            )}
                            {selRect && !editingCell && !showAutofillHandle && ci === selRect.maxCol && ri === selRect.maxRow && (
                              <div className="selection-handle handle-br" />
                            )}
                            {refInfo && refInfo.top && refInfo.left && (
                              <div className="selection-handle handle-tl" style={{ background: refInfo.color }} />
                            )}
                            {refInfo && refInfo.bottom && refInfo.right && (
                              <div className="selection-handle handle-br" style={{ background: refInfo.color }} />
                            )}
                            {peers && (
                              <div className="datagrid-peer-tip" style={{ background: peers.color }}>
                                {peerDisplayName(peers.peerId, peers.userGroupId)}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    </>
                  );
                })}
                      {endRow < totalRows && (
                        <tr style={{ height: (rowOffsets[totalRows] - rowOffsets[endRow]) + 'px' }}>
                          <td colSpan={visibleColIds.length + 1} />
                        </tr>
                      )}
                    </>
                  );
                })()}
              </tbody>
            </table>
          </div>
          </ContextMenuTrigger>
          <CommandContextMenuContent
            entries={
              contextMenu?.type === 'cell' ? commands.cellCtx
              : contextMenu?.type === 'row' ? commands.rowCtx
              : contextMenu?.type === 'col' ? commands.colCtx
              : []
            }
          />
          </ContextMenu>

          {!focusMode && (
            <SheetTabsBar
              sheets={sheetOrder}
              currentSheetId={effectiveSheetId ?? ''}
              readOnly={!canEdit}
              onSelect={handleSelectSheet}
              onAdd={handleAddSheet}
              onOpenList={() => setSheetListOpen(true)}
              onOpenOptions={() => setSheetOptionsOpen(true)}
            />
          )}
          </div>
        </>
      )}

      </div>

      <ConditionalFormatSheet
        open={condFormatOpen}
        onOpenChange={setCondFormatOpen}
        rules={currentSheet?.conditionalFormats}
        sortedRowIds={sortedRowIds}
        sortedColIds={sortedColIds}
        currentSheetId={currentSheetId ?? ''}
        mutate={mutate}
        selectedCell={selectedCell}
        selectionRange={selectionRange}
        visibleRowIds={visibleRowIds}
        visibleColIds={visibleColIds}
      />
      </div>

      {/* Monte Carlo stats for the selected cell — a strip at the bottom of the
          page, directly above the formula editor. Deliberately not gated on
          focusMode: in overview mode it sits flush at the page bottom instead. */}
      {(() => {
        if (!mcResults || !selectedCell) return null;
        const cellKey = `${effectiveSheetId}:${visibleRowIds[selectedCell[1]]}:${visibleColIds[selectedCell[0]]}`;
        const stats = mcResults.cells.get(cellKey);
        if (!stats) return null;
        return <DistributionPanel stats={stats} isSource={mcResults.sources.has(cellKey)} />;
      })()}

      {/* Focus-mode bottom bar: the (single) cell editor + quick actions.
          Mounted only while a cell is selected so CodeMirror never loads at
          page-load time (avoids the OOM crash — see FormulaEditor). */}
      {focusMode && columnDefs.length > 0 && doc2 && (
        <BottomEditorBar
          value={editingCell ? editValue : formulaBarValue}
          onInput={setEditValue}
          onEditorFocus={() => {
            if (!canEditRef.current) return;
            if (!editingCell && selectedCell) {
              editFromBarRef.current = true;
              startEditing(selectedCell[0], selectedCell[1]);
            }
          }}
          onCommit={() => {
            const cell = editingCell;
            commitEdit();
            if (cell) {
              const nextRow = Math.min(cell[1] + 1, visibleRowIds.length - 1);
              selectCell(cell[0], nextRow);
            }
            tableRef.current?.focus();
          }}
          onCancel={() => {
            cancelEdit();
            tableRef.current?.focus();
          }}
          onTab={() => {
            const cell = editingCell;
            commitEdit();
            if (cell) {
              const nextCol = Math.min(cell[0] + 1, visibleColIds.length - 1);
              selectCell(nextCol, cell[1]);
            }
            tableRef.current?.focus();
          }}
          onBlur={() => {
            setTimeout(() => {
              const ae = document.activeElement;
              if (ae?.closest('.bottom-editor-bar')) return;
              commitEdit();
            }, 0);
          }}
          onHighlightsChange={setFormulaRefHighlights}
          functionNames={formulaNames}
          readOnly={!canEdit}
          apiRef={formulaApiRef}
          previewValue={editorPreviewValue}
          resolveCommand={commands.resolveById}
          onOpenColor={canEdit ? setColorTarget : undefined}
          currentFormat={currentCellFormat}
          onInsertFormula={() => setFormulaInsertOpen(true)}
          aggregates={aggregateChips}
          multiSelect={isMultiSelect && !editingCell}
        />
      )}
      <FormulaInsertSheet
        open={formulaInsertOpen}
        onOpenChange={setFormulaInsertOpen}
        customFunctionNames={formulaNames}
        onInsert={insertFunction}
      />
      {/* Row/column header menu — long-press (touch) or right-click. */}
      <HeaderContextMenu
        kind={headerMenu?.kind ?? 'row'}
        anchor={headerMenu?.anchor ?? null}
        page={headerMenu?.page ?? 'main'}
        onPageChange={(page) => setHeaderMenu(m => m && { ...m, page })}
        onClose={() => { setHeaderMenu(null); setContextMenu(null); }}
        resolveCommand={commands.resolveById}
        onResize={() => { const k = headerMenu?.kind ?? 'row'; setHeaderMenu(null); setResizeKind(k); }}
      />
      <ResizeSheet
        open={resizeKind !== null}
        onOpenChange={(o) => { if (!o) setResizeKind(null); }}
        kind={resizeKind ?? 'row'}
        count={resizeTargetIds.length}
        currentSize={resizeCurrentSize}
        onApply={(size) => {
          if (effectiveSheetId && resizeKind) {
            applyItemSize(mutate, effectiveSheetId, resizeKind, resizeTargetIds, size);
          }
        }}
      />
      <FormatSheet
        open={formatSheetOpen}
        onOpenChange={setFormatSheetOpen}
        currentFormat={currentCellFormat}
        onApply={(patch) => {
          if (commandCtxRef.current) applyFormatToSelection(commandCtxRef.current, patch);
        }}
        onClear={() => commands.resolveById('clear-formatting').execute()}
        onOpenConditional={() => setCondFormatOpen(true)}
        onOpenColor={setColorTarget}
        onOpenNumberFormat={() => setNumFmtOpen(true)}
        onOpenFontFamily={() => setFontFamilyOpen(true)}
      />
      {/* The two long single-selects, as sibling sheets over the format sheet — same
          arrangement as the colour picker, so the format sheet stays put behind them
          and formatting remains iterative. */}
      <PickerSheet
        open={numFmtOpen}
        onOpenChange={setNumFmtOpen}
        title="Number format"
        options={NUMBER_FORMAT_OPTIONS}
        value={currentCellFormat?.numFmt ?? 'auto'}
        onPick={(v) => {
          if (commandCtxRef.current) {
            applyFormatToSelection(commandCtxRef.current, { numFmt: v === 'auto' ? undefined : v });
          }
        }}
        data-testid="number-format-sheet"
      />
      <PickerSheet
        open={fontFamilyOpen}
        onOpenChange={setFontFamilyOpen}
        title="Font"
        options={FONT_FAMILY_OPTIONS}
        value={currentCellFormat?.fontFamily ?? 'Default'}
        onPick={(v) => {
          if (commandCtxRef.current) {
            applyFormatToSelection(commandCtxRef.current, { fontFamily: v === 'Default' ? undefined : v });
          }
        }}
        data-testid="font-family-sheet"
      />
      {/* Colour-only picker, shared by the bottom bar and the format sheet. */}
      <ColorSheet
        target={colorTarget}
        onOpenChange={(o) => { if (!o) setColorTarget(null); }}
        textColor={currentCellFormat?.textColor}
        bgColor={currentCellFormat?.bgColor}
        onApply={(target, color) => {
          if (!commandCtxRef.current) return;
          applyFormatToSelection(commandCtxRef.current,
            target === 'fill' ? { bgColor: color } : { textColor: color });
        }}
        onOpenConditional={() => setCondFormatOpen(true)}
      />
      <SheetListSheet
        open={sheetListOpen}
        onOpenChange={setSheetListOpen}
        sheets={sheetOrder}
        currentSheetId={effectiveSheetId ?? ''}
        readOnly={!canEdit}
        onPick={(id) => {
          const s = sheetOrder.find(sh => sh.id === id);
          if (s?.hidden) {
            if (!canEditRef.current) return;
            handleUnhideSheet(id);
          }
          handleSelectSheet(id);
        }}
      />
      {effectiveSheetId && (
        <SheetOptionsSheet
          open={sheetOptionsOpen}
          onOpenChange={setSheetOptionsOpen}
          sheetId={effectiveSheetId}
          sheetName={meta?.sheets?.[effectiveSheetId]?.name ?? ''}
          onRename={handleRenameSheet}
          canMoveLeft={visibleSheetIds.indexOf(effectiveSheetId) > 0}
          canMoveRight={visibleSheetIds.indexOf(effectiveSheetId) >= 0 && visibleSheetIds.indexOf(effectiveSheetId) < visibleSheetIds.length - 1}
          onMove={handleMoveSheet}
          canHide={visibleSheetIds.length > 1}
          onHide={handleHideSheet}
          canDelete={sheetOrder.length > 1}
          onDelete={handleDeleteSheet}
          frozenRows={frozenRowCount}
          frozenCols={frozenColCount}
          maxFrozenRows={Math.max(0, visibleRowIds.length - 1)}
          maxFrozenCols={Math.max(0, visibleColIds.length - 1)}
          onSetFrozen={(kind, count) => {
            if (effectiveSheetId) applyFreezeCount(mutate, effectiveSheetId, kind, count);
          }}
        />
      )}
    </div>
    </DocLoader>
  );
}
