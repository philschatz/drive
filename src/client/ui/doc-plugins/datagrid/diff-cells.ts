/**
 * History mode for the grid, the pure part: what the version on screen did to
 * one sheet's cells, columns, rows and the sheet itself, and which sheet to
 * show first. Paths are `['sheets', sid, 'cells', 'rowId:colId', 'value']` and
 * their siblings (`columns`, `rows`, `formats`, `conditionalFormats`, `name`…).
 * DataGrid cannot mount under jsdom, so this is where its history logic is
 * tested.
 */
import { itemChanges, type ChangeKind, type VersionChange } from '../../../../shared/version-changes';

export interface SheetDiff {
  /** Per cell key, the kind and — for a removed or replaced value — what it was. */
  cells: Map<string, { kind: ChangeKind; before?: string }>;
  columns: Map<string, ChangeKind>;
  rows: Map<string, ChangeKind>;
  /** The sheet itself: added / removed, or changed for anything not covered above. */
  sheet?: ChangeKind;
}

const RANK: Record<ChangeKind, number> = { changed: 0, added: 1, removed: 2 };

export function sheetDiff(changes: VersionChange[], sheetId: string): SheetDiff {
  const cells = new Map<string, { kind: ChangeKind; before?: string }>();
  for (const [key, kind] of itemChanges(changes, ['sheets', sheetId, 'cells'])) cells.set(key, { kind });
  for (const c of changes) {
    if (c.path[0] !== 'sheets' || c.path[1] !== sheetId || c.path[2] !== 'cells') continue;
    const key = String(c.path[3]);
    const cell = cells.get(key);
    if (!cell) continue;
    if (c.path.length === 4 && c.kind === 'removed') {
      const before = (c.before as { value?: unknown } | undefined)?.value;
      if (typeof before === 'string') cell.before = before;
    } else if (c.path.length === 5 && c.path[4] === 'value' && typeof c.before === 'string') {
      cell.before = c.before;
    }
  }
  let sheet: ChangeKind | undefined;
  for (const c of changes) {
    if (c.path[0] !== 'sheets' || c.path[1] !== sheetId) continue;
    const kind: ChangeKind = c.path.length === 2 ? c.kind
      : c.path[2] === 'cells' || c.path[2] === 'columns' || c.path[2] === 'rows' ? 'changed'
      : 'changed';
    // Only a change to the sheet's own fields (or the sheet itself) marks the tab;
    // cells/columns/rows are shown in place.
    if (c.path.length > 2 && (c.path[2] === 'cells' || c.path[2] === 'columns' || c.path[2] === 'rows')) continue;
    if (!sheet || RANK[kind] > RANK[sheet]) sheet = kind;
  }
  return {
    cells,
    columns: itemChanges(changes, ['sheets', sheetId, 'columns']),
    rows: itemChanges(changes, ['sheets', sheetId, 'rows']),
    sheet,
  };
}

/** Per sheet id, the kind to mark its tab with (any change under the sheet counts). */
export function sheetKinds(changes: VersionChange[]): Map<string, ChangeKind> {
  return itemChanges(changes, ['sheets']);
}

/**
 * The sheet to show for a version: the one on screen if the version touched it,
 * else the first sheet the version touched that exists at this version, else —
 * when the sheet on screen does not exist at this version (it was added later,
 * so its subscription has nothing to render) — `fallback`. Null means stay.
 */
export function sheetToShow(
  changes: VersionChange[],
  shown: string | null,
  fallback: string | null,
  exists: (sheetId: string) => boolean,
): string | null {
  const touched = sheetKinds(changes);
  const shownExists = !!shown && exists(shown);
  if (shownExists && touched.has(shown!)) return shown;
  for (const [sid, kind] of touched) {
    if (kind !== 'removed' && exists(sid)) return sid;
  }
  if (!shownExists && fallback && exists(fallback)) return fallback;
  return null;
}

/** The top-left-most highlighted cell, as visible [col, row] indices. */
export function firstDiffCell(
  cells: SheetDiff['cells'],
  visibleRowIds: string[],
  visibleColIds: string[],
): [number, number] | null {
  let best: [number, number] | null = null;
  for (const key of cells.keys()) {
    const sep = key.indexOf(':');
    const ri = visibleRowIds.indexOf(key.slice(0, sep));
    const ci = visibleColIds.indexOf(key.slice(sep + 1));
    if (ri < 0 || ci < 0) continue;
    if (!best || ri < best[1] || (ri === best[1] && ci < best[0])) best = [ci, ri];
  }
  return best;
}
