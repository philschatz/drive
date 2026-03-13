import {
  sortedEntries,
  colIndexToLetter,
  letterToColIndex,
  a1ToInternal,
  internalToA1,
  internalToR1C1,
  buildSheetData,
  getDisplayValue,
  shortId,
  detectNumericPattern,
  cycleFill,
  generateAutofillValues,
  getAutofillSourceValues,
  rewriteFormulaForDeletion,
  updateFormulasForDeletion,
} from '../src/client/datagrid/helpers';

describe('colIndexToLetter', () => {
  it('converts single-letter columns', () => {
    expect(colIndexToLetter(0)).toBe('A');
    expect(colIndexToLetter(1)).toBe('B');
    expect(colIndexToLetter(25)).toBe('Z');
  });

  it('converts double-letter columns', () => {
    expect(colIndexToLetter(26)).toBe('AA');
    expect(colIndexToLetter(27)).toBe('AB');
    expect(colIndexToLetter(51)).toBe('AZ');
    expect(colIndexToLetter(52)).toBe('BA');
  });

  it('converts triple-letter columns', () => {
    expect(colIndexToLetter(702)).toBe('AAA');
  });
});

describe('letterToColIndex', () => {
  it('converts single-letter columns', () => {
    expect(letterToColIndex('A')).toBe(0);
    expect(letterToColIndex('B')).toBe(1);
    expect(letterToColIndex('Z')).toBe(25);
  });

  it('converts double-letter columns', () => {
    expect(letterToColIndex('AA')).toBe(26);
    expect(letterToColIndex('AB')).toBe(27);
    expect(letterToColIndex('AZ')).toBe(51);
    expect(letterToColIndex('BA')).toBe(52);
  });

  it('is the inverse of colIndexToLetter', () => {
    for (let i = 0; i < 100; i++) {
      expect(letterToColIndex(colIndexToLetter(i))).toBe(i);
    }
  });
});

describe('sortedEntries', () => {
  it('sorts by index', () => {
    const map = {
      c: { index: 3 },
      a: { index: 1 },
      b: { index: 2 },
    };
    const result = sortedEntries(map);
    expect(result.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });

  it('handles fractional indices', () => {
    const map = {
      x: { index: 1.5 },
      y: { index: 1 },
      z: { index: 2 },
    };
    const result = sortedEntries(map);
    expect(result.map(([id]) => id)).toEqual(['y', 'x', 'z']);
  });

  it('returns empty array for empty map', () => {
    expect(sortedEntries({})).toEqual([]);
  });
});

describe('a1ToInternal', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3'];
  const colIds = ['c0', 'c1', 'c2', 'c3'];

  it('converts relative references', () => {
    // Cell at row 1, col 1 referencing A1 (row 0, col 0)
    expect(a1ToInternal('=A1', 1, 1, rowIds, colIds)).toBe('={R[r0]C[c0]}');
  });

  it('converts absolute references to IDs', () => {
    expect(a1ToInternal('=$A$1', 2, 2, rowIds, colIds)).toBe('={R{r0}C{c0}}');
  });

  it('handles mixed references', () => {
    // $A1 → absolute col, relative row
    expect(a1ToInternal('=$A1', 1, 1, rowIds, colIds)).toBe('={R[r0]C{c0}}');
    // A$1 → relative col, absolute row
    expect(a1ToInternal('=A$1', 1, 1, rowIds, colIds)).toBe('={R{r0}C[c0]}');
  });

  it('handles multiple references in a formula', () => {
    const result = a1ToInternal('=A1+B2', 0, 0, rowIds, colIds);
    expect(result).toBe('={R[r0]C[c0]}+{R[r1]C[c1]}');
  });

  it('preserves strings in quotes', () => {
    const result = a1ToInternal('="A1"', 0, 0, rowIds, colIds);
    expect(result).toBe('="A1"');
  });

  it('does not interpret scientific notation as cell refs', () => {
    const result = a1ToInternal('=1E2', 0, 0, rowIds, colIds);
    expect(result).toBe('=1E2');
  });

  it('handles SUM with range', () => {
    const result = a1ToInternal('=SUM(A1:A4)', 0, 0, rowIds, colIds);
    expect(result).toBe('=SUM({R[r0]C[c0]}:{R[r3]C[c0]})');
  });
});

describe('internalToA1', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3'];
  const colIds = ['c0', 'c1', 'c2', 'c3'];

  it('converts relative refs to A1', () => {
    expect(internalToA1('={R[r0]C[c0]}', 0, 0, rowIds, colIds)).toBe('=A1');
  });

  it('converts absolute refs (IDs) to $A$1 notation', () => {
    expect(internalToA1('={R{r0}C{c0}}', 2, 2, rowIds, colIds)).toBe('=$A$1');
    expect(internalToA1('={R{r1}C{c2}}', 0, 0, rowIds, colIds)).toBe('=$C$2');
  });

  it('converts mixed refs', () => {
    // absolute row, relative col
    expect(internalToA1('={R{r0}C[c0]}', 1, 1, rowIds, colIds)).toBe('=A$1');
    // relative row, absolute col
    expect(internalToA1('={R[r0]C{c0}}', 1, 1, rowIds, colIds)).toBe('=$A1');
  });

  it('returns #REF! for missing IDs', () => {
    expect(internalToA1('={R{gone}C{c0}}', 0, 0, rowIds, colIds)).toBe('=#REF!');
    expect(internalToA1('={R{r0}C{gone}}', 0, 0, rowIds, colIds)).toBe('=#REF!');
  });

  it('handles multiple refs in formula', () => {
    const result = internalToA1('={R[r0]C[c0]}+{R[r1]C[c1]}', 0, 0, rowIds, colIds);
    expect(result).toBe('=A1+B2');
  });

  it('round-trips with a1ToInternal', () => {
    const formulas = ['=A1', '=B3+C4', '=$A$1', '=SUM(A1:D4)', '=$B1+A$2'];
    for (const formula of formulas) {
      const internal = a1ToInternal(formula, 1, 1, rowIds, colIds);
      const back = internalToA1(internal, 1, 1, rowIds, colIds);
      expect(back).toBe(formula);
    }
  });
});

describe('buildSheetData', () => {
  it('builds 2D array from cells', () => {
    const cells = {
      'r0:c0': { value: '10' },
      'r0:c1': { value: 'hello' },
      'r1:c0': { value: '20' },
    };
    const result = buildSheetData(cells, ['r0', 'r1'], ['c0', 'c1']);
    expect(result).toEqual([
      [10, 'hello'],
      [20, null],
    ]);
  });

  it('converts numeric strings to numbers', () => {
    const cells = { 'r0:c0': { value: '42.5' } };
    expect(buildSheetData(cells, ['r0'], ['c0'])).toEqual([[42.5]]);
  });

  it('converts boolean strings', () => {
    const cells = {
      'r0:c0': { value: 'true' },
      'r0:c1': { value: 'false' },
    };
    expect(buildSheetData(cells, ['r0'], ['c0', 'c1'])).toEqual([[true, false]]);
  });

  it('treats empty strings as null', () => {
    const cells = { 'r0:c0': { value: '' } };
    expect(buildSheetData(cells, ['r0'], ['c0'])).toEqual([[null]]);
  });

  it('converts formulas from internal to A1 format', () => {
    const cells = {
      'r0:c0': { value: '10' },
      'r1:c0': { value: '={R[r0]C[c0]}' }, // relative ref to r0:c0
    };
    const result = buildSheetData(cells, ['r0', 'r1'], ['c0', 'c1']);
    expect(result[1][0]).toBe('=A1'); // canonical {R[r0]C[c0]} at row 1, col 0 → A1
  });
});

describe('getDisplayValue', () => {
  it('returns empty string for falsy values', () => {
    expect(getDisplayValue(null, '', 0, 0)).toBe('');
  });

  it('returns raw value for non-formula strings', () => {
    expect(getDisplayValue(null, 'hello', 0, 0)).toBe('hello');
    expect(getDisplayValue(null, '42', 0, 0)).toBe('42');
  });

  it('returns raw formula when no hf engine', () => {
    expect(getDisplayValue(null, '=A1+B2', 0, 0)).toBe('=A1+B2');
  });

  it('returns computed value from hf engine', () => {
    const mockHf = {
      getCellValue: jest.fn().mockReturnValue(42),
    };
    expect(getDisplayValue(mockHf, '=A1+B2', 0, 0)).toBe('42');
    expect(mockHf.getCellValue).toHaveBeenCalledWith({ sheet: 0, col: 0, row: 0 });
  });

  it('returns raw formula when hf returns object (error)', () => {
    const mockHf = {
      getCellValue: jest.fn().mockReturnValue({ type: 'ERROR' }),
    };
    expect(getDisplayValue(mockHf, '=A1+B2', 0, 0)).toBe('=A1+B2');
  });
});

describe('shortId', () => {
  it('returns a string of reasonable length', () => {
    const id = shortId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThanOrEqual(4);
    expect(id.length).toBeLessThanOrEqual(10);
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => shortId()));
    expect(ids.size).toBe(100);
  });
});

// --- Autofill tests ---

describe('detectNumericPattern', () => {
  it('detects constant single value', () => {
    expect(detectNumericPattern(['5'])).toEqual({ type: 'constant', start: 5, step: 0 });
  });

  it('detects constant sequence', () => {
    expect(detectNumericPattern(['5', '5', '5'])).toEqual({ type: 'constant', start: 5, step: 0 });
  });

  it('detects ascending arithmetic sequence', () => {
    expect(detectNumericPattern(['1', '2', '3'])).toEqual({ type: 'arithmetic', start: 1, step: 1 });
  });

  it('detects descending arithmetic sequence', () => {
    expect(detectNumericPattern(['30', '20', '10'])).toEqual({ type: 'arithmetic', start: 30, step: -10 });
  });

  it('detects arithmetic with step 10', () => {
    expect(detectNumericPattern(['10', '20', '30'])).toEqual({ type: 'arithmetic', start: 10, step: 10 });
  });

  it('detects two-value arithmetic', () => {
    expect(detectNumericPattern(['1', '3'])).toEqual({ type: 'arithmetic', start: 1, step: 2 });
  });

  it('handles decimal numbers', () => {
    expect(detectNumericPattern(['0.5', '1', '1.5'])).toEqual({ type: 'arithmetic', start: 0.5, step: 0.5 });
  });

  it('handles negative numbers', () => {
    expect(detectNumericPattern(['-3', '-2', '-1'])).toEqual({ type: 'arithmetic', start: -3, step: 1 });
  });

  it('returns null for non-arithmetic numbers', () => {
    expect(detectNumericPattern(['1', '3', '7'])).toBeNull();
  });

  it('returns null for non-numeric values', () => {
    expect(detectNumericPattern(['hello'])).toBeNull();
    expect(detectNumericPattern(['1', 'hello'])).toBeNull();
  });

  it('returns null for empty strings', () => {
    expect(detectNumericPattern([''])).toBeNull();
    expect(detectNumericPattern(['1', ''])).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(detectNumericPattern([])).toBeNull();
  });
});

describe('cycleFill', () => {
  it('cycles forward through values', () => {
    expect(cycleFill(['a', 'b'], 5, 'forward')).toEqual(['a', 'b', 'a', 'b', 'a']);
  });

  it('cycles backward through values', () => {
    expect(cycleFill(['a', 'b', 'c'], 3, 'backward')).toEqual(['a', 'b', 'c']);
  });

  it('handles single value', () => {
    expect(cycleFill(['x'], 3, 'forward')).toEqual(['x', 'x', 'x']);
  });

  it('returns empty for zero count', () => {
    expect(cycleFill(['a'], 0, 'forward')).toEqual([]);
  });

  it('returns empty for empty source', () => {
    expect(cycleFill([], 3, 'forward')).toEqual([]);
  });
});

describe('generateAutofillValues', () => {
  it('continues arithmetic sequence forward', () => {
    expect(generateAutofillValues(['1', '2', '3'], 3, 'forward')).toEqual(['4', '5', '6']);
  });

  it('continues arithmetic sequence backward', () => {
    expect(generateAutofillValues(['4', '5', '6'], 3, 'backward')).toEqual(['1', '2', '3']);
  });

  it('repeats constant number', () => {
    expect(generateAutofillValues(['5'], 3, 'forward')).toEqual(['5', '5', '5']);
  });

  it('continues step-10 forward', () => {
    expect(generateAutofillValues(['10', '20'], 2, 'forward')).toEqual(['30', '40']);
  });

  it('copies formulas verbatim', () => {
    expect(generateAutofillValues(['={{-1,0}}'], 3, 'forward')).toEqual([
      '={{-1,0}}', '={{-1,0}}', '={{-1,0}}',
    ]);
  });

  it('cycles multiple formulas', () => {
    expect(generateAutofillValues(['={{-1,0}}', '={{-2,0}}'], 4, 'forward')).toEqual([
      '={{-1,0}}', '={{-2,0}}', '={{-1,0}}', '={{-2,0}}',
    ]);
  });

  it('repeats single text value', () => {
    expect(generateAutofillValues(['hello'], 3, 'forward')).toEqual(['hello', 'hello', 'hello']);
  });

  it('cycles multiple text values', () => {
    expect(generateAutofillValues(['a', 'b', 'c'], 5, 'forward')).toEqual(['a', 'b', 'c', 'a', 'b']);
  });

  it('cycles non-arithmetic numbers as text', () => {
    expect(generateAutofillValues(['1', '3', '7'], 3, 'forward')).toEqual(['1', '3', '7']);
  });

  it('fills empty strings for all-empty source', () => {
    expect(generateAutofillValues(['', ''], 2, 'forward')).toEqual(['', '']);
  });

  it('returns empty for zero fill count', () => {
    expect(generateAutofillValues(['1', '2'], 0, 'forward')).toEqual([]);
  });

  it('returns empty for empty source', () => {
    expect(generateAutofillValues([], 3, 'forward')).toEqual([]);
  });
});

describe('getAutofillSourceValues', () => {
  const cells: Record<string, { value: string }> = {
    'r0:c0': { value: '1' },
    'r0:c1': { value: '2' },
    'r1:c0': { value: '3' },
    'r1:c1': { value: '4' },
    'r2:c0': { value: '5' },
    'r2:c1': { value: '6' },
  };
  const rowIds = ['r0', 'r1', 'r2'];
  const colIds = ['c0', 'c1'];

  it('extracts column strips for vertical fill', () => {
    const range = { minCol: 0, maxCol: 1, minRow: 0, maxRow: 2 };
    const result = getAutofillSourceValues(cells, rowIds, colIds, range, 'row');
    expect(result).toEqual([
      ['1', '3', '5'],  // column 0
      ['2', '4', '6'],  // column 1
    ]);
  });

  it('extracts row strips for horizontal fill', () => {
    const range = { minCol: 0, maxCol: 1, minRow: 0, maxRow: 1 };
    const result = getAutofillSourceValues(cells, rowIds, colIds, range, 'col');
    expect(result).toEqual([
      ['1', '2'],  // row 0
      ['3', '4'],  // row 1
    ]);
  });

  it('returns empty string for missing cells', () => {
    const sparseCells: Record<string, { value: string }> = { 'r2:c0': { value: '5' } };
    const range = { minCol: 0, maxCol: 1, minRow: 2, maxRow: 2 };
    const result = getAutofillSourceValues(sparseCells, rowIds, colIds, range, 'row');
    expect(result).toEqual([['5'], ['']]);
  });

  it('handles single-cell source', () => {
    const range = { minCol: 0, maxCol: 0, minRow: 0, maxRow: 0 };
    const result = getAutofillSourceValues(cells, rowIds, colIds, range, 'row');
    expect(result).toEqual([['1']]);
  });
});

describe('internalToR1C1', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3', 'r4'];
  const colIds = ['c0', 'c1', 'c2', 'c3', 'c4'];

  it('converts relative refs to R1C1 offsets', () => {
    // ={R[r0]C[c0]} at cell (1,1): r0 is at index 0, offset = 0-1 = -1
    expect(internalToR1C1('={R[r0]C[c0]}', 1, 1, rowIds, colIds)).toBe('=R[-1]C[-1]');
  });

  it('converts absolute refs to R1C1 absolute', () => {
    // ={R{r0}C{c0}} → R1C1 (1-based absolute)
    expect(internalToR1C1('={R{r0}C{c0}}', 2, 2, rowIds, colIds)).toBe('=R1C1');
  });

  it('converts mixed refs', () => {
    // absolute row r0, relative col c0 at cell (1,1)
    expect(internalToR1C1('={R{r0}C[c0]}', 1, 1, rowIds, colIds)).toBe('=R1C[-1]');
  });

  it('converts self-referencing relative ref to RC (zero offsets omitted)', () => {
    expect(internalToR1C1('={R[r1]C[c1]}', 1, 1, rowIds, colIds)).toBe('=RC');
  });

  it('handles expressions', () => {
    expect(internalToR1C1('={R[r0]C[c0]}*2+{R[r1]C[c1]}', 0, 0, rowIds, colIds))
      .toBe('=RC*2+R[1]C[1]');
  });

  it('handles ranges in functions', () => {
    expect(internalToR1C1('=SUM({R[r0]C[c0]}:{R[r2]C[c0]})', 0, 0, rowIds, colIds))
      .toBe('=SUM(RC:R[2]C)');
  });

  it('returns #REF! for missing IDs', () => {
    expect(internalToR1C1('={R{gone}C{c0}}', 0, 0, rowIds, colIds)).toBe('=#REF!');
  });

  it('returns original formula on parse error', () => {
    expect(internalToR1C1('not a formula', 0, 0, rowIds, colIds)).toBe('not a formula');
  });

  it('round-trips through a1ToInternal: R1C1 → canonical → R1C1', () => {
    // ={R[r0]C[c0]} at (1,1) → R[-1]C[-1]
    const r1c1 = internalToR1C1('={R[r0]C[c0]}', 1, 1, rowIds, colIds);
    expect(r1c1).toBe('=R[-1]C[-1]');
    // Re-parse at (2,2): target = 2+(-1)=1, 2+(-1)=1 → r1, c1
    const canonical = a1ToInternal(r1c1, 2, 2, rowIds, colIds);
    expect(canonical).toBe('={R[r1]C[c1]}');
  });
});

// --- Formula rewriting on deletion ---

describe('rewriteFormulaForDeletion', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3', 'r4'];
  const colIds = ['c0', 'c1', 'c2', 'c3', 'c4'];

  it('returns null when no refs are affected', () => {
    expect(rewriteFormulaForDeletion(
      '={R[r0]C[c0]}+{R[r1]C[c1]}',
      new Set(['r4']), new Set(), rowIds, colIds,
    )).toBeNull();
  });

  it('replaces single cell ref with deleted row → #REF!', () => {
    expect(rewriteFormulaForDeletion(
      '={R[r2]C[c0]}',
      new Set(['r2']), new Set(), rowIds, colIds,
    )).toBe('=#REF!');
  });

  it('replaces single cell ref with deleted col → #REF!', () => {
    expect(rewriteFormulaForDeletion(
      '={R[r0]C[c2]}',
      new Set(), new Set(['c2']), rowIds, colIds,
    )).toBe('=#REF!');
  });

  it('replaces only affected ref in mixed formula', () => {
    expect(rewriteFormulaForDeletion(
      '={R[r0]C[c0]}+{R[r2]C[c0]}',
      new Set(['r2']), new Set(), rowIds, colIds,
    )).toBe('={R[r0]C[c0]}+#REF!');
  });

  it('shrinks range when end row is deleted', () => {
    // SUM(r0:r3) col c0, delete r3 → range becomes r0:r2
    expect(rewriteFormulaForDeletion(
      '=SUM({R[r0]C[c0]}:{R[r3]C[c0]})',
      new Set(['r3']), new Set(), rowIds, colIds,
    )).toBe('=SUM({R[r0]C[c0]}:{R[r2]C[c0]})');
  });

  it('shrinks range when start row is deleted', () => {
    // SUM(r0:r3) col c0, delete r0 → range becomes r1:r3
    expect(rewriteFormulaForDeletion(
      '=SUM({R[r0]C[c0]}:{R[r3]C[c0]})',
      new Set(['r0']), new Set(), rowIds, colIds,
    )).toBe('=SUM({R[r1]C[c0]}:{R[r3]C[c0]})');
  });

  it('shrinks range when end col is deleted', () => {
    expect(rewriteFormulaForDeletion(
      '=SUM({R[r0]C[c0]}:{R[r0]C[c3]})',
      new Set(), new Set(['c3']), rowIds, colIds,
    )).toBe('=SUM({R[r0]C[c0]}:{R[r0]C[c2]})');
  });

  it('shrinks range when both endpoints deleted but survivors in middle', () => {
    // range r0:r3, delete r0 and r3 → shrinks to r1:r2
    expect(rewriteFormulaForDeletion(
      '={R[r0]C[c0]}:{R[r3]C[c0]}',
      new Set(['r0', 'r3']), new Set(), rowIds, colIds,
    )).toBe('={R[r1]C[c0]}:{R[r2]C[c0]}');
  });

  it('range shrinks to nearest survivor outside range', () => {
    // r0:r2 all deleted, r3 survives → both endpoints collapse to r3
    expect(rewriteFormulaForDeletion(
      '=SUM({R[r0]C[c0]}:{R[r2]C[c0]})',
      new Set(['r0', 'r1', 'r2']), new Set(), rowIds, colIds,
    )).toBe('=SUM({R[r3]C[c0]}:{R[r3]C[c0]})');
  });

  it('range becomes #REF! when all rows are deleted', () => {
    expect(rewriteFormulaForDeletion(
      '=SUM({R[r0]C[c0]}:{R[r2]C[c0]})',
      new Set(['r0', 'r1', 'r2', 'r3', 'r4']), new Set(), rowIds, colIds,
    )).toBe('=SUM(#REF!)');
  });

  it('handles absolute refs the same way', () => {
    expect(rewriteFormulaForDeletion(
      '={R{r2}C{c0}}',
      new Set(['r2']), new Set(), rowIds, colIds,
    )).toBe('=#REF!');
  });

  it('does not modify non-formula strings', () => {
    // Non-formula strings would throw in parseInternal; caller should filter
    expect(() => rewriteFormulaForDeletion(
      'hello',
      new Set(['r0']), new Set(), rowIds, colIds,
    )).toThrow();
  });

  it('handles nested function with range and single ref', () => {
    // IF(SUM(r0:r3) > r4, r0, 0) — delete r4 → IF(SUM(r0:r3) > #REF!, r0, 0)
    expect(rewriteFormulaForDeletion(
      '=IF(SUM({R[r0]C[c0]}:{R[r3]C[c0]})>{R[r4]C[c0]},{R[r0]C[c0]},0)',
      new Set(['r4']), new Set(), rowIds, colIds,
    )).toBe('=IF(SUM({R[r0]C[c0]}:{R[r3]C[c0]})>#REF!,{R[r0]C[c0]},0)');
  });
});

describe('updateFormulasForDeletion', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3'];
  const colIds = ['c0', 'c1', 'c2', 'c3'];

  it('returns only changed cells', () => {
    const cells: Record<string, { value: string }> = {
      'r0:c0': { value: '={R[r2]C[c0]}' },  // refs deleted row
      'r0:c1': { value: '={R[r0]C[c0]}' },  // not affected
      'r1:c0': { value: 'hello' },            // not a formula
    };
    const result = updateFormulasForDeletion(cells, new Set(['r2']), new Set(), rowIds, colIds);
    expect(result).toEqual({ 'r0:c0': '=#REF!' });
  });

  it('skips cells belonging to deleted rows', () => {
    const cells: Record<string, { value: string }> = {
      'r2:c0': { value: '={R[r0]C[c0]}' },  // belongs to deleted row
      'r0:c0': { value: '={R[r2]C[c0]}' },  // refs deleted row
    };
    const result = updateFormulasForDeletion(cells, new Set(['r2']), new Set(), rowIds, colIds);
    expect(result).toEqual({ 'r0:c0': '=#REF!' });
    expect(result).not.toHaveProperty('r2:c0');
  });

  it('skips cells belonging to deleted cols', () => {
    const cells: Record<string, { value: string }> = {
      'r0:c2': { value: '={R[r0]C[c0]}' },  // belongs to deleted col
      'r0:c0': { value: '={R[r0]C[c2]}' },  // refs deleted col
    };
    const result = updateFormulasForDeletion(cells, new Set(), new Set(['c2']), rowIds, colIds);
    expect(result).toEqual({ 'r0:c0': '=#REF!' });
    expect(result).not.toHaveProperty('r0:c2');
  });

  it('returns empty when no formulas are affected', () => {
    const cells: Record<string, { value: string }> = {
      'r0:c0': { value: '={R[r0]C[c0]}' },
      'r0:c1': { value: '42' },
    };
    const result = updateFormulasForDeletion(cells, new Set(['r3']), new Set(), rowIds, colIds);
    expect(result).toEqual({});
  });
});

// ── Paste pipeline ───────────────────────────────────────────────────────────

// Simulates the paste pipeline: clipboard data → parseHtmlClipboard / TSV split
// → a1ToInternal for formula cells → stored value in the document.
// This mirrors the logic in commands.ts paste handler.

const pasteRowIds = ['r0', 'r1', 'r2', 'r3', 'r4'];
const pasteColIds = ['c0', 'c1', 'c2', 'c3', 'c4'];

/** Simulate the paste storage logic from commands.ts */
function simulatePaste(
  values: string[][],
  destRow: number,
  destCol: number,
  rowIds = pasteRowIds,
  colIds = pasteColIds,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let dr = 0; dr < values.length; dr++) {
    for (let dc = 0; dc < values[dr].length; dc++) {
      const r = destRow + dr;
      const c = destCol + dc;
      if (r >= rowIds.length || c >= colIds.length) continue;
      const val = values[dr][dc];
      const stored = val.startsWith('=')
        ? a1ToInternal(val, r, c, rowIds, colIds)
        : val;
      result[`${rowIds[r]}:${colIds[c]}`] = stored;
    }
  }
  return result;
}

describe('paste with formulas', () => {
  it('pastes plain values without conversion', () => {
    const result = simulatePaste([['10', '20'], ['30', '40']], 0, 0);
    expect(result).toEqual({
      'r0:c0': '10',
      'r0:c1': '20',
      'r1:c0': '30',
      'r1:c1': '40',
    });
  });

  it('converts A1-style formula to internal format on paste', () => {
    // Pasting =A1+B1 into cell (row=1, col=0) should reference r0:c0 and r0:c1
    const result = simulatePaste([['=A1+B1']], 1, 0);
    const stored = result['r1:c0'];
    expect(stored).toMatch(/^=/);
    // Convert back to A1 to verify round-trip
    const a1 = internalToA1(stored, 1, 0, pasteRowIds, pasteColIds);
    expect(a1).toBe('=A1+B1');
  });

  it('converts R1C1 relative formula to internal format on paste', () => {
    // =R[-1]C[0] in cell (row=2, col=1) should reference row 1, col 1
    const result = simulatePaste([['=R[-1]C[0]']], 2, 1);
    const stored = result['r2:c1'];
    expect(stored).toMatch(/^=/);
    // Should reference one row above same column → r1:c1
    const a1 = internalToA1(stored, 2, 1, pasteRowIds, pasteColIds);
    expect(a1).toBe('=B2');
  });

  it('converts R1C1 absolute formula to internal format on paste', () => {
    // =R1C1 (absolute row 1, col 1 in 1-based) → should always be A1
    const result = simulatePaste([['=R1C1']], 3, 3);
    const stored = result['r3:c3'];
    expect(stored).toMatch(/^=/);
    const a1 = internalToA1(stored, 3, 3, pasteRowIds, pasteColIds);
    expect(a1).toBe('=$A$1');
  });

  it('converts R1C1 range formula on paste', () => {
    // =SUM(R1C1:R2C3) pasted into (0,0)
    const result = simulatePaste([['=SUM(R1C1:R2C3)']], 0, 0);
    const stored = result['r0:c0'];
    expect(stored).toMatch(/^=/);
    const a1 = internalToA1(stored, 0, 0, pasteRowIds, pasteColIds);
    expect(a1).toBe('=SUM($A$1:$C$2)');
  });

  it('converts R1C1 mixed relative/absolute on paste', () => {
    // =R[-1]C1 → relative row, absolute col. In cell (row=2, col=2) → $A2
    const result = simulatePaste([['=R[-1]C1']], 2, 2);
    const stored = result['r2:c2'];
    const a1 = internalToA1(stored, 2, 2, pasteRowIds, pasteColIds);
    expect(a1).toBe('=$A2');
  });

  it('converts bare RC (current cell) on paste', () => {
    // =RC means current cell. In cell (row=1, col=1) → B2
    const result = simulatePaste([['=RC']], 1, 1);
    const stored = result['r1:c1'];
    const a1 = internalToA1(stored, 1, 1, pasteRowIds, pasteColIds);
    expect(a1).toBe('=B2');
  });

  it('handles paste at offset position: formulas adjust via R1C1 relative refs', () => {
    // Pasting =R[-1]C[0] at row=3, col=2 should reference row 2, col 2 → C3
    const parsed = [['=R[-1]C[0]']];
    const result = simulatePaste(parsed, 3, 2);
    const a1 = internalToA1(result['r3:c2'], 3, 2, pasteRowIds, pasteColIds);
    expect(a1).toBe('=C3');
  });

  it('handles internal copy→paste roundtrip with formulas', () => {
    // Step 1: Cell at (1,1) has internal formula referencing (0,0)
    const internalFormula = a1ToInternal('=A1+1', 1, 1, pasteRowIds, pasteColIds);

    // Step 2: Copy converts to R1C1
    const r1c1 = internalToR1C1(internalFormula, 1, 1, pasteRowIds, pasteColIds);

    // Step 3: Paste at (2,2) converts R1C1 back to internal
    const pastedInternal = a1ToInternal(r1c1, 2, 2, pasteRowIds, pasteColIds);

    // Step 4: Verify it now references (1,1) — shifted by (1,1) from original
    const a1 = internalToA1(pastedInternal, 2, 2, pasteRowIds, pasteColIds);
    expect(a1).toBe('=B2+1');
  });

  it('handles internal copy→paste roundtrip preserving absolute refs', () => {
    // $A$1 should stay $A$1 regardless of paste position
    const internalFormula = a1ToInternal('=$A$1', 0, 0, pasteRowIds, pasteColIds);
    const r1c1 = internalToR1C1(internalFormula, 0, 0, pasteRowIds, pasteColIds);
    const pastedInternal = a1ToInternal(r1c1, 3, 3, pasteRowIds, pasteColIds);
    const a1 = internalToA1(pastedInternal, 3, 3, pasteRowIds, pasteColIds);
    expect(a1).toBe('=$A$1');
  });

  it('handles R1C1 formulas with COUNTIF-style function names', () => {
    // Function names containing R or C should not be confused with R1C1 refs
    const result = simulatePaste([['=COUNTIF(R1C1:R3C1,">0")']], 0, 0);
    const stored = result['r0:c0'];
    const a1 = internalToA1(stored, 0, 0, pasteRowIds, pasteColIds);
    expect(a1).toBe('=COUNTIF($A$1:$A$3,">0")');
  });

  it('handles R1C1 formula with CONCATENATE', () => {
    const result = simulatePaste([['=CONCATENATE(RC[-1],RC[-2])']], 0, 2);
    const stored = result['r0:c2'];
    const a1 = internalToA1(stored, 0, 2, pasteRowIds, pasteColIds);
    expect(a1).toBe('=CONCATENATE(B1,A1)');
  });

  it('handles R1C1 relative range in SUM', () => {
    // =SUM(R[-2]C[0]:R[-1]C[0]) at row 3
    const result = simulatePaste([['=SUM(R[-2]C[0]:R[-1]C[0])']], 3, 0);
    const stored = result['r3:c0'];
    const a1 = internalToA1(stored, 3, 0, pasteRowIds, pasteColIds);
    expect(a1).toBe('=SUM(A2:A3)');
  });

  it('handles multi-cell paste where some cells have formulas and some are plain', () => {
    const values = [
      ['100', '=RC[-1]*2'],
      ['=R[-1]C[0]+1', '=RC[-1]*2'],
    ];
    const result = simulatePaste(values, 0, 0);

    expect(result['r0:c0']).toBe('100');

    const a1_01 = internalToA1(result['r0:c1'], 0, 1, pasteRowIds, pasteColIds);
    expect(a1_01).toBe('=A1*2');

    const a1_10 = internalToA1(result['r1:c0'], 1, 0, pasteRowIds, pasteColIds);
    expect(a1_10).toBe('=A1+1');

    const a1_11 = internalToA1(result['r1:c1'], 1, 1, pasteRowIds, pasteColIds);
    expect(a1_11).toBe('=A2*2');
  });

  it('handles TSV paste with formula strings (plain text fallback)', () => {
    // When HTML is unavailable, formulas come as plain text via TSV split
    const text = '=A1+B1\t=SUM(A1:A3)\n100\t200';
    const rows = text.split('\n').map(l => l.split('\t'));
    const result = simulatePaste(rows, 0, 0);

    // Formula cells should be converted
    expect(result['r0:c0']).toMatch(/^=/);
    const a1_00 = internalToA1(result['r0:c0'], 0, 0, pasteRowIds, pasteColIds);
    expect(a1_00).toBe('=A1+B1');

    expect(result['r0:c1']).toMatch(/^=/);
    const a1_01 = internalToA1(result['r0:c1'], 0, 1, pasteRowIds, pasteColIds);
    expect(a1_01).toBe('=SUM(A1:A3)');

    // Plain cells
    expect(result['r1:c0']).toBe('100');
    expect(result['r1:c1']).toBe('200');
  });

});
