/**
 * Thin API layer for the HyperFormula evaluation worker.
 *
 * Creates the HF worker and a MessageChannel for its document reads. The main thread
 * only receives computed formula values and Monte Carlo results.
 *
 * The far end of that channel used to be transferred into the automerge worker so HF
 * could query the engine directly. It can't be any more: the engine may live in
 * another tab and a `MessagePort` cannot cross a `BroadcastChannel`. So this side
 * keeps the port and proxies the only two messages that ever crossed it —
 * `subscribe-query` / `unsubscribe-query` — through the normal worker API. HF itself
 * is unchanged; it still speaks the same protocol over the same port.
 *
 * This also retires a latent id collision: HF used to mint its own `subId` from 1
 * into the engine's single flat subscription map, where the UI's ids start at 1 too.
 * Its subscriptions now share the one allocator every other caller uses.
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
  evalCondFormats(rules: { id: string; conditionType: string; conditionValue?: string; ranges: { rangeRowStart: string; rangeRowEnd: string; rangeColStart: string; rangeColEnd: string }[] }[]): void;
  onComputedValues(cb: (values: Map<string, string | number>, spillTargets: Set<string>, errors: Map<string, string>) => void): () => void;
  onMCResults(cb: (results: MCResults) => void): () => void;
  onCondFormatResults(cb: (results: CondFormatResults) => void): () => void;
  destroy(): void;
}

/**
 * The subset of `subscribeQuery` this bridge needs. Injected so the DataGrid's
 * worker-api import stays in one place (and so a test can stub the read path).
 */
export type QuerySubscriber = (
  docId: string,
  filter: string,
  onResult: (result: any, heads: string[]) => void,
  onError?: (error: string) => void,
  opts?: { peek?: boolean },
) => () => void;

/**
 * Create an HF bridge. Requires the doc-query subscriber the HF worker reads through
 * (its reads are machine-driven, so they always `peek` — they must not count as the
 * user viewing a document, which would clear its unseen-changes marker).
 */
export function createHfBridge(subscribeQuery: QuerySubscriber): HfBridge {
  const worker = new Worker(
    new URL('./hf-worker.ts', import.meta.url),
    { type: 'module' },
  );

  // port2 → hf worker; port1 stays here and is proxied into the engine below.
  const channel = new MessageChannel();
  const enginePort = channel.port1;
  worker.postMessage({ type: 'init', port: channel.port2 }, [channel.port2]);

  // HF's document reads. Each `subscribe-query` becomes a real subscription whose
  // results are handed back over the port in the shape HF already expects.
  const hfSubs = new Map<number, () => void>();
  enginePort.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'subscribe-query') {
      const { subId, docId, filter } = msg;
      hfSubs.get(subId)?.(); // a re-subscribe on the same id supersedes the old one
      hfSubs.set(subId, subscribeQuery(
        docId,
        filter,
        (result, heads) => enginePort.postMessage({ type: 'query-result', subId, result, heads }),
        (error) => enginePort.postMessage({ type: 'query-result', subId, result: null, heads: [], error }),
        { peek: true },
      ));
    } else if (msg.type === 'unsubscribe-query') {
      hfSubs.get(msg.subId)?.();
      hfSubs.delete(msg.subId);
    }
  };
  enginePort.start();

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
      // The worker is gone and can no longer send `unsubscribe-query`, so release its
      // engine subscriptions here or they leak for the life of the tab.
      for (const off of hfSubs.values()) off();
      hfSubs.clear();
      enginePort.close();
      valueListeners.clear();
      mcListeners.clear();
      cfListeners.clear();
    },
  };
}
