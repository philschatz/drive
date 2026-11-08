import { sheetDiff, sheetKinds, sheetOfFirstChange, firstDiffCell } from './diff-cells';
import type { VersionChange } from '../../../../shared/version-changes';

const changes: VersionChange[] = [
  { path: ['sheets', 's1', 'cells', 'r1:c1', 'value'], kind: 'changed', action: 'put', before: '1', after: '2' },
  { path: ['sheets', 's1', 'cells', 'r2:c1'], kind: 'added', action: 'put' },
  { path: ['sheets', 's1', 'cells', 'r2:c1', 'value'], kind: 'added', action: 'put', after: 'new' },
  { path: ['sheets', 's1', 'cells', 'r3:c2'], kind: 'removed', action: 'del', before: { value: 'gone' } },
  { path: ['sheets', 's1', 'columns', 'c2', 'width'], kind: 'changed', action: 'put', before: 100, after: 140 },
  { path: ['sheets', 's1', 'rows', 'r9'], kind: 'removed', action: 'del', before: { index: 9 } },
  { path: ['sheets', 's2', 'name'], kind: 'changed', action: 'put', before: 'Old', after: 'New' },
  { path: ['sheets', 's3'], kind: 'added', action: 'put' },
  { path: ['name'], kind: 'changed', action: 'put' },
];

describe('sheetDiff', () => {
  it('folds a sheet\'s changes per cell, column and row, keeping old cell values', () => {
    const d = sheetDiff(changes, 's1');
    expect(d.cells.get('r1:c1')).toEqual({ kind: 'changed', before: '1' });
    expect(d.cells.get('r2:c1')).toEqual({ kind: 'added' });       // new cell: added wins over its value's change
    expect(d.cells.get('r3:c2')).toEqual({ kind: 'removed', before: 'gone' });
    expect(d.columns.get('c2')).toBe('changed');
    expect(d.rows.get('r9')).toBe('removed');
    expect(d.sheet).toBeUndefined();                               // cells etc. show in place, not on the tab
  });

  it('marks the tab for the sheet\'s own fields and for a new sheet', () => {
    expect(sheetDiff(changes, 's2').sheet).toBe('changed');
    expect(sheetDiff(changes, 's3').sheet).toBe('added');
    expect(sheetKinds(changes)).toEqual(new Map([['s1', 'changed'], ['s2', 'changed'], ['s3', 'added']]));
  });
});

describe('sheetOfFirstChange', () => {
  const exists = (id: string) => ['s1', 's2'].includes(id);
  it('stays on the current sheet when the version touched it', () => {
    expect(sheetOfFirstChange(changes, 's2', exists)).toBe('s2');
  });
  it('otherwise goes to the first touched sheet that exists', () => {
    expect(sheetOfFirstChange(changes, 'other', exists)).toBe('s1');
    expect(sheetOfFirstChange([changes[7]], 'other', exists)).toBeNull();   // s3 does not exist here
    expect(sheetOfFirstChange([changes[8]], 's1', exists)).toBeNull();      // nothing sheet-scoped
  });
});

describe('firstDiffCell', () => {
  it('picks the top-left-most highlighted cell that is visible', () => {
    const cells = sheetDiff(changes, 's1').cells;
    expect(firstDiffCell(cells, ['r1', 'r2', 'r3'], ['c1', 'c2'])).toEqual([0, 0]);
    expect(firstDiffCell(cells, ['r3', 'r2'], ['c1', 'c2'])).toEqual([1, 0]);     // r3:c2 is now the top row
    expect(firstDiffCell(cells, ['rX'], ['c1'])).toBeNull();
  });
});
