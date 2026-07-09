import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { subscribeQuery, updateDoc, getWorkerUserGroupId } from '../worker-api';
import type { PeerState } from '../shared/automerge';
import { peerDisplayName, initPresence, type PresenceState } from '../shared/presence';
import { EditorTitleBar } from '../shared/EditorTitleBar';
import { useAccess } from '../shared/useAccess';
import { DocLoader } from '../shared/useDocument';
import { IronCalc, type Model } from '@ironcalc/workbook';
import {
  DataGridBridge, ensureWasm, toDocState, DOC_QUERY, type DocState, type BridgeCallbacks,
} from './model-bridge';
import { DataGridMenuBar } from './DataGridMenuBar';
import { ConditionalFormatPanel } from './ConditionalFormatPanel';
import '@ironcalc/workbook/dist/ironcalc.css';
import './datagrid.css';

/**
 * Collaborative spreadsheet: IronCalc's editing UI over our Automerge CRDT doc.
 * The `DataGridBridge` keeps the IronCalc `Model` and the Automerge document in sync
 * both ways (see model-bridge.ts). This component owns the WASM lifecycle, the doc
 * subscription, presence, and the doc-name title bar; IronCalc owns everything inside
 * the grid (toolbar, formula bar, sheet tabs, cell editing).
 */
export function DataGrid({ readOnly }: { readOnly?: boolean }) {
  const { docId, sheetId, '*': cell } = useParams();
  return (
    <DocLoader docId={docId}>
      <DataGridInner docId={docId} readOnly={readOnly} initialSheetId={sheetId} initialCell={cell} />
    </DocLoader>
  );
}

function DataGridInner({ docId, readOnly, initialSheetId, initialCell }: {
  docId?: string; readOnly?: boolean; initialSheetId?: string; initialCell?: string;
}) {
  const [gridName, setGridName] = useState('Spreadsheet');
  const [peerStates, setPeerStates] = useState<Record<string, PeerState<PresenceState>>>({});
  const [model, setModel] = useState<Model | null>(null);
  const [refreshId, setRefreshId] = useState(0);
  const [mountKey, setMountKey] = useState(0);
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [docState, setDocState] = useState<DocState | null>(null);
  const [cfOpen, setCfOpen] = useState(false);
  const [cfCtx, setCfCtx] = useState<{
    sheetId: string;
    selectedCell: [number, number] | null;
    selectionRange: { minCol: number; maxCol: number; minRow: number; maxRow: number } | null;
  } | null>(null);

  const { canEdit: accessCanEdit } = useAccess(docId);
  const canEdit = !readOnly && accessCanEdit;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;

  const bridgeRef = useRef<DataGridBridge | null>(null);
  const broadcastRef = useRef<((key: keyof PresenceState, value: any) => void) | null>(null);
  const titleFocusedRef = useRef(false);
  // Selection ⇄ URL: capture the cell from the initial URL to restore once on load.
  const initialSelRef = useRef({ sheetId: initialSheetId, cell: initialCell });
  const restoredRef = useRef(false);

  // ── Presence ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!docId) return;
    const { broadcast, cleanup } = initPresence<PresenceState>(
      docId,
      () => ({ viewing: true, focusedField: null, userGroupId: getWorkerUserGroupId() ?? undefined }),
      setPeerStates,
    );
    broadcastRef.current = broadcast;
    return () => { cleanup(); broadcastRef.current = null; };
  }, [docId]);

  // ── Doc subscription + bridge lifecycle ──────────────────────────────────────
  useEffect(() => {
    if (!docId) return;
    let disposed = false;
    const latest = { current: null as DocState | null };

    const urlPrefix = readOnly ? '/view/datagrids/' : '/datagrids/';

    const makeCallbacks = (): BridgeCallbacks => ({
      onModelChanged: () => setRefreshId((x) => x + 1),
      onFocus: (path) => {
        broadcastRef.current?.('focusedField', path);
        // Reflect the selected cell in the URL using position-independent row/col IDs
        // (#/datagrids/<id>/sheets/<sid>/<rowId>:<colId>), so the link survives row/col
        // inserts and deletes. replaceState avoids a router navigation per selection.
        if (!docId || !path || path[0] !== 'sheets') return;
        const sid = String(path[1]);
        const cellKey = String(path[3] ?? '');
        if (!cellKey.includes(':')) return;
        window.history.replaceState(null, '', `#${urlPrefix}${docId}/sheets/${sid}/${cellKey}`);
      },
    });

    const build = (state: DocState) => {
      const bridge = new DataGridBridge(docId, state, makeCallbacks(), !canEditRef.current);
      bridgeRef.current = bridge;
      setModel(bridge.model);
      setMountKey((k) => k + 1);
      // Restore the selection encoded in the initial URL (rowId:colId), once.
      if (!restoredRef.current && initialSelRef.current.cell) {
        restoredRef.current = true;
        const { sheetId: sid, cell } = initialSelRef.current;
        const mm = bridge.model as any;
        try {
          const si = sid ? state.sheetIds.indexOf(sid) : -1;
          const sheet = sid ? state.sheets[sid] : undefined;
          const sep = (cell ?? '').indexOf(':');
          if (si >= 0 && sheet && sep >= 0) {
            const r = sheet.rowIds.indexOf(cell!.slice(0, sep));
            const c = sheet.colIds.indexOf(cell!.slice(sep + 1));
            if (r >= 0 && c >= 0) {
              mm.setSelectedSheet(si);
              mm.setSelectedCell(r + 1, c + 1);
              setRefreshId((x) => x + 1);
            }
          }
        } catch { /* selection restore is best-effort */ }
      }
    };

    const unsub = subscribeQuery(docId, DOC_QUERY, (result) => {
      if (disposed) return;
      const next = toDocState(result);
      latest.current = next;
      setDocState(next);
      setGridName(next.name);
      if (!titleFocusedRef.current) document.title = `${next.name} - Spreadsheet`;

      const bridge = bridgeRef.current;
      if (!bridge) {
        // First result: load WASM once, then seed from the newest snapshot we have.
        if (model === null && !wasmError) {
          ensureWasm()
            .then(() => { if (!disposed && !bridgeRef.current && latest.current) build(latest.current); })
            .catch((e) => { console.error('[datagrid] WASM init failed', e); setWasmError(String(e?.message ?? e)); });
        }
        return;
      }
      // Subsequent results: structural changes need a fresh Model; value changes patch in place.
      if (bridge.structurallyDiffers(next)) {
        bridge.destroy();
        build(next);
      } else {
        bridge.applyRemoteCells(next);
      }
    });

    return () => {
      disposed = true;
      unsub();
      bridgeRef.current?.destroy();
      bridgeRef.current = null;
      setModel(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const peerList = Object.values(peerStates).filter((p) => p.value?.viewing);

  // Open the conditional-format panel for the currently-selected sheet, capturing
  // IronCalc's current selection (converted to 0-based indices the panel expects).
  const openConditionalFormat = () => {
    if (!model || !docState) return;
    let sheetIdx = 0;
    let selectedCell: [number, number] | null = null;
    let selectionRange: { minCol: number; maxCol: number; minRow: number; maxRow: number } | null = null;
    try {
      const v = model.getSelectedView();
      sheetIdx = v.sheet;
      const [r0, c0, r1, c1] = v.range;
      const minRow = Math.min(r0, r1) - 1, maxRow = Math.max(r0, r1) - 1;
      const minCol = Math.min(c0, c1) - 1, maxCol = Math.max(c0, c1) - 1;
      selectedCell = [minCol, minRow];
      selectionRange = { minCol, maxCol, minRow, maxRow };
    } catch { /* no selection */ }
    const sheetId = docState.sheetIds[sheetIdx] ?? docState.sheetIds[0];
    if (!sheetId) return;
    setCfCtx({ sheetId, selectedCell, selectionRange });
    setCfOpen(true);
  };

  const cfSheet = docState && cfCtx ? docState.sheets[cfCtx.sheetId] : undefined;

  return (
    <div className="datagrid-root flex flex-col h-full min-h-0">
      <EditorTitleBar
        icon="table_chart"
        title={gridName}
        titleEditable={canEdit}
        onTitleFocus={() => { titleFocusedRef.current = true; }}
        onTitleChange={setGridName}
        onTitleBlur={(value) => {
          titleFocusedRef.current = false;
          if (!docId || !canEdit) return;
          const name = value.trim() || 'Spreadsheet';
          setGridName(name);
          updateDoc(docId, (d, name) => { d.name = name; }, name);
          document.title = `${name} - Spreadsheet`;
        }}
        docId={docId}
        peers={peerList}
        peerTitle={(peer) => `${peerDisplayName(peer.peerId, peer.value?.userGroupId)}${peer.value?.focusedField ? ' (editing)' : ''}`}
      />
      {model && canEdit && (
        <DataGridMenuBar
          model={model}
          onRefresh={() => setRefreshId((x) => x + 1)}
          onOpenConditionalFormat={openConditionalFormat}
        />
      )}
      <div className="flex flex-1 min-h-0">
        <div className="datagrid-host flex-1 min-h-0 relative">
          {wasmError
            ? <div className="p-4 text-red-600">Failed to load spreadsheet engine: {wasmError}</div>
            : model
              ? <IronCalc key={mountKey} model={model} refreshId={refreshId} />
              : <div className="p-4 text-gray-500">Loading spreadsheet…</div>}
        </div>
        {cfCtx && cfSheet && (
          <ConditionalFormatPanel
            open={cfOpen}
            onOpenChange={setCfOpen}
            rules={cfSheet.conditionalFormats}
            sortedRowIds={cfSheet.rowIds}
            sortedColIds={cfSheet.colIds}
            currentSheetId={cfCtx.sheetId}
            mutate={(fn, args) => { if (docId) updateDoc(docId, fn as any, ...args); }}
            selectedCell={cfCtx.selectedCell}
            selectionRange={cfCtx.selectionRange}
            visibleRowIds={cfSheet.rowIds}
            visibleColIds={cfSheet.colIds}
          />
        )}
      </div>
    </div>
  );
}
