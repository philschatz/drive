import { FormulaParseError } from './formula-ast';
import type { Token } from './formula-ast';

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
