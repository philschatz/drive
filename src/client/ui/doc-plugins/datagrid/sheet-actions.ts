/**
 * Freeze bookkeeping.
 *
 * Freezing is a count on the sheet (`frozenRows` / `frozenCols`): the first N
 * *visible* rows/columns are pinned.
 */

/**
 * Frozen count to render for a sheet: the stored count, clamped so it can never
 * exceed the rows/columns that exist (a synced count can outlive them) and
 * always leaves one unfrozen so there is something left to scroll.
 */
export function effectiveFrozenCount(storedCount: number | undefined, visibleIds: string[]): number {
  return Math.max(0, Math.min(storedCount ?? 0, Math.max(0, visibleIds.length - 1)));
}

/** Default rendered row height / column width when none is stored (px). */
export const DEFAULT_ROW_HEIGHT = 28;
export const DEFAULT_COL_WIDTH = 100;

/**
 * Allowed size range per axis, matching the schema's `min: 0` with a usable floor.
 *
 * The row floor is DEFAULT_ROW_HEIGHT, not something smaller, because a `<tr>`
 * height is a *minimum* and `.datagrid-cell` in datagrid.css sets a hard 28px of
 * content — so every stored height below the default rendered identically to it.
 * Allowing them meant the sheet could report a change that was invisible on the
 * grid, which is worse than not offering it.
 */
export const SIZE_LIMITS = {
  row: { min: DEFAULT_ROW_HEIGHT, max: 500, step: 4 },
  col: { min: 20, max: 2000, step: 10 },
} as const;

/**
 * Set (or clear) the height/width of specific rows/columns. `size === null`
 * removes the stored value, restoring the default.
 */
export function applyItemSize(
  mutate: (fn: (d: any, ...args: any[]) => void, args: unknown[]) => void,
  sheetId: string,
  kind: 'row' | 'col',
  ids: string[],
  size: number | null,
): void {
  if (ids.length === 0) return;
  const limits = SIZE_LIMITS[kind];
  const next = size === null
    ? null
    : Math.max(limits.min, Math.min(limits.max, Math.round(size)));
  if (next !== null && isNaN(next)) return;
  mutate((d, sid, kind, ids, next) => {
    const sheet = d.sheets[sid];
    if (!sheet) return;
    const coll = kind === 'row' ? sheet.rows : sheet.columns;
    const field = kind === 'row' ? 'height' : 'width';
    for (const id of ids) {
      const item = coll[id];
      if (!item) continue;
      if (next === null) delete item[field];
      else item[field] = next;
    }
  }, [sheetId, kind, ids, next]);
}

/**
 * Set the number of frozen visible rows/columns on a sheet. The mutation
 * callback is serialized (updateDoc), so all data travels through args.
 */
export function applyFreezeCount(
  mutate: (fn: (d: any, ...args: any[]) => void, args: unknown[]) => void,
  sheetId: string,
  kind: 'row' | 'col',
  count: number,
): void {
  const next = Math.max(0, Math.floor(count));
  mutate((d, sid, kind, next) => {
    const sheet = d.sheets[sid];
    if (!sheet) return;
    const field = kind === 'row' ? 'frozenRows' : 'frozenCols';
    if (next === 0) delete sheet[field];
    else sheet[field] = next;
    // Older builds marked individual rows/columns with a `frozen` flag, which
    // is no longer part of the schema — drop any left behind.
    for (const item of Object.values(kind === 'row' ? sheet.rows : sheet.columns) as any[]) {
      if (item.frozen !== undefined) delete item.frozen;
    }
  }, [sheetId, kind, next]);
}
