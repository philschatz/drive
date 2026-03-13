import { useRef, useState, useCallback, useEffect } from 'preact/hooks';
import { getDocHistory, restoreDocToVersion } from '../client/worker-api';

export { toPlain, syncToTarget } from './sync-to-target';

/**
 * History-based undo/redo.
 *
 * Uses the full Automerge history — not just the current session.
 * Maintains a logical cursor into the history. Undo steps back, redo forward.
 *
 * When a restore happens, Automerge appends a new change (the sync-to-target),
 * which grows the history. We track this with `restoringRef` so we don't
 * advance the cursor for restore-generated changes.
 */
export function useUndoRedo(docId: string) {
  // Logical cursor: which version the doc currently represents.
  // This can differ from historyLen-1 after undo.
  const cursorRef = useRef(-1);
  const historyLenRef = useRef(0);
  const restoringRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // After undo, we remember the "forward" versions for redo.
  // Stack of version indices we can redo to.
  const redoStackRef = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    getDocHistory(docId).then(h => {
      if (cancelled) return;
      historyLenRef.current = h.length;
      cursorRef.current = h.length - 1;
      setCanUndo(h.length > 1);
      setCanRedo(false);
      redoStackRef.current = [];
    });
    return () => { cancelled = true; };
  }, [docId]);

  const onHeadsUpdate = useCallback((_heads: string[]) => {
    historyLenRef.current++;
    if (restoringRef.current) {
      restoringRef.current = false;
      return;
    }
    // A genuine new edit — advance cursor and clear redo stack
    cursorRef.current = historyLenRef.current - 1;
    redoStackRef.current = [];
    setCanUndo(historyLenRef.current > 1);
    setCanRedo(false);
  }, []);

  const undo = useCallback(async () => {
    if (cursorRef.current <= 0) return;
    const current = cursorRef.current;
    const target = current - 1;
    redoStackRef.current.push(current);
    restoringRef.current = true;
    await restoreDocToVersion(docId, target);
    cursorRef.current = target;
    setCanUndo(target > 0);
    setCanRedo(true);
  }, [docId]);

  const redo = useCallback(async () => {
    if (redoStackRef.current.length === 0) return;
    const target = redoStackRef.current.pop()!;
    restoringRef.current = true;
    await restoreDocToVersion(docId, target);
    cursorRef.current = target;
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [docId]);

  return { undo, redo, canUndo, canRedo, onHeadsUpdate };
}
