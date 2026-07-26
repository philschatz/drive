import { computeFreezeIds, applyFreezeCount } from './sheet-actions';

describe('computeFreezeIds', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];

  it('freezes the prefix up to the count-th visible id', () => {
    expect(computeFreezeIds(all, all, 2)).toEqual({
      idsToFreeze: ['a', 'b'],
      idsToUnfreeze: ['c', 'd', 'e'],
    });
  });

  it('count 0 unfreezes everything', () => {
    expect(computeFreezeIds(all, all, 0)).toEqual({
      idsToFreeze: [],
      idsToUnfreeze: all,
    });
  });

  it('includes hidden items interleaved in the frozen prefix', () => {
    // 'b' is hidden: freezing 2 visible items ⇒ prefix a,b,c
    const visible = ['a', 'c', 'd', 'e'];
    expect(computeFreezeIds(all, visible, 2)).toEqual({
      idsToFreeze: ['a', 'b', 'c'],
      idsToUnfreeze: ['d', 'e'],
    });
  });

  it('clamps a count past the end to all items', () => {
    expect(computeFreezeIds(all, all, 99)).toEqual({
      idsToFreeze: all,
      idsToUnfreeze: [],
    });
  });

  it('handles empty visible lists', () => {
    expect(computeFreezeIds(all, [], 3)).toEqual({
      idsToFreeze: [],
      idsToUnfreeze: all,
    });
  });
});

describe('applyFreezeCount', () => {
  it('mutates the right collection with args-only data', () => {
    const sheet = {
      rows: { r1: { index: 1 }, r2: { index: 2 }, r3: { index: 3 } },
      columns: { c1: { index: 1 }, c2: { index: 2 } },
    };
    const doc: any = { sheets: { s1: structuredClone(sheet) } };
    const mutate = (fn: (d: any, ...args: any[]) => void, args: unknown[]) => fn(doc, ...args);

    applyFreezeCount(mutate, 's1', sheet, ['r1', 'r2', 'r3'], 'row', 2);
    expect(doc.sheets.s1.rows.r1.frozen).toBe(true);
    expect(doc.sheets.s1.rows.r2.frozen).toBe(true);
    expect(doc.sheets.s1.rows.r3.frozen).toBeUndefined();

    applyFreezeCount(mutate, 's1', sheet, ['r1', 'r2', 'r3'], 'row', 0);
    expect(doc.sheets.s1.rows.r1.frozen).toBeUndefined();
    expect(doc.sheets.s1.rows.r2.frozen).toBeUndefined();

    applyFreezeCount(mutate, 's1', sheet, ['c1', 'c2'], 'col', 1);
    expect(doc.sheets.s1.columns.c1.frozen).toBe(true);
    expect(doc.sheets.s1.columns.c2.frozen).toBeUndefined();
  });
});
