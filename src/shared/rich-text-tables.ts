/**
 * Tables in a Peritext field: grouping `table-cell` blocks into rows.
 *
 * A table has no block of its own. Each cell is an ordinary block (`type:
 * 'table-cell'`, `attrs: { col, header? }`), so a cell's text is spliced,
 * marked and merged exactly like a paragraph's — two people editing two cells
 * at once keep both edits, where a table stored as one block's attrs would
 * resolve to one writer's whole table. The price is that the 2-D shape is
 * derived, by this module, from the 1-D run of cells:
 *
 * - a TABLE is a maximal run of consecutive `table-cell` blocks, and a header
 *   cell at column 0 that follows a body cell starts a new one (two tables with
 *   nothing between them);
 * - a ROW starts at every cell whose `col` is not past the previous cell's;
 * - the COLUMN COUNT is the first row's length. Later rows may be ragged (a
 *   peer's concurrent edit, a hand-edited source); renderers pad or truncate.
 *
 * Lives in src/shared because the Markdown exporter (worker-side backup) and the
 * editor's block model (UI) must agree on the grouping, and only one of them
 * may import the other.
 */

export interface TableCellAttrs {
  col: number;
  header?: boolean;
}

/** The loosest block shape both callers can offer: the UI's `BlockNode.block`
 * (null for the implicit leading paragraph) or the exporter's own node. */
export interface BlockLike {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TableGroup {
  /** Block index range of the cells, `end` exclusive. */
  start: number;
  end: number;
  /** Block indices, row by row. */
  rows: number[][];
  /** The first row's length — what every row is padded or cut to when drawn. */
  columns: number;
}

export const isTableCellBlock = (b: BlockLike | null | undefined): boolean => b?.type === 'table-cell';

export function cellAttrs(b: BlockLike | null | undefined): TableCellAttrs {
  const raw = (b?.attrs ?? {}) as Record<string, unknown>;
  const col = typeof raw.col === 'number' && Number.isInteger(raw.col) && raw.col >= 0 ? raw.col : 0;
  return { col, header: raw.header === true };
}

/** Every table in `blocks`, in document order. */
export function groupTables(blocks: (BlockLike | null | undefined)[]): TableGroup[] {
  const groups: TableGroup[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (!isTableCellBlock(blocks[i])) { i++; continue; }
    const start = i;
    const rows: number[][] = [];
    let prevCol = -1;
    let seenBody = false;
    while (i < blocks.length && isTableCellBlock(blocks[i])) {
      const { col, header } = cellAttrs(blocks[i]);
      // A header row can only open a table, so one appearing after body cells
      // is the next table's.
      if (header && col === 0 && seenBody) break;
      if (col <= prevCol || rows.length === 0) rows.push([]);
      rows[rows.length - 1].push(i);
      if (!header) seenBody = true;
      prevCol = col;
      i++;
    }
    groups.push({ start, end: i, rows, columns: rows[0]?.length ?? 0 });
  }
  return groups;
}

/** The table containing block `bi`, if it is a cell. */
export function tableContaining(groups: TableGroup[], bi: number): TableGroup | null {
  return groups.find(g => bi >= g.start && bi < g.end) ?? null;
}
