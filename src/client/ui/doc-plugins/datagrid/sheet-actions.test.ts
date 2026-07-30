import {
  effectiveFrozenCount, applyFreezeCount, applyItemSize, SIZE_LIMITS, DEFAULT_ROW_HEIGHT,
} from './sheet-actions';

describe('effectiveFrozenCount', () => {
  const visible = ['a', 'b', 'c', 'd'];

  it('returns the stored count', () => {
    expect(effectiveFrozenCount(3, visible)).toBe(3);
  });

  it('is 0 when nothing is stored', () => {
    expect(effectiveFrozenCount(undefined, visible)).toBe(0);
  });

  it('clamps so at least one row/col stays scrollable', () => {
    expect(effectiveFrozenCount(99, visible)).toBe(3);
    expect(effectiveFrozenCount(4, visible)).toBe(3);
  });

  it('is 0 for an empty sheet', () => {
    expect(effectiveFrozenCount(2, [])).toBe(0);
  });

  it('never goes negative', () => {
    expect(effectiveFrozenCount(-5, visible)).toBe(0);
  });
});

describe('applyFreezeCount', () => {
  const makeDoc = () => ({
    sheets: {
      s1: {
        rows: { r1: { index: 1, frozen: true }, r2: { index: 2 }, r3: { index: 3 } },
        columns: { c1: { index: 1 }, c2: { index: 2 } },
      } as any,
    },
  });

  it('writes the count and clears legacy flags', () => {
    const doc = makeDoc();
    applyFreezeCount((fn, args) => fn(doc, ...args), 's1', 'row', 2);
    expect(doc.sheets.s1.frozenRows).toBe(2);
    expect(doc.sheets.s1.rows.r1.frozen).toBeUndefined();
  });

  it('deletes the field entirely when unfreezing', () => {
    const doc = makeDoc();
    applyFreezeCount((fn, args) => fn(doc, ...args), 's1', 'row', 2);
    applyFreezeCount((fn, args) => fn(doc, ...args), 's1', 'row', 0);
    expect('frozenRows' in doc.sheets.s1).toBe(false);
  });

  it('writes columns independently of rows', () => {
    const doc = makeDoc();
    applyFreezeCount((fn, args) => fn(doc, ...args), 's1', 'col', 1);
    expect(doc.sheets.s1.frozenCols).toBe(1);
    expect(doc.sheets.s1.frozenRows).toBeUndefined();
  });

  it('floors and clamps the stored count', () => {
    const doc = makeDoc();
    applyFreezeCount((fn, args) => fn(doc, ...args), 's1', 'row', 2.7);
    expect(doc.sheets.s1.frozenRows).toBe(2);
    applyFreezeCount((fn, args) => fn(doc, ...args), 's1', 'row', -3);
    expect('frozenRows' in doc.sheets.s1).toBe(false);
  });

  it('ignores an unknown sheet id', () => {
    const doc = makeDoc();
    expect(() => applyFreezeCount((fn, args) => fn(doc, ...args), 'nope', 'row', 1)).not.toThrow();
  });
});

describe('applyItemSize', () => {
  const makeDoc = () => ({
    sheets: {
      s1: {
        rows: { r1: { index: 1 }, r2: { index: 2 } },
        columns: { c1: { index: 1 } },
      } as any,
    },
  });
  const apply = (doc: any, kind: 'row' | 'col', ids: string[], size: number | null) =>
    applyItemSize((fn, args) => fn(doc, ...args), 's1', kind, ids, size);

  it('writes the height on every named row', () => {
    const doc = makeDoc();
    apply(doc, 'row', ['r1', 'r2'], 60);
    expect(doc.sheets.s1.rows.r1.height).toBe(60);
    expect(doc.sheets.s1.rows.r2.height).toBe(60);
  });

  it('writes width for columns, leaving rows alone', () => {
    const doc = makeDoc();
    apply(doc, 'col', ['c1'], 250);
    expect(doc.sheets.s1.columns.c1.width).toBe(250);
    expect(doc.sheets.s1.rows.r1.height).toBeUndefined();
  });

  it('clamps to the axis limits rather than storing an unrenderable size', () => {
    const doc = makeDoc();
    apply(doc, 'row', ['r1'], 1);
    expect(doc.sheets.s1.rows.r1.height).toBe(SIZE_LIMITS.row.min);
    apply(doc, 'row', ['r1'], 99_999);
    expect(doc.sheets.s1.rows.r1.height).toBe(SIZE_LIMITS.row.max);
  });

  // A `<tr>` height is a minimum and .datagrid-cell hard-codes 28px of content,
  // so anything below the default would render as the default — a stored value
  // the grid cannot show. This is what let a resize "apply" invisibly.
  it('never stores a row height below the rendered default', () => {
    expect(SIZE_LIMITS.row.min).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('rounds a fractional size', () => {
    const doc = makeDoc();
    apply(doc, 'row', ['r1'], 60.6);
    expect(doc.sheets.s1.rows.r1.height).toBe(61);
  });

  it('deletes the stored size on null, restoring the default', () => {
    const doc = makeDoc();
    apply(doc, 'row', ['r1'], 60);
    apply(doc, 'row', ['r1'], null);
    expect('height' in doc.sheets.s1.rows.r1).toBe(false);
  });

  it('does nothing for an empty id list', () => {
    const doc = makeDoc();
    apply(doc, 'row', [], 60);
    expect(doc.sheets.s1.rows.r1.height).toBeUndefined();
  });

  it('skips ids the sheet does not have, without throwing', () => {
    const doc = makeDoc();
    expect(() => apply(doc, 'row', ['nope', 'r1'], 60)).not.toThrow();
    expect(doc.sheets.s1.rows.r1.height).toBe(60);
  });

  it('ignores an unknown sheet id', () => {
    const doc = makeDoc();
    expect(() =>
      applyItemSize((fn, args) => fn(doc, ...args), 'nope', 'row', ['r1'], 60)
    ).not.toThrow();
  });
});
