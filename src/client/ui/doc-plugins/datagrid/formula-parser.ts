import { colIndexToLetter, letterToColIndex } from './helpers';

// ─── Source Location ─────────────────────────────────────────────────────────

export interface Span {
  /** Offset from start of formula string (including the '=') */
  readonly start: number;
  /** Exclusive end offset */
  readonly end: number;
}

// ─── AST Node Types ──────────────────────────────────────────────────────────

export interface NumberLiteral extends Span {
  readonly type: 'number';
  readonly value: number;
  readonly raw: string;
}

export interface StringLiteral extends Span {
  readonly type: 'string';
  readonly value: string;
  readonly raw: string;
}

export interface BooleanLiteral extends Span {
  readonly type: 'boolean';
  readonly value: boolean;
}

export interface ErrorLiteral extends Span {
  readonly type: 'error';
  readonly errorType: string;
}

export interface CellRefPart {
  readonly id: string;
  readonly relative: boolean;
}

export interface SheetRefPart {
  readonly id: string;
}

export interface CellRef extends Span {
  readonly type: 'cellRef';
  readonly row: CellRefPart;
  readonly col: CellRefPart;
  readonly sheet?: SheetRefPart;
}

export interface RangeRef extends Span {
  readonly type: 'range';
  readonly from: CellRef;
  readonly to: CellRef;
}

export interface UnaryExpr extends Span {
  readonly type: 'unary';
  readonly operator: '+' | '-';
  readonly operand: FormulaNode;
}

export interface BinaryExpr extends Span {
  readonly type: 'binary';
  readonly operator: '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=';
  readonly left: FormulaNode;
  readonly right: FormulaNode;
}

export interface FunctionCall extends Span {
  readonly type: 'function';
  readonly name: string;
  readonly args: readonly FormulaNode[];
}

export interface ParenExpr extends Span {
  readonly type: 'paren';
  readonly expr: FormulaNode;
}

export type FormulaNode =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | ErrorLiteral
  | CellRef
  | RangeRef
  | UnaryExpr
  | BinaryExpr
  | FunctionCall
  | ParenExpr;

export interface FormulaAST {
  readonly type: 'formula';
  readonly body: FormulaNode;
  readonly source: string;
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export type TokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'ERROR'
  | 'CELL_REF'
  | 'FUNCTION_NAME'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'COLON'
  | 'PLUS'
  | 'MINUS'
  | 'STAR'
  | 'SLASH'
  | 'CARET'
  | 'AMP'
  | 'EQ'
  | 'NEQ'
  | 'LT'
  | 'GT'
  | 'LTE'
  | 'GTE'
  | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

// ─── Error ───────────────────────────────────────────────────────────────────

export class FormulaParseError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'FormulaParseError';
    this.offset = offset;
  }
}

// ─── Lexer ───────────────────────────────────────────────────────────────────

export function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = formula.length;

  if (len === 0 || formula[0] !== '=') {
    throw new FormulaParseError('Formula must start with =', 0);
  }
  i = 1; // skip leading '='

  while (i < len) {
    // Skip whitespace
    if (formula[i] === ' ' || formula[i] === '\t') {
      i++;
      continue;
    }

    const start = i;
    const ch = formula[i];

    // String literal
    if (ch === '"') {
      i++;
      let value = '';
      while (i < len) {
        if (formula[i] === '"') {
          if (i + 1 < len && formula[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += formula[i];
          i++;
        }
      }
      if (i === len && formula[i - 1] !== '"') {
        throw new FormulaParseError('Unterminated string literal', start);
      }
      tokens.push({ type: 'STRING', value, start, end: i });
      continue;
    }

    // Error literal: #REF!, #VALUE!, #DIV/0!, #NAME?, #N/A, #NULL!
    if (ch === '#') {
      const rest = formula.slice(i);
      const m = rest.match(/^#(?:N\/A|[A-Z/0]+[!?])/i);
      if (m) {
        tokens.push({ type: 'ERROR', value: m[0], start, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      throw new FormulaParseError(`Unexpected character '#'`, i);
    }

    // Number literal (including scientific notation)
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && formula[i + 1] >= '0' && formula[i + 1] <= '9')) {
      let numStr = '';
      // Integer/decimal part
      while (i < len && formula[i] >= '0' && formula[i] <= '9') {
        numStr += formula[i];
        i++;
      }
      if (i < len && formula[i] === '.') {
        numStr += '.';
        i++;
        while (i < len && formula[i] >= '0' && formula[i] <= '9') {
          numStr += formula[i];
          i++;
        }
      }
      // Scientific notation: E/e followed by optional +/- and digits
      if (i < len && (formula[i] === 'E' || formula[i] === 'e')) {
        const saved = i;
        let sciStr = formula[i];
        i++;
        if (i < len && (formula[i] === '+' || formula[i] === '-')) {
          sciStr += formula[i];
          i++;
        }
        if (i < len && formula[i] >= '0' && formula[i] <= '9') {
          while (i < len && formula[i] >= '0' && formula[i] <= '9') {
            sciStr += formula[i];
            i++;
          }
          numStr += sciStr;
        } else {
          // Not scientific notation, backtrack
          i = saved;
        }
      }
      tokens.push({ type: 'NUMBER', value: numStr, start, end: i });
      continue;
    }

    // Canonical cell ref: {R{id}C{id}}, {C{id}} (whole-column), {R{id}} (whole-row)
    if (ch === '{') {
      const next = i + 1 < len ? formula[i + 1] : '';
      if (next === 'R' || next === 'C') {
        const refStart = i;
        i++; // skip '{'

        /** Parse a bracketed part: {id} or [id]. Returns the substring including brackets. */
        const parseBracketed = () => {
          if (i >= len || (formula[i] !== '{' && formula[i] !== '[')) {
            throw new FormulaParseError('Expected { or [ in cell reference', i);
          }
          const open = formula[i];
          const close = open === '{' ? '}' : ']';
          i++;
          while (i < len && formula[i] !== close) i++;
          if (i >= len) throw new FormulaParseError(`Expected ${close} in cell reference`, i);
          i++; // skip close
        };

        // Parse R part (if present)
        if (formula[i] === 'R') {
          i++; // skip 'R'
          parseBracketed();
        }
        // Parse C part (if present)
        if (i < len && formula[i] === 'C') {
          i++; // skip 'C'
          parseBracketed();
        }
        // Optional sheet part: S{sheetId}
        if (i < len && formula[i] === 'S') {
          i++; // skip 'S'
          if (i >= len || formula[i] !== '{') {
            throw new FormulaParseError('Expected { after S in cell reference', i);
          }
          i++;
          while (i < len && formula[i] !== '}') i++;
          if (i >= len) throw new FormulaParseError('Expected } in sheet reference', i);
          i++; // skip '}'
        }
        // Expect closing '}'
        if (i >= len || formula[i] !== '}') throw new FormulaParseError('Expected } to close cell reference', i);
        i++; // skip '}'
        const value = formula.slice(refStart, i);
        tokens.push({ type: 'CELL_REF', value, start: refStart, end: i });
        continue;
      }
      throw new FormulaParseError(`Unexpected character '{'`, i);
    }

    // Dollar sign or letter: BOOLEAN or FUNCTION_NAME
    if (ch === '$' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      const rest = formula.slice(i);

      // Try function name or boolean: [A-Z]+
      const nameMatch = rest.match(/^[A-Z]+/i);
      if (nameMatch) {
        const name = nameMatch[0].toUpperCase();
        // Check if followed by '(' → function name (even for TRUE/FALSE, which are valid 0-arg functions)
        let peek = i + name.length;
        while (peek < len && (formula[peek] === ' ' || formula[peek] === '\t')) peek++;
        if (peek < len && formula[peek] === '(') {
          tokens.push({ type: 'FUNCTION_NAME', value: name, start, end: i + name.length });
          i += name.length;
          continue;
        }
        if (name === 'TRUE' || name === 'FALSE') {
          tokens.push({ type: 'BOOLEAN', value: name, start, end: i + name.length });
          i += name.length;
          continue;
        }
      }

      // Lone '$' or unrecognized letter sequence
      throw new FormulaParseError(`Unexpected character '${ch}'`, i);
    }

    // Single/multi-char operators and punctuation
    if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(', start, end: i + 1 }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')', start, end: i + 1 }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'COMMA', value: ',', start, end: i + 1 }); i++; continue; }
    if (ch === ':') { tokens.push({ type: 'COLON', value: ':', start, end: i + 1 }); i++; continue; }
    if (ch === '+') { tokens.push({ type: 'PLUS', value: '+', start, end: i + 1 }); i++; continue; }
    if (ch === '-') { tokens.push({ type: 'MINUS', value: '-', start, end: i + 1 }); i++; continue; }
    if (ch === '*') { tokens.push({ type: 'STAR', value: '*', start, end: i + 1 }); i++; continue; }
    if (ch === '/') { tokens.push({ type: 'SLASH', value: '/', start, end: i + 1 }); i++; continue; }
    if (ch === '^') { tokens.push({ type: 'CARET', value: '^', start, end: i + 1 }); i++; continue; }
    if (ch === '&') { tokens.push({ type: 'AMP', value: '&', start, end: i + 1 }); i++; continue; }
    if (ch === '=') { tokens.push({ type: 'EQ', value: '=', start, end: i + 1 }); i++; continue; }
    if (ch === '<') {
      if (i + 1 < len && formula[i + 1] === '>') {
        tokens.push({ type: 'NEQ', value: '<>', start, end: i + 2 }); i += 2; continue;
      }
      if (i + 1 < len && formula[i + 1] === '=') {
        tokens.push({ type: 'LTE', value: '<=', start, end: i + 2 }); i += 2; continue;
      }
      tokens.push({ type: 'LT', value: '<', start, end: i + 1 }); i++; continue;
    }
    if (ch === '>') {
      if (i + 1 < len && formula[i + 1] === '=') {
        tokens.push({ type: 'GTE', value: '>=', start, end: i + 2 }); i += 2; continue;
      }
      tokens.push({ type: 'GT', value: '>', start, end: i + 1 }); i++; continue;
    }

    throw new FormulaParseError(`Unexpected character '${ch}'`, i);
  }

  tokens.push({ type: 'EOF', value: '', start: i, end: i });
  return tokens;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/** Parse an internal-format formula (only handles {R...C...} cell refs). */
export function parseInternal(formula: string): FormulaAST {
  const tokens = tokenize(formula);
  let pos = 0;

  function peek(): Token { return tokens[pos]; }
  function advance(): Token { return tokens[pos++]; }

  function expect(type: TokenType): Token {
    const t = peek();
    if (t.type !== type) {
      throw new FormulaParseError(`Expected ${type} but got ${t.type}`, t.start);
    }
    return advance();
  }

  function parseExpression(): FormulaNode {
    return parseComparison();
  }

  function parseComparison(): FormulaNode {
    let left = parseConcatenation();
    while (true) {
      const t = peek();
      if (t.type === 'EQ' || t.type === 'NEQ' || t.type === 'LT' || t.type === 'GT' || t.type === 'LTE' || t.type === 'GTE') {
        advance();
        const right = parseConcatenation();
        left = { type: 'binary', operator: t.value as BinaryExpr['operator'], left, right, start: left.start, end: right.end };
      } else {
        break;
      }
    }
    return left;
  }

  function parseConcatenation(): FormulaNode {
    let left = parseAddition();
    while (peek().type === 'AMP') {
      advance();
      const right = parseAddition();
      left = { type: 'binary', operator: '&', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  function parseAddition(): FormulaNode {
    let left = parseMultiplication();
    while (peek().type === 'PLUS' || peek().type === 'MINUS') {
      const op = advance();
      const right = parseMultiplication();
      left = { type: 'binary', operator: op.value as '+' | '-', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  function parseMultiplication(): FormulaNode {
    let left = parseExponentiation();
    while (peek().type === 'STAR' || peek().type === 'SLASH') {
      const op = advance();
      const right = parseExponentiation();
      left = { type: 'binary', operator: op.value as '*' | '/', left, right, start: left.start, end: right.end };
    }
    return left;
  }

  function parseExponentiation(): FormulaNode {
    const base = parseUnary();
    if (peek().type === 'CARET') {
      advance();
      const exp = parseExponentiation(); // right-associative
      return { type: 'binary', operator: '^', left: base, right: exp, start: base.start, end: exp.end };
    }
    return base;
  }

  function parseUnary(): FormulaNode {
    const t = peek();
    if (t.type === 'PLUS' || t.type === 'MINUS') {
      advance();
      const operand = parseUnary();
      return { type: 'unary', operator: t.value as '+' | '-', operand, start: t.start, end: operand.end };
    }
    return parsePrimary();
  }

  function parseCellRefToken(t: Token): CellRef {
    // Parse canonical format: {R{id}C{id}}, {R[id]C[id]}, {R{id}C{id}S{sheetId}}, or mixed
    const inner = t.value.slice(1, -1); // strip outer { }
    function parsePart(s: string): CellRefPart {
      const id = s.slice(1, -1);
      return { id, relative: s[0] === '[' };
    }
    const STAR: CellRefPart = { id: '*', relative: false };

    // Full cell ref: R{id}C{id}[S{id}]
    const mFull = inner.match(/^R(\{[^}]*\}|\[[^\]]*\])C(\{[^}]*\}|\[[^\]]*\])(?:S\{([^}]*)\})?$/);
    if (mFull) {
      return { type: 'cellRef', row: parsePart(mFull[1]), col: parsePart(mFull[2]), start: t.start, end: t.end, ...(mFull[3] ? { sheet: { id: mFull[3] } } : {}) };
    }
    // Column-only ref: C{id}[S{id}] (whole column, no R)
    const mCol = inner.match(/^C(\{[^}]*\}|\[[^\]]*\])(?:S\{([^}]*)\})?$/);
    if (mCol) {
      return { type: 'cellRef', row: STAR, col: parsePart(mCol[1]), start: t.start, end: t.end, ...(mCol[2] ? { sheet: { id: mCol[2] } } : {}) };
    }
    // Row-only ref: R{id}[S{id}] (whole row, no C)
    const mRow = inner.match(/^R(\{[^}]*\}|\[[^\]]*\])(?:S\{([^}]*)\})?$/);
    if (mRow) {
      return { type: 'cellRef', row: parsePart(mRow[1]), col: STAR, start: t.start, end: t.end, ...(mRow[2] ? { sheet: { id: mRow[2] } } : {}) };
    }
    throw new FormulaParseError('Invalid cell reference format', t.start);
  }

  function parsePrimary(): FormulaNode {
    const t = peek();

    if (t.type === 'NUMBER') {
      advance();
      return { type: 'number', value: Number(t.value), raw: t.value, start: t.start, end: t.end };
    }

    if (t.type === 'STRING') {
      advance();
      return { type: 'string', value: t.value, raw: '"' + t.value.replace(/"/g, '""') + '"', start: t.start, end: t.end };
    }

    if (t.type === 'BOOLEAN') {
      advance();
      return { type: 'boolean', value: t.value === 'TRUE', start: t.start, end: t.end };
    }

    if (t.type === 'ERROR') {
      advance();
      const errorNode: FormulaNode = { type: 'error', errorType: t.value, start: t.start, end: t.end };
      // Consume #REF!:... range so the colon doesn't break the surrounding expression
      if (peek().type === 'COLON') {
        advance();
        if (peek().type === 'CELL_REF') advance();
        else if (peek().type === 'ERROR') advance();
      }
      return errorNode;
    }

    if (t.type === 'FUNCTION_NAME') {
      const name = advance();
      expect('LPAREN');
      const args: FormulaNode[] = [];
      if (peek().type !== 'RPAREN') {
        args.push(parseExpression());
        while (peek().type === 'COMMA') {
          advance();
          args.push(parseExpression());
        }
      }
      const rparen = expect('RPAREN');
      return { type: 'function', name: name.value, args, start: name.start, end: rparen.end };
    }

    if (t.type === 'CELL_REF') {
      advance();
      const ref = parseCellRefToken(t);
      if (peek().type === 'COLON') {
        advance();
        const t2 = peek();
        if (t2.type === 'CELL_REF') {
          advance();
          const ref2 = parseCellRefToken(t2);
          return { type: 'range', from: ref, to: ref2, start: ref.start, end: ref2.end };
        }
        // Range with degraded endpoint (#REF!) — consume and return error
        if (t2.type === 'ERROR') advance();
        return { type: 'error', errorType: '#REF!', start: ref.start, end: t2.end };
      }
      return ref;
    }

    if (t.type === 'LPAREN') {
      advance();
      const expr = parseExpression();
      const rparen = expect('RPAREN');
      return { type: 'paren', expr, start: t.start, end: rparen.end };
    }

    throw new FormulaParseError(`Unexpected token ${t.type}`, t.start);
  }

  const body = parseExpression();

  if (peek().type !== 'EOF') {
    const t = peek();
    throw new FormulaParseError(`Unexpected token ${t.type} after expression`, t.start);
  }

  return { type: 'formula', body, source: formula };
}

// ─── Serializer (internal format) ────────────────────────────────────────────

function serializePart(part: CellRefPart): string {
  return part.relative ? `[${part.id}]` : `{${part.id}}`;
}

function serializeNode(node: FormulaNode): string {
  switch (node.type) {
    case 'number': return node.raw;
    case 'string': return node.raw;
    case 'boolean': return node.value ? 'TRUE' : 'FALSE';
    case 'error': return node.errorType;
    case 'cellRef': {
      const s = node.sheet ? `S{${node.sheet.id}}` : '';
      const rPart = node.row.id === '*' ? '' : `R${serializePart(node.row)}`;
      const cPart = node.col.id === '*' ? '' : `C${serializePart(node.col)}`;
      return `{${rPart}${cPart}${s}}`;
    }
    case 'range': return serializeNode(node.from) + ':' + serializeNode(node.to);
    case 'unary': return node.operator + serializeNode(node.operand);
    case 'binary': return serializeNode(node.left) + node.operator + serializeNode(node.right);
    case 'function': return node.name + '(' + node.args.map(serializeNode).join(',') + ')';
    case 'paren': return '(' + serializeNode(node.expr) + ')';
  }
}

/** Serialize an AST to internal format: {R{id}C{id}} / {R[id]C[id]}. */
export function serialize(ast: FormulaAST): string {
  return '=' + serializeNode(ast.body);
}

// ─── Serialize to A1 format ──────────────────────────────────────────────────

function quoteSheetName(name: string): string {
  return /[\s!':]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

// ─── Shared serialization machinery ──────────────────────────────────────────

type SheetRowColLookup = (sheetId: string) => {
  idToRowIndex: (id: string) => number | undefined;
  idToColIndex: (id: string) => number | undefined;
  totalRows?: number;
  totalCols?: number;
} | undefined;

type ResolvedRef = {
  rowIdx: number | undefined;
  colIdx: number | undefined;
  isWholeCol: boolean;
  isWholeRow: boolean;
  sheetPrefix: string;
  totalRows?: number;
  totalCols?: number;
};

/**
 * Resolve a cellRef to target indices. Cross-sheet refs use the target sheet's
 * lookups (and its totals for whole-col/whole-row expansion); '#REF!' if unresolvable.
 */
function resolveRef(
  node: CellRef,
  idToRowIndex: (id: string) => number | undefined,
  idToColIndex: (id: string) => number | undefined,
  sheetNameLookup?: (sheetId: string) => string | undefined,
  sheetRowColLookup?: SheetRowColLookup,
  totalRows?: number,
  totalCols?: number,
): ResolvedRef | '#REF!' {
  const targetLookups = node.sheet && sheetRowColLookup ? sheetRowColLookup(node.sheet.id) : undefined;
  const rowLookup = targetLookups?.idToRowIndex ?? idToRowIndex;
  const colLookup = targetLookups?.idToColIndex ?? idToColIndex;
  const effectiveTotalRows = targetLookups?.totalRows ?? totalRows;
  const effectiveTotalCols = targetLookups?.totalCols ?? totalCols;
  const isWholeCol = node.row.id === '*';
  const isWholeRow = node.col.id === '*';
  const rowIdx = isWholeCol ? undefined : rowLookup(node.row.id);
  const colIdx = isWholeRow ? undefined : colLookup(node.col.id);
  if (!isWholeCol && rowIdx === undefined) return '#REF!';
  if (!isWholeRow && colIdx === undefined) return '#REF!';
  let sheetPrefix = '';
  if (node.sheet && sheetNameLookup) {
    const name = sheetNameLookup(node.sheet.id);
    if (name === undefined) return '#REF!';
    sheetPrefix = quoteSheetName(name) + '!';
  }
  return { rowIdx, colIdx, isWholeCol, isWholeRow, sheetPrefix, totalRows: effectiveTotalRows, totalCols: effectiveTotalCols };
}

/** Shared walker for A1/R1C1/canonical renderers; `ref`/`range` are the per-format pieces. */
function serializeNodeFmt(
  node: FormulaNode,
  ref: (node: CellRef, resolved: ResolvedRef) => string,
  range: (node: RangeRef, map: (n: FormulaNode) => string) => string,
  cellRow: number, cellCol: number,
  idToRowIndex: (id: string) => number | undefined,
  idToColIndex: (id: string) => number | undefined,
  sheetNameLookup?: (sheetId: string) => string | undefined,
  sheetRowColLookup?: SheetRowColLookup,
  totalRows?: number,
  totalCols?: number,
): string {
  const map = (n: FormulaNode) => serializeNodeFmt(n, ref, range, cellRow, cellCol, idToRowIndex, idToColIndex, sheetNameLookup, sheetRowColLookup, totalRows, totalCols);
  switch (node.type) {
    case 'cellRef': {
      const resolved = resolveRef(node, idToRowIndex, idToColIndex, sheetNameLookup, sheetRowColLookup, totalRows, totalCols);
      if (resolved === '#REF!') return '#REF!';
      return ref(node, resolved);
    }
    case 'range': return range(node, map);
    case 'binary': return map(node.left) + node.operator + map(node.right);
    case 'unary': return node.operator + map(node.operand);
    case 'function': return node.name + '(' + node.args.map(map).join(',') + ')';
    case 'paren': return '(' + map(node.expr) + ')';
    default: return serializeNode(node);
  }
}

// ─── Serialize to A1 format ──────────────────────────────────────────────────

/** Serialize an AST to A1 format. Relative refs become A1, absolute become $A$1. */
export function serializeA1(
  ast: FormulaAST,
  cellRow: number, cellCol: number,
  idToRowIndex: (id: string) => number | undefined,
  idToColIndex: (id: string) => number | undefined,
  sheetNameLookup?: (sheetId: string) => string | undefined,
  sheetRowColLookup?: SheetRowColLookup,
  totalRows?: number,
  totalCols?: number,
): string {
  const ref = (node: CellRef, r: ResolvedRef): string => {
    let cellA1: string;
    if (r.isWholeCol) {
      const colStr = (node.col.relative ? '' : '$') + colIndexToLetter(r.colIdx!);
      if (r.totalRows !== undefined) {
        // HyperFormula doesn't support bare column refs — expand to concrete last row
        cellA1 = colStr + '$' + r.totalRows;
      } else {
        cellA1 = colStr;
      }
    } else if (r.isWholeRow) {
      const rowStr = (node.row.relative ? '' : '$') + (r.rowIdx! + 1);
      if (r.totalCols !== undefined) {
        cellA1 = '$' + colIndexToLetter(r.totalCols - 1) + rowStr;
      } else {
        cellA1 = rowStr;
      }
    } else {
      const colStr = (node.col.relative ? '' : '$') + colIndexToLetter(r.colIdx!);
      const rowStr = (node.row.relative ? '' : '$') + (r.rowIdx! + 1);
      cellA1 = colStr + rowStr;
    }
    return r.sheetPrefix + cellA1;
  };

  const range = (node: RangeRef, map: (n: FormulaNode) => string): string => {
    if (node.from.sheet) {
      // Cross-sheet range: sheet name only on 'from' (e.g., Sheet!A1:B2), and the
      // 'to' endpoint resolves against the target sheet's lookups.
      const fromStr = map(node.from);
      if (fromStr === '#REF!') return '#REF!';
      const targetLookups = sheetRowColLookup ? sheetRowColLookup(node.from.sheet.id) : undefined;
      const toRowLookup = targetLookups?.idToRowIndex ?? idToRowIndex;
      const toColLookup = targetLookups?.idToColIndex ?? idToColIndex;
      const toNoSheet: CellRef = { ...node.to, sheet: undefined };
      const toTotalRows = targetLookups?.totalRows ?? totalRows;
      const toTotalCols = targetLookups?.totalCols ?? totalCols;
      const toStr = serializeNodeFmt(toNoSheet, ref, range, cellRow, cellCol, toRowLookup, toColLookup, sheetNameLookup, sheetRowColLookup, toTotalRows, toTotalCols);
      if (toStr === '#REF!') return fromStr;
      return fromStr + ':' + toStr;
    }
    const fromStr = map(node.from);
    const toStr = map(node.to);
    if (fromStr === '#REF!' || toStr === '#REF!') return '#REF!';
    return fromStr + ':' + toStr;
  };

  return '=' + serializeNodeFmt(ast.body, ref, range, cellRow, cellCol, idToRowIndex, idToColIndex, sheetNameLookup, sheetRowColLookup, totalRows, totalCols);
}

// ─── Serialize to R1C1 format ────────────────────────────────────────────────

/** Serialize an AST to R1C1 format. Absolute = R1C1 (1-based), relative = R[offset]C[offset]. */
export function serializeR1C1(
  ast: FormulaAST,
  cellRow: number, cellCol: number,
  idToRowIndex: (id: string) => number | undefined,
  idToColIndex: (id: string) => number | undefined,
  sheetNameLookup?: (sheetId: string) => string | undefined,
  sheetRowColLookup?: SheetRowColLookup,
): string {
  const ref = (node: CellRef, r: ResolvedRef): string => {
    let r1c1: string;
    if (r.isWholeCol) {
      const colPart = node.col.relative ? `[${r.colIdx! - cellCol}]` : `${r.colIdx! + 1}`;
      r1c1 = `C${colPart}`;
    } else if (r.isWholeRow) {
      const rowPart = node.row.relative ? `[${r.rowIdx! - cellRow}]` : `${r.rowIdx! + 1}`;
      r1c1 = `R${rowPart}`;
    } else {
      const rowOffset = r.rowIdx! - cellRow;
      const colOffset = r.colIdx! - cellCol;
      const rowPart = node.row.relative ? (rowOffset === 0 ? '' : `[${rowOffset}]`) : `${r.rowIdx! + 1}`;
      const colPart = node.col.relative ? (colOffset === 0 ? '' : `[${colOffset}]`) : `${r.colIdx! + 1}`;
      r1c1 = `R${rowPart}C${colPart}`;
    }
    return r.sheetPrefix + r1c1;
  };

  const range = (node: RangeRef, map: (n: FormulaNode) => string): string => {
    if (node.from.sheet) {
      const fromStr = map(node.from);
      const toStr = map(node.to);
      // Strip the redundant sheet prefix from the second endpoint (Sheet!A1:B2,
      // not Sheet!A1:Sheet!B2)
      const bangIdx = toStr.indexOf('!');
      return fromStr + ':' + (bangIdx >= 0 ? toStr.slice(bangIdx + 1) : toStr);
    }
    return map(node.from) + ':' + map(node.to);
  };

  return '=' + serializeNodeFmt(ast.body, ref, range, cellRow, cellCol, idToRowIndex, idToColIndex, sheetNameLookup, sheetRowColLookup);
}

// ─── parseFormula (universal parser) ─────────────────────────────────────────

type IdLookup = (index: number) => string;

/**
 * Parse a formula in A1, R1C1, or canonical format, always producing
 * a canonical AST with CellRef nodes using CellRefPart { id, relative }.
 *
 * Pre-processes the formula to convert A1 and R1C1 refs to canonical syntax,
 * then calls parseInternal().
 *
 * When `lookupSheetId` is provided, `SheetName!A1` and `'Sheet Name'!A1`
 * prefixes are converted to `S{sheetId}` in the canonical form.
 */
export function parseFormula(
  formula: string,
  cellRow: number, cellCol: number,
  lookupRowId: IdLookup, lookupColId: IdLookup,
  lookupSheetId?: (name: string) => string | undefined,
  /** For cross-sheet refs: given a sheetId, return row/col lookups for that sheet. */
  lookupSheetRowColIds?: (sheetId: string) => { rowId: IdLookup; colId: IdLookup; totalRows?: number } | undefined,
  /** Total number of rows in the current sheet. Used to resolve partial ranges like B2:B → B2:B{lastRow}. */
  totalRows?: number,
): FormulaAST {
  let result = '';
  let i = 0;
  const len = formula.length;

  /** Try to consume a sheet prefix at position i. Returns [sheetId, newI] or null. */
  function tryParseSheetPrefix(): [string, number] | null {
    if (!lookupSheetId) return null;
    let j = i;
    let sheetName: string;

    if (j < len && formula[j] === "'") {
      // Quoted sheet name: 'Sheet Name'!
      j++; // skip opening quote
      let name = '';
      while (j < len) {
        if (formula[j] === "'") {
          if (j + 1 < len && formula[j + 1] === "'") {
            name += "'";
            j += 2;
          } else {
            j++; // skip closing quote
            break;
          }
        } else {
          name += formula[j];
          j++;
        }
      }
      if (j >= len || formula[j] !== '!') return null;
      j++; // skip '!'
      sheetName = name;
    } else {
      // Unquoted sheet name: letters/digits/underscores followed by !
      const rest = formula.slice(j);
      const m = rest.match(/^([A-Za-z0-9_]+)!/);
      if (!m) return null;
      sheetName = m[1];
      j += m[0].length;
    }

    const sheetId = lookupSheetId(sheetName);
    if (sheetId === undefined) return null;
    return [sheetId, j];
  }

  /** Convert a column-only ref (e.g. B or $B) to canonical format — omits R part. */
  function convertColOnly(dollarCol: string, colLetters: string, sheetSuffix: string, targetSheetId?: string): string {
    const colIdx = letterToColIndex(colLetters.toUpperCase());
    const colAbsolute = dollarCol === '$';
    const sheetLookups = targetSheetId && lookupSheetRowColIds ? lookupSheetRowColIds(targetSheetId) : undefined;
    const colId = (sheetLookups?.colId ?? lookupColId)(colIdx);
    const colStr = colAbsolute ? `{${colId}}` : `[${colId}]`;
    return `{C${colStr}${sheetSuffix}}`;
  }

  /** Convert a row-only ref (e.g. 1 or $1) to canonical format — omits C part. */
  function convertRowOnly(dollarRow: string, rowDigits: string, sheetSuffix: string, targetSheetId?: string): string {
    const rowIdx = parseInt(rowDigits, 10) - 1;
    const rowAbsolute = dollarRow === '$';
    const sheetLookups = targetSheetId && lookupSheetRowColIds ? lookupSheetRowColIds(targetSheetId) : undefined;
    const rowId = (sheetLookups?.rowId ?? lookupRowId)(rowIdx);
    const rowStr = rowAbsolute ? `{${rowId}}` : `[${rowId}]`;
    return `{R${rowStr}${sheetSuffix}}`;
  }

  /** Try to match and convert an R1C1 ref at the given position. Returns null if no match. */
  function tryConvertR1C1(
    rest: string,
    sheetSuffix = '',
    targetSheetId?: string,
  ): { result: string; consumed: number } | null {
    const r1c1Match = rest.match(/^R(\d+|\[-?\d+\])?C(\d+|\[-?\d+\])?(?![A-Za-z])/);
    if (!r1c1Match) return null;
    const rowPart = r1c1Match[1] ?? '[0]';
    const colPart = r1c1Match[2] ?? '[0]';
    const sheetLookups = targetSheetId && lookupSheetRowColIds ? lookupSheetRowColIds(targetSheetId) : undefined;

    let rowId: string;
    let rowRelative: boolean;
    if (rowPart[0] === '[') {
      const offset = parseInt(rowPart.slice(1, -1), 10);
      rowId = (sheetLookups?.rowId ?? lookupRowId)(cellRow + offset);
      rowRelative = true;
    } else {
      const idx = parseInt(rowPart, 10) - 1;
      rowId = (sheetLookups?.rowId ?? lookupRowId)(idx);
      rowRelative = false;
    }

    let colId: string;
    let colRelative: boolean;
    if (colPart[0] === '[') {
      const offset = parseInt(colPart.slice(1, -1), 10);
      colId = (sheetLookups?.colId ?? lookupColId)(cellCol + offset);
      colRelative = true;
    } else {
      const idx = parseInt(colPart, 10) - 1;
      colId = (sheetLookups?.colId ?? lookupColId)(idx);
      colRelative = false;
    }

    const rowStr = rowRelative ? `[${rowId}]` : `{${rowId}}`;
    const colStr = colRelative ? `[${colId}]` : `{${colId}}`;
    let out = `{R${rowStr}C${colStr}${sheetSuffix}}`;

    let consumed = r1c1Match[0].length;
    // Handle R1C1 range: R2C3:R1642C3
    if (consumed < rest.length && rest[consumed] === ':') {
      const rangeRest = rest.slice(consumed + 1);
      const r1c1Match2 = rangeRest.match(/^R(\d+|\[-?\d+\])?C(\d+|\[-?\d+\])?(?![A-Za-z])/);
      if (r1c1Match2) {
        const conv2 = tryConvertR1C1(rangeRest, sheetSuffix, targetSheetId);
        if (conv2) {
          out += ':' + conv2.result;
          consumed += 1 + conv2.consumed;
        }
      }
    }
    return { result: out, consumed };
  }

  /** Convert an A1 cell ref to canonical format with optional sheet suffix. */
  function convertA1(full: string, dollarCol: string, colLetters: string, dollarRow: string, rowDigits: string, sheetSuffix: string, targetSheetId?: string): string {
    const colIdx = letterToColIndex(colLetters.toUpperCase());
    const rowIdx = parseInt(rowDigits, 10) - 1;
    const colAbsolute = dollarCol === '$';
    const rowAbsolute = dollarRow === '$';
    // For cross-sheet refs, use the target sheet's row/col lookups
    const sheetLookups = targetSheetId && lookupSheetRowColIds ? lookupSheetRowColIds(targetSheetId) : undefined;
    const rowId = (sheetLookups?.rowId ?? lookupRowId)(rowIdx);
    const colId = (sheetLookups?.colId ?? lookupColId)(colIdx);
    const rowStr = rowAbsolute ? `{${rowId}}` : `[${rowId}]`;
    const colStr = colAbsolute ? `{${colId}}` : `[${colId}]`;
    return `{R${rowStr}C${colStr}${sheetSuffix}}`;
  }

  while (i < len) {
    const ch = formula[i];

    // Pass through string literals unchanged
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        if (formula[i] === '"') {
          result += '"';
          if (i + 1 < len && formula[i + 1] === '"') {
            result += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          result += formula[i];
          i++;
        }
      }
      continue;
    }

    // Canonical refs: pass through unchanged
    if (ch === '{' && i + 1 < len && formula[i + 1] === 'R') {
      // Find closing }
      let j = i + 2;
      let depth = 1;
      while (j < len && depth > 0) {
        if (formula[j] === '{') depth++;
        else if (formula[j] === '}') depth--;
        j++;
      }
      result += formula.slice(i, j);
      i = j;
      continue;
    }

    // Quoted sheet prefix: 'Sheet Name'!A1
    if (ch === "'" && lookupSheetId) {
      const saved = i;
      const sheetResult = tryParseSheetPrefix();
      if (sheetResult) {
        const [sheetId, afterBang] = sheetResult;
        const sheetSuffix = `S{${sheetId}}`;
        i = afterBang;
        // Now expect a cell ref or column range (A1 format) right after the !
        const rest = formula.slice(i);
        const a1Match = rest.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)(?![A-Za-z(])/);
        if (a1Match) {
          result += convertA1(a1Match[0], a1Match[1], a1Match[2], a1Match[3], a1Match[4], sheetSuffix, sheetId);
          i += a1Match[0].length;
          // Range: 'Sheet'!A1:B2 — second endpoint inherits sheet
          if (i < len && formula[i] === ':') {
            const rangeRest = formula.slice(i + 1);
            const a1Match2 = rangeRest.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)(?![A-Za-z(])/);
            if (a1Match2) {
              result += ':' + convertA1(a1Match2[0], a1Match2[1], a1Match2[2], a1Match2[3], a1Match2[4], sheetSuffix, sheetId);
              i += 1 + a1Match2[0].length;
            } else {
              // Partial range end: 'Sheet'!B2:B — missing row = last row
              const effectiveRows = lookupSheetRowColIds?.(sheetId)?.totalRows ?? totalRows;
              if (effectiveRows != null) {
                const colOnlyEnd = rangeRest.match(/^(\$?)([A-Za-z]+)(?![A-Za-z0-9(])/);
                if (colOnlyEnd) {
                  result += ':' + convertA1('', colOnlyEnd[1], colOnlyEnd[2], '', String(effectiveRows), sheetSuffix, sheetId);
                  i += 1 + colOnlyEnd[0].length;
                }
              }
            }
          }
          continue;
        }
        // Partial range: B:B5 — column-only start (row 1), full cell ref end
        {
          const effectiveRows = lookupSheetRowColIds?.(sheetId)?.totalRows ?? totalRows;
          if (effectiveRows != null) {
            const partialStartMatch = rest.match(/^(\$?)([A-Za-z]+):(\$?)([A-Za-z]+)(\$?)(\d+)(?![A-Za-z(])/);
            if (partialStartMatch) {
              result += convertA1('', partialStartMatch[1], partialStartMatch[2], '', '1', sheetSuffix, sheetId)
                + ':' + convertA1('', partialStartMatch[3], partialStartMatch[4], partialStartMatch[5], partialStartMatch[6], sheetSuffix, sheetId);
              i += partialStartMatch[0].length;
              continue;
            }
          }
        }
        // Column range: B:B, $A:$C
        const colRangeMatch = rest.match(/^(\$?)([A-Za-z]+):(\$?)([A-Za-z]+)(?![A-Za-z0-9(])/);
        if (colRangeMatch) {
          result += convertColOnly(colRangeMatch[1], colRangeMatch[2], sheetSuffix, sheetId)
            + ':' + convertColOnly(colRangeMatch[3], colRangeMatch[4], sheetSuffix, sheetId);
          i += colRangeMatch[0].length;
          continue;
        }
        // Row range: 1:1, $1:$5
        const rowRangeMatch = rest.match(/^(\$?)(\d+):(\$?)(\d+)(?![A-Za-z(])/);
        if (rowRangeMatch) {
          result += convertRowOnly(rowRangeMatch[1], rowRangeMatch[2], sheetSuffix, sheetId)
            + ':' + convertRowOnly(rowRangeMatch[3], rowRangeMatch[4], sheetSuffix, sheetId);
          i += rowRangeMatch[0].length;
          continue;
        }
        // Try R1C1 format after quoted sheet prefix: 'Sheet'!R2C3
        const r1c1Result = tryConvertR1C1(rest, sheetSuffix, sheetId);
        if (r1c1Result) {
          result += r1c1Result.result;
          i += r1c1Result.consumed;
          continue;
        }
        // Not a valid ref after sheet name — backtrack
        i = saved;
      }
      // Sheet not found — consume 'Name'! syntax and emit #REF! for the ref
      {
        let j = i + 1; // skip opening '
        while (j < len) {
          if (formula[j] === "'") {
            if (j + 1 < len && formula[j + 1] === "'") j += 2;
            else { j++; break; }
          } else j++;
        }
        if (j < len && formula[j] === '!') {
          j++; // skip !
          const rest = formula.slice(j);
          const m = rest.match(/^(\$?[A-Za-z]+\$?\d+:\$?[A-Za-z]+\$?\d+)/) ||
                    rest.match(/^(\$?[A-Za-z]+\$?\d+)/) ||
                    rest.match(/^(\$?[A-Za-z]+:\$?[A-Za-z]+)/) ||
                    rest.match(/^(\$?\d+:\$?\d+)/);
          if (m) j += m[0].length;
          result += '#REF!';
          i = j;
          continue;
        }
      }
      result += ch;
      i++;
      continue;
    }

    // R1C1 format: R followed by digit or [ (but not followed by letter making it a cell ref like R1 in A1 mode)
    // R1C1 absolute: R<digits>C<digits> (1-based)
    // R1C1 relative: R[<offset>]C[<offset>]
    // Mixed combinations
    if (ch === 'R' && i + 1 < len) {
      const converted = tryConvertR1C1(formula.slice(i));
      if (converted) {
        result += converted.result;
        i += converted.consumed;
        continue;
      }
    }

    // A1 format: possibly preceded by SheetName! (unquoted)
    if ((ch === '$' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) && !(i > 0 && formula[i - 1] >= '0' && formula[i - 1] <= '9')) {
      // Try unquoted sheet prefix first: SheetName!A1
      let sheetSuffix = '';
      let targetSheetId: string | undefined;
      const saved = i;
      if (lookupSheetId) {
        const sheetResult = tryParseSheetPrefix();
        if (sheetResult) {
          const [sheetId, afterBang] = sheetResult;
          sheetSuffix = `S{${sheetId}}`;
          targetSheetId = sheetId;
          i = afterBang;
        }
      }

      const rest = formula.slice(i);
      const a1Match = rest.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)(?![A-Za-z(])/);
      if (a1Match) {
        result += convertA1(a1Match[0], a1Match[1], a1Match[2], a1Match[3], a1Match[4], sheetSuffix, targetSheetId);
        i += a1Match[0].length;
        // Range: Sheet!A1:B2 — second endpoint inherits sheet
        if (sheetSuffix && i < len && formula[i] === ':') {
          const rangeRest = formula.slice(i + 1);
          const a1Match2 = rangeRest.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)(?![A-Za-z(])/);
          if (a1Match2) {
            result += ':' + convertA1(a1Match2[0], a1Match2[1], a1Match2[2], a1Match2[3], a1Match2[4], sheetSuffix, targetSheetId);
            i += 1 + a1Match2[0].length;
          } else {
            // Partial range end: Sheet!B2:B — missing row = last row
            const effectiveRows = (targetSheetId && lookupSheetRowColIds?.(targetSheetId)?.totalRows) ?? totalRows;
            if (effectiveRows != null) {
              const colOnlyEnd = rangeRest.match(/^(\$?)([A-Za-z]+)(?![A-Za-z0-9(])/);
              if (colOnlyEnd) {
                result += ':' + convertA1('', colOnlyEnd[1], colOnlyEnd[2], '', String(effectiveRows), sheetSuffix, targetSheetId);
                i += 1 + colOnlyEnd[0].length;
              }
            }
          }
        }
        // Partial range end (no sheet prefix): B2:B — missing row = last row
        if (!sheetSuffix && i < len && formula[i] === ':') {
          const rangeRest = formula.slice(i + 1);
          // Only handle column-only after colon (full ref B2:B5 is handled by parseInternal)
          const fullRefCheck = rangeRest.match(/^(\$?)([A-Za-z]+)(\$?)(\d+)(?![A-Za-z(])/);
          if (!fullRefCheck && totalRows != null) {
            const colOnlyEnd = rangeRest.match(/^(\$?)([A-Za-z]+)(?![A-Za-z0-9(])/);
            if (colOnlyEnd) {
              result += ':' + convertA1('', colOnlyEnd[1], colOnlyEnd[2], '', String(totalRows), '', undefined);
              i += 1 + colOnlyEnd[0].length;
            }
          }
        }
        continue;
      }

      // Try R1C1 format after unquoted sheet prefix: SheetName!R2C3
      {
        const r1c1Result = tryConvertR1C1(rest, sheetSuffix, targetSheetId);
        if (r1c1Result) {
          result += r1c1Result.result;
          i += r1c1Result.consumed;
          continue;
        }
      }

      // Partial range: B:B5 — column-only start (row 1), full cell ref end (with optional sheet prefix)
      {
        const effectiveRows = (targetSheetId && lookupSheetRowColIds?.(targetSheetId)?.totalRows) ?? totalRows;
        if (effectiveRows != null) {
          const partialStartMatch = rest.match(/^(\$?)([A-Za-z]+):(\$?)([A-Za-z]+)(\$?)(\d+)(?![A-Za-z(])/);
          if (partialStartMatch) {
            result += convertA1('', partialStartMatch[1], partialStartMatch[2], '', '1', sheetSuffix, targetSheetId)
              + ':' + convertA1('', partialStartMatch[3], partialStartMatch[4], partialStartMatch[5], partialStartMatch[6], sheetSuffix, targetSheetId);
            i += partialStartMatch[0].length;
            continue;
          }
        }
      }

      // Column range: B:B, $A:$C, A:Z (with optional sheet prefix)
      const colRangeMatch = rest.match(/^(\$?)([A-Za-z]+):(\$?)([A-Za-z]+)(?![A-Za-z0-9(])/);
      if (colRangeMatch) {
        result += convertColOnly(colRangeMatch[1], colRangeMatch[2], sheetSuffix, targetSheetId)
          + ':' + convertColOnly(colRangeMatch[3], colRangeMatch[4], sheetSuffix, targetSheetId);
        i += colRangeMatch[0].length;
        continue;
      }

      // Row range starting with $: $1:$5 (with optional sheet prefix)
      const rowRangeMatch = rest.match(/^(\$)(\d+):(\$?)(\d+)(?![A-Za-z(])/);
      if (rowRangeMatch) {
        result += convertRowOnly(rowRangeMatch[1], rowRangeMatch[2], sheetSuffix, targetSheetId)
          + ':' + convertRowOnly(rowRangeMatch[3], rowRangeMatch[4], sheetSuffix, targetSheetId);
        i += rowRangeMatch[0].length;
        continue;
      }

      // If we consumed a sheet prefix but no A1 ref or column/row range followed, backtrack
      if (sheetSuffix) {
        i = saved;
      }

      // Check for function name / boolean (original logic)
      const rest2 = formula.slice(i);
      const nameMatch = rest2.match(/^[A-Za-z]+/);
      if (nameMatch) {
        const name = nameMatch[0].toUpperCase();
        if (name === 'TRUE' || name === 'FALSE') {
          // Let the tokenizer handle it
          result += formula.slice(i, i + nameMatch[0].length);
          i += nameMatch[0].length;
          continue;
        }
        // Check if followed by '(' → function name, pass through
        let peek = i + nameMatch[0].length;
        while (peek < len && (formula[peek] === ' ' || formula[peek] === '\t')) peek++;
        if (peek < len && formula[peek] === '(') {
          result += formula.slice(i, i + nameMatch[0].length);
          i += nameMatch[0].length;
          continue;
        }
      }

      // Lone character — pass through
      result += ch;
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  return parseInternal(result);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Single home for the AST walk: `visit` recurses via the `map` it's given. */
export function mapFormulaNodes<T>(
  node: FormulaNode,
  visit: (node: FormulaNode, map: (n: FormulaNode) => T) => T,
): T {
  const map = (n: FormulaNode): T => mapFormulaNodes(n, visit);
  return visit(node, map);
}

/** Extract all cell references and range references from an AST. */
export function extractCellRefs(ast: FormulaAST): (CellRef | RangeRef)[] {
  const refs: (CellRef | RangeRef)[] = [];
  mapFormulaNodes(ast.body, (node, map) => {
    switch (node.type) {
      case 'cellRef':
      case 'range':
        // Range endpoints aren't recursed, so refs inside a range aren't collected twice.
        refs.push(node);
        break;
      case 'binary': map(node.left); map(node.right); break;
      case 'unary': map(node.operand); break;
      case 'function': node.args.forEach(map); break;
      case 'paren': map(node.expr); break;
    }
    return 0;
  });
  return refs;
}
