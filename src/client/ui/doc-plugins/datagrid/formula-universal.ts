import { letterToColIndex } from './helpers';
import { parseInternal } from './formula-parse';
import type { FormulaAST } from './formula-ast';

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
