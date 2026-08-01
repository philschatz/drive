import { useEffect } from 'preact/hooks';
import type { Dispatch, StateUpdater } from 'preact/hooks';
import { commitAutofill } from './commands';
import type { GridCommandContext } from './commands';

export type AutofillRange = { minCol: number; maxCol: number; minRow: number; maxRow: number };
export type AutofillDragRef = { sourceRange: AutofillRange } | null;
export type AutofillTarget = AutofillRange;

/**
 * Document-level mousemove/mouseup during an autofill drag: paints the fill
 * target (the axis the mouse is furthest beyond the source range) and commits
 * it on release via the shared command context.
 */
export function useAutofillDrag(opts: {
  autofillDragRef: { current: AutofillDragRef };
  commandCtxRef: { current: GridCommandContext | null };
  canEditRef: { current: boolean };
  setAutofillTarget: Dispatch<StateUpdater<AutofillTarget | null>>;
}): void {
  const { autofillDragRef, commandCtxRef, canEditRef, setAutofillTarget } = opts;

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!autofillDragRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const td = el?.closest('[data-cell-col]') as HTMLElement | null;
      if (!td) return;
      const col = parseInt(td.dataset.cellCol!, 10);
      const row = parseInt(td.dataset.cellRow!, 10);
      if (isNaN(col) || isNaN(row)) return;

      const src = autofillDragRef.current.sourceRange;

      // Determine which axis the mouse has moved beyond
      const beyondRow = row > src.maxRow ? row - src.maxRow : row < src.minRow ? src.minRow - row : 0;
      const beyondCol = col > src.maxCol ? col - src.maxCol : col < src.minCol ? src.minCol - col : 0;

      if (beyondRow === 0 && beyondCol === 0) {
        setAutofillTarget(null);
        return;
      }

      // Fill in whichever axis the mouse is furthest beyond
      if (beyondRow >= beyondCol) {
        // Vertical fill
        if (row > src.maxRow) {
          setAutofillTarget({ minCol: src.minCol, maxCol: src.maxCol, minRow: src.maxRow + 1, maxRow: row });
        } else {
          setAutofillTarget({ minCol: src.minCol, maxCol: src.maxCol, minRow: row, maxRow: src.minRow - 1 });
        }
      } else {
        // Horizontal fill
        if (col > src.maxCol) {
          setAutofillTarget({ minRow: src.minRow, maxRow: src.maxRow, minCol: src.maxCol + 1, maxCol: col });
        } else {
          setAutofillTarget({ minRow: src.minRow, maxRow: src.maxRow, minCol: col, maxCol: src.minCol - 1 });
        }
      }
    };

    const onMouseUp = () => {
      if (!autofillDragRef.current) return;
      const src = autofillDragRef.current.sourceRange;
      autofillDragRef.current = null;

      // Use functional update to read current autofillTarget without stale closure
      setAutofillTarget(prev => {
        if (prev && commandCtxRef.current && canEditRef.current) {
          commitAutofill(commandCtxRef.current, src, prev);
        }
        return null;
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);
}
