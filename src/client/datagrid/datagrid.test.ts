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
} from './helpers';

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

  it('resolves partial range B2:B (missing end row = last row)', () => {
    const result = a1ToInternal('=SUM(B2:B)', 0, 0, rowIds, colIds);
    // 4 rows (r0-r3), B=c1, row 2=r1, last row=r3
    expect(result).toBe('=SUM({R[r1]C[c1]}:{R[r3]C[c1]})');
  });

  it('resolves partial range B:B4 (missing start row = row 1)', () => {
    const result = a1ToInternal('=SUM(B:B4)', 0, 0, rowIds, colIds);
    // B=c1, start row=r0, B4 row=r3
    expect(result).toBe('=SUM({R[r0]C[c1]}:{R[r3]C[c1]})');
  });

  it('round-trips partial range B2:B through a1ToInternal → internalToA1', () => {
    const internal = a1ToInternal('=SUM(B2:B)', 0, 0, rowIds, colIds);
    const back = internalToA1(internal, 0, 0, rowIds, colIds);
    // B2:B resolves to B2:B4 (4 rows)
    expect(back).toBe('=SUM(B2:B4)');
  });

  it('converts cross-sheet references using target sheet row/col IDs', () => {
    // Current sheet needs enough cols for local refs H2, I2 (indices 7, 8)
    const localRows = ['lr0', 'lr1', 'lr2', 'lr3', 'lr4', 'lr5', 'lr6', 'lr7'];
    const localCols = ['lc0', 'lc1', 'lc2', 'lc3', 'lc4', 'lc5', 'lc6', 'lc7', 'lc8'];
    // Target "Joint Transactions" sheet has its own IDs
    const jtRowIds = ['jr0', 'jr1', 'jr2', 'jr3', 'jr4', 'jr5', 'jr6'];
    const jtColIds = ['jcA', 'jcB', 'jcC', 'jcD', 'jcE', 'jcF', 'jcG', 'jcH', 'jcI', 'jcJ', 'jcK', 'jcL', 'jcM'];
    const lookupSheetId = (name: string) => name === 'Joint Transactions' ? 'jt-sheet' : undefined;
    const lookupSheetRowColIds = (sheetId: string) =>
      sheetId === 'jt-sheet' ? { rowIds: jtRowIds, colIds: jtColIds } : undefined;

    const result = a1ToInternal(
      "=-SUMIFS('Joint Transactions'!E$2:E$7,'Joint Transactions'!M$2:M$7,\"<>IGNORED\",'Joint Transactions'!E$2:E$7,\"< 0\",'Joint Transactions'!B$2:B$7,\">=\"&H2,'Joint Transactions'!B$2:B$7,\"<=\"&I2)",
      0, 0, localRows, localCols, lookupSheetId, lookupSheetRowColIds,
    );
    // Cross-sheet refs must use the target sheet's IDs (jr*, jc*), not the local sheet's (lr*, lc*)
    expect(result).toContain('jcE');   // column E from Joint Transactions
    expect(result).toContain('jr1');   // row $2 (0-indexed: 1) from Joint Transactions
    expect(result).toContain('jr6');   // row $7 (0-indexed: 6) from Joint Transactions
    expect(result).toContain('jcM');   // column M from Joint Transactions
    expect(result).toContain('jcB');   // column B from Joint Transactions
    // Local refs H2 and I2 should use current sheet IDs
    expect(result).toContain('lc7');   // H is col index 7 on local sheet
    expect(result).toContain('lc8');   // I is col index 8 on local sheet
  });

  it('round-trips cross-sheet SUMIFS through a1ToInternal → internalToA1', () => {
    const localRows = ['lr0', 'lr1', 'lr2', 'lr3', 'lr4', 'lr5', 'lr6', 'lr7'];
    const localCols = ['lc0', 'lc1', 'lc2', 'lc3', 'lc4', 'lc5', 'lc6', 'lc7', 'lc8'];
    const jtRowIds = ['jr0', 'jr1', 'jr2', 'jr3', 'jr4', 'jr5', 'jr6'];
    const jtColIds = ['jcA', 'jcB', 'jcC', 'jcD', 'jcE', 'jcF', 'jcG', 'jcH', 'jcI', 'jcJ', 'jcK', 'jcL', 'jcM'];
    const lookupSheetId = (name: string) => name === 'Joint Transactions' ? 'jt-sheet' : undefined;
    const lookupSheetRowColIds = (sheetId: string) =>
      sheetId === 'jt-sheet' ? { rowIds: jtRowIds, colIds: jtColIds } : undefined;
    const sheetNameLookup = (id: string) => id === 'jt-sheet' ? 'Joint Transactions' : undefined;

    const formula = "=-SUMIFS('Joint Transactions'!E$2:E$7,'Joint Transactions'!M$2:M$7,\"<>IGNORED\",'Joint Transactions'!E$2:E$7,\"< 0\",'Joint Transactions'!B$2:B$7,\">=\"&H2,'Joint Transactions'!B$2:B$7,\"<=\"&I2)";
    const internal = a1ToInternal(formula, 0, 0, localRows, localCols, lookupSheetId, lookupSheetRowColIds);
    const back = internalToA1(internal, 0, 0, localRows, localCols, sheetNameLookup, lookupSheetRowColIds);
    expect(back).toBe(formula);
  });

  it('round-trips cross-sheet refs through internalToR1C1 → a1ToInternal (autofill path)', () => {
    const localRows = ['lr0', 'lr1', 'lr2'];
    const localCols = ['lc0', 'lc1', 'lc2', 'lc3', 'lc4'];
    const catRowIds = Array.from({ length: 1642 }, (_, i) => 'cr' + i);
    const catColIds = ['cc0', 'cc1', 'cc2'];
    const lookupSheetId = (name: string) => name === 'Categories' ? 'cat1' : undefined;
    const lookupSheetRowColIds = (sheetId: string) =>
      sheetId === 'cat1' ? { rowIds: catRowIds, colIds: catColIds } : undefined;
    const sheetNameLookup = (id: string) => id === 'cat1' ? 'Categories' : undefined;

    const formula = '=INDEX(Categories!$C$2:$C$1642,MATCH(TRUE,SEARCH(Categories!$A$2:$A$1642,C3)>=1,0))';
    const internal = a1ToInternal(formula, 2, 0, localRows, localCols, lookupSheetId, lookupSheetRowColIds);
    expect(internal).not.toContain('#REF');

    // Autofill round-trip: internal → R1C1 → internal
    const r1c1 = internalToR1C1(internal, 2, 0, localRows, localCols, sheetNameLookup, lookupSheetRowColIds);
    expect(r1c1).toContain('Categories!');
    expect(r1c1).not.toContain('#REF');

    const backInternal = a1ToInternal(r1c1, 2, 0, localRows, localCols, lookupSheetId, lookupSheetRowColIds);
    expect(backInternal).not.toContain('#REF');
    expect(backInternal).toBe(internal);
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

  it('converts cross-sheet references when lookups are provided', () => {
    const cells = {
      'r0:c0': { value: '={R{rA}C{cX}S{sheet2}}' }, // absolute ref to sheet2 rA:cX
    };
    const sheetNameLookup = (id: string) => id === 'sheet2' ? 'Prices' : undefined;
    const sheetRowColLookup = (id: string) =>
      id === 'sheet2' ? { rowIds: ['rA', 'rB'], colIds: ['cX', 'cY'] } : undefined;
    const result = buildSheetData(cells, ['r0'], ['c0'], sheetNameLookup, sheetRowColLookup);
    expect(result[0][0]).toBe('=Prices!$A$1');
  });

  it('returns #REF! for cross-sheet refs when lookups are missing', () => {
    const cells = {
      'r0:c0': { value: '={R{rA}C{cX}S{sheet2}}' },
    };
    // No lookups provided — sheet2 is unknown
    const result = buildSheetData(cells, ['r0'], ['c0']);
    expect(result[0][0]).toBe('=#REF!');
  });

  it('converts cross-sheet range references', () => {
    const cells = {
      'r0:c0': { value: '=SUM({R{rA}C{cX}S{sheet2}}:{R{rB}C{cY}S{sheet2}})' },
    };
    const sheetNameLookup = (id: string) => id === 'sheet2' ? 'Data' : undefined;
    const sheetRowColLookup = (id: string) =>
      id === 'sheet2' ? { rowIds: ['rA', 'rB'], colIds: ['cX', 'cY'] } : undefined;
    const result = buildSheetData(cells, ['r0'], ['c0'], sheetNameLookup, sheetRowColLookup);
    expect(result[0][0]).toBe('=SUM(Data!$A$1:$B$2)');
  });

  it('quotes sheet names with spaces in cross-sheet refs', () => {
    const cells = {
      'r0:c0': { value: '={R{rA}C{cX}S{s2}}' },
    };
    const sheetNameLookup = (id: string) => id === 's2' ? 'My Sheet' : undefined;
    const sheetRowColLookup = (id: string) =>
      id === 's2' ? { rowIds: ['rA'], colIds: ['cX'] } : undefined;
    const result = buildSheetData(cells, ['r0'], ['c0'], sheetNameLookup, sheetRowColLookup);
    expect(result[0][0]).toBe("='My Sheet'!$A$1");
  });
});

describe('getDisplayValue', () => {
  it('returns empty string for falsy values', () => {
    expect(getDisplayValue(null, '', 's1', 'r1', 'c1')).toBe('');
  });

  it('returns raw value for non-formula strings', () => {
    expect(getDisplayValue(null, 'hello', 's1', 'r1', 'c1')).toBe('hello');
    expect(getDisplayValue(null, '42', 's1', 'r1', 'c1')).toBe('42');
  });

  it('returns raw formula when no computed values', () => {
    expect(getDisplayValue(null, '=A1+B2', 's1', 'r1', 'c1')).toBe('=A1+B2');
  });

  it('returns computed value from lookup map', () => {
    const map = new Map<string, string | number>([['s1:r1:c1', 42]]);
    expect(getDisplayValue(map, '=A1+B2', 's1', 'r1', 'c1')).toBe('42');
  });

  it('returns empty string when formula has no computed value', () => {
    const map = new Map<string, string | number>();
    expect(getDisplayValue(map, '=A1+B2', 's1', 'r1', 'c1')).toBe('');
  });

  it('returns spilled value for empty cell with computed value (spill target)', () => {
    const map = new Map<string, string | number>([['s1:r2:c1', 10], ['s1:r3:c1', 20]]);
    expect(getDisplayValue(map, '', 's1', 'r2', 'c1')).toBe('10');
    expect(getDisplayValue(map, '', 's1', 'r3', 'c1')).toBe('20');
  });

  it('returns empty string for empty cell with no computed value', () => {
    const map = new Map<string, string | number>([['s1:r1:c1', 42]]);
    expect(getDisplayValue(map, '', 's1', 'r2', 'c1')).toBe('');
  });
});

describe('HyperFormula array spill', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const HyperFormula = require('hyperformula').default;

  it('spills down rows AND across columns for 2D array results', () => {
    // 3x3 grid of values in columns A and B, formula in C1 that produces a vertical array
    const hf = HyperFormula.buildFromArray(
      [
        [1, 10, '=A1:A3*B1:B3'],
        [2, 20, null],
        [3, 30, null],
      ],
      { licenseKey: 'gpl-v3', useArrayArithmetic: true },
    );

    // Should spill C1=10, C2=40, C3=90
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 0 })).toBe(10);
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 1 })).toBe(40);
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 2 })).toBe(90);

    // C2 and C3 should be ARRAY type (spill targets)
    expect(hf.getCellType({ sheet: 0, col: 2, row: 1 })).toBe('ARRAY');
    expect(hf.getCellType({ sheet: 0, col: 2, row: 2 })).toBe('ARRAY');

    hf.destroy();
  });

  it('spills horizontally with TRANSPOSE', () => {
    // Column of values in A1:A3, TRANSPOSE in B1 should spill to C1, D1
    const hf = HyperFormula.buildFromArray(
      [
        [1, '=TRANSPOSE(A1:A3)', null, null],
        [2, null,                null, null],
        [3, null,                null, null],
      ],
      { licenseKey: 'gpl-v3', useArrayArithmetic: true },
    );

    // B1=1, C1=2, D1=3
    expect(hf.getCellValue({ sheet: 0, col: 1, row: 0 })).toBe(1);
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 0 })).toBe(2);
    expect(hf.getCellValue({ sheet: 0, col: 3, row: 0 })).toBe(3);

    // C1 and D1 should be ARRAY type (horizontal spill targets)
    expect(hf.getCellType({ sheet: 0, col: 2, row: 0 })).toBe('ARRAY');
    expect(hf.getCellType({ sheet: 0, col: 3, row: 0 })).toBe('ARRAY');

    hf.destroy();
  });

  it('HyperFormula expands grid for horizontal spill beyond input dimensions', () => {
    // Grid is only 2 columns wide — TRANSPOSE needs 3 columns for spill
    const hf = HyperFormula.buildFromArray(
      [
        [1, '=TRANSPOSE(A1:A3)'],
        [2, null],
        [3, null],
      ],
      { licenseKey: 'gpl-v3', useArrayArithmetic: true },
    );

    const dims = hf.getSheetDimensions(0);
    // HyperFormula expands grid from 2 to 4 columns for spill
    expect(dims.width).toBe(4);

    expect(hf.getCellValue({ sheet: 0, col: 1, row: 0 })).toBe(1);
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 0 })).toBe(2);
    expect(hf.getCellValue({ sheet: 0, col: 3, row: 0 })).toBe(3);
    expect(hf.getCellType({ sheet: 0, col: 2, row: 0 })).toBe('ARRAY');
    expect(hf.getCellType({ sheet: 0, col: 3, row: 0 })).toBe('ARRAY');

    hf.destroy();
  });

  it('spills 2D matrix with MMULT', () => {
    // 2x2 matrix multiply should produce a 2x2 result
    const hf = HyperFormula.buildFromArray(
      [
        [1, 0, '=MMULT(A1:B2,A1:B2)', null],
        [0, 1, null,                   null],
      ],
      { licenseKey: 'gpl-v3', useArrayArithmetic: true },
    );

    // Identity * Identity = Identity: C1=1, D1=0, C2=0, D2=1
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 0 })).toBe(1);
    expect(hf.getCellValue({ sheet: 0, col: 3, row: 0 })).toBe(0);
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 1 })).toBe(0);
    expect(hf.getCellValue({ sheet: 0, col: 3, row: 1 })).toBe(1);

    // D1, C2, D2 should be ARRAY type
    expect(hf.getCellType({ sheet: 0, col: 3, row: 0 })).toBe('ARRAY');
    expect(hf.getCellType({ sheet: 0, col: 2, row: 1 })).toBe('ARRAY');
    expect(hf.getCellType({ sheet: 0, col: 3, row: 1 })).toBe('ARRAY');

    hf.destroy();
  });

  it('SPLIT splits a string horizontally by delimiter', () => {
    const { registerCustomFunctions } = require('./hf-functions');
    registerCustomFunctions();

    // Test with literal strings
    const hf1 = HyperFormula.buildFromArray(
      [
        ['=SPLIT("food:grocery:safeway", ":")', null, null],
      ],
      { licenseKey: 'gpl-v3', useArrayArithmetic: true },
    );

    expect(hf1.getCellValue({ sheet: 0, col: 0, row: 0 })).toBe('food');
    expect(hf1.getCellValue({ sheet: 0, col: 1, row: 0 })).toBe('grocery');
    expect(hf1.getCellValue({ sheet: 0, col: 2, row: 0 })).toBe('safeway');
    expect(hf1.getCellType({ sheet: 0, col: 1, row: 0 })).toBe('ARRAY');
    expect(hf1.getCellType({ sheet: 0, col: 2, row: 0 })).toBe('ARRAY');

    hf1.destroy();

    // Test with cell reference
    const hf2 = HyperFormula.buildFromArray(
      [
        ['food:grocery:safeway', '=SPLIT(A1, ":")', null, null],
      ],
      { licenseKey: 'gpl-v3', useArrayArithmetic: true },
    );

    expect(hf2.getCellValue({ sheet: 0, col: 1, row: 0 })).toBe('food');
    expect(hf2.getCellValue({ sheet: 0, col: 2, row: 0 })).toBe('grocery');
    expect(hf2.getCellValue({ sheet: 0, col: 3, row: 0 })).toBe('safeway');

    hf2.destroy();
  });

  it('FILTER returns matching rows from a multi-column range', () => {
    const { FunctionPlugin: FP, FunctionArgumentType: FAT, SimpleRangeValue: SRV, ArraySize: AS, CellError: CE, ErrorType: ET, EmptyValue: EV } = require('hyperformula');

    class TestFilter extends FP {
      static implementedFunctions = { 'TFILTER': { method: 'tfilter', parameters: [{ argumentType: FAT.RANGE }, { argumentType: FAT.RANGE }], repeatLastArgs: 1, sizeOfResultArrayMethod: 'tfilterSize', enableArrayArithmeticForArguments: true } };
      tfilter(ast: any, state: any) {
        return this.runFunction(ast.args, state, this.metadata('TFILTER'), (...args: any[]) => {
          const data = args[0].data;
          const colCount = data[0]?.length ?? 1;
          const mask = new Array(data.length).fill(true);
          for (let ci = 1; ci < args.length; ci++) {
            const cd = args[ci].data;
            for (let r = 0; r < data.length; r++) {
              if (mask[r] && (!cd[r] || !cd[r][0] || cd[r][0] === EV || cd[r][0] === 0)) mask[r] = false;
            }
          }
          const result = data.filter((_: any, i: number) => mask[i]);
          if (result.length === 0) return new CE(ET.NA);
          // Pad to match predicted size (input row count)
          const emptyRow = new Array(colCount).fill(EV);
          while (result.length < data.length) result.push([...emptyRow]);
          return SRV.onlyValues(result);
        });
      }
      tfilterSize(ast: any, state: any) { const r = this.arraySizeForAst(ast.args[0], state); return (r.width <= 1 && r.height <= 1) ? AS.scalar() : new AS(r.width, r.height); }
    }
    HyperFormula.registerFunctionPlugin(TestFilter, { enGB: { TFILTER: 'TFILTER' } });

    // 5 rows, filter keeps 3 → result is 3 data rows + 2 empty padding rows
    const hf1 = HyperFormula.buildFromArray([
      ['Alice',   100, false, '=TFILTER(A1:B5,C1:C5)', null],
      ['Bob',     200, true,  null, null],
      ['Carol',   300, true,  null, null],
      ['Dave',    400, false, null, null],
      ['Eve',     500, true,  null, null],
    ], { licenseKey: 'gpl-v3' });

    expect(hf1.getCellValue({ sheet: 0, col: 3, row: 0 })).toBe('Bob');
    expect(hf1.getCellValue({ sheet: 0, col: 4, row: 0 })).toBe(200);
    expect(hf1.getCellValue({ sheet: 0, col: 3, row: 1 })).toBe('Carol');
    expect(hf1.getCellValue({ sheet: 0, col: 3, row: 2 })).toBe('Eve');

    hf1.destroy();
    HyperFormula.unregisterFunctionPlugin(TestFilter);
  });

  it('FILTER override: multi-column data with single-column condition', () => {
    // This test uses the ACTUAL FILTER name (not TFILTER) to verify the built-in is overridden
    const { registerCustomFunctions } = require('./hf-functions');
    registerCustomFunctions();

    // Check if the test's HyperFormula has our FILTER registered
    const hfFuncs = HyperFormula.getRegisteredFunctionNames('enGB');
    console.log('FILTER in test HF:', hfFuncs.includes('FILTER'));

    // Check if it's the same instance
    const HF2 = require('hyperformula').default;
    console.log('Same HF instance:', HyperFormula === HF2);

    const hf = HyperFormula.buildFromArray([
      ['Alice',   100, false, '=FILTER(A1:B5,C1:C5)', null],
      ['Bob',     200, true,  null, null],
      ['Carol',   300, true,  null, null],
      ['Dave',    400, false, null, null],
      ['Eve',     500, true,  null, null],
    ], { licenseKey: 'gpl-v3' });

    // Built-in FILTER would fail here (width mismatch: 2 vs 1)
    // Custom FILTER should return Bob, Carol, Eve
    const val = hf.getCellValue({ sheet: 0, col: 3, row: 0 });
    expect(val).toBe('Bob');
    expect(hf.getCellValue({ sheet: 0, col: 4, row: 0 })).toBe(200);
    expect(hf.getCellValue({ sheet: 0, col: 3, row: 1 })).toBe('Carol');
    expect(hf.getCellValue({ sheet: 0, col: 3, row: 2 })).toBe('Eve');

    hf.destroy();
  });

  it('FILTER with expression conditions and cross-sheet refs', () => {
    const { FunctionPlugin: FP, FunctionArgumentType: FAT, SimpleRangeValue: SRV, ArraySize: AS, CellError: CE, ErrorType: ET, EmptyValue: EV } = require('hyperformula');

    class TestFilter2 extends FP {
      static implementedFunctions = { 'TFILTER2': { method: 'tfilter2', parameters: [{ argumentType: FAT.RANGE }, { argumentType: FAT.RANGE }], repeatLastArgs: 1, sizeOfResultArrayMethod: 'tfilter2Size', enableArrayArithmeticForArguments: true } };
      tfilter2(ast: any, state: any) {
        return this.runFunction(ast.args, state, this.metadata('TFILTER2'), (...args: any[]) => {
          const data = args[0].data;
          const colCount = data[0]?.length ?? 1;
          const mask = new Array(data.length).fill(true);
          for (let ci = 1; ci < args.length; ci++) {
            const cd = args[ci].data;
            for (let r = 0; r < data.length; r++) {
              if (mask[r] && (!cd[r] || !cd[r][0] || cd[r][0] === EV || cd[r][0] === 0)) mask[r] = false;
            }
          }
          const result = data.filter((_: any, i: number) => mask[i]);
          if (result.length === 0) return new CE(ET.NA);
          const emptyRow = new Array(colCount).fill(EV);
          while (result.length < data.length) result.push([...emptyRow]);
          return SRV.onlyValues(result);
        });
      }
      tfilter2Size(ast: any, state: any) { const r = this.arraySizeForAst(ast.args[0], state); return (r.width <= 1 && r.height <= 1) ? AS.scalar() : new AS(r.width, r.height); }
    }
    HyperFormula.registerFunctionPlugin(TestFilter2, { enGB: { TFILTER2: 'TFILTER2' } });

    // Cross-sheet with expression conditions (B>10 AND B<30)
    const hf = HyperFormula.buildFromSheets({
      'Main': [
        ['=ARRAYFORMULA(TFILTER2(Data!A1:C5,Data!B1:B5>E1,Data!B1:B5<F1))', null, null, null, 10, 30],
      ],
      'Data': [
        ['Alice', 5, 100],
        ['Bob', 15, 200],
        ['Carol', 20, 300],
        ['Dave', 25, 400],
        ['Eve', 35, 500],
      ],
    }, { licenseKey: 'gpl-v3' });

    // Bob(15), Carol(20), Dave(25) match the conditions
    expect(hf.getCellValue({ sheet: 0, col: 0, row: 0 })).toBe('Bob');
    expect(hf.getCellValue({ sheet: 0, col: 1, row: 0 })).toBe(15);
    expect(hf.getCellValue({ sheet: 0, col: 2, row: 0 })).toBe(200);
    expect(hf.getCellValue({ sheet: 0, col: 0, row: 1 })).toBe('Carol');
    expect(hf.getCellValue({ sheet: 0, col: 0, row: 2 })).toBe('Dave');
    // Row 3 and 4 should be empty (padded)
    expect(hf.getCellType({ sheet: 0, col: 0, row: 0 })).toBe('ARRAYFORMULA');

    hf.destroy();
    HyperFormula.unregisterFunctionPlugin(TestFilter2);
  });

  it('MATCH(TRUE, SEARCH(range, cell)>=1, 0) finds first matching row via full pipeline', () => {
    const { addGoogleSheetsNamedExpressions, hfConfig } = require('./hf-functions');

    // Simulate two sheets with ID-based storage (like Automerge documents)
    const mainRows = ['r0', 'r1', 'r2'];
    const mainCols = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
    const catRows = ['cr0', 'cr1', 'cr2', 'cr3', 'cr4'];
    const catCols = ['cc0', 'cc1', 'cc2'];

    const lookupSheetId = (name: string) => name === 'Categories' ? 'cat1' : undefined;
    const lookupSheetRowColIds = (sheetId: string) =>
      sheetId === 'cat1' ? { rowIds: catRows, colIds: catCols } : undefined;
    const sheetNameLookup = (id: string) => id === 'cat1' ? 'Categories' : undefined;

    // User enters this formula in cell F3 (row=2, col=5)
    const userFormula = '=IF(NOT(E3>0),"IGNORED",IF(""=INDEX(Categories!$C$2:$C$5,MATCH(TRUE,SEARCH(Categories!$A$2:$A$5,C3)>=1,0)),"UNCATEGORIZED",INDEX(Categories!$C$2:$C$5,MATCH(TRUE,SEARCH(Categories!$A$2:$A$5,C3)>=1,0))))';

    // Convert A1 → internal (stored in Automerge)
    const internal = a1ToInternal(userFormula, 2, 5, mainRows, mainCols, lookupSheetId, lookupSheetRowColIds);
    expect(internal).not.toContain('#REF');

    // Build sheet data using the same pipeline as hf-worker
    const mainCells: Record<string, { value: string }> = {
      'r2:c2': { value: 'SAFEWAY STORE #1234' },
      'r2:c4': { value: '50' },
      'r2:c5': { value: internal },
    };
    const catCells: Record<string, { value: string }> = {
      'cr0:cc0': { value: 'keyword' }, 'cr0:cc1': { value: 'x' }, 'cr0:cc2': { value: 'category' },
      'cr1:cc0': { value: 'walmart' }, 'cr1:cc1': { value: 'x' }, 'cr1:cc2': { value: 'grocery:walmart' },
      'cr2:cc0': { value: 'safeway' }, 'cr2:cc1': { value: 'x' }, 'cr2:cc2': { value: 'grocery:safeway' },
      'cr3:cc0': { value: 'target' },  'cr3:cc1': { value: 'x' }, 'cr3:cc2': { value: 'grocery:target' },
      'cr4:cc0': { value: 'costco' },  'cr4:cc1': { value: 'x' }, 'cr4:cc2': { value: 'grocery:costco' },
    };

    const mainData = buildSheetData(mainCells, mainRows, mainCols, sheetNameLookup, lookupSheetRowColIds);
    const catData = buildSheetData(catCells, catRows, catCols, sheetNameLookup, lookupSheetRowColIds);

    // Verify the formula was converted back to valid A1
    const formulaInSheet = mainData[2][5];
    expect(typeof formulaInSheet).toBe('string');
    expect((formulaInSheet as string).startsWith('=')).toBe(true);
    expect(formulaInSheet).not.toContain('#REF');

    const hf = HyperFormula.buildFromSheets({
      'Sheet1': mainData,
      'Categories': catData,
    }, hfConfig);
    addGoogleSheetsNamedExpressions(hf);

    const result = hf.getCellValue({ sheet: 0, col: 5, row: 2 });
    expect(result).toBe('grocery:safeway');

    hf.destroy();
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

  it('cross-document paste: formulas from doc A paste correctly into doc B with different IDs', () => {
    // Simulate copying from document A (row/col IDs: rA0..rA4, cA0..cA4)
    const docARowIds = ['rA0', 'rA1', 'rA2', 'rA3', 'rA4'];
    const docAColIds = ['cA0', 'cA1', 'cA2', 'cA3', 'cA4'];
    // Cell (1,1) in doc A has formula =A1+B1 (referencing row 0, cols 0 and 1)
    const internalA = a1ToInternal('=A1+B1', 1, 1, docARowIds, docAColIds);
    // Copy converts to R1C1
    const r1c1 = internalToR1C1(internalA, 1, 1, docARowIds, docAColIds);
    // R[-1]C means R[-1]C[0] — bare C = current column (offset 0)
    expect(r1c1).toBe('=R[-1]C[-1]+R[-1]C');

    // Paste into document B (different row/col IDs) at position (2,2)
    const docBRowIds = ['rB0', 'rB1', 'rB2', 'rB3', 'rB4'];
    const docBColIds = ['cB0', 'cB1', 'cB2', 'cB3', 'cB4'];
    const result = simulatePaste([[r1c1]], 2, 2, docBRowIds, docBColIds);
    const stored = result['rB2:cB2'];
    expect(stored).toMatch(/^=/);

    // Should reference (1,1) in doc B — one row up and one col left from (2,2)
    const a1 = internalToA1(stored, 2, 2, docBRowIds, docBColIds);
    expect(a1).toBe('=B2+C2');
  });

  it('cross-document paste via TSV: R1C1 formulas adapt to new document', () => {
    // Simulate TSV clipboard from doc A containing a plain value and a formula
    // Cell (0,0) = "10", Cell (0,1) = "=A1*2" → in R1C1: "=RC[-1]*2"
    const docARowIds = ['rA0', 'rA1', 'rA2'];
    const docAColIds = ['cA0', 'cA1', 'cA2'];
    const internalFormula = a1ToInternal('=A1*2', 0, 1, docARowIds, docAColIds);
    const r1c1 = internalToR1C1(internalFormula, 0, 1, docARowIds, docAColIds);
    const tsv = `10\t${r1c1}`;

    // Simulate plain text fallback
    const rows = tsv.split('\n').map(l => l.split('\t'));

    // Paste into document B at (1, 0)
    const docBRowIds = ['rB0', 'rB1', 'rB2'];
    const docBColIds = ['cB0', 'cB1', 'cB2'];
    const result = simulatePaste(rows, 1, 0, docBRowIds, docBColIds);

    expect(result['rB1:cB0']).toBe('10');
    const a1 = internalToA1(result['rB1:cB1'], 1, 1, docBRowIds, docBColIds);
    expect(a1).toBe('=A2*2');
  });

});
