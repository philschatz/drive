import { useState, useRef, useCallback } from 'preact/hooks';
import { getDocHistory, setDocVersion, restoreDocToVersion } from '../worker-api';

export interface DocumentHistory {
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
  /** The full list of versions (index + epoch-seconds timestamp), newest last. */
  entries: Array<{ version: number; time: number }>;
  /** Timestamp of the current history entry */
  time: number | null;
  /** Toggle history mode on/off */
  toggleHistory: () => void;
  /** Set version from slider — worker immediately re-runs subscriptions */
  onSliderChange: (version: number) => void;
  /** Jump to the latest version */
  jumpToLatest: () => void;
  /** Restore the document to a specific version, then exit history mode. */
  restoreToVersion: (version: number) => Promise<void>;
  /**
   * Undo the most recent change by restoring the previous version (appends a
   * forward-only revert change; invoking it again re-reverts, i.e. redo).
   */
  undoLastChange?: () => Promise<void>;
  /**
   * Call this from your subscribeQuery callback with the new heads.
   * Used to track when new changes arrive while in history mode.
   */
  onNewHeads: (heads: string[]) => void;
}

export function useDocumentHistory(docId: string): DocumentHistory {
  const [entries, setEntries] = useState<Array<{ version: number; time: number }>>([]);
  const [version, setVersion] = useState(-1);
  const [changeCount, setChangeCount] = useState(0);
  const atLatestRef = useRef(true);

  const active = version >= 0;
  const isLatest = !active || version === changeCount - 1;
  const editable = !active || isLatest;

  const loadHistory = useCallback(async () => {
    const h = await getDocHistory(docId);
    setEntries(h);
    setChangeCount(h.length);
    return h;
  }, [docId]);

  const toggleHistory = useCallback(async () => {
    if (active) {
      setDocVersion(docId, null);
      setVersion(-1);
      setEntries([]);
      setChangeCount(0);
      atLatestRef.current = true;
      return;
    }
    const h = await loadHistory();
    if (h.length > 0) {
      setVersion(h.length - 1);
      atLatestRef.current = true;
      // Pin to latest version so subscription shows historical snapshot
      setDocVersion(docId, h.length - 1);
    }
  }, [active, docId, loadHistory]);

  const onSliderChange = useCallback((v: number) => {
    atLatestRef.current = v === changeCount - 1;
    setVersion(v);
    setDocVersion(docId, v);
  }, [docId, changeCount]);

  const jumpToLatest = useCallback(() => {
    atLatestRef.current = true;
    setVersion(changeCount - 1);
    setDocVersion(docId, null);
  }, [docId, changeCount]);

  const restoreToVersion = useCallback(async (target: number) => {
    await restoreDocToVersion(docId, target);
    // Worker clears pinnedVersion after restore; exit history mode
    setDocVersion(docId, null);
    setVersion(-1);
    setEntries([]);
    setChangeCount(0);
    atLatestRef.current = true;
  }, [docId]);

  const undoLastChange = useCallback(async () => {
    const h = await getDocHistory(docId);
    if (h.length < 2) return; // nothing before the current version
    await restoreDocToVersion(docId, h.length - 2);
  }, [docId]);

  /**
   * Called by editor's subscribeQuery callback when new heads arrive.
   * When at latest in history mode, advance the slider to track new changes.
   */
  const onNewHeads = useCallback((_heads: string[]) => {
    if (!active) return;
    if (atLatestRef.current) {
      setChangeCount(prev => {
        const next = prev + 1;
        setVersion(next - 1);
        return next;
      });
    }
  }, [active]);

  const time = active && entries[version] ? entries[version].time : null;

  return {
    active,
    editable,
    isLatest,
    version,
    changeCount,
    entries,
    time,
    toggleHistory,
    onSliderChange,
    jumpToLatest,
    restoreToVersion,
    undoLastChange,
    onNewHeads,
  };
}
