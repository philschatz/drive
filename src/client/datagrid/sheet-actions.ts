import { sortedEntries } from './helpers';

/**
 * Freeze bookkeeping shared by the freeze commands (freeze up to the
 * selection) and the sheet-options steppers (freeze the first N visible
 * rows/columns).
 *
 * Frozen state is a per-row/col `frozen` flag whose rendered meaning is the
 * contiguous prefix of *visible* items — so freezing "the first N visible"
 * must also flag any hidden items interleaved in that prefix (and unflag
 * everything after it) to keep the stored state canonical.
 */
export function computeFreezeIds(
  allIdsInOrder: string[],
  visibleIds: string[],
  count: number,
): { idsToFreeze: string[]; idsToUnfreeze: string[] } {
  if (count <= 0 || visibleIds.length === 0) {
    return { idsToFreeze: [], idsToUnfreeze: [...allIdsInOrder] };
  }
  const upToId = visibleIds[Math.min(count, visibleIds.length) - 1];
  const upToIdx = allIdsInOrder.indexOf(upToId);
  if (upToIdx < 0) return { idsToFreeze: [], idsToUnfreeze: [...allIdsInOrder] };
  return {
    idsToFreeze: allIdsInOrder.slice(0, upToIdx + 1),
    idsToUnfreeze: allIdsInOrder.slice(upToIdx + 1),
  };
}

/**
 * Set the number of frozen visible rows/columns on a sheet. `count === 0`
 * unfreezes everything. The mutation callback is serialized (updateDoc), so
 * everything goes through args.
 */
export function applyFreezeCount(
  mutate: (fn: (d: any, ...args: any[]) => void, args: unknown[]) => void,
  sheetId: string,
  sheet: { rows: Record<string, any>; columns: Record<string, any> },
  visibleIds: string[],
  kind: 'row' | 'col',
  count: number,
): void {
  const allIds = sortedEntries(kind === 'row' ? sheet.rows : sheet.columns).map(([id]: [string, any]) => id);
  const { idsToFreeze, idsToUnfreeze } = computeFreezeIds(allIds, visibleIds, count);
  mutate((d, sid, kind, idsToFreeze, idsToUnfreeze) => {
    const coll = kind === 'row' ? d.sheets[sid].rows : d.sheets[sid].columns;
    for (const id of idsToFreeze) coll[id].frozen = true;
    for (const id of idsToUnfreeze) delete coll[id].frozen;
  }, [sheetId, kind, idsToFreeze, idsToUnfreeze]);
}
