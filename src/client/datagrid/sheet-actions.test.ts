import { effectiveFrozenCount, applyFreezeCount } from './sheet-actions';

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
