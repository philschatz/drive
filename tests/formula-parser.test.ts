import {
  tokenize,
  parseInternal,
  serialize,
  serializeA1,
  serializeR1C1,
  parseFormula,
  extractCellRefs,
  nodeAtOffset,
  FormulaParseError,
} from '../src/client/datagrid/formula-parser';
import type { FormulaAST, FormulaNode, CellRef, RangeRef } from '../src/client/datagrid/formula-parser';

// ─── Tokenizer ───────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('tokenizes a simple number', () => {
    const tokens = tokenize('=42');
    expect(tokens.map(t => [t.type, t.value])).toEqual([
      ['NUMBER', '42'],
      ['EOF', ''],
    ]);
  });

  it('tokenizes a decimal number', () => {
    const tokens = tokenize('=3.14');
    expect(tokens[0]).toMatchObject({ type: 'NUMBER', value: '3.14' });
  });

  it('tokenizes a leading-dot number', () => {
    const tokens = tokenize('=.5');
    expect(tokens[0]).toMatchObject({ type: 'NUMBER', value: '.5' });
  });

  it('tokenizes scientific notation', () => {
    const tokens = tokenize('=1E2');
    expect(tokens[0]).toMatchObject({ type: 'NUMBER', value: '1E2' });
  });

  it('tokenizes scientific notation with sign', () => {
    const tokens = tokenize('=2.5e-3');
    expect(tokens[0]).toMatchObject({ type: 'NUMBER', value: '2.5e-3' });
  });

  it('tokenizes a string literal', () => {
    const tokens = tokenize('="hello"');
    expect(tokens[0]).toMatchObject({ type: 'STRING', value: 'hello' });
  });

  it('tokenizes a string with escaped quotes', () => {
    const tokens = tokenize('="say ""hi"""');
    expect(tokens[0]).toMatchObject({ type: 'STRING', value: 'say "hi"' });
  });

  it('tokenizes TRUE and FALSE as booleans', () => {
    expect(tokenize('=TRUE')[0]).toMatchObject({ type: 'BOOLEAN', value: 'TRUE' });
    expect(tokenize('=FALSE')[0]).toMatchObject({ type: 'BOOLEAN', value: 'FALSE' });
  });

  it('tokenizes a canonical cell ref with absolute ids', () => {
    const tokens = tokenize('={R{r0}C{c0}}');
    expect(tokens[0]).toMatchObject({ type: 'CELL_REF', value: '{R{r0}C{c0}}' });
  });

  it('tokenizes a canonical cell ref with relative ids', () => {
    const tokens = tokenize('={R[r0]C[c0]}');
    expect(tokens[0]).toMatchObject({ type: 'CELL_REF', value: '{R[r0]C[c0]}' });
  });

  it('tokenizes a canonical cell ref with mixed ids', () => {
    const tokens = tokenize('={R{r0}C[c0]}');
    expect(tokens[0]).toMatchObject({ type: 'CELL_REF', value: '{R{r0}C[c0]}' });
  });

  it('tokenizes a function name', () => {
    const tokens = tokenize('=SUM({R[r0]C[c0]})');
    expect(tokens[0]).toMatchObject({ type: 'FUNCTION_NAME', value: 'SUM' });
    expect(tokens[1]).toMatchObject({ type: 'LPAREN' });
  });

  it('tokenizes all arithmetic operators', () => {
    const tokens = tokenize('=1+2-3*4/5^6');
    const ops = tokens.filter(t => ['PLUS', 'MINUS', 'STAR', 'SLASH', 'CARET'].includes(t.type));
    expect(ops.map(t => t.type)).toEqual(['PLUS', 'MINUS', 'STAR', 'SLASH', 'CARET']);
  });

  it('tokenizes comparison operators', () => {
    expect(tokenize('={R[a]C[b]}<>{R[c]C[d]}')[1]).toMatchObject({ type: 'NEQ', value: '<>' });
    expect(tokenize('={R[a]C[b]}<={R[c]C[d]}')[1]).toMatchObject({ type: 'LTE', value: '<=' });
    expect(tokenize('={R[a]C[b]}>={R[c]C[d]}')[1]).toMatchObject({ type: 'GTE', value: '>=' });
    expect(tokenize('={R[a]C[b]}<{R[c]C[d]}')[1]).toMatchObject({ type: 'LT', value: '<' });
    expect(tokenize('={R[a]C[b]}>{R[c]C[d]}')[1]).toMatchObject({ type: 'GT', value: '>' });
    expect(tokenize('={R[a]C[b]}={R[c]C[d]}')[1]).toMatchObject({ type: 'EQ', value: '=' });
  });

  it('tokenizes ampersand', () => {
    expect(tokenize('="a"&"b"')[1]).toMatchObject({ type: 'AMP', value: '&' });
  });

  it('tokenizes range colon', () => {
    const tokens = tokenize('={R[a]C[b]}:{R[c]C[d]}');
    expect(tokens.map(t => t.type)).toEqual(['CELL_REF', 'COLON', 'CELL_REF', 'EOF']);
  });

  it('ignores whitespace', () => {
    const tokens = tokenize('= {R[a]C[b]} + {R[c]C[d]} ');
    expect(tokens.filter(t => t.type !== 'EOF').map(t => t.type)).toEqual(['CELL_REF', 'PLUS', 'CELL_REF']);
  });

  it('tokenizes error literals', () => {
    expect(tokenize('=#REF!')[0]).toMatchObject({ type: 'ERROR', value: '#REF!' });
    expect(tokenize('=#VALUE!')[0]).toMatchObject({ type: 'ERROR', value: '#VALUE!' });
    expect(tokenize('=#DIV/0!')[0]).toMatchObject({ type: 'ERROR', value: '#DIV/0!' });
    expect(tokenize('=#NAME?')[0]).toMatchObject({ type: 'ERROR', value: '#NAME?' });
    expect(tokenize('=#N/A')[0]).toMatchObject({ type: 'ERROR' });
  });

  it('tracks correct start/end offsets', () => {
    // ={R[a]C[b]}+{R[c]C[d]}
    // 0123456789...
    const tokens = tokenize('={R[a]C[b]}+{R[c]C[d]}');
    expect(tokens[0]).toMatchObject({ type: 'CELL_REF', start: 1, end: 11 });
    expect(tokens[1]).toMatchObject({ type: 'PLUS', start: 11, end: 12 });
    expect(tokens[2]).toMatchObject({ type: 'CELL_REF', start: 12, end: 22 });
  });

  it('throws on missing leading equals', () => {
    expect(() => tokenize('A1+B2')).toThrow(FormulaParseError);
  });

  it('throws on unexpected character', () => {
    expect(() => tokenize('={R[a]C[b]}~1')).toThrow(FormulaParseError);
  });

  it('throws on unterminated string', () => {
    expect(() => tokenize('="hello')).toThrow(FormulaParseError);
  });

  it('throws on bare A1-style ref (not canonical)', () => {
    expect(() => tokenize('=A1')).toThrow(FormulaParseError);
  });
});

// ─── Parser ──────────────────────────────────────────────────────────────────

describe('parse', () => {
  it('parses a number literal', () => {
    const ast = parseInternal('=42');
    expect(ast.body).toMatchObject({ type: 'number', value: 42, raw: '42' });
  });

  it('parses a negative number (unary minus)', () => {
    const ast = parseInternal('=-5');
    expect(ast.body).toMatchObject({
      type: 'unary', operator: '-',
      operand: { type: 'number', value: 5 },
    });
  });

  it('parses a string literal', () => {
    const ast = parseInternal('="hi"');
    expect(ast.body).toMatchObject({ type: 'string', value: 'hi' });
  });

  it('parses booleans', () => {
    expect(parseInternal('=TRUE').body).toMatchObject({ type: 'boolean', value: true });
    expect(parseInternal('=FALSE').body).toMatchObject({ type: 'boolean', value: false });
  });

  it('parses an error literal', () => {
    expect(parseInternal('=#REF!').body).toMatchObject({ type: 'error', errorType: '#REF!' });
  });

  it('parses a canonical cell ref with absolute ids', () => {
    const ast = parseInternal('={R{r0}C{c0}}');
    expect(ast.body).toMatchObject({
      type: 'cellRef',
      row: { id: 'r0', relative: false },
      col: { id: 'c0', relative: false },
    });
  });

  it('parses a canonical cell ref with relative ids', () => {
    const ast = parseInternal('={R[r0]C[c0]}');
    expect(ast.body).toMatchObject({
      type: 'cellRef',
      row: { id: 'r0', relative: true },
      col: { id: 'c0', relative: true },
    });
  });

  it('parses a canonical cell ref with mixed ids', () => {
    const ast = parseInternal('={R{r0}C[c1]}');
    expect(ast.body).toMatchObject({
      type: 'cellRef',
      row: { id: 'r0', relative: false },
      col: { id: 'c1', relative: true },
    });
  });

  it('parses a range', () => {
    const ast = parseInternal('={R[r0]C[c0]}:{R[r3]C[c3]}');
    expect(ast.body).toMatchObject({
      type: 'range',
      from: { type: 'cellRef', row: { id: 'r0', relative: true }, col: { id: 'c0', relative: true } },
      to: { type: 'cellRef', row: { id: 'r3', relative: true }, col: { id: 'c3', relative: true } },
    });
  });

  it('parses addition', () => {
    const ast = parseInternal('=1+2');
    expect(ast.body).toMatchObject({
      type: 'binary', operator: '+',
      left: { type: 'number', value: 1 },
      right: { type: 'number', value: 2 },
    });
  });

  it('respects multiplication over addition precedence', () => {
    const ast = parseInternal('=1+2*3');
    expect(ast.body).toMatchObject({
      type: 'binary', operator: '+',
      left: { type: 'number', value: 1 },
      right: { type: 'binary', operator: '*', left: { value: 2 }, right: { value: 3 } },
    });
  });

  it('respects parentheses', () => {
    const ast = parseInternal('=(1+2)*3');
    expect(ast.body).toMatchObject({
      type: 'binary', operator: '*',
      left: { type: 'paren', expr: { type: 'binary', operator: '+' } },
      right: { type: 'number', value: 3 },
    });
  });

  it('parses right-associative exponentiation', () => {
    const ast = parseInternal('=2^3^4');
    expect(ast.body).toMatchObject({
      type: 'binary', operator: '^',
      left: { type: 'number', value: 2 },
      right: { type: 'binary', operator: '^', left: { value: 3 }, right: { value: 4 } },
    });
  });

  it('parses string concatenation', () => {
    const ast = parseInternal('="a"&"b"');
    expect(ast.body).toMatchObject({ type: 'binary', operator: '&' });
  });

  it('parses comparison operators', () => {
    expect(parseInternal('={R[a]C[b]}>5').body).toMatchObject({ type: 'binary', operator: '>' });
    expect(parseInternal('={R[a]C[b]}<>5').body).toMatchObject({ type: 'binary', operator: '<>' });
    expect(parseInternal('={R[a]C[b]}<=5').body).toMatchObject({ type: 'binary', operator: '<=' });
  });

  it('parses a function with no args', () => {
    const ast = parseInternal('=NOW()');
    expect(ast.body).toMatchObject({ type: 'function', name: 'NOW', args: [] });
  });

  it('parses a function with one arg', () => {
    const ast = parseInternal('=ABS(-1)');
    expect(ast.body).toMatchObject({
      type: 'function', name: 'ABS',
      args: [{ type: 'unary', operator: '-', operand: { type: 'number', value: 1 } }],
    });
  });

  it('parses a function with multiple args', () => {
    const ast = parseInternal('=IF({R[a]C[b]}>0,{R[a]C[b]},0)');
    const fn = ast.body as any;
    expect(fn.type).toBe('function');
    expect(fn.name).toBe('IF');
    expect(fn.args).toHaveLength(3);
  });

  it('parses nested functions', () => {
    const ast = parseInternal('=SUM({R[a]C[b]},MAX({R[c]C[d]},{R[e]C[f]}))');
    const fn = ast.body as any;
    expect(fn.args[1].type).toBe('function');
    expect(fn.args[1].name).toBe('MAX');
  });

  it('parses a function with a range arg', () => {
    const ast = parseInternal('=SUM({R[a]C[b]}:{R[c]C[d]})');
    const fn = ast.body as any;
    expect(fn.args[0].type).toBe('range');
  });

  it('parses error + arithmetic', () => {
    const ast = parseInternal('=#REF!+1');
    expect(ast.body).toMatchObject({
      type: 'binary', operator: '+',
      left: { type: 'error', errorType: '#REF!' },
      right: { type: 'number', value: 1 },
    });
  });

  it('parses cell ref in expressions', () => {
    const ast = parseInternal('={R[r0]C[c0]}+{R[r1]C[c1]}');
    expect(ast.body).toMatchObject({
      type: 'binary', operator: '+',
      left: { type: 'cellRef' },
      right: { type: 'cellRef' },
    });
  });

  it('parses cell ref as function argument', () => {
    const ast = parseInternal('=SUM({R[r0]C[c0]}:{R[r3]C[c0]})');
    const fn = ast.body as any;
    expect(fn.type).toBe('function');
    expect(fn.args[0].type).toBe('range');
    expect(fn.args[0].from.type).toBe('cellRef');
  });

  it('throws on empty formula', () => {
    expect(() => parseInternal('=')).toThrow(FormulaParseError);
  });

  it('throws on missing operand', () => {
    expect(() => parseInternal('=1+')).toThrow(FormulaParseError);
  });

  it('throws on unclosed paren', () => {
    expect(() => parseInternal('=(1+2')).toThrow(FormulaParseError);
  });

  it('throws on extra tokens after expression', () => {
    expect(() => parseInternal('=1 2')).toThrow(FormulaParseError);
  });

  it('parses double unary as valid', () => {
    const ast = parseInternal('=1++2');
    expect(ast.body).toMatchObject({
      type: 'binary', operator: '+',
      left: { type: 'number', value: 1 },
      right: { type: 'unary', operator: '+', operand: { type: 'number', value: 2 } },
    });
  });
});

// ─── Serializer (internal round-trips) ───────────────────────────────────────

describe('serialize', () => {
  const roundTrips = [
    '={R{r0}C{c0}}',
    '={R[r0]C[c0]}',
    '={R{r0}C[c0]}',
    '={R[r0]C{c0}}',
    '=42',
    '=3.14',
    '="hello"',
    '=TRUE',
    '=FALSE',
    '=#REF!',
    '={R[a]C[b]}+{R[c]C[d]}',
    '=1+2*3',
    '=(1+2)*3',
    '=2^3^4',
    '="a"&"b"',
    '={R[a]C[b]}<>{R[c]C[d]}',
    '={R[a]C[b]}<=5',
    '=SUM({R[a]C[b]}:{R[c]C[d]})',
    '=IF({R[a]C[b]}>0,{R[a]C[b]},0)',
    '=NOW()',
    '=-5',
    '=SUM({R[a]C[b]},MAX({R[c]C[d]},{R[e]C[f]}))',
    '={R[a]C[b]}:{R[c]C[d]}',
    '={R{abc123}C{def456}}',
  ];

  it.each(roundTrips)('round-trips %s', (formula) => {
    expect(serialize(parseInternal(formula))).toBe(formula);
  });

  it('round-trips string with escaped quotes', () => {
    expect(serialize(parseInternal('="say ""hi"""'))).toBe('="say ""hi"""');
  });
});

// ─── parseFormula (A1 → canonical) ──────────────────────────────────────────

describe('parseFormula', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3'];
  const colIds = ['c0', 'c1', 'c2', 'c3'];
  const lookupRow = (idx: number) => rowIds[idx] ?? `?row${idx}`;
  const lookupCol = (idx: number) => colIds[idx] ?? `?col${idx}`;

  describe('from A1 format', () => {
    it('converts relative A1 ref', () => {
      // A1 at cell (1,1) → row 0 col 0 → relative ids r0, c0
      const ast = parseFormula('=A1', 1, 1, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r0', relative: true },
        col: { id: 'c0', relative: true },
      });
    });

    it('converts absolute A1 ref', () => {
      const ast = parseFormula('=$A$1', 2, 2, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r0', relative: false },
        col: { id: 'c0', relative: false },
      });
    });

    it('converts mixed A1 refs', () => {
      const r1 = parseFormula('=$A1', 1, 1, lookupRow, lookupCol).body as CellRef;
      expect(r1.col.relative).toBe(false); // $A = absolute col
      expect(r1.row.relative).toBe(true);  // 1 = relative row

      const r2 = parseFormula('=A$1', 1, 1, lookupRow, lookupCol).body as CellRef;
      expect(r2.col.relative).toBe(true);  // A = relative col
      expect(r2.row.relative).toBe(false); // $1 = absolute row
    });

    it('converts multiple A1 refs in expression', () => {
      const ast = parseFormula('=A1+B2', 0, 0, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'binary', operator: '+',
        left: { type: 'cellRef', row: { id: 'r0' }, col: { id: 'c0' } },
        right: { type: 'cellRef', row: { id: 'r1' }, col: { id: 'c1' } },
      });
    });

    it('preserves strings', () => {
      const ast = parseFormula('="A1"', 0, 0, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({ type: 'string', value: 'A1' });
    });

    it('handles SUM with range', () => {
      const ast = parseFormula('=SUM(A1:A4)', 0, 0, lookupRow, lookupCol);
      const fn = ast.body as any;
      expect(fn.type).toBe('function');
      expect(fn.args[0].type).toBe('range');
      expect(fn.args[0].from).toMatchObject({ type: 'cellRef', row: { id: 'r0' }, col: { id: 'c0' } });
      expect(fn.args[0].to).toMatchObject({ type: 'cellRef', row: { id: 'r3' }, col: { id: 'c0' } });
    });

    it('does not treat scientific notation as cell ref', () => {
      const ast = parseFormula('=1E2', 0, 0, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({ type: 'number', value: 100 });
    });

    it('handles lowercase A1 refs', () => {
      const ast = parseFormula('=a1*2', 0, 0, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'binary', operator: '*',
        left: { type: 'cellRef', row: { id: 'r0' }, col: { id: 'c0' } },
        right: { type: 'number', value: 2 },
      });
    });

    it('handles mixed-case A1 refs', () => {
      const ast = parseFormula('=sum(a1:B4)', 0, 0, lookupRow, lookupCol);
      const fn = ast.body as any;
      expect(fn.type).toBe('function');
      expect(fn.name).toBe('SUM');
      expect(fn.args[0].type).toBe('range');
    });
  });

  describe('from R1C1 format', () => {
    it('converts absolute R1C1 ref (1-based)', () => {
      // R1C1 = row 0, col 0 (absolute)
      const ast = parseFormula('=R1C1', 2, 2, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r0', relative: false },
        col: { id: 'c0', relative: false },
      });
    });

    it('converts relative R1C1 ref', () => {
      // R[0]C[0] at cell (1,1) → row 1, col 1
      const ast = parseFormula('=R[0]C[0]', 1, 1, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r1', relative: true },
        col: { id: 'c1', relative: true },
      });
    });

    it('converts relative R1C1 ref with negative offset', () => {
      const ast = parseFormula('=R[-1]C[-1]', 1, 1, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r0', relative: true },
        col: { id: 'c0', relative: true },
      });
    });

    it('converts mixed R1C1 ref', () => {
      // R1C[0] at cell (1,1) → absolute row 0, relative col 1
      const ast = parseFormula('=R1C[0]', 1, 1, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r0', relative: false },
        col: { id: 'c1', relative: true },
      });
    });

    it('converts R1C1 in expression', () => {
      const ast = parseFormula('=R[0]C[0]+R[1]C[1]', 0, 0, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'binary', operator: '+',
        left: { type: 'cellRef', row: { id: 'r0' }, col: { id: 'c0' } },
        right: { type: 'cellRef', row: { id: 'r1' }, col: { id: 'c1' } },
      });
    });

    it('handles bare R (current row) in R1C1 — LibreOffice style RC[-1]', () => {
      // RC[-1] at cell (1, 2) → same row (1), col 2-1=1
      const ast = parseFormula('=RC[-1]', 1, 2, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r1', relative: true },
        col: { id: 'c1', relative: true },
      });
    });

    it('handles bare C (current col) in R1C1 — LibreOffice style R[-1]C', () => {
      // R[-1]C at cell (2, 1) → row 2-1=1, same col (1)
      const ast = parseFormula('=R[-1]C', 2, 1, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r1', relative: true },
        col: { id: 'c1', relative: true },
      });
    });

    it('handles bare RC (current cell) in R1C1', () => {
      // RC at cell (1, 1) → row 1, col 1
      const ast = parseFormula('=RC', 1, 1, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r1', relative: true },
        col: { id: 'c1', relative: true },
      });
    });
  });

  describe('from canonical format', () => {
    it('passes through canonical refs unchanged', () => {
      const ast = parseFormula('={R{r0}C{c0}}', 0, 0, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r0', relative: false },
        col: { id: 'c0', relative: false },
      });
    });

    it('passes through canonical relative refs', () => {
      const ast = parseFormula('={R[r0]C[c0]}', 0, 0, lookupRow, lookupCol);
      expect(ast.body).toMatchObject({
        type: 'cellRef',
        row: { id: 'r0', relative: true },
        col: { id: 'c0', relative: true },
      });
    });
  });
});

// ─── serializeA1 ─────────────────────────────────────────────────────────────

describe('serializeA1', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3'];
  const colIds = ['c0', 'c1', 'c2', 'c3'];
  const idToRowIndex = (id: string) => { const i = rowIds.indexOf(id); return i === -1 ? undefined : i; };
  const idToColIndex = (id: string) => { const i = colIds.indexOf(id); return i === -1 ? undefined : i; };

  it('serializes absolute ref as $A$1', () => {
    const ast = parseInternal('={R{r0}C{c0}}');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=$A$1');
  });

  it('serializes relative ref as A1', () => {
    const ast = parseInternal('={R[r0]C[c0]}');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=A1');
  });

  it('serializes mixed ref', () => {
    const ast = parseInternal('={R{r0}C[c0]}');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=A$1');
  });

  it('serializes expression with refs', () => {
    const ast = parseInternal('={R[r0]C[c0]}+{R{r1}C{c1}}');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=A1+$B$2');
  });

  it('returns #REF! for unknown row id', () => {
    const ast = parseInternal('={R{gone}C{c0}}');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=#REF!');
  });

  it('returns #REF! for unknown col id', () => {
    const ast = parseInternal('={R{r0}C{gone}}');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=#REF!');
  });

  it('serializes range', () => {
    const ast = parseInternal('={R[r0]C[c0]}:{R[r3]C[c3]}');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=A1:D4');
  });

  it('serializes function with range', () => {
    const ast = parseInternal('=SUM({R[r0]C[c0]}:{R[r3]C[c0]})');
    expect(serializeA1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=SUM(A1:A4)');
  });
});

// ─── serializeR1C1 ───────────────────────────────────────────────────────────

describe('serializeR1C1', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3'];
  const colIds = ['c0', 'c1', 'c2', 'c3'];
  const idToRowIndex = (id: string) => { const i = rowIds.indexOf(id); return i === -1 ? undefined : i; };
  const idToColIndex = (id: string) => { const i = colIds.indexOf(id); return i === -1 ? undefined : i; };

  it('serializes absolute ref as R1C1 (1-based)', () => {
    const ast = parseInternal('={R{r0}C{c0}}');
    expect(serializeR1C1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=R1C1');
  });

  it('serializes relative ref with zero offset as bare RC', () => {
    const ast = parseInternal('={R[r0]C[c0]}');
    expect(serializeR1C1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=RC');
  });

  it('serializes relative ref with offset', () => {
    const ast = parseInternal('={R[r0]C[c0]}');
    // r0 is at index 0, cell is at row 2 → offset = 0 - 2 = -2
    expect(serializeR1C1(ast, 2, 2, idToRowIndex, idToColIndex)).toBe('=R[-2]C[-2]');
  });

  it('serializes mixed ref', () => {
    const ast = parseInternal('={R{r0}C[c1]}');
    expect(serializeR1C1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=R1C[1]');
  });

  it('returns #REF! for unknown id', () => {
    const ast = parseInternal('={R{gone}C{c0}}');
    expect(serializeR1C1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=#REF!');
  });

  it('serializes expression', () => {
    const ast = parseInternal('={R[r0]C[c0]}+{R{r1}C{c1}}');
    expect(serializeR1C1(ast, 0, 0, idToRowIndex, idToColIndex)).toBe('=RC+R2C2');
  });
});

// ─── Cross-format round-trips ────────────────────────────────────────────────

describe('cross-format round-trips', () => {
  const rowIds = ['r0', 'r1', 'r2', 'r3'];
  const colIds = ['c0', 'c1', 'c2', 'c3'];
  const lookupRow = (idx: number) => rowIds[idx];
  const lookupCol = (idx: number) => colIds[idx];
  const idToRowIndex = (id: string) => { const i = rowIds.indexOf(id); return i === -1 ? undefined : i; };
  const idToColIndex = (id: string) => { const i = colIds.indexOf(id); return i === -1 ? undefined : i; };

  const a1Formulas = ['=A1', '=B3+C4', '=$A$1', '=SUM(A1:D4)', '=$B1+A$2'];

  it.each(a1Formulas)('A1 → canonical → A1: %s at (1,1)', (formula) => {
    const ast = parseFormula(formula, 1, 1, lookupRow, lookupCol);
    const back = serializeA1(ast, 1, 1, idToRowIndex, idToColIndex);
    expect(back).toBe(formula);
  });

  it('R1C1 → canonical → R1C1', () => {
    const ast = parseFormula('=R1C1+R[0]C[1]', 0, 0, lookupRow, lookupCol);
    const back = serializeR1C1(ast, 0, 0, idToRowIndex, idToColIndex);
    expect(back).toBe('=R1C1+RC[1]');
  });
});

// ─── extractCellRefs ─────────────────────────────────────────────────────────

describe('extractCellRefs', () => {
  it('extracts a single cell ref', () => {
    const refs = extractCellRefs(parseInternal('={R[r0]C[c0]}'));
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('cellRef');
  });

  it('extracts a range', () => {
    const refs = extractCellRefs(parseInternal('={R[a]C[b]}:{R[c]C[d]}'));
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe('range');
  });

  it('extracts refs from a complex formula', () => {
    const refs = extractCellRefs(parseInternal('=SUM({R[a]C[b]}:{R[c]C[d]})+{R[e]C[f]}'));
    expect(refs).toHaveLength(2);
    expect(refs[0].type).toBe('range');
    expect(refs[1].type).toBe('cellRef');
  });

  it('returns empty for no-ref formulas', () => {
    expect(extractCellRefs(parseInternal('=42+1'))).toHaveLength(0);
    expect(extractCellRefs(parseInternal('="hello"'))).toHaveLength(0);
  });

  it('extracts refs from nested functions', () => {
    const refs = extractCellRefs(parseInternal('=IF({R[a]C[b]}>{R[c]C[d]},{R[e]C[f]},{R[g]C[h]})'));
    expect(refs).toHaveLength(4);
  });
});

// ─── nodeAtOffset ────────────────────────────────────────────────────────────

describe('nodeAtOffset', () => {
  it('finds a cell ref at its offset', () => {
    // ={R[a]C[b]}+{R[c]C[d]}
    const ast = parseInternal('={R[a]C[b]}+{R[c]C[d]}');
    const node = nodeAtOffset(ast, 1);
    expect(node).toMatchObject({ type: 'cellRef' });
  });

  it('finds the second cell ref', () => {
    const ast = parseInternal('={R[a]C[b]}+{R[c]C[d]}');
    const node = nodeAtOffset(ast, 12);
    expect(node).toMatchObject({ type: 'cellRef', col: { id: 'd' } });
  });

  it('finds the operator (falls through to binary)', () => {
    const ast = parseInternal('={R[a]C[b]}+{R[c]C[d]}');
    const node = nodeAtOffset(ast, 11);
    expect(node).toMatchObject({ type: 'binary', operator: '+' });
  });

  it('finds a function call', () => {
    const ast = parseInternal('=SUM({R[a]C[b]})');
    const node = nodeAtOffset(ast, 1);
    expect(node).toMatchObject({ type: 'function', name: 'SUM' });
  });

  it('returns null for offset beyond string', () => {
    const ast = parseInternal('={R[a]C[b]}');
    expect(nodeAtOffset(ast, 100)).toBeNull();
  });

  it('returns null for offset 0 (the = sign)', () => {
    const ast = parseInternal('={R[a]C[b]}');
    expect(nodeAtOffset(ast, 0)).toBeNull();
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('error handling', () => {
  it('throws FormulaParseError for missing leading =', () => {
    expect(() => parseInternal('A1+B2')).toThrow(FormulaParseError);
  });

  it('throws FormulaParseError for empty formula', () => {
    expect(() => parseInternal('=')).toThrow(FormulaParseError);
  });

  it('throws FormulaParseError for unclosed paren', () => {
    expect(() => parseInternal('=(1+2')).toThrow(FormulaParseError);
  });

  it('throws FormulaParseError for mismatched paren', () => {
    expect(() => parseInternal('=1+2)')).toThrow(FormulaParseError);
  });

  it('throws FormulaParseError for missing operand', () => {
    expect(() => parseInternal('=1+')).toThrow(FormulaParseError);
  });

  it('throws FormulaParseError for unterminated string', () => {
    expect(() => parseInternal('="hello')).toThrow(FormulaParseError);
  });

  it('includes offset in parse errors', () => {
    try {
      parseInternal('=1+');
      fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FormulaParseError);
      expect((e as FormulaParseError).offset).toBeDefined();
    }
  });
});
