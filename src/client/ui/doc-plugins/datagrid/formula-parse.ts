import { FormulaParseError } from './formula-ast';
import { tokenize } from './formula-lexer';
import type { BinaryExpr, CellRef, CellRefPart, FormulaAST, FormulaNode, Token, TokenType } from './formula-ast';

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
