import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { subscribeQuery, updateDoc } from '../worker-api';
import type { PeerState } from '../../shared/automerge';
import { peerColor, initPresence, type PresenceState } from '../../shared/presence';
import { EditorTitleBar } from '../../shared/EditorTitleBar';
import type { PeerFieldInfo } from '../../shared/presence';
import type { DataGridDocument } from './schema';
import { asMultiSheet } from './schema';
import { useGridCommands, commitReorder, commitAutofill, type GridCommandState, type GridCommandContext } from './commands';
import { CommandMenuBar, CommandToolbar, CommandContextMenuContent } from './CommandBar';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import HyperFormula from 'hyperformula';
import {
  sortedEntries, colIndexToLetter, shortId,
  a1ToInternal, internalToA1,
  buildSheetData, getDisplayValue, cellToHfValue,
  rewriteFormulasForSheetDeletion,
} from './helpers';
import { FormulaEditor, type FormulaHighlight, isRange } from './FormulaEditor';
import { SheetTabs } from './SheetTabs';
import { useUndoRedo } from '../../shared/useUndoRedo';
import { useDocumentHistory } from '../../shared/useDocumentHistory';
import { useAccess } from '../../shared/useAccess';
import { HistorySlider } from '../../shared/HistorySlider';
import { useDocumentValidation } from '../../shared/useDocumentValidation';
import { ValidationPanel } from '../../shared/ValidationPanel';
import { DocLoader } from '../../shared/useDocument';
import { registerCustomFunctions, getDistributionRegistry, clearDistributionRegistry } from './hf-functions';
import { runMonteCarloAsync, type MCResults } from './monte-carlo';
import { DistributionPanel } from './DistributionPanel';
import { formatDistValue } from './helpers';
import { addDocId, getDocEntry, updateDocCache } from '@/doc-storage';
import './datagrid.css';

registerCustomFunctions();

const DATAGRID_QUERY = '{ "@type": .["@type"], name: (.name // "Spreadsheet"), sheets: (.sheets // {}) }';

export function DataGrid({ docId, sheetId, readOnly }: { docId?: string; sheetId?: string; readOnly?: boolean; path?: string }) {
  // Read initial sheet from URL — prefer router-provided sheetId, fall back to parsing hash
  const initialSheetId = sheetId
    || (docId ? window.location.hash.match(/\/sheets\/([^/?#]+)/)?.[1] : undefined);
  const [gridName, setGridName] = useState('Spreadsheet');
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});
  const [, setTick] = useState(0);
  const [selectedCell, setSelectedCell] = useState<[number, number] | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<[number, number] | null>(null);
  const [editingCell, setEditingCell] = useState<[number, number] | null>(null);
  const [editValue, setEditValue] = useState('');
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [selectedCols, setSelectedCols] = useState<Set<number>>(new Set());
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
  const ROW_HEIGHT = 28;
  const OVERSCAN = 15;
  const [rawDoc, setRawDoc] = useState<any>(null);
  const docRef = useRef<DataGridDocument | null>(null);
  const broadcastRef = useRef<((key: keyof PresenceState, value: any) => void) | null>(null);
  const validationErrors = useDocumentValidation(docId);
  const { undo, redo, canUndo, canRedo } = useUndoRedo(docId!);
  const history = useDocumentHistory(docId!);
  const { canEdit: accessCanEdit } = useAccess(getDocEntry(docId!)?.khDocId);
  const canEdit = !readOnly && history.editable && accessCanEdit;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const hfRef = useRef<HyperFormula | null>(null);
  const [syncing, setSyncing] = useState(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtySheetsRef = useRef<Set<number>>(new Set());
  const titleFocusedRef = useRef(false);
  const editFromBarRef = useRef(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const lastClickedRowRef = useRef<number | null>(null);
  const lastClickedColRef = useRef<number | null>(null);
  const dragRef = useRef<{ type: 'row' | 'col'; indices: number[] } | null>(null);
  const justDraggedRef = useRef(false);
  const cellDragRef = useRef<{ anchor: [number, number] } | null>(null);
  const autofillDragRef = useRef<{ sourceRange: { minCol: number; maxCol: number; minRow: number; maxRow: number } } | null>(null);
  const dispatchKeyRef = useRef<((e: KeyboardEvent, isMod: boolean) => boolean) | null>(null);
  const commandCtxRef = useRef<GridCommandContext | null>(null);
  const sheetRenameRef = useRef<((id: string) => void) | null>(null);
  const [autofillTarget, setAutofillTarget] = useState<{ minCol: number; maxCol: number; minRow: number; maxRow: number } | null>(null);
  const [clipboardSource, setClipboardSource] = useState<{ minRow: number; maxRow: number; minCol: number; maxCol: number } | null>(null);
  const [sheetContextMenu, setSheetContextMenu] = useState<string | null>(null);
  const clipboardRef = useRef<{
    values: string[][];
    mode: 'copy' | 'cut';
    range: { minRow: number; maxRow: number; minCol: number; maxCol: number };
  } | null>(null);

  const [addRowCount, setAddRowCount] = useState(10);
  const [mcResults, setMcResults] = useState<MCResults | null>(null);
  const mcCancelRef = useRef<(() => void) | null>(null);

  const [currentSheetId, setCurrentSheetId] = useState<string | null>(null);

  // Memoize sorted IDs from the current sheet
  const docState = docRef.current;
  // Fall back to first sheet if currentSheetId doesn't exist in this doc version
  const effectiveSheetId = docState?.sheets && currentSheetId && !docState.sheets[currentSheetId]
    ? Object.keys(docState.sheets)[0] ?? currentSheetId
    : currentSheetId;
  const currentSheet = docState && effectiveSheetId ? docState.sheets?.[effectiveSheetId] ?? null : null;

  const sortedColIds = useMemo(() => {
    if (!currentSheet?.columns) return [];
    return sortedEntries(currentSheet.columns).map(([id]) => id);
  }, [currentSheet?.columns]);

  const sortedRowIds = useMemo(() => {
    if (!currentSheet?.rows) return [];
    return sortedEntries(currentSheet.rows).map(([id]) => id);
  }, [currentSheet?.rows]);

  const columnDefs = useMemo(() => {
    if (!currentSheet?.columns) return [];
    return sortedEntries(currentSheet.columns).map(([id, col]) => ({ id, ...col }));
  }, [currentSheet?.columns]);

  // Sheet ordering for HyperFormula and tabs
  const sheetOrder = useMemo(() => {
    if (!docState?.sheets) return [];
    return sortedEntries(docState.sheets).map(([id, s]) => ({ id, name: s.name, hidden: s.hidden }));
  }, [docState?.sheets]);

  const hfSheetIndex = useMemo(() => {
    if (!effectiveSheetId) return 0;
    const idx = sheetOrder.findIndex(s => s.id === effectiveSheetId);
    return idx >= 0 ? idx : 0;
  }, [effectiveSheetId, sheetOrder]);

  const sheetNameLookup = useCallback((sheetId: string) => {
    return docState?.sheets?.[sheetId]?.name;
  }, [docState?.sheets]);

  const sheetIdLookup = useCallback((name: string) => {
    if (!docState?.sheets) return undefined;
    const lower = name.toLowerCase();
    for (const [id, s] of Object.entries(docState.sheets)) {
      if (s.name.toLowerCase() === lower) return id;
    }
    return undefined;
  }, [docState?.sheets]);

  const sheetRowColLookup = useCallback((sheetId: string) => {
    const sheet = docState?.sheets?.[sheetId];
    if (!sheet) return undefined;
    return {
      rowIds: sortedEntries(sheet.rows).map(([rid]) => rid),
      colIds: sortedEntries(sheet.columns).map(([cid]) => cid),
    };
  }, [docState?.sheets]);

  // Rebuild HyperFormula from all sheets. Called when sheet structure changes.
  const rebuildHyperFormula = useCallback(() => {
    const d = docRef.current;
    if (!d?.sheets) return;
    hfRef.current?.destroy();
    const order = sortedEntries(d.sheets);
    const sheetsData: Record<string, (string | number | boolean | null)[][]> = {};
    const sheetNameLookupFn = (id: string) => d.sheets[id]?.name;
    const sheetRowColFn = (id: string) => {
      const s = d.sheets[id];
      if (!s) return undefined;
      return { rowIds: sortedEntries(s.rows).map(([r]) => r), colIds: sortedEntries(s.columns).map(([c]) => c) };
    };
    for (const [, sheet] of order) {
      const rIds = sortedEntries(sheet.rows).map(([rid]) => rid);
      const cIds = sortedEntries(sheet.columns).map(([cid]) => cid);
      sheetsData[sheet.name] = buildSheetData(sheet.cells, rIds, cIds, sheetNameLookupFn, sheetRowColFn);
    }
    hfRef.current = HyperFormula.buildFromSheets(sheetsData, { licenseKey: 'gpl-v3' });
    setTick(t => t + 1);
  }, []);

  // Sync a single HyperFormula sheet by index.
  const syncHfSheet = useCallback((hf: HyperFormula, sheetIdx: number) => {
    const d = docRef.current;
    if (!d?.sheets) return;
    const order = sortedEntries(d.sheets);
    if (sheetIdx < 0 || sheetIdx >= order.length) return;
    const [, sheet] = order[sheetIdx];
    const sheetNameLookupFn = (id: string) => d.sheets[id]?.name;
    const sheetRowColFn = (id: string) => {
      const s = d.sheets[id];
      if (!s) return undefined;
      return { rowIds: sortedEntries(s.rows).map(([r]) => r), colIds: sortedEntries(s.columns).map(([c]) => c) };
    };
    const rIds = sortedEntries(sheet.rows).map(([rid]) => rid);
    const cIds = sortedEntries(sheet.columns).map(([cid]) => cid);
    const data = buildSheetData(sheet.cells, rIds, cIds, sheetNameLookupFn, sheetRowColFn);
    hf.setSheetContent(sheetIdx, data);
  }, []);

  // Schedule MC simulation after HF sync
  const scheduleMC = useCallback(() => {
    if (mcCancelRef.current) { mcCancelRef.current(); mcCancelRef.current = null; }
    const d = docRef.current;
    const registry = getDistributionRegistry();
    if (!d || registry.size === 0) {
      setMcResults(null);
      return;
    }
    // Deep-copy registry since it may get cleared
    const regCopy = new Map(registry);
    mcCancelRef.current = runMonteCarloAsync(d, regCopy, (results) => {
      mcCancelRef.current = null;
      setMcResults(results);
    });
  }, []);

  // Sync HyperFormula when doc changes (remote edits, structural changes).
  // Only syncs the current sheet; marks all others dirty for lazy re-sync on switch.
  const syncHyperFormula = useCallback(() => {
    const d = docRef.current;
    const hf = hfRef.current;
    if (!d?.sheets || !hf) return;
    const order = sortedEntries(d.sheets);
    // If sheet count changed, do a full rebuild
    if (hf.countSheets() !== order.length) {
      rebuildHyperFormula();
      setSyncing(false);
      clearDistributionRegistry();
      return;
    }
    // Find the current sheet's HF index
    const curIdx = currentSheetId ? order.findIndex(([id]) => id === currentSheetId) : 0;
    const activeIdx = curIdx >= 0 ? curIdx : 0;
    // Sync only the active sheet; mark all others dirty
    clearDistributionRegistry();
    syncHfSheet(hf, activeIdx);
    dirtySheetsRef.current.clear();
    for (let i = 0; i < order.length; i++) {
      if (i !== activeIdx) dirtySheetsRef.current.add(i);
    }
    setSyncing(false);
    setTick(t => t + 1);
    scheduleMC();
  }, [rebuildHyperFormula, syncHfSheet, currentSheetId, scheduleMC]);

  // Debounced async wrapper — shows progress bar, then runs sync after a short delay.
  const scheduleSyncHyperFormula = useCallback((delay = 50) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    setSyncing(true);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      syncHyperFormula();
    }, delay);
  }, [syncHyperFormula]);

  // Single gateway for all document mutations.
  const mutate = useCallback((fn: (d: any) => void, args: Record<string, unknown> = {}, noHfSync = false) => {
    if (!canEditRef.current || !docId) return;
    updateDoc(docId, fn, args);
    if (!noHfSync) scheduleSyncHyperFormula();
    else setTick(t => t + 1);
  }, [scheduleSyncHyperFormula, docId]);

  // Write a cell value to the Automerge doc and update HyperFormula incrementally.
  // Bypasses scheduleSyncHyperFormula() to avoid a full sheet rebuild on every keystroke.
  const commitCellValue = useCallback((col: number, row: number, value: string) => {
    if (!canEditRef.current || !docId) return;
    if (col >= sortedColIds.length || row >= sortedRowIds.length || !currentSheetId) return;
    const rowId = sortedRowIds[row];
    const colId = sortedColIds[col];
    const cellKey = `${rowId}:${colId}`;
    const sid = currentSheetId;
    const stored = value.startsWith('=')
      ? a1ToInternal(value, row, col, sortedRowIds, sortedColIds, sheetIdLookup, sheetRowColLookup)
      : value;
    updateDoc(docId, (d) => {
      const existing = d.sheets[sid].cells[cellKey];
      if (stored === '') { if (existing) delete d.sheets[sid].cells[cellKey]; }
      else if (!existing) { d.sheets[sid].cells[cellKey] = { value: stored }; }
      else if (existing.value !== stored) { existing.value = stored; }
    }, { sid, cellKey, stored });
    const hf = hfRef.current;
    if (hf) {
      const hfValue = cellToHfValue(stored || undefined, row, col, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup);
      if (hfSheetIndex < hf.countSheets()) {
        hf.setCellContents({ sheet: hfSheetIndex, col, row }, [[hfValue]]);
      }
    }
    setTick(t => t + 1);
  }, [sortedColIds, sortedRowIds, currentSheetId, sheetIdLookup, sheetRowColLookup, sheetNameLookup, hfSheetIndex, docId]);

  // Start editing a cell
  const startEditing = useCallback((col: number, row: number) => {
    if (!canEditRef.current) return;
    const d = docRef.current;
    if (!d || !currentSheetId) return;
    const sh = d.sheets[currentSheetId];
    if (!sh) return;
    const rowId = sortedRowIds[row];
    const colId = sortedColIds[col];
    const raw = sh.cells[`${rowId}:${colId}`]?.value || '';
    const display = raw.startsWith('=') ? internalToA1(raw, row, col, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup) : raw;
    setEditingCell([col, row]);
    setEditValue(display);
  }, [sortedColIds, sortedRowIds, currentSheetId, sheetNameLookup, sheetRowColLookup]);

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

  // Selection change → broadcast presence
  const selectCell = useCallback((col: number, row: number) => {
    setSelectedCell([col, row]);
    setSelectionAnchor(null);
    setSelectedRows(new Set());
    setSelectedCols(new Set());
    tableRef.current?.focus();
    if (broadcastRef.current && row < sortedRowIds.length && col < sortedColIds.length) {
      broadcastRef.current('focusedField', ['sheets', currentSheetId!, 'cells', `${sortedRowIds[row]}:${sortedColIds[col]}`]);
    }
  }, [sortedRowIds, sortedColIds, currentSheetId]);

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

  // Autofill handle: show at bottom-right of selection when not editing
  const autofillHandleCell = useMemo(() => {
    if (editingCell) return null;
    if (selectionRange && isMultiSelect) return [selectionRange.maxCol, selectionRange.maxRow] as [number, number];
    if (selectedCell) return selectedCell;
    return null;
  }, [editingCell, selectionRange, isMultiSelect, selectedCell]);

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

      if (ci < sortedColIds.length && currentSheetId) {
        const colId = sortedColIds[ci];
        const sid = currentSheetId;
        mutate((d) => { d.sheets[sid].columns[colId].width = finalWidth; }, { sid, colId, finalWidth }, true);
      }
    };

    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [columnDefs, sortedColIds, mutate, currentSheetId]);

  const autoFitColumn = useCallback((ci: number) => {
    const container = tableRef.current;
    if (!container || ci >= sortedColIds.length || !currentSheetId) return;
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
    const colId = sortedColIds[ci];
    const sid = currentSheetId;
    mutate((d) => { d.sheets[sid].columns[colId].width = Math.ceil(maxWidth); }, { sid, colId, finalWidth: Math.ceil(maxWidth) }, true);
  }, [sortedColIds, mutate, currentSheetId]);

  // -- Sheet management handlers --

  const handleSelectSheet = useCallback((id: string) => {
    if (id === currentSheetId) return;
    if (editingCell) commitEdit();
    // Sync target sheet if it was dirtied by a remote peer edit while we were on another sheet
    const newIdx = sheetOrder.findIndex(s => s.id === id);
    const hf = hfRef.current;
    if (hf && newIdx >= 0 && dirtySheetsRef.current.has(newIdx)) {
      syncHfSheet(hf, newIdx);
      dirtySheetsRef.current.delete(newIdx);
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
    // Update URL without triggering hashchange (which would cause router rematch → remount)
    if (docId) {
      const base = window.location.href.split('#')[0];
      window.history.replaceState(null, '', `${base}#/datagrids/${docId}/sheets/${id}`);
    }
  }, [currentSheetId, editingCell, commitEdit, sheetOrder, syncHfSheet, docId]);

  const handleAddSheet = useCallback(() => {
    const docSnap = docRef.current;
    if (!docSnap || !docId) return;
    const maxIndex = Object.values(docSnap.sheets).reduce((max, s) => Math.max(max, s.index), 0);
    const sheetCount = Object.keys(docSnap.sheets).length;
    const sid = shortId();
    const cols: Record<string, { index: number; name: string }> = {};
    for (let i = 0; i < 3; i++) cols[shortId()] = { index: i + 1, name: '' };
    const rows: Record<string, { index: number }> = {};
    for (let i = 0; i < 10; i++) rows[shortId()] = { index: i + 1 };
    const newSheet = { '@type': 'Sheet', name: `Sheet ${sheetCount + 1}`, index: maxIndex + 1, columns: cols, rows, cells: {} };
    updateDoc(docId, (d) => { d.sheets[sid] = newSheet as any; }, { sid, newSheet });
    rebuildHyperFormula();
    handleSelectSheet(sid);
  }, [docId, handleSelectSheet, rebuildHyperFormula]);

  const handleRenameSheet = useCallback((id: string, name: string) => {
    mutate((d) => { d.sheets[id].name = name; }, { id, name }, true);
  }, [mutate]);

  const handleDeleteSheet = useCallback((id: string) => {
    const docSnap = docRef.current;
    if (!docSnap || !docId) return;
    if (Object.keys(docSnap.sheets).length <= 1) return;
    const rewrites = rewriteFormulasForSheetDeletion(docSnap.sheets as any, id);
    const remaining = sortedEntries(docSnap.sheets).filter(([sid]) => sid !== id);
    updateDoc(docId, (d) => {
      for (const [sheetId, cellUpdates] of Object.entries(rewrites)) {
        for (const [cellKey, newFormula] of Object.entries(cellUpdates)) {
          if (d.sheets[sheetId]?.cells?.[cellKey]) d.sheets[sheetId].cells[cellKey].value = newFormula;
        }
      }
      delete d.sheets[id];
    }, { id, rewrites });
    rebuildHyperFormula();
    if (id === currentSheetId) {
      setCurrentSheetId(remaining.length > 0 ? remaining[0][0] : null);
      setSelectedCell(null); setSelectionAnchor(null); setEditingCell(null);
      setSelectedRows(new Set()); setSelectedCols(new Set()); setClipboardSource(null);
    }
  }, [docId, currentSheetId, rebuildHyperFormula]);

  const handleHideSheet = useCallback((id: string) => {
    const docSnap = docRef.current;
    if (!docSnap) return;
    const visibleCount = Object.values(docSnap.sheets).filter(s => !s.hidden).length;
    if (visibleCount <= 1) return;
    mutate((d) => { d.sheets[id].hidden = true; }, { id }, true);
    if (id === currentSheetId) {
      const order = sortedEntries(docSnap.sheets);
      const firstVisible = order.find(([, s]) => !s.hidden);
      if (firstVisible) handleSelectSheet(firstVisible[0]);
    }
  }, [mutate, currentSheetId, handleSelectSheet]);

  const handleReorderSheet = useCallback((draggedId: string, dropIndex: number) => {
    const docSnap = docRef.current;
    if (!docSnap) return;
    const order = sortedEntries(docSnap.sheets);
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
    mutate((d) => { d.sheets[draggedId].index = newIdx; }, { draggedId, newIdx }, true);
  }, [mutate]);

  // -- Context menu handlers --

  const handleRowContextMenu = useCallback((ri: number, _e: MouseEvent) => {
    const indices = selectedRows.has(ri) ? [...selectedRows].sort((a, b) => a - b) : [ri];
    if (!selectedRows.has(ri)) {
      setSelectedRows(new Set([ri]));
      setSelectedCols(new Set());
      setSelectedCell(null);
      lastClickedRowRef.current = ri;
    }
    setContextMenu({ type: 'row', indices });
  }, [selectedRows]);

  const handleColContextMenu = useCallback((ci: number, _e: MouseEvent) => {
    const indices = selectedCols.has(ci) ? [...selectedCols].sort((a, b) => a - b) : [ci];
    if (!selectedCols.has(ci)) {
      setSelectedCols(new Set([ci]));
      setSelectedRows(new Set());
      setSelectedCell(null);
      lastClickedColRef.current = ci;
    }
    setContextMenu({ type: 'col', indices });
  }, [selectedCols]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (editingCell) { cancelEdit(); return; }
      if (selectionAnchor) { setSelectionAnchor(null); return; }
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
      return;
    }
    if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (!selectionAnchor) setSelectionAnchor([col, row]);
      let nc = col, nr = row;
      if (e.key === 'ArrowRight') nc = Math.min(col + 1, sortedColIds.length - 1);
      else if (e.key === 'ArrowLeft') nc = Math.max(col - 1, 0);
      else if (e.key === 'ArrowDown') nr = Math.min(row + 1, sortedRowIds.length - 1);
      else if (e.key === 'ArrowUp') nr = Math.max(row - 1, 0);
      setSelectedCell([nc, nr]);
      return;
    }

    let newCol = col, newRow = row;
    if (e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); newCol = Math.min(col + 1, sortedColIds.length - 1); }
    else if (e.key === 'ArrowLeft') { newCol = Math.max(col - 1, 0); }
    else if (e.key === 'ArrowDown') { newRow = Math.min(row + 1, sortedRowIds.length - 1); }
    else if (e.key === 'ArrowUp') { newRow = Math.max(row - 1, 0); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      setSelectionAnchor(null);
      setEditingCell([col, row]);
      setEditValue(e.key);
      return;
    }
    else return;

    if (newCol !== col || newRow !== row) {
      selectCell(newCol, newRow);
    }
  }, [editingCell, selectedCell, selectionAnchor, selectionRange, sortedColIds, sortedRowIds, startEditing, selectCell, cancelEdit]);

  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    el.addEventListener('keydown', handleKeyDown);
    return () => el.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Track scroll position and viewport height for row virtualization.
  // The container scrolls (not the page), so we listen on the container element.
  useEffect(() => {
    const el = tableRef.current;
    if (!el) return;
    const handleScroll = () => {
      setScrollTop(el.scrollTop);
    };
    const updateHeight = () => {
      setViewportHeight(el.clientHeight);
    };
    updateHeight();
    el.addEventListener('scroll', handleScroll, { passive: true });
    const ro = new ResizeObserver(updateHeight);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', handleScroll);
      ro.disconnect();
    };
  }, []);

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


  // Peer presence cell map — keyed by "col:row", first peer wins
  const peerCellMap = useMemo(() => {
    const map: Record<string, PeerFieldInfo> = {};
    for (const peer of Object.values(peerStates)) {
      const pf = peer.value.focusedField;
      if (!pf || pf.length < 4 || pf[0] !== 'sheets' || pf[1] !== currentSheetId || pf[2] !== 'cells') continue;
      const cellKey = String(pf[3]);
      const sep = cellKey.indexOf(':');
      if (sep === -1) continue;
      const rowId = cellKey.slice(0, sep);
      const colId = cellKey.slice(sep + 1);
      const col = sortedColIds.indexOf(colId);
      const row = sortedRowIds.indexOf(rowId);
      if (col >= 0 && row >= 0) {
        const key = `${col}:${row}`;
        if (!map[key]) map[key] = { color: peerColor(peer.peerId), peerId: peer.peerId };
      }
    }
    return map;
  }, [peerStates, sortedColIds, sortedRowIds, currentSheetId]);

  // Load document and init presence
  useEffect(() => {
    if (!docId) return;

    let mounted = true;

    const unsubscribe = subscribeQuery(docId, DATAGRID_QUERY, (result, heads) => {
      if (!mounted || !result) return;
      const d = asMultiSheet(result);

      if (!docRef.current) {
        // First load
        addDocId(docId, { type: 'DataGrid', name: result.name });
        const order = sortedEntries(d.sheets);
        const firstSheetId = order.length > 0 ? order[0][0] : null;
        const validInitial = initialSheetId && d.sheets[initialSheetId] ? initialSheetId : null;
        setCurrentSheetId(validInitial ?? firstSheetId);
      }

      setRawDoc(result);
      docRef.current = d;
      if (!titleFocusedRef.current && d.name) setGridName(d.name);
      document.title = (d.name || 'Spreadsheet') + ' - Spreadsheet';
      history.onNewHeads(heads);
      scheduleSyncHyperFormula();
    });

    const { broadcast, cleanup: presenceCleanup } = initPresence<PresenceState>(
      docId,
      () => ({ viewing: true, focusedField: null }),
      (states) => { if (mounted) setPeerStates(states); },
    );
    broadcastRef.current = broadcast;

    return () => {
      mounted = false;
      broadcastRef.current = null;
      presenceCleanup();
      unsubscribe();
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      if (mcCancelRef.current) { mcCancelRef.current(); mcCancelRef.current = null; }
      hfRef.current?.destroy();
      hfRef.current = null;
    };
  }, [docId]);

  // Formula bar value
  const formulaBarValue = useMemo(() => {
    if (!selectedCell || !currentSheet) return '';
    const [col, row] = selectedCell;
    if (row >= sortedRowIds.length || col >= sortedColIds.length) return '';
    const rowId = sortedRowIds[row];
    const colId = sortedColIds[col];
    const raw = currentSheet.cells[`${rowId}:${colId}`]?.value || '';
    return raw.startsWith('=') ? internalToA1(raw, row, col, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup) : raw;
  }, [selectedCell, currentSheet, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup]);

  // Cell address label (e.g. "A1", "A1:C3", "2:5", "A:C")
  const cellLabel = useMemo(() => {
    if (selectedRows.size > 0) {
      const rows = [...selectedRows].sort((a, b) => a - b);
      const min = rows[0] + 1;
      const max = rows[rows.length - 1] + 1;
      return min === max ? `${min}:${min}` : `${min}:${max}`;
    }
    if (selectedCols.size > 0) {
      const cols = [...selectedCols].sort((a, b) => a - b);
      const min = colIndexToLetter(cols[0]);
      const max = colIndexToLetter(cols[cols.length - 1]);
      return min === max ? `${min}:${min}` : `${min}:${max}`;
    }
    if (!selectedCell) return '';
    const [col, row] = selectedCell;
    if (selectionRange && isMultiSelect) {
      return `${colIndexToLetter(selectionRange.minCol)}${selectionRange.minRow + 1}:${colIndexToLetter(selectionRange.maxCol)}${selectionRange.maxRow + 1}`;
    }
    return `${colIndexToLetter(col)}${row + 1}`;
  }, [selectedCell, selectedRows, selectedCols, selectionRange, isMultiSelect]);

  const formulaNames = useMemo(() => {
    try { return HyperFormula.getRegisteredFunctionNames('enGB').sort(); }
    catch { return []; }
  }, []);

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

  const peerList = Object.values(peerStates).filter(p => p.value.viewing);
  const doc2 = docRef.current;
  const hf = hfRef.current;

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

  const commandState: GridCommandState = {
    canUndo,
    canRedo,
    hasSelection: selectedCell !== null,
    currentRowIndices,
    currentColIndices,
    sheetCount: sheetOrder.length,
    contextScope: contextMenu
      ? { type: contextMenu.type, indices: contextMenu.indices }
      : null,
  };
  const commandCtx: GridCommandContext = {
    doc: doc2 ?? null,
    hf: hfRef.current,
    currentSheetId: currentSheetId ?? '',
    hfSheetIndex,
    sortedRowIds,
    sortedColIds,
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
    targetSheetId: sheetContextMenu ?? undefined,
    onDeleteSheet: handleDeleteSheet,
    onHideSheet: handleHideSheet,
    onRenameSheet: (id) => {
      // Close context menu first, then SheetTabs will handle inline rename
      setSheetContextMenu(null);
      sheetRenameRef.current?.(id);
    },
  };
  commandCtxRef.current = commandCtx;
  const commands = useGridCommands(commandState, commandCtx);
  dispatchKeyRef.current = commands.dispatchKey;

  return (
    <DocLoader docId={docId}>
    <div className="datagrid-page">
      <EditorTitleBar
        icon="grid_on"
        title={gridName}
        titleEditable={canEdit}
        onTitleFocus={() => { titleFocusedRef.current = true; }}
        onTitleChange={setGridName}
        onTitleBlur={(value) => {
          titleFocusedRef.current = false;
          const name = value.trim() || 'Spreadsheet';
          setGridName(name);
          if (docId) updateDoc(docId, (d) => { d.name = name; }, { name });
          document.title = name + ' - Spreadsheet';
        }}
        docId={docId}
        peers={peerList}
        onToggleHistory={history.toggleHistory}
        historyActive={history.active}
        khDocId={getDocEntry(docId!)?.khDocId}
        docType="DataGrid"
        sharingGroupId={getDocEntry(docId!)?.sharingGroupId}
        onSharingEnabled={(khDocId, groupId) => updateDocCache(docId!, { khDocId, sharingGroupId: groupId })}
      />
      <HistorySlider history={history} />
      <ValidationPanel errors={validationErrors} docId={docId} />

      {columnDefs.length > 0 && doc2 && (
        <>
          <CommandMenuBar menus={commands.menus} />

          <CommandToolbar entries={commands.toolbar} />

          {/* Formula bar — shows a CodeMirror editor once a cell is selected,
              so CodeMirror is never loaded at page-load time (avoids OOM crash). */}
          <div className="formula-bar">
            <span className="formula-cell-label">{cellLabel}</span>
            {selectedCell ? (
              <FormulaEditor
                className="formula-bar-cm"
                value={editingCell ? editValue : formulaBarValue}
                onInput={setEditValue}
                onFocus={() => {
                  if (!editingCell) {
                    editFromBarRef.current = true;
                    startEditing(selectedCell[0], selectedCell[1]);
                  }
                }}
                onCommit={() => {
                  const cell = editingCell;
                  commitEdit();
                  if (cell) {
                    const nextRow = Math.min(cell[1] + 1, sortedRowIds.length - 1);
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
                    const nextCol = Math.min(cell[0] + 1, sortedColIds.length - 1);
                    selectCell(nextCol, cell[1]);
                  }
                  tableRef.current?.focus();
                }}
                onHighlightsChange={setFormulaRefHighlights}
                onBlur={() => {
                  setTimeout(() => {
                    const ae = document.activeElement;
                    if (ae?.closest('.formula-bar-cm')) return;
                    if (ae?.closest('.cell-editor-cm')) return;
                    commitEdit();
                  }, 0);
                }}
                functionNames={formulaNames}
                autoFocus={false}
              />
            ) : (
              <input className="formula-input" readOnly value="" />
            )}
          </div>

          {syncing && (
            <div className="hf-sync-bar">
              <div className="hf-sync-bar-fill" />
            </div>
          )}

          {/* Distribution stats panel */}
          {(() => {
            if (!mcResults || !selectedCell) return null;
            const cellKey = `${hfSheetIndex}:${selectedCell[0]}:${selectedCell[1]}`;
            const stats = mcResults.cells.get(cellKey);
            if (!stats) return null;
            return <DistributionPanel stats={stats} isSource={mcResults.sources.has(cellKey)} />;
          })()}

          {/* Grid table + sheet tabs wrapper */}
          <div className="datagrid-wrapper">
          <ContextMenu modal={false} onOpenChange={(open: boolean) => { if (!open) setContextMenu(null); }}>
          <ContextMenuTrigger asChild>
          <div className="datagrid-container" ref={tableRef} tabIndex={0}>
            <table className="datagrid-table" style={{ width: columnDefs.reduce((sum, col, i) => sum + ((resizingCol?.index === i ? resizingCol.width : col.width) || 100), 48) }}>
              <thead>
                <tr>
                  <th className="datagrid-row-header datagrid-corner-header" />
                  {columnDefs.map((col, ci) => {
                    const isColSelected = selectedCols.has(ci);
                    let dropClass = '';
                    if (dropIndicator?.type === 'col') {
                      if (dropIndicator.index === ci) dropClass = ' drop-left';
                      else if (dropIndicator.index === ci + 1 && ci === columnDefs.length - 1) dropClass = ' drop-right';
                    }
                    return (
                      <th
                        key={col.id}
                        className={'datagrid-col-header' + (isColSelected ? ' selected' : '') + dropClass}
                        style={{ width: (resizingCol?.index === ci ? resizingCol.width : col.width) || 100 }}
                        data-col-index={ci}
                        onClick={(e: any) => handleColHeaderClick(ci, e)}
                        onContextMenu={(e: any) => handleColContextMenu(ci, e)}
                        onMouseDown={(e: any) => handleHeaderMouseDown('col', ci, e)}
                      >
                        {colIndexToLetter(ci)}
                        <div className="col-resize-handle" onMouseDown={(e: any) => handleResizeMouseDown(ci, e)} onDblClick={(e: any) => { e.stopPropagation(); autoFitColumn(ci); }} />
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const totalRows = sortedRowIds.length;
                  const firstVisible = Math.floor(scrollTop / ROW_HEIGHT);
                  const startRow = Math.max(0, firstVisible - OVERSCAN);
                  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT);
                  const endRow = Math.min(totalRows, firstVisible + visibleCount + OVERSCAN);
                  return (
                    <>
                      {startRow > 0 && (
                        <tr style={{ height: startRow * ROW_HEIGHT + 'px' }}>
                          <td colSpan={sortedColIds.length + 1} />
                        </tr>
                      )}
                      {sortedRowIds.slice(startRow, endRow).map((rowId, offset) => {
                  const ri = startRow + offset;
                  const isRowSelected = selectedRows.has(ri);
                  let dropClass = '';
                  if (dropIndicator?.type === 'row') {
                    if (dropIndicator.index === ri) dropClass = ' drop-above';
                    else if (dropIndicator.index === ri + 1 && ri === sortedRowIds.length - 1) dropClass = ' drop-below';
                  }
                  return (
                    <tr key={rowId}>
                      <td
                        className={'datagrid-row-header' + (isRowSelected ? ' selected' : '') + dropClass}
                        data-row-index={ri}
                        onClick={(e: any) => handleRowHeaderClick(ri, e)}
                        onContextMenu={(e: any) => handleRowContextMenu(ri, e)}
                        onMouseDown={(e: any) => handleHeaderMouseDown('row', ri, e)}
                      >
                        {ri + 1}
                      </td>
                      {sortedColIds.map((colId, ci) => {
                        const isSelected = selectedCell && selectedCell[0] === ci && selectedCell[1] === ri;
                        const isEditing = editingCell && editingCell[0] === ci && editingCell[1] === ri;
                        const peers = peerCellMap[`${ci}:${ri}`];
                        const refInfo = refHighlightMap.get(`${ci}:${ri}`);
                        const rawValue = currentSheet?.cells[`${rowId}:${colId}`]?.value || '';
                        const safeHfIdx = hf && hfSheetIndex < hf.countSheets() ? hfSheetIndex : undefined;
                        let display = getDisplayValue(safeHfIdx !== undefined ? hf : null, rawValue, ci, ri, safeHfIdx ?? 0);
                        const mcKey = `${hfSheetIndex}:${ci}:${ri}`;
                        const mcStats = mcResults?.cells.get(mcKey);
                        const isMcSource = mcResults?.sources.has(mcKey);
                        if (mcStats && !display.startsWith('#')) {
                          display = formatDistValue(mcStats.mean, mcStats.stdev);
                        }
                        const inRange = selectionRange && ci >= selectionRange.minCol && ci <= selectionRange.maxCol && ri >= selectionRange.minRow && ri <= selectionRange.maxRow;
                        const inAutofillTarget = autofillTarget && ci >= autofillTarget.minCol && ci <= autofillTarget.maxCol && ri >= autofillTarget.minRow && ri <= autofillTarget.maxRow;
                        const showAutofillHandle = autofillHandleCell && autofillHandleCell[0] === ci && autofillHandleCell[1] === ri && !autofillDragRef.current;

                        const cellStyle: Record<string, string> = {};
                        if (peers) cellStyle.boxShadow = `inset 0 0 0 2px ${peers.color}`;
                        if (refInfo) {
                          const c = refInfo.color;
                          const dash = `2px dashed ${c}`;
                          const none = '1px solid #dee2e6';
                          cellStyle.borderTop = refInfo.top ? dash : none;
                          cellStyle.borderRight = refInfo.right ? dash : none;
                          cellStyle.borderBottom = refInfo.bottom ? dash : none;
                          cellStyle.borderLeft = refInfo.left ? dash : none;
                          if (refInfo.active) cellStyle.background = `${c}18`;
                        }
                        if (clipboardSource && ci >= clipboardSource.minCol && ci <= clipboardSource.maxCol && ri >= clipboardSource.minRow && ri <= clipboardSource.maxRow) {
                          const dash = '2px dashed #228be6';
                          const none = '1px solid #dee2e6';
                          cellStyle.borderTop = ri === clipboardSource.minRow ? dash : none;
                          cellStyle.borderBottom = ri === clipboardSource.maxRow ? dash : none;
                          cellStyle.borderLeft = ci === clipboardSource.minCol ? dash : none;
                          cellStyle.borderRight = ci === clipboardSource.maxCol ? dash : none;
                        }

                        return (
                          <td
                            key={colId}
                            className={'datagrid-cell' + (isSelected && !refInfo && !isEditing ? ' selected' : '') + (inRange && isMultiSelect ? ' in-range' : '') + (inAutofillTarget ? ' autofill-target' : '') + (isRowSelected || selectedCols.has(ci) ? ' header-selected' : '') + (peers ? ' peer-focused' : '') + (refInfo ? ' formula-ref-highlight' : '') + (isMcSource ? ' dist-source' : mcStats ? ' dist-dependent' : '')}
                            style={Object.keys(cellStyle).length > 0 ? cellStyle : undefined}
                            title={mcStats ? `μ=${mcStats.mean.toFixed(2)} σ=${mcStats.stdev.toFixed(2)} [P5=${mcStats.p5.toFixed(2)}, P95=${mcStats.p95.toFixed(2)}]` : peers ? `Peer ${peers.peerId.slice(0, 8)}` : undefined}
                            data-cell-col={ci}
                            data-cell-row={ri}
                            onMouseDown={(e: any) => {
                              if (e.button !== 0) return;
                              if (isEditing) return; // let the in-cell editor handle clicks
                              if (editingCell) commitEdit();
                              if (e.shiftKey && selectedCell) {
                                if (!selectionAnchor) setSelectionAnchor([...selectedCell] as [number, number]);
                                setSelectedCell([ci, ri]);
                              } else {
                                selectCell(ci, ri);
                                cellDragRef.current = { anchor: [ci, ri] };
                              }
                            }}
                            onDblClick={() => startEditing(ci, ri)}
                            onContextMenu={() => {
                              if (!isSelected && !inRange) selectCell(ci, ri);
                              setContextMenu({ type: 'cell', indices: [] });
                            }}
                          >
                            {isEditing ? (
                              <>
                                <FormulaEditor
                                  value={editValue}
                                  onInput={setEditValue}
                                  onHighlightsChange={setFormulaRefHighlights}
                                  onCommit={() => {
                                    commitEdit();
                                    const nextRow = Math.min(ri + 1, sortedRowIds.length - 1);
                                    selectCell(ci, nextRow);
                                    tableRef.current?.focus();
                                  }}
                                  onCancel={() => {
                                    cancelEdit();
                                    tableRef.current?.focus();
                                  }}
                                  onTab={() => {
                                    commitEdit();
                                    const nextCol = Math.min(ci + 1, sortedColIds.length - 1);
                                    selectCell(nextCol, ri);
                                    tableRef.current?.focus();
                                  }}
                                  onBlur={() => {
                                    setTimeout(() => {
                                      const ae = document.activeElement;
                                      if (ae?.closest?.('.cell-editor-cm')) return;
                                      if (ae?.closest?.('.formula-editor-cm')) return;
                                      if (ae?.closest?.('.formula-bar-cm')) return;
                                      commitEdit();
                                    }, 0);
                                  }}
                                  functionNames={formulaNames}
                                  autoFocus={!editFromBarRef.current}
                                  className="cell-editor-cm"
                                />
                                {(() => {
                                  if (!editValue.startsWith('=') || !hf) return null;
                                  let result: string;
                                  try {
                                    const val = hf.calculateFormula(editValue, 0);
                                    if (val != null && typeof val === 'object' && 'value' in val) result = val.value;
                                    else if (val != null && typeof val !== 'object') result = String(val);
                                    else result = editValue;
                                  } catch {
                                    result = editValue;
                                  }
                                  return result !== editValue ? <div className="cell-eval-tooltip">{result}</div> : null;
                                })()}
                              </>
                            ) : (
                              <span className={display.startsWith('#') ? 'datagrid-cell-error' : rawValue.startsWith('=') ? 'datagrid-formula' : ''} title={display.startsWith('#') ? display : undefined}>{display}</span>
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
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                      {endRow < totalRows && (
                        <tr style={{ height: (totalRows - endRow) * ROW_HEIGHT + 'px' }}>
                          <td colSpan={sortedColIds.length + 1} />
                        </tr>
                      )}
                    </>
                  );
                })()}
              </tbody>
            </table>
            <div className="add-rows-bar">
              <button
                className="add-rows-link"
                onClick={() => {
                  const count = Math.max(1, Math.min(1000, addRowCount));
                  if (!currentSheetId || !docId) return;
                  const sid = currentSheetId;
                  const docSnap = docRef.current;
                  if (!docSnap) return;
                  const rowEntries = sortedEntries(docSnap.sheets[sid].rows);
                  const lastIdx = rowEntries.length > 0 ? rowEntries[rowEntries.length - 1][1].index : 0;
                  const newRowEntries: Array<[string, { index: number }]> = [];
                  for (let i = 0; i < count; i++) {
                    newRowEntries.push([shortId(), { index: lastIdx + i + 1 }]);
                  }
                  mutate((d) => {
                    for (const [id, entry] of newRowEntries) {
                      d.sheets[sid].rows[id] = entry as any;
                    }
                  }, { sid, newRowEntries });
                }}
              >Add</button>
              {' '}
              <input
                type="number"
                className="add-rows-input"
                value={addRowCount}
                min={1}
                max={1000}
                onInput={(e: any) => setAddRowCount(parseInt(e.currentTarget.value, 10) || 10)}
                onKeyDown={(e: any) => e.stopPropagation()}
              />
              {' more rows at the bottom'}
            </div>
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

          <ContextMenu modal={false} onOpenChange={(open: boolean) => { if (!open) setSheetContextMenu(null); }}>
            <ContextMenuTrigger>
              <SheetTabs
                sheets={sheetOrder}
                currentSheetId={currentSheetId ?? ''}
                onSelect={handleSelectSheet}
                onAdd={handleAddSheet}
                onRename={handleRenameSheet}
                onReorder={handleReorderSheet}
                onContextMenu={(id) => setSheetContextMenu(id)}
                renameRef={sheetRenameRef}
              />
            </ContextMenuTrigger>
            <CommandContextMenuContent entries={commands.sheetCtx} />
          </ContextMenu>
          </div>
        </>
      )}



    </div>
    </DocLoader>
  );
}
