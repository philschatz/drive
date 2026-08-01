import { useCallback } from 'preact/hooks';
import type { Dispatch, StateUpdater } from 'preact/hooks';
import { updateDoc } from '../../worker-api';
import { sortedEntries, shortId } from './helpers';
import { pushDocHash } from '../../common/doc-urls';
import type { DataGridDocMeta } from './useDataGridDoc';
import type { HfBridge } from './hf-bridge';
import type { GridCommandContext } from './commands';
import type { FormulaHighlight } from './FormulaEditor';

export type SheetContextMenuState = { type: 'row' | 'col' | 'cell'; indices: number[] } | null;
export type ClipboardSourceState = { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;

/**
 * Sheet-management handlers (select/add/rename/delete/hide/unhide/reorder).
 * `subscribeSheet` comes from useDataGridDoc and owns the active-sheet
 * subscription swap; these handlers additionally notify the HF bridge.
 */
export function useSheetActions(opts: {
  docId?: string;
  currentSheetId: string | null;
  editingCell: [number, number] | null;
  commitEdit: () => void;
  mutate: GridCommandContext['mutate'];
  subscribeSheet: (id: string) => void;
  refs: {
    docMetaRef: { current: DataGridDocMeta | null };
    hfBridgeRef: { current: HfBridge | null };
  };
  setCurrentSheetId: Dispatch<StateUpdater<string | null>>;
  setTick: Dispatch<StateUpdater<number>>;
  setSelectedCell: Dispatch<StateUpdater<[number, number] | null>>;
  setSelectionAnchor: Dispatch<StateUpdater<[number, number] | null>>;
  setEditingCell: Dispatch<StateUpdater<[number, number] | null>>;
  setSelectedRows: Dispatch<StateUpdater<Set<number>>>;
  setSelectedCols: Dispatch<StateUpdater<Set<number>>>;
  setContextMenu: Dispatch<StateUpdater<SheetContextMenuState>>;
  setClipboardSource: Dispatch<StateUpdater<ClipboardSourceState>>;
  setFormulaRefHighlights: Dispatch<StateUpdater<FormulaHighlight[]>>;
}): {
  handleSelectSheet: (id: string, skipUrlUpdate?: boolean) => void;
  handleAddSheet: () => void;
  handleRenameSheet: (id: string, name: string) => void;
  handleDeleteSheet: (id: string) => void;
  handleHideSheet: (id: string) => void;
  handleUnhideSheet: (id: string) => void;
  handleReorderSheet: (draggedId: string, dropIndex: number) => void;
  handleMoveSheet: (id: string, dir: -1 | 1) => void;
} {
  const { docId, currentSheetId, editingCell, commitEdit, mutate, subscribeSheet } = opts;
  const { docMetaRef, hfBridgeRef } = opts.refs;
  const { setCurrentSheetId, setTick, setSelectedCell, setSelectionAnchor, setEditingCell } = opts;
  const { setSelectedRows, setSelectedCols, setContextMenu, setClipboardSource, setFormulaRefHighlights } = opts;

  const handleSelectSheet = useCallback((id: string, skipUrlUpdate = false) => {
    if (id === currentSheetId) return;
    if (editingCell) commitEdit();
    hfBridgeRef.current?.switchSheet(id);
    subscribeSheet(id);
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
  }, [currentSheetId, editingCell, commitEdit, docId, hfBridgeRef, subscribeSheet, setCurrentSheetId, setSelectedCell, setSelectionAnchor, setEditingCell, setSelectedRows, setSelectedCols, setContextMenu, setClipboardSource, setFormulaRefHighlights]);

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
  }, [docId, docMetaRef, setTick, handleSelectSheet]);

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
  }, [docId, docMetaRef, currentSheetId, hfBridgeRef, setCurrentSheetId, setSelectedCell, setSelectionAnchor, setEditingCell, setSelectedRows, setSelectedCols, setClipboardSource]);

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
  }, [mutate, docMetaRef, currentSheetId, handleSelectSheet]);

  const handleUnhideSheet = useCallback((id: string) => {
    mutate((d, id) => { d.sheets[id].hidden = false; }, [id]);
    const m = docMetaRef.current;
    if (m?.sheets[id]) {
      docMetaRef.current = { ...m, sheets: { ...m.sheets, [id]: { ...m.sheets[id], hidden: false } } };
    }
  }, [mutate, docMetaRef]);

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
  }, [mutate, docMetaRef]);

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

  return {
    handleSelectSheet, handleAddSheet, handleRenameSheet,
    handleDeleteSheet, handleHideSheet, handleUnhideSheet,
    handleReorderSheet, handleMoveSheet,
  };
}
