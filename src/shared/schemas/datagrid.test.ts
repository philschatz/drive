import { validateDocument } from '.';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasPath(errors: { path: (string | number)[] }[], expected: (string | number)[]) {
  return errors.some(e =>
    e.path.length === expected.length && e.path.every((v, i) => v === expected[i])
  );
}

// ---------------------------------------------------------------------------
// DataGrid document
// ---------------------------------------------------------------------------

/** Wrap sheet data in the multi-sheet DataGrid format. */
function grid(sheetData: { columns: any; rows: any; cells: any }, name = 'Sheet1') {
  return {
    '@type': 'DataGrid',
    name,
    sheets: { s1: { '@type': 'Sheet', name: 'Sheet 1', index: 1, ...sheetData } },
  };
}

describe('DataGrid document validation', () => {
  const validGrid = grid({
    columns: { c1: { index: 1 }, c2: { index: 2 } },
    rows: { r1: { index: 1 }, r2: { index: 2 } },
    cells: {},
  });

  it('accepts a minimal valid datagrid', () => {
    expect(validateDocument(validGrid)).toEqual([]);
  });

  it('rejects a malformed column / row id key (not a base-36 shortId)', () => {
    const badCol = grid({ columns: { 'C1': { index: 1 } }, rows: { r1: { index: 1 } }, cells: {} });
    expect(hasPath(validateDocument(badCol), ['sheets', 's1', 'columns', 'C1'])).toBe(true);
    const badRow = grid({ columns: { c1: { index: 1 } }, rows: { 'r-1': { index: 1 } }, cells: {} });
    expect(hasPath(validateDocument(badRow), ['sheets', 's1', 'rows', 'r-1'])).toBe(true);
  });

  it('rejects a malformed sheet id key', () => {
    const doc = {
      '@type': 'DataGrid', name: 'x',
      sheets: { 'bad sheet': { '@type': 'Sheet', name: 'S', index: 1, columns: {}, rows: {}, cells: {} } },
    };
    expect(hasPath(validateDocument(doc), ['sheets', 'bad sheet'])).toBe(true);
  });

  it('accepts a datagrid with cells', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: {
        'r1:c1': { value: 'Hello' },
        'r2:c2': { value: '=A1+1' },
      },
    });
    expect(validateDocument(doc)).toEqual([]);
  });

  it('rejects missing columns', () => {
    const doc = grid({ columns: undefined, rows: {}, cells: {} });
    expect(hasPath(validateDocument(doc), ['sheets', 's1', 'columns'])).toBe(true);
  });

  it('accepts non-integer column index', () => {
    const doc = grid({
      columns: { c1: { index: 1.5 } },
      rows: {},
      cells: {},
    });
    expect(hasPath(validateDocument(doc), ['sheets', 's1', 'columns', 'c1', 'index'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DataGrid data dependencies
// ---------------------------------------------------------------------------

describe('DataGrid data dependencies', () => {
  it('flags duplicate column indices', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: {},
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Duplicate column index'))).toBe(true);
  });

  it('flags duplicate row indices', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 }, r2: { index: 1 } },
      cells: {},
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Duplicate row index'))).toBe(true);
  });

  it('flags cell key with bad format', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'badkey': { value: 'x' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('not in rowId:colId format'))).toBe(true);
  });

  it('flags cell referencing non-existent row', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r99:c1': { value: 'x' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('non-existent row'))).toBe(true);
  });

  it('flags cell referencing non-existent column', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c99': { value: 'x' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('non-existent column'))).toBe(true);
  });

  it('accepts valid cell references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: 'a' }, 'r1:c2': { value: 'b' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('flags formula referencing non-existent row UUID', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: '={R{gone}C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Formula references non-existent row "gone"'))).toBe(true);
  });

  it('flags formula referencing non-existent column UUID', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: '={R{r1}C{gone}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('Formula references non-existent column "gone"'))).toBe(true);
  });

  it('accepts formulas with valid absolute references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: { 'r2:c2': { value: '={R{r1}C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('accepts formulas with relative references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: { 'r2:c2': { value: '={R[r1]C[c1]}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('accepts formulas with mixed references', () => {
    const doc = grid({
      columns: { c1: { index: 1 }, c2: { index: 2 } },
      rows: { r1: { index: 1 }, r2: { index: 2 } },
      cells: { 'r2:c2': { value: '={R{r1}C[c1]}+{R[r2]C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });

  it('flags multiple bad references in a single formula', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: '={R{badrow}C{badcol}}+{R{alsobad}C{c1}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors.filter(e => e.message.includes('Formula references non-existent')).length).toBe(3);
  });

  it('ignores non-formula cell values', () => {
    const doc = grid({
      columns: { c1: { index: 1 } },
      rows: { r1: { index: 1 } },
      cells: { 'r1:c1': { value: 'just text with {R{fake}C{refs}}' } },
    });
    const errors = validateDocument(doc);
    expect(errors).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// DataGrid: colors & range direction (Group E)
// ---------------------------------------------------------------------------

describe('DataGrid extended validation', () => {
  it('flags a non-hex conditional-format textColor', () => {
    const doc = {
      '@type': 'DataGrid', name: 'g',
      sheets: {
        s1: {
          '@type': 'Sheet', name: 'Sheet 1', index: 1,
          columns: { c1: { index: 1 } }, rows: { r1: { index: 1 } }, cells: {},
          conditionalFormats: {
            cf1: {
              index: 1, conditionType: 'gt', conditionValue: '5',
              ranges: { rg1: { rangeRowStart: 'r1', rangeRowEnd: 'r1', rangeColStart: 'c1', rangeColEnd: 'c1' } },
              format: { textColor: 'red' },
            },
          },
        },
      },
    };
    expect(hasPath(validateDocument(doc), ['sheets', 's1', 'conditionalFormats', 'cf1', 'format', 'textColor'])).toBe(true);
  });

  it('flags a non-hex format bgColor and border color', () => {
    const doc = {
      '@type': 'DataGrid', name: 'g',
      sheets: {
        s1: {
          '@type': 'Sheet', name: 'Sheet 1', index: 1,
          columns: { c1: { index: 1 } }, rows: { r1: { index: 1 } }, cells: {},
          formats: {
            f1: {
              index: 1, rangeRowStart: 'r1', rangeRowEnd: 'r1', rangeColStart: 'c1', rangeColEnd: 'c1',
              format: { bgColor: 'yellow', borderTop: { style: 'thin', color: 'black' } },
            },
          },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(hasPath(errors, ['sheets', 's1', 'formats', 'f1', 'format', 'bgColor'])).toBe(true);
    expect(hasPath(errors, ['sheets', 's1', 'formats', 'f1', 'format', 'borderTop', 'color'])).toBe(true);
  });

  it('accepts hex colors from the color picker / presets', () => {
    const doc = {
      '@type': 'DataGrid', name: 'g',
      sheets: {
        s1: {
          '@type': 'Sheet', name: 'Sheet 1', index: 1,
          columns: { c1: { index: 1 } }, rows: { r1: { index: 1 } }, cells: {},
          formats: {
            f1: {
              index: 1, rangeRowStart: 'r1', rangeRowEnd: 'r1', rangeColStart: 'c1', rangeColEnd: 'c1',
              format: { textColor: '#000000', bgColor: '#ffff00', borderTop: { style: 'thin', color: '#000000' } },
            },
          },
        },
      },
    };
    expect(validateDocument(doc)).toEqual([]);
  });

  it('flags a reversed conditional-format range (start col after end col)', () => {
    const doc = {
      '@type': 'DataGrid', name: 'g',
      sheets: {
        s1: {
          '@type': 'Sheet', name: 'Sheet 1', index: 1,
          columns: { c1: { index: 1 }, c2: { index: 2 }, c3: { index: 3 } },
          rows: { r1: { index: 1 }, r2: { index: 2 } },
          cells: {},
          conditionalFormats: {
            cf1: {
              index: 1, conditionType: 'gt', conditionValue: '5',
              ranges: { rg1: { rangeRowStart: 'r1', rangeRowEnd: 'r2', rangeColStart: 'c3', rangeColEnd: 'c1' } },
              format: {},
            },
          },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('reversed range') && e.message.includes('column'))).toBe(true);
  });

  it('flags a reversed format range (start row after end row)', () => {
    const doc = {
      '@type': 'DataGrid', name: 'g',
      sheets: {
        s1: {
          '@type': 'Sheet', name: 'Sheet 1', index: 1,
          columns: { c1: { index: 1 }, c2: { index: 2 } },
          rows: { r1: { index: 1 }, r2: { index: 2 } },
          cells: {},
          formats: {
            f1: {
              index: 1, rangeRowStart: 'r2', rangeRowEnd: 'r1', rangeColStart: 'c1', rangeColEnd: 'c2',
              format: {},
            },
          },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('reversed range') && e.message.includes('row'))).toBe(true);
  });

  it('accepts a forward range and still reports missing ids', () => {
    const forward = {
      '@type': 'DataGrid', name: 'g',
      sheets: {
        s1: {
          '@type': 'Sheet', name: 'Sheet 1', index: 1,
          columns: { c1: { index: 1 }, c2: { index: 2 } },
          rows: { r1: { index: 1 }, r2: { index: 2 } },
          cells: {},
          formats: {
            f1: {
              index: 1, rangeRowStart: 'r1', rangeRowEnd: 'r2', rangeColStart: 'c1', rangeColEnd: 'c2',
              format: {},
            },
          },
        },
      },
    };
    expect(validateDocument(forward)).toEqual([]);

    // A missing id still reports non-existent, and does not spuriously report reversed.
    const missing = JSON.parse(JSON.stringify(forward));
    missing.sheets.s1.formats.f1.rangeColEnd = 'gone';
    const errors = validateDocument(missing);
    expect(errors.some(e => e.message.includes('non-existent column "gone"'))).toBe(true);
    expect(errors.some(e => e.message.includes('reversed range'))).toBe(false);
  });
});

