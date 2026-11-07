import { groupTables, tableContaining, type BlockLike } from './rich-text-tables';

const p: BlockLike = { type: 'paragraph' };
const cell = (col: number, header = false): BlockLike =>
  ({ type: 'table-cell', attrs: header ? { col, header: true } : { col } });

describe('groupTables', () => {
  it('reads rows off the column numbers', () => {
    const blocks = [p, cell(0, true), cell(1, true), cell(0), cell(1), p];
    expect(groupTables(blocks)).toEqual([
      { start: 1, end: 5, rows: [[1, 2], [3, 4]], columns: 2 },
    ]);
  });

  it('starts a new table at a header cell that follows body cells', () => {
    const blocks = [cell(0, true), cell(0), cell(0, true), cell(0)];
    expect(groupTables(blocks).map(g => [g.start, g.end])).toEqual([[0, 2], [2, 4]]);
  });

  it('keeps a header-less run as one table whose first row sets the width', () => {
    const blocks = [cell(0), cell(1), cell(2), cell(0), cell(1)];
    const [g] = groupTables(blocks);
    expect(g.rows).toEqual([[0, 1, 2], [3, 4]]);
    expect(g.columns).toBe(3);
  });

  it('tolerates a ragged column sequence without losing a cell', () => {
    // col never going backwards means every cell lands in the same row.
    const blocks = [cell(0), cell(1), cell(5), cell(2)];
    const [g] = groupTables(blocks);
    expect(g.rows).toEqual([[0, 1, 2], [3]]);
    expect(g.rows.flat()).toHaveLength(4);
  });

  it('treats a missing or malformed col as 0', () => {
    const blocks: BlockLike[] = [{ type: 'table-cell' }, { type: 'table-cell', attrs: { col: 'x' } }];
    expect(groupTables(blocks)[0].rows).toEqual([[0], [1]]);
  });

  it('skips the implicit leading block and non-cells', () => {
    expect(groupTables([null, p, { type: 'divider' }])).toEqual([]);
  });

  it('finds the table a block index belongs to', () => {
    const groups = groupTables([p, cell(0, true), cell(0), p]);
    expect(tableContaining(groups, 2)?.start).toBe(1);
    expect(tableContaining(groups, 3)).toBeNull();
    expect(tableContaining(groups, 0)).toBeNull();
  });
});
