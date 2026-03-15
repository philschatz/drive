import { useRef, useState, useCallback, useEffect } from 'preact/hooks';
import { getDocHistory, restoreDocToVersion } from '../client/worker-api';

export { toPlain, syncToTarget } from './sync-to-target';

/**
 * History-based undo/redo.
 *
 * Uses the full Automerge history — not just the current session.
 * Maintains a logical cursor into the history. Undo steps back, redo forward.
 *
 * Each undo/redo fetches the real history length from the worker to avoid
 * cursor drift from race conditions during init or remote edits.
 */
export function useUndoRedo(docId: string) {
  // Logical cursor: which version the doc currently represents.
  const cursorRef = useRef(-1);
  const restoringRef = useRef(false);
  const seenFirstHeadsRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const redoStackRef = useRef<number[]>([]);

  // Load history on mount to set initial cursor
  useEffect(() => {
    let cancelled = false;
    getDocHistory(docId).then(h => {
      if (cancelled) return;
      cursorRef.current = h.length - 1;
      setCanUndo(h.length > 1);
      setCanRedo(false);
      redoStackRef.current = [];
    });
    return () => { cancelled = true; };
  }, [docId]);

  /**
   * Call from subscribeQuery callback when new heads arrive.
   * Restore-generated changes are ignored; genuine edits advance the cursor.
   */
  const onHeadsUpdate = useCallback((_heads: string[]) => {
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    // The first callback is the initial subscription load, not a new edit
    if (!seenFirstHeadsRef.current) {
      seenFirstHeadsRef.current = true;
      return;
    }
    // A genuine new edit — advance cursor past wherever we were
    if (cursorRef.current >= 0) {
      cursorRef.current++;
      redoStackRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
    }
  }, []);

  const undo = useCallback(async () => {
    if (cursorRef.current <= 0) return;
    const target = cursorRef.current - 1;
    redoStackRef.current.push(cursorRef.current);
    cursorRef.current = target;
    restoringRef.current = true;
    try {
      await restoreDocToVersion(docId, target);
    } catch {
      // Version not found — re-sync cursor from worker
      const h = await getDocHistory(docId);
      cursorRef.current = h.length - 1;
      redoStackRef.current = [];
      setCanUndo(h.length > 1);
      setCanRedo(false);
      restoringRef.current = false;
      return;
    }
    setCanUndo(target > 0);
    setCanRedo(true);
  }, [docId]);

  const redo = useCallback(async () => {
    if (redoStackRef.current.length === 0) return;
    const target = redoStackRef.current.pop()!;
    cursorRef.current = target;
    restoringRef.current = true;
    try {
      await restoreDocToVersion(docId, target);
    } catch {
      const h = await getDocHistory(docId);
      cursorRef.current = h.length - 1;
      redoStackRef.current = [];
      setCanUndo(h.length > 1);
      setCanRedo(false);
      restoringRef.current = false;
      return;
    }
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [docId]);

  return { undo, redo, canUndo, canRedo, onHeadsUpdate };
}
