import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { getDocHistory, setDocVersion, restoreDocToVersion, getVersionChanges } from '../worker-api';
import type { VersionChange } from '../../../shared/version-changes';

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
   * Call this from your subscribeQuery callback with the new heads.
   * Used to track when new changes arrive while in history mode.
   */
  onNewHeads: (heads: string[]) => void;
  /**
   * What the version on screen changed (shared/version-changes.ts), for the
   * editor to highlight: null while history is inactive or the description is
   * still loading. Loaded 120 ms after `version` settles, so a scrub does not
   * fetch every version it passes, and cleared the moment the version moves so
   * no highlight outlives the version it describes.
   */
  changes: VersionChange[] | null;
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

  const [changes, setChanges] = useState<VersionChange[] | null>(null);
  const changesSerial = useRef(0);
  useEffect(() => {
    const serial = ++changesSerial.current;
    setChanges(null);
    if (version < 0) return;
    const timer = setTimeout(() => {
      getVersionChanges(docId, version).then(
        got => { if (changesSerial.current === serial) setChanges(got); },
        () => { /* the version is still viewable without its description */ },
      );
    }, 120);
    // Bumping the serial here too keeps a response in flight at close from
    // resurrecting the highlights.
    return () => { clearTimeout(timer); changesSerial.current++; };
  }, [docId, version]);

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
    onNewHeads,
    changes,
  };
}
