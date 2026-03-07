import { useState, useRef, useCallback, useMemo, useEffect } from 'preact/hooks';
import { Automerge } from './automerge';
import type { DocHandle } from './automerge';
import type { State } from '@automerge/automerge';

export interface DocumentHistory<T> {
  /** Whether history mode is active */
  active: boolean;
  /** Whether the document can be edited (false when viewing a past version) */
  editable: boolean;
  /** Whether the slider is at the latest version */
  isLatest: boolean;
  /** Current version index (0-based), -1 when inactive */
  version: number;
  /** Total number of changes in history */
  changeCount: number;
  /** Historical snapshot when viewing a past version, null otherwise */
  snapshot: T | null;
  /** Timestamp of the current history entry */
  time: number | null;
  /** Toggle history mode on/off */
  toggleHistory: () => void;
  /** Set version from slider */
  onSliderChange: (version: number) => void;
  /** Jump to the latest version */
  jumpToLatest: () => void;
  /** Undo all changes after the current version */
  undoToVersion: () => void;
}

export function useDocumentHistory<T>(handleRef: { current: DocHandle<T> | null }): DocumentHistory<T> {
  const [entries, setEntries] = useState<State<T>[]>([]);
  const [version, setVersion] = useState(-1);
  const [changeCount, setChangeCount] = useState(0);
  const historyStaleRef = useRef(false);
  const atLatestRef = useRef(true);

  const active = version >= 0;
  const isLatest = !active || version === changeCount - 1;
  const editable = !active || isLatest;

  const loadHistory = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return null;
    const doc = handle.doc();
    if (!doc) return null;
    try {
      const h = Automerge.getHistory(doc);
      setEntries(h);
      setChangeCount(h.length);
      historyStaleRef.current = false;
      return h;
    } catch (e) {
      console.error('Failed to load history:', e);
      return null;
    }
  }, []);

  const toggleHistory = useCallback(() => {
    if (active) {
      setVersion(-1);
      setEntries([]);
      setChangeCount(0);
      atLatestRef.current = true;
      return;
    }
    const h = loadHistory();
    if (h) {
      setVersion(h.length - 1);
      atLatestRef.current = true;
    }
  }, [active, loadHistory]);

  // Track new changes while in history mode
  useEffect(() => {
    if (!active) return;
    const handle = handleRef.current;
    if (!handle) return;
    const onChange = () => {
      historyStaleRef.current = true;
      if (atLatestRef.current) {
        setChangeCount(prev => prev + 1);
        setVersion(prev => prev + 1);
      }
    };
    handle.on('change', onChange);
    return () => { handle.off('change', onChange); };
  }, [active, handleRef.current]);

  const onSliderChange = useCallback((v: number) => {
    const latest = v === changeCount - 1;
    atLatestRef.current = latest;
    if (!latest && historyStaleRef.current) {
      loadHistory();
    }
    setVersion(v);
  }, [changeCount, loadHistory]);

  const jumpToLatest = useCallback(() => {
    atLatestRef.current = true;
    const h = historyStaleRef.current ? loadHistory() : null;
    setVersion(h ? h.length - 1 : changeCount - 1);
  }, [changeCount, loadHistory]);

  const undoToVersion = useCallback(() => {
    const handle = handleRef.current;
    if (!handle || !active || isLatest) return;
    const snap = entries[version]?.snapshot;
    if (!snap) return;
    const plain = JSON.parse(JSON.stringify(snap));
    handle.change((d: any) => {
      // Remove keys not in snapshot
      for (const key of Object.keys(d)) {
        if (!(key in plain)) delete d[key];
      }
      // Copy snapshot keys (deep-assign handles nested merge)
      for (const [key, val] of Object.entries(plain)) {
        (d as any)[key] = val;
      }
    });
    // Jump to latest after undo
    const h = loadHistory();
    if (h) {
      atLatestRef.current = true;
      setVersion(h.length - 1);
    }
  }, [active, isLatest, version, entries, loadHistory]);

  const snapshot = useMemo<T | null>(() => {
    if (!active || isLatest) return null;
    return entries[version]?.snapshot ?? null;
  }, [active, isLatest, version, entries]);

  const time = active && entries[version] ? entries[version].change.time : null;

  return {
    active,
    editable,
    isLatest,
    version,
    changeCount,
    snapshot,
    time,
    toggleHistory,
    onSliderChange,
    jumpToLatest,
    undoToVersion,
  };
}
