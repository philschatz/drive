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
