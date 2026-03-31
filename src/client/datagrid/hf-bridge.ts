/**
 * Thin API layer for the HyperFormula evaluation worker.
 *
 * Creates the HF worker and a MessageChannel connecting it to the automerge
 * worker for direct communication. The main thread only receives computed
 * formula values and Monte Carlo results.
 */

import type { DistributionStats } from './distributions';

export interface MCResults {
  cells: Map<string, DistributionStats>;
  sources: Set<string>;
}

export interface CondFormatResults {
  /** ruleId -> set of matching "rowId:colId" keys */
  matches: Map<string, Set<string>>;
}

export interface HfBridge {
  watch(docId: string, activeSheet: string): void;
  switchSheet(sheetId: string): void;
  unwatch(): void;
  setCellContents(sheetId: string, rowId: string, colId: string, value: string): void;
  evalCondFormats(rules: { id: string; conditionType: string; conditionValue?: string; rangeRowStart: string; rangeRowEnd: string; rangeColStart: string; rangeColEnd: string }[]): void;
  onComputedValues(cb: (values: Map<string, string | number>, spillTargets: Set<string>, errors: Map<string, string>) => void): () => void;
  onMCResults(cb: (results: MCResults) => void): () => void;
  onCondFormatResults(cb: (results: CondFormatResults) => void): () => void;
  destroy(): void;
}

/**
 * Create an HF bridge. Requires a function that sends a MessagePort to the
 * automerge worker (so the HF worker can subscribe to doc queries directly).
 */
export function createHfBridge(sendPortToAutomerge: (port: MessagePort) => void): HfBridge {
  const worker = new Worker(
    new URL('./hf-worker.ts', import.meta.url),
    { type: 'module' },
  );

  // Create a MessageChannel: port1 → automerge worker, port2 → hf worker
  const channel = new MessageChannel();
  sendPortToAutomerge(channel.port1);
  worker.postMessage({ type: 'init', port: channel.port2 }, [channel.port2]);

  const valueListeners = new Set<(values: Map<string, string | number>, spillTargets: Set<string>, errors: Map<string, string>) => void>();
  const mcListeners = new Set<(results: MCResults) => void>();
  const cfListeners = new Set<(results: CondFormatResults) => void>();

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'computed-values') {
      const map = new Map<string, string | number>(Object.entries(msg.values));
      const spillTargets = new Set<string>(msg.spillTargets ?? []);
      const errors = new Map<string, string>(Object.entries(msg.errors ?? {}));
      for (const cb of valueListeners) cb(map, spillTargets, errors);
    } else if (msg.type === 'mc-results') {
      const cells = new Map<string, DistributionStats>(msg.cells);
      const sources = new Set<string>(msg.sources);
      for (const cb of mcListeners) cb({ cells, sources });
    } else if (msg.type === 'cond-format-results') {
      const matches = new Map<string, Set<string>>();
      for (const [ruleId, keys] of Object.entries(msg.results as Record<string, string[]>)) {
        matches.set(ruleId, new Set(keys));
      }
      for (const cb of cfListeners) cb({ matches });
    }
  };

  return {
    watch(docId: string, activeSheet: string) {
      worker.postMessage({ type: 'watch', docId, activeSheet });
    },
    switchSheet(sheetId: string) {
      worker.postMessage({ type: 'switch-sheet', sheetId });
    },
    unwatch() {
      worker.postMessage({ type: 'unwatch' });
    },
    setCellContents(sheetId: string, rowId: string, colId: string, value: string) {
      worker.postMessage({ type: 'set-cell', sheetId, rowId, colId, value });
    },
    evalCondFormats(rules) {
      worker.postMessage({ type: 'eval-cond-formats', rules });
    },
    onComputedValues(cb) {
      valueListeners.add(cb);
      return () => { valueListeners.delete(cb); };
    },
    onMCResults(cb) {
      mcListeners.add(cb);
      return () => { mcListeners.delete(cb); };
    },
    onCondFormatResults(cb) {
      cfListeners.add(cb);
      return () => { cfListeners.delete(cb); };
    },
    destroy() {
      worker.postMessage({ type: 'unwatch' });
      worker.terminate();
      valueListeners.clear();
      mcListeners.clear();
      cfListeners.clear();
    },
  };
}
