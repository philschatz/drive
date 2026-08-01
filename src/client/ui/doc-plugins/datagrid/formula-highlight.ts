import { letterToColIndex } from './helpers';
import { MATERIAL_CATEGORICAL as REF_COLORS } from '../../common/categorical-colors';
export { REF_COLORS };

// Rotating palette for cell/range reference colors.
// Shared with peer-presence colors so formula tokens, grid ref decorations,
// and every other categorical consumer draw from one Material palette.

export interface FormulaRef {
  col: number;
  row: number;
  color: string;
}

export interface FormulaRangeRef {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
  color: string;
}

export type FormulaHighlight = (FormulaRef | FormulaRangeRef) & { active?: boolean };

export function isRange(h: FormulaHighlight): h is FormulaRangeRef & { active?: boolean } {
  return 'minCol' in h;
}

// Token types for A1 formula highlighting
export interface FormulaToken {
  type: 'equals' | 'cellRef' | 'range' | 'function' | 'number' | 'string' | 'boolean' | 'operator' | 'paren' | 'error' | 'comma';
  start: number;
  end: number;
  refIndex?: number;
  /** True when the ref is prefixed with a sheet name (e.g. Sheet2!A1) */
  crossSheet?: boolean;
}

// Tokenize an A1-format formula for syntax highlighting purposes
export function tokenizeA1(text: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  if (!text.startsWith('=')) return tokens;
  tokens.push({ type: 'equals', start: 0, end: 1 });

  let i = 1;
  const len = text.length;
  let refCounter = 0;

  while (i < len) {
    if (text[i] === ' ' || text[i] === '\t') { i++; continue; }

    const start = i;
    const ch = text[i];

    // String literal
    if (ch === '"') {
      i++;
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') { i += 2; }
          else { i++; break; }
        } else { i++; }
      }
      tokens.push({ type: 'string', start, end: i });
      continue;
    }

    // Error literal
    if (ch === '#') {
      const rest = text.slice(i);
      const m = rest.match(/^#(?:N\/A|[A-Z/0]+[!?])/i);
      if (m) {
        tokens.push({ type: 'error', start, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
      i++;
      continue;
    }

    // Number
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && text[i + 1] >= '0' && text[i + 1] <= '9')) {
      while (i < len && ((text[i] >= '0' && text[i] <= '9') || text[i] === '.')) i++;
      if (i < len && (text[i] === 'E' || text[i] === 'e')) {
        const saved = i;
        i++;
        if (i < len && (text[i] === '+' || text[i] === '-')) i++;
        if (i < len && text[i] >= '0' && text[i] <= '9') {
          while (i < len && text[i] >= '0' && text[i] <= '9') i++;
        } else {
          i = saved;
        }
      }
      tokens.push({ type: 'number', start, end: i });
      continue;
    }

    // Quoted sheet prefix: 'Sheet Name'!A1 or 'Sheet Name'!A1:B2
    if (ch === "'") {
      const rest = text.slice(i);
      // Match 'SheetName'! followed by a cell ref or range (including partial ranges like B2:B or B:B5)
      const quotedMatch = rest.match(/^'(?:[^']|'')*'!(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+|\$?[A-Za-z]+))?/);
      if (quotedMatch) {
        const refIdx = refCounter++;
        if (quotedMatch[2]) {
          tokens.push({ type: 'range', start: i, end: i + quotedMatch[0].length, refIndex: refIdx, crossSheet: true });
        } else {
          tokens.push({ type: 'cellRef', start: i, end: i + quotedMatch[0].length, refIndex: refIdx, crossSheet: true });
        }
        i += quotedMatch[0].length;
        continue;
      }
      // Also match quoted sheet prefix with column range: 'Sheet'!B:B or partial 'Sheet'!B:B5
      const quotedColRange = rest.match(/^'(?:[^']|'')*'!\$?[A-Za-z]+:\$?[A-Za-z]+\$?\d*/);
      if (quotedColRange) {
        tokens.push({ type: 'range', start: i, end: i + quotedColRange[0].length, refIndex: refCounter++, crossSheet: true });
        i += quotedColRange[0].length;
        continue;
      }
      // Also match quoted sheet prefix with row range: 'Sheet'!1:5
      const quotedRowRange = rest.match(/^'(?:[^']|'')*'!\$?\d+:\$?\d+/);
      if (quotedRowRange) {
        tokens.push({ type: 'range', start: i, end: i + quotedRowRange[0].length, refIndex: refCounter++, crossSheet: true });
        i += quotedRowRange[0].length;
        continue;
      }
      i++;
      continue;
    }

    // Dollar sign or letter: could be cell ref, range, boolean, or function
    if (ch === '$' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      const rest = text.slice(i);

      // Unquoted sheet prefix: SheetName!A1 or SheetName!A1:B2 or SheetName!A1:B (partial)
      const sheetCellMatch = rest.match(/^([A-Za-z0-9_]+)!(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+|\$?[A-Za-z]+))?/);
      if (sheetCellMatch) {
        const name = sheetCellMatch[1].toUpperCase();
        if (name !== 'TRUE' && name !== 'FALSE') {
          const refIdx = refCounter++;
          if (sheetCellMatch[3]) {
            tokens.push({ type: 'range', start: i, end: i + sheetCellMatch[0].length, refIndex: refIdx, crossSheet: true });
          } else {
            tokens.push({ type: 'cellRef', start: i, end: i + sheetCellMatch[0].length, refIndex: refIdx, crossSheet: true });
          }
          i += sheetCellMatch[0].length;
          continue;
        }
      }
      // Unquoted sheet prefix with column range: SheetName!B:B or partial SheetName!B:B5
      const sheetColRange = rest.match(/^([A-Za-z0-9_]+)!\$?[A-Za-z]+:\$?[A-Za-z]+\$?\d*/);
      if (sheetColRange) {
        const name = sheetColRange[1].toUpperCase();
        if (name !== 'TRUE' && name !== 'FALSE') {
          tokens.push({ type: 'range', start: i, end: i + sheetColRange[0].length, refIndex: refCounter++, crossSheet: true });
          i += sheetColRange[0].length;
          continue;
        }
      }
      // Unquoted sheet prefix with row range: SheetName!1:5
      const sheetRowRange = rest.match(/^([A-Za-z0-9_]+)!\$?\d+:\$?\d+/);
      if (sheetRowRange) {
        const name = sheetRowRange[1].toUpperCase();
        if (name !== 'TRUE' && name !== 'FALSE') {
          tokens.push({ type: 'range', start: i, end: i + sheetRowRange[0].length, refIndex: refCounter++, crossSheet: true });
          i += sheetRowRange[0].length;
          continue;
        }
      }

      const cellMatch = rest.match(/^(\$?[A-Za-z]+\$?\d+)(?::(\$?[A-Za-z]+\$?\d+|\$?[A-Za-z]+))?/);
      if (cellMatch) {
        const firstRef = cellMatch[1];
        const lettersMatch = firstRef.match(/^\$?([A-Za-z]+)\$?\d+$/);
        if (lettersMatch) {
          const letters = lettersMatch[1].toUpperCase();
          if (letters !== 'TRUE' && letters !== 'FALSE') {
            const pureLetters = rest.match(/^[A-Za-z]+/);
            if (pureLetters && text[i + pureLetters[0].length] === '(' && !cellMatch[1].match(/\d/)) {
              // function name, fall through
            } else {
              const colIdx = letterToColIndex(letters);
              if (colIdx >= 0 && colIdx < 18278) {
                if (cellMatch[2]) {
                  tokens.push({ type: 'range', start: i, end: i + cellMatch[0].length, refIndex: refCounter++ });
                } else {
                  tokens.push({ type: 'cellRef', start: i, end: i + cellMatch[0].length, refIndex: refCounter++ });
                }
                i += cellMatch[0].length;
                continue;
              }
            }
          }
        }
      }

      // Local column range: B:B, or partial range: B:B5
      const localColRange = rest.match(/^(\$?[A-Za-z]+):(\$?[A-Za-z]+\$?\d*)(?![A-Za-z(])/);
      if (localColRange) {
        const colLetters = localColRange[1].replace(/\$/g, '').toUpperCase();
        if (colLetters !== 'TRUE' && colLetters !== 'FALSE') {
          const colIdx = letterToColIndex(colLetters);
          if (colIdx >= 0 && colIdx < 18278) {
            tokens.push({ type: 'range', start: i, end: i + localColRange[0].length, refIndex: refCounter++ });
            i += localColRange[0].length;
            continue;
          }
        }
      }

      const boolMatch = rest.match(/^(TRUE|FALSE)(?![A-Za-z(])/i);
      if (boolMatch) {
        tokens.push({ type: 'boolean', start, end: i + boolMatch[0].length });
        i += boolMatch[0].length;
        continue;
      }

      const funcMatch = rest.match(/^[A-Za-z]+(?=\s*\()/);
      if (funcMatch) {
        tokens.push({ type: 'function', start, end: i + funcMatch[0].length });
        i += funcMatch[0].length;
        continue;
      }

      i++;
      continue;
    }

    // Operators
    if ('+-*/^&=<>'.includes(ch)) {
      if (ch === '<' && i + 1 < len && (text[i + 1] === '>' || text[i + 1] === '=')) {
        tokens.push({ type: 'operator', start, end: i + 2 }); i += 2; continue;
      }
      if (ch === '>' && i + 1 < len && text[i + 1] === '=') {
        tokens.push({ type: 'operator', start, end: i + 2 }); i += 2; continue;
      }
      tokens.push({ type: 'operator', start, end: i + 1 }); i++; continue;
    }

    if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', start, end: i + 1 }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', start, end: i + 1 }); i++; continue; }
    i++;
  }

  return tokens;
}

// Parse a cell reference string like "$A$1" or "B2" into grid coordinates
function parseCellRefStr(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^\$?([A-Za-z]+)\$?(\d+)$/);
  if (!m) return null;
  const col = letterToColIndex(m[1].toUpperCase());
  const row = parseInt(m[2], 10) - 1;
  if (col < 0 || row < 0) return null;
  return { col, row };
}

// Extract FormulaHighlights from A1 text, marking the ref under the cursor as active
export function extractHighlights(text: string, cursorPos?: number): FormulaHighlight[] {
  if (!text.startsWith('=')) return [];
  const tokens = tokenizeA1(text);
  const highlights: FormulaHighlight[] = [];

  let activeRefIndex: number | null = null;
  if (cursorPos != null) {
    for (const tok of tokens) {
      if ((tok.type === 'cellRef' || tok.type === 'range') && tok.refIndex != null) {
        if (cursorPos >= tok.start && cursorPos <= tok.end) {
          activeRefIndex = tok.refIndex;
          break;
        }
      }
    }
  }

  for (const tok of tokens) {
    // Cross-sheet refs get syntax highlighting but should not produce cell highlights
    if (tok.crossSheet) continue;
    const active = tok.refIndex != null && tok.refIndex === activeRefIndex;
    if (tok.type === 'cellRef') {
      const ref = parseCellRefStr(text.slice(tok.start, tok.end));
      if (ref) {
        highlights.push({ col: ref.col, row: ref.row, color: REF_COLORS[tok.refIndex! % REF_COLORS.length], active });
      }
    } else if (tok.type === 'range') {
      const parts = text.slice(tok.start, tok.end).split(':');
      if (parts.length === 2) {
        const from = parseCellRefStr(parts[0]);
        const to = parseCellRefStr(parts[1]);
        if (from && to) {
          highlights.push({
            minCol: Math.min(from.col, to.col),
            maxCol: Math.max(from.col, to.col),
            minRow: Math.min(from.row, to.row),
            maxRow: Math.max(from.row, to.row),
            color: REF_COLORS[tok.refIndex! % REF_COLORS.length],
            active,
          });
        }
      }
    }
  }

  return highlights;
}

// Token type → CSS class
export const tokenClassMap: Record<FormulaToken['type'], string> = {
  equals: 'formula-tok-equals',
  cellRef: 'formula-tok-ref',
  range: 'formula-tok-ref',
  function: 'formula-tok-function',
  number: 'formula-tok-number',
  string: 'formula-tok-string',
  boolean: 'formula-tok-boolean',
  operator: 'formula-tok-operator',
  paren: 'formula-tok-paren',
  error: 'formula-tok-error',
  comma: 'formula-tok-operator',
};

/** Find the span of the innermost function call enclosing the cursor.
 *  Returns { start, end } covering FUNCNAME(...) or null if cursor is
 *  not inside any function call. */
export function findEnclosingFunctionSpan(
  text: string,
  tokens: FormulaToken[],
  cursor: number,
): { start: number; end: number } | null {
  const spans: { start: number; end: number }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'function') continue;
    const funcStart = tokens[i].start;
    // Find the opening paren
    let j = i + 1;
    while (j < tokens.length && tokens[j].type !== 'paren') j++;
    if (j >= tokens.length || text[tokens[j].start] !== '(') continue;
    // Find the matching close paren
    let depth = 1;
    let k = j + 1;
    while (k < tokens.length && depth > 0) {
      if (tokens[k].type === 'paren') {
        if (text[tokens[k].start] === '(') depth++;
        else if (text[tokens[k].start] === ')') depth--;
      }
      k++;
    }
    if (depth === 0) {
      spans.push({ start: funcStart, end: tokens[k - 1].end });
    }
  }

  // Find the innermost (smallest) span containing the cursor
  let best: { start: number; end: number } | null = null;
  for (const span of spans) {
    if (cursor >= span.start && cursor <= span.end) {
      if (!best || (span.end - span.start) < (best.end - best.start)) {
        best = span;
      }
    }
  }
  return best;
}
