import {
  applyFormatPatch, clearFormatRanges, setColumnWidths, setRowHeights,
  setFrozenRows, setFrozenColumns, frozenRowCount, frozenColCount,
  type MutSheet, type RangeBounds,
} from './doc-mutations';

/** Sheet with rows r1..rN (index 1..N) and cols c1..cM (index 1..M). */
function makeSheet(nRows = 3, nCols = 3): MutSheet {
  const rows: MutSheet['rows'] = {};
  const columns: MutSheet['columns'] = {};
  for (let i = 1; i <= nRows; i++) rows[`r${i}`] = { index: i };
  for (let i = 1; i <= nCols; i++) columns[`c${i}`] = { index: i };
  return { rows, columns, cells: {} };
}
const rowIds = ['r1', 'r2', 'r3'];
const colIds = ['c1', 'c2', 'c3'];
const bounds = (rs: string, re: string, cs: string, ce: string): RangeBounds =>
  ({ rangeRowStart: rs, rangeRowEnd: re, rangeColStart: cs, rangeColEnd: ce });

let counter = 0;
const newId = () => `id${++counter}`;
beforeEach(() => { counter = 0; });

describe('applyFormatPatch (cell formatting)', () => {
  it('creates a new FormatRange with index 1 for the first format', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r1', 'c1', 'c1'), { bold: true }, newId);
    expect(s.formats).toEqual({ id1: { index: 1, ...bounds('r1', 'r1', 'c1', 'c1'), format: { bold: true } } });
  });

  it('reuses the range with identical bounds and merges the patch', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r2', 'c1', 'c1'), { bold: true }, newId);
    applyFormatPatch(s, bounds('r1', 'r2', 'c1', 'c1'), { italic: true, textColor: '#f00' }, newId);
    expect(Object.keys(s.formats!)).toHaveLength(1);
    expect(s.formats!.id1.format).toEqual({ bold: true, italic: true, textColor: '#f00' });
  });

  it('creates a separate range for different bounds, with an incrementing index', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r1', 'c1', 'c1'), { bold: true }, newId);
    applyFormatPatch(s, bounds('r2', 'r2', 'c2', 'c2'), { italic: true }, newId);
    expect(s.formats!.id1.index).toBe(1);
    expect(s.formats!.id2.index).toBe(2);
  });

  it('deletes a property when the patch value is undefined', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r1', 'c1', 'c1'), { bold: true, italic: true }, newId);
    applyFormatPatch(s, bounds('r1', 'r1', 'c1', 'c1'), { bold: undefined }, newId);
    expect(s.formats!.id1.format).toEqual({ italic: true });
  });

  it('removes the range entirely when its format becomes empty', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r1', 'c1', 'c1'), { bold: true }, newId);
    applyFormatPatch(s, bounds('r1', 'r1', 'c1', 'c1'), { bold: undefined }, newId);
    expect(s.formats).toEqual({});
  });

  it('stores number format the same way (numFmt)', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r3', 'c1', 'c1'), { numFmt: '$#,##0.00' }, newId);
    expect(s.formats!.id1.format.numFmt).toBe('$#,##0.00');
  });
});

describe('clearFormatRanges', () => {
  it('deletes ranges entirely inside the rectangle but keeps others', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r1', 'c1', 'c1'), { bold: true }, newId);  // inside
    applyFormatPatch(s, bounds('r1', 'r2', 'c1', 'c2'), { italic: true }, newId); // inside
    applyFormatPatch(s, bounds('r3', 'r3', 'c3', 'c3'), { bold: true }, newId);   // outside
    clearFormatRanges(s, rowIds, colIds, 0, 1, 0, 1); // rows r1..r2, cols c1..c2
    expect(Object.keys(s.formats!)).toEqual(['id3']);
  });

  it('keeps ranges that only partially overlap the rectangle', () => {
    const s = makeSheet();
    applyFormatPatch(s, bounds('r1', 'r3', 'c1', 'c1'), { bold: true }, newId); // spans beyond r0..r1
    clearFormatRanges(s, rowIds, colIds, 0, 1, 0, 0);
    expect(Object.keys(s.formats!)).toEqual(['id1']);
  });
});

describe('column width / row height', () => {
  it('sets width on the given columns only', () => {
    const s = makeSheet();
    setColumnWidths(s, ['c2', 'c3'], 140);
    expect(s.columns.c1.width).toBeUndefined();
    expect(s.columns.c2.width).toBe(140);
    expect(s.columns.c3.width).toBe(140);
  });

  it('sets height on the given rows only', () => {
    const s = makeSheet();
    setRowHeights(s, ['r2'], 40);
    expect(s.rows.r1.height).toBeUndefined();
    expect(s.rows.r2.height).toBe(40);
  });
});

describe('freeze rows / columns', () => {
  it('freezes the first N rows and unfreezes the rest', () => {
    const s = makeSheet();
    setFrozenRows(s, rowIds, 2);
    expect(s.rows.r1.frozen).toBe(true);
    expect(s.rows.r2.frozen).toBe(true);
    expect(s.rows.r3.frozen).toBeUndefined();
  });

  it('unfreezing (count 0) clears all frozen flags', () => {
    const s = makeSheet();
    setFrozenRows(s, rowIds, 2);
    setFrozenRows(s, rowIds, 0);
    expect(frozenRowCount(s, rowIds)).toBe(0);
    expect(s.rows.r1.frozen).toBeUndefined();
  });

  it('freezes the first N columns', () => {
    const s = makeSheet();
    setFrozenColumns(s, colIds, 1);
    expect(s.columns.c1.frozen).toBe(true);
    expect(s.columns.c2.frozen).toBeUndefined();
  });

  it('frozenRowCount / frozenColCount count only the contiguous leading frozen band', () => {
    const s = makeSheet();
    setFrozenRows(s, rowIds, 2);
    expect(frozenRowCount(s, rowIds)).toBe(2);
    // A gap (non-contiguous frozen) stops the count at the first unfrozen row.
    s.rows.r1.frozen = false;
    expect(frozenRowCount(s, rowIds)).toBe(0);
    setFrozenColumns(s, colIds, 3);
    expect(frozenColCount(s, colIds)).toBe(3);
  });
});
