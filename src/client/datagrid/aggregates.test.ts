import { computeSelectionAggregates } from './aggregates';

describe('computeSelectionAggregates', () => {
  it('returns null for single-cell selections', () => {
    expect(computeSelectionAggregates([{ display: '5' }])).toBeNull();
  });

  it('returns null when no cell is numeric', () => {
    expect(computeSelectionAggregates([{ display: 'a' }, { display: '' }, { display: 'x1' }])).toBeNull();
  });

  it('aggregates numeric cells, ignoring text and blanks', () => {
    const agg = computeSelectionAggregates([
      { display: '10' },
      { display: 'label' },
      { display: '' },
      { display: '20' },
      { display: '-6' },
    ]);
    expect(agg).toEqual({ sum: 24, avg: 8, min: -6, max: 20, count: 3, numFmt: undefined });
  });

  it('exposes the shared numFmt when every numeric cell agrees', () => {
    const agg = computeSelectionAggregates([
      { display: '10', numFmt: '$#,##0.00' },
      { display: 'x', numFmt: '0%' }, // non-numeric cells don't participate
      { display: '20', numFmt: '$#,##0.00' },
    ]);
    expect(agg?.numFmt).toBe('$#,##0.00');
  });

  it('drops the numFmt when numeric cells disagree', () => {
    const agg = computeSelectionAggregates([
      { display: '10', numFmt: '$#,##0.00' },
      { display: '20', numFmt: '0%' },
    ]);
    expect(agg?.numFmt).toBeUndefined();
  });

  it('drops the numFmt when only some numeric cells have one', () => {
    const agg = computeSelectionAggregates([
      { display: '10', numFmt: '$#,##0.00' },
      { display: '20' },
    ]);
    expect(agg?.numFmt).toBeUndefined();
  });

  it('handles negative-only ranges', () => {
    const agg = computeSelectionAggregates([{ display: '-5' }, { display: '-2' }]);
    expect(agg).toMatchObject({ sum: -7, min: -5, max: -2, count: 2 });
  });
});
