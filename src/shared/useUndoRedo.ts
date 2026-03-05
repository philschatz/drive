import { useRef, useState, useCallback, useEffect } from 'preact/hooks';
import type { DocHandle } from '@automerge/automerge-repo';
import type { UrlHeads } from '@automerge/automerge-repo';

const MAX_UNDO = 100;

/** Convert an Automerge proxy value to a plain JS value safe for assignment. */
export function toPlain(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v);
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(toPlain);
  const result: Record<string, any> = {};
  for (const key of Object.keys(v)) result[key] = toPlain(v[key]);
  return result;
}

/** Recursively sync a mutable Automerge doc to match a target snapshot. */
export function syncToTarget(d: any, target: any): void {
  // Delete keys not in target
  for (const key of Object.keys(d)) {
    if (!(key in target)) delete d[key];
  }
  // Set or recurse into keys from target
  for (const key of Object.keys(target)) {
    const tv = target[key];
    const dv = d[key];
    if (tv === null || typeof tv !== 'object') {
      if (dv !== tv) d[key] = tv;
    } else if (!Array.isArray(tv) && typeof dv === 'object' && dv !== null && !Array.isArray(dv)) {
      syncToTarget(dv, tv);
    } else {
      d[key] = toPlain(tv);
    }
  }
}

export function useUndoRedo<T>(handleRef: { current: DocHandle<T> | null }) {
  const undoStackRef = useRef<UrlHeads[]>([]);
  const redoStackRef = useRef<UrlHeads[]>([]);
  const isUndoRedoRef = useRef(false);
  const prevHeadsRef = useRef<UrlHeads | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Auto-track heads via change event — no manual checkpoint calls needed
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    prevHeadsRef.current = handle.heads();
    const onChange = () => {
      if (isUndoRedoRef.current) return;
      if (prevHeadsRef.current) {
        undoStackRef.current.push(prevHeadsRef.current);
        if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
        redoStackRef.current = [];
        setCanUndo(true);
        setCanRedo(false);
      }
      prevHeadsRef.current = handle.heads();
    };
    handle.on('change', onChange);
    return () => { handle.off('change', onChange); };
  }, [handleRef.current]);

  const restoreToHeads = useCallback((targetHeads: UrlHeads) => {
    const handle = handleRef.current;
    if (!handle) return;
    const targetDoc = handle.view(targetHeads).doc();
    if (!targetDoc) return;
    isUndoRedoRef.current = true;
    handle.change((d: any) => syncToTarget(d, targetDoc));
    prevHeadsRef.current = handle.heads();
    isUndoRedoRef.current = false;
  }, [handleRef]);

  const undo = useCallback(() => {
    const handle = handleRef.current;
    if (!handle || undoStackRef.current.length === 0) return;
    redoStackRef.current.push(handle.heads());
    restoreToHeads(undoStackRef.current.pop()!);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }, [handleRef, restoreToHeads]);

  const redo = useCallback(() => {
    const handle = handleRef.current;
    if (!handle || redoStackRef.current.length === 0) return;
    undoStackRef.current.push(handle.heads());
    restoreToHeads(redoStackRef.current.pop()!);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [handleRef, restoreToHeads]);

  return { undo, redo, canUndo, canRedo };
}
