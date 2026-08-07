import { useCallback, useEffect } from 'preact/hooks';
import type { Dispatch, StateUpdater } from 'preact/hooks';
import { subscribeQuery } from '../../worker-api';
import { createHfBridge } from './hf-bridge';
import type { HfBridge, MCResults, CondFormatResults } from './hf-bridge';
import { sortedEntries } from './helpers';

// Lightweight metadata query — returns doc name and each sheet's name/index/hidden plus row/col ordering (no cell data)
export const META_QUERY = '{ "@type": .["@type"], name: (.name // "Spreadsheet"), sheets: (.sheets | to_entries | map({ key: .key, value: { name: .value.name, index: .value.index, hidden: .value.hidden, rows: (.value.rows | to_entries | sort_by(.value.index) | map(.key)), cols: (.value.columns | to_entries | sort_by(.value.index) | map(.key)) } }) | from_entries) }';

// Active sheet query template — returns the full sheet object for the current sheet
export function sheetQuery(sheetId: string): string {
  return `.sheets["${sheetId}"]`;
}

export type DataGridDocMeta = {
  '@type': string;
  name: string;
  sheets: Record<string, { name: string; index: number; hidden?: boolean; rows?: string[]; cols?: string[] }>;
};

export type DataGridDocRefs = {
  hfBridgeRef: { current: HfBridge | null };
  computedValuesRef: { current: Map<string, string | number> };
  errorMessagesRef: { current: Map<string, string> };
  spillTargetsRef: { current: Set<string> };
  condFormatResultsRef: { current: CondFormatResults | null };
  activeSheetRef: { current: any };
  activeSheetUnsubRef: { current: (() => void) | null };
  docMetaRef: { current: DataGridDocMeta | null };
};

/**
 * Load the document: set up the HyperFormula bridge, subscribe to the
 * lightweight metadata (doc name + sheet list), and pick/subscribe the active
 * sheet on first load. `subscribeSheet` swaps the active-sheet subscription and
 * is also used by the sheet-management handlers on navigation.
 */
export function useDataGridDoc(opts: {
  docId?: string;
  initialSheetId: string | undefined;
  history: { onNewHeads(heads: string[]): void };
  onHeadsUpdate: (heads: string[]) => void;
  setCurrentSheetId: Dispatch<StateUpdater<string | null>>;
  setRawDoc: Dispatch<StateUpdater<any>>;
  setGridName: Dispatch<StateUpdater<string>>;
  setMcResults: Dispatch<StateUpdater<MCResults | null>>;
  setTick: Dispatch<StateUpdater<number>>;
  refs: DataGridDocRefs;
}): { subscribeSheet: (id: string) => void } {
  const { docId, initialSheetId, history, onHeadsUpdate } = opts;
  const { setCurrentSheetId, setRawDoc, setGridName, setMcResults, setTick } = opts;
  const {
    hfBridgeRef, computedValuesRef, errorMessagesRef, spillTargetsRef,
    condFormatResultsRef, activeSheetRef, activeSheetUnsubRef, docMetaRef,
  } = opts.refs;

  // Swap the active sheet subscription. Shared by the initial load and the
  // sheet-management handlers (which additionally notify the HF bridge).
  const subscribeSheet = useCallback((id: string) => {
    if (!docId) return;
    activeSheetUnsubRef.current?.();
    activeSheetRef.current = null;
    activeSheetUnsubRef.current = subscribeQuery(docId, sheetQuery(id), (sheetResult) => {
      activeSheetRef.current = sheetResult;
      setTick(t => t + 1);
    });
  }, [docId, activeSheetUnsubRef, activeSheetRef, setTick]);

  useEffect(() => {
    if (!docId) return;

    let mounted = true;

    // Set up HF bridge for formula evaluation
    const bridge = createHfBridge(subscribeQuery);
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
          subscribeSheet(activeSheet);
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

  return { subscribeSheet };
}
