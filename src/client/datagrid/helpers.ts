import type { FormulaNode, CellRef, ErrorLiteral } from './formula-parser';
import { parseInternal, serialize, serializeA1, serializeR1C1, parseFormula } from './formula-parser';

/** Sort map entries by their float index. */
export function sortedEntries<T extends { index: number }>(map: Record<string, T>): [string, T][] {
  return Object.entries(map).sort((a, b) => a[1].index - b[1].index);
}

/** Convert a column index (0-based) to a spreadsheet letter (A, B, ... Z, AA, AB, ...) */
export function colIndexToLetter(i: number): string {
  let s = '';
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/** Convert column letters (A, B, ..., Z, AA, AB, ...) to a 0-based index. */
export function letterToColIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/**
 * Convert A1-style formula to canonical internal format.
 * Uses parseFormula to parse A1 refs, then serialize to canonical {R...C...} format.
 */
export function a1ToInternal(
  formula: string,
  cellRow: number,
  cellCol: number,
  sortedRowIds: string[],
  sortedColIds: string[],
  lookupSheetId?: (name: string) => string | undefined,
  /** For cross-sheet refs: given a sheetId, return row/col ID arrays for that sheet. */
  lookupSheetRowColIds?: (sheetId: string) => { rowIds: string[]; colIds: string[] } | undefined,
): string {
  const ast = parseFormula(
    formula, cellRow, cellCol,
    (idx) => sortedRowIds[idx] ?? `?row${idx}`,
    (idx) => sortedColIds[idx] ?? `?col${idx}`,
    lookupSheetId,
    lookupSheetRowColIds
      ? (sheetId) => {
          const ids = lookupSheetRowColIds(sheetId);
          if (!ids) return undefined;
          return {
            rowId: (idx) => ids.rowIds[idx] ?? `?row${idx}`,
            colId: (idx) => ids.colIds[idx] ?? `?col${idx}`,
          };
        }
      : undefined,
  );
  return serialize(ast);
}

/**
 * Convert canonical internal format back to A1-style formula.
 * Parses canonical {R...C...} refs, then serializes to A1.
 */
export function internalToA1(
  formula: string,
  cellRow: number,
  cellCol: number,
  sortedRowIds: string[],
  sortedColIds: string[],
  sheetNameLookup?: (sheetId: string) => string | undefined,
  /** For cross-sheet refs: given a sheetId, return row/col ID arrays for that sheet. */
  sheetRowColLookup?: (sheetId: string) => { rowIds: string[]; colIds: string[] } | undefined,
): string {
  try {
    const ast = parseInternal(formula);
    return serializeA1(
      ast, cellRow, cellCol,
      (id) => { const idx = sortedRowIds.indexOf(id); return idx === -1 ? undefined : idx; },
      (id) => { const idx = sortedColIds.indexOf(id); return idx === -1 ? undefined : idx; },
      sheetNameLookup,
      sheetRowColLookup
        ? (sheetId) => {
            const ids = sheetRowColLookup(sheetId);
            if (!ids) return undefined;
            return {
              idToRowIndex: (id) => { const idx = ids.rowIds.indexOf(id); return idx === -1 ? undefined : idx; },
              idToColIndex: (id) => { const idx = ids.colIds.indexOf(id); return idx === -1 ? undefined : idx; },
            };
          }
        : undefined,
    );
  } catch {
    return formula;
  }
}

/**
 * Convert canonical internal format to R1C1 format.
 * Parses canonical {R...C...} refs, then serializes to R1C1.
 */
export function internalToR1C1(
  formula: string,
  cellRow: number,
  cellCol: number,
  sortedRowIds: string[],
  sortedColIds: string[],
  sheetNameLookup?: (sheetId: string) => string | undefined,
): string {
  try {
    const ast = parseInternal(formula);
    return serializeR1C1(
      ast, cellRow, cellCol,
      (id) => { const idx = sortedRowIds.indexOf(id); return idx === -1 ? undefined : idx; },
      (id) => { const idx = sortedColIds.indexOf(id); return idx === -1 ? undefined : idx; },
      sheetNameLookup,
    );
  } catch {
    return formula;
  }
}

/** Convert a single cell's raw string value to a HyperFormula-compatible value. */
export function cellToHfValue(
  rawValue: string | undefined,
  rowIdx: number,
  colIdx: number,
  sortedRowIds: string[],
  sortedColIds: string[],
  sheetNameLookup?: (sheetId: string) => string | undefined,
  sheetRowColLookup?: (sheetId: string) => { rowIds: string[]; colIds: string[] } | undefined,
): string | number | boolean | null {
  if (!rawValue || rawValue === '') return null;
  if (rawValue.startsWith('=')) {
    return internalToA1(rawValue, rowIdx, colIdx, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup);
  }
  const num = Number(rawValue);
  if (!isNaN(num) && rawValue.trim() !== '') return num;
  if (rawValue === 'true') return true;
  if (rawValue === 'false') return false;
  return rawValue;
}

/** Build a HyperFormula-compatible 2D array from a sheet's cells. */
export function buildSheetData(
  cells: Record<string, { value: string }>,
  sortedRowIds: string[],
  sortedColIds: string[],
  sheetNameLookup?: (sheetId: string) => string | undefined,
  sheetRowColLookup?: (sheetId: string) => { rowIds: string[]; colIds: string[] } | undefined,
): (string | number | boolean | null)[][] {
  return sortedRowIds.map((rowId, rowIdx) =>
    sortedColIds.map((colId, colIdx) => {
      const cell = cells[`${rowId}:${colId}`];
      return cellToHfValue(cell?.value, rowIdx, colIdx, sortedRowIds, sortedColIds, sheetNameLookup, sheetRowColLookup);
    })
  );
}

/** Get computed display value for a cell from HyperFormula. */
export function getDisplayValue(hf: { getCellValue(addr: { sheet: number; col: number; row: number }): any } | null, rawValue: string, col: number, row: number, sheetIndex = 0): string {
  if (!rawValue) return '';
  if (rawValue.startsWith('=') && hf) {
    const computed = hf.getCellValue({ sheet: sheetIndex, col, row });
    if (computed == null) return '';
    if (typeof computed !== 'object') return String(computed);
    // HyperFormula DetailedCellError — show the error value (e.g. #VALUE!, #REF!, #NAME?)
    if ('value' in computed && typeof computed.value === 'string') return computed.value;
    return rawValue;
  }
  return rawValue;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Format a cell value with distribution uncertainty. */
export function formatDistValue(mean: number, stdev: number): string {
  const fmt = (v: number) => {
    if (Number.isInteger(v) && Math.abs(v) < 1e6) return String(v);
    return Math.abs(v) >= 1e6 || Math.abs(v) < 0.01 ? v.toExponential(2) : v.toFixed(2);
  };
  return `${fmt(mean)} ±${fmt(stdev)}`;
}

// --- Autofill ---

/** Detect if values form a numeric pattern (constant or arithmetic sequence). */
export function detectNumericPattern(
  values: string[],
): { type: 'constant' | 'arithmetic'; start: number; step: number } | null {
  if (values.length === 0) return null;
  const nums = values.map(v => Number(v));
  if (nums.some(n => isNaN(n)) || values.some(v => v.trim() === '')) return null;

  if (nums.length === 1) {
    return { type: 'constant', start: nums[0], step: 0 };
  }

  const step = nums[1] - nums[0];
  for (let i = 2; i < nums.length; i++) {
    if (Math.abs((nums[i] - nums[i - 1]) - step) > 1e-10) return null;
  }

  return { type: step === 0 ? 'constant' : 'arithmetic', start: nums[0], step };
}

/** Cycle through source values to produce fill values. */
export function cycleFill(
  values: string[],
  count: number,
  direction: 'forward' | 'backward',
): string[] {
  const len = values.length;
  if (len === 0 || count <= 0) return [];
  const results: string[] = [];
  for (let i = 0; i < count; i++) {
    if (direction === 'forward') {
      results.push(values[i % len]);
    } else {
      results.push(values[len - 1 - (i % len)]);
    }
  }
  if (direction === 'backward') results.reverse();
  return results;
}

/** Generate autofill values from source cell values. */
export function generateAutofillValues(
  sourceValues: string[],
  fillCount: number,
  direction: 'forward' | 'backward',
): string[] {
  if (sourceValues.length === 0 || fillCount <= 0) return [];

  if (sourceValues.every(v => v === '')) return Array(fillCount).fill('');

  // Formulas: cycle verbatim (relative offsets auto-adjust per cell position)
  if (sourceValues.every(v => v.startsWith('='))) {
    return cycleFill(sourceValues, fillCount, direction);
  }

  // Numeric pattern
  const pattern = detectNumericPattern(sourceValues);
  if (pattern) {
    const { start, step } = pattern;
    const lastVal = start + step * (sourceValues.length - 1);
    const results: string[] = [];
    for (let i = 1; i <= fillCount; i++) {
      if (direction === 'forward') {
        results.push(String(lastVal + step * i));
      } else {
        results.push(String(start - step * i));
      }
    }
    if (direction === 'backward') results.reverse();
    return results;
  }

  // Text/mixed: cycle
  return cycleFill(sourceValues, fillCount, direction);
}

/** Extract source values as strips for autofill. */
export function getAutofillSourceValues(
  cells: Record<string, { value: string }>,
  sortedRowIds: string[],
  sortedColIds: string[],
  sourceRange: { minCol: number; maxCol: number; minRow: number; maxRow: number },
  axis: 'row' | 'col',
): string[][] {
  if (axis === 'row') {
    // Vertical fill: one strip per column
    const strips: string[][] = [];
    for (let c = sourceRange.minCol; c <= sourceRange.maxCol; c++) {
      const strip: string[] = [];
      for (let r = sourceRange.minRow; r <= sourceRange.maxRow; r++) {
        const key = `${sortedRowIds[r]}:${sortedColIds[c]}`;
        strip.push(cells[key]?.value || '');
      }
      strips.push(strip);
    }
    return strips;
  } else {
    // Horizontal fill: one strip per row
    const strips: string[][] = [];
    for (let r = sourceRange.minRow; r <= sourceRange.maxRow; r++) {
      const strip: string[] = [];
      for (let c = sourceRange.minCol; c <= sourceRange.maxCol; c++) {
        const key = `${sortedRowIds[r]}:${sortedColIds[c]}`;
        strip.push(cells[key]?.value || '');
      }
      strips.push(strip);
    }
    return strips;
  }
}

// --- Formula rewriting on deletion ---

/**
 * Find the nearest surviving ID when `deletedId` has been removed.
 * Prefers scanning in `preferDirection` first (inward toward the other range endpoint),
 * then falls back to scanning the opposite direction.
 */
function findSurvivor(
  deletedId: string,
  sortedIds: readonly string[],
  deletedSet: ReadonlySet<string>,
  preferDirection: 'before' | 'after',
): string | null {
  const idx = sortedIds.indexOf(deletedId);
  if (idx === -1) return null;

  const scanBefore = () => {
    for (let i = idx - 1; i >= 0; i--) {
      if (!deletedSet.has(sortedIds[i])) return sortedIds[i];
    }
    return null;
  };
  const scanAfter = () => {
    for (let i = idx + 1; i < sortedIds.length; i++) {
      if (!deletedSet.has(sortedIds[i])) return sortedIds[i];
    }
    return null;
  };

  if (preferDirection === 'after') {
    return scanAfter() ?? scanBefore();
  }
  return scanBefore() ?? scanAfter();
}

/**
 * Rewrite a single internal-format formula, replacing refs to deleted IDs.
 * - Single cell ref with deleted row or col → #REF!
 * - Range endpoint with deleted row/col → shrink to nearest surviving neighbor
 * - If no survivor exists → #REF!
 * Returns the rewritten formula string, or null if unchanged.
 */
export function rewriteFormulaForDeletion(
  formula: string,
  deletedRowIds: ReadonlySet<string>,
  deletedColIds: ReadonlySet<string>,
  sortedRowIds: readonly string[],
  sortedColIds: readonly string[],
): string | null {
  let changed = false;

  const ast = parseInternal(formula);

  function makeError(start: number, end: number): ErrorLiteral {
    changed = true;
    return { type: 'error', errorType: '#REF!', start, end };
  }

  function rewriteRangeEndpoint(
    endpoint: CellRef,
    which: 'from' | 'to',
  ): CellRef | ErrorLiteral {
    let rowId = endpoint.row.id;
    let colId = endpoint.col.id;
    let endpointChanged = false;

    if (deletedRowIds.has(rowId)) {
      const prefer = which === 'from' ? 'after' : 'before';
      const survivor = findSurvivor(rowId, sortedRowIds, deletedRowIds, prefer);
      if (!survivor) return makeError(endpoint.start, endpoint.end);
      rowId = survivor;
      endpointChanged = true;
    }
    if (deletedColIds.has(colId)) {
      const prefer = which === 'from' ? 'after' : 'before';
      const survivor = findSurvivor(colId, sortedColIds, deletedColIds, prefer);
      if (!survivor) return makeError(endpoint.start, endpoint.end);
      colId = survivor;
      endpointChanged = true;
    }

    if (!endpointChanged) return endpoint;
    changed = true;
    return {
      ...endpoint,
      row: { ...endpoint.row, id: rowId },
      col: { ...endpoint.col, id: colId },
    };
  }

  function rewriteNode(node: FormulaNode): FormulaNode {
    switch (node.type) {
      case 'cellRef': {
        if (deletedRowIds.has(node.row.id) || deletedColIds.has(node.col.id)) {
          return makeError(node.start, node.end);
        }
        return node;
      }
      case 'range': {
        const from = rewriteRangeEndpoint(node.from, 'from');
        const to = rewriteRangeEndpoint(node.to, 'to');
        if (from.type === 'error' || to.type === 'error') {
          return makeError(node.start, node.end);
        }
        if (from === node.from && to === node.to) return node;
        return { ...node, from, to };
      }
      case 'binary': {
        const left = rewriteNode(node.left);
        const right = rewriteNode(node.right);
        if (left === node.left && right === node.right) return node;
        return { ...node, left, right };
      }
      case 'unary': {
        const operand = rewriteNode(node.operand);
        if (operand === node.operand) return node;
        return { ...node, operand };
      }
      case 'function': {
        const args = node.args.map(rewriteNode);
        if (args.every((a, i) => a === node.args[i])) return node;
        return { ...node, args };
      }
      case 'paren': {
        const expr = rewriteNode(node.expr);
        if (expr === node.expr) return node;
        return { ...node, expr };
      }
      default:
        return node;
    }
  }

  const newBody = rewriteNode(ast.body);
  if (!changed) return null;
  return serialize({ ...ast, body: newBody });
}

/**
 * Rewrite all formulas in a cells record that reference deleted row/col IDs.
 * Returns a map of cellKey → newValue for only the cells that changed.
 */
export function updateFormulasForDeletion(
  cells: Record<string, { value: string }>,
  deletedRowIds: ReadonlySet<string>,
  deletedColIds: ReadonlySet<string>,
  sortedRowIds: readonly string[],
  sortedColIds: readonly string[],
): Record<string, string> {
  const rewrites: Record<string, string> = {};
  for (const [key, cell] of Object.entries(cells)) {
    if (!cell.value.startsWith('=')) continue;
    // Skip cells that belong to deleted rows/cols (they'll be removed anyway)
    const [rowId, colId] = key.split(':');
    if (deletedRowIds.has(rowId) || deletedColIds.has(colId)) continue;
    try {
      const result = rewriteFormulaForDeletion(
        cell.value, deletedRowIds, deletedColIds, sortedRowIds, sortedColIds,
      );
      if (result !== null) rewrites[key] = result;
    } catch {
      // If parsing fails, leave the formula as-is
    }
  }
  return rewrites;
}

/**
 * Rewrite formulas across all sheets that reference a deleted sheet.
 * Cell refs with `S{deletedSheetId}` become `#REF!`.
 * Returns a nested map: sheetId → cellKey → newValue for changed cells.
 */
export function rewriteFormulasForSheetDeletion(
  allSheets: Record<string, { cells: Record<string, { value: string }> }>,
  deletedSheetId: string,
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};

  for (const [sheetId, sheet] of Object.entries(allSheets)) {
    if (sheetId === deletedSheetId) continue;
    for (const [key, cell] of Object.entries(sheet.cells)) {
      if (!cell.value.startsWith('=')) continue;
      // Quick check: does the formula mention the deleted sheet?
      if (!cell.value.includes(`S{${deletedSheetId}}`)) continue;
      try {
        const ast = parseInternal(cell.value);
        let changed = false;

        function rewriteNode(node: FormulaNode): FormulaNode {
          switch (node.type) {
            case 'cellRef': {
              if (node.sheet?.id === deletedSheetId) {
                changed = true;
                return { type: 'error', errorType: '#REF!', start: node.start, end: node.end };
              }
              return node;
            }
            case 'range': {
              const from = rewriteNode(node.from) as CellRef | ErrorLiteral;
              const to = rewriteNode(node.to) as CellRef | ErrorLiteral;
              if (from.type === 'error' || to.type === 'error') {
                changed = true;
                return { type: 'error', errorType: '#REF!', start: node.start, end: node.end };
              }
              if (from === node.from && to === node.to) return node;
              return { ...node, from: from as CellRef, to: to as CellRef };
            }
            case 'binary': {
              const left = rewriteNode(node.left);
              const right = rewriteNode(node.right);
              if (left === node.left && right === node.right) return node;
              return { ...node, left, right };
            }
            case 'unary': {
              const operand = rewriteNode(node.operand);
              if (operand === node.operand) return node;
              return { ...node, operand };
            }
            case 'function': {
              const args = node.args.map(rewriteNode);
              if (args.every((a, i) => a === node.args[i])) return node;
              return { ...node, args };
            }
            case 'paren': {
              const expr = rewriteNode(node.expr);
              if (expr === node.expr) return node;
              return { ...node, expr };
            }
            default: return node;
          }
        }

        const newBody = rewriteNode(ast.body);
        if (changed) {
          if (!result[sheetId]) result[sheetId] = {};
          result[sheetId][key] = serialize({ ...ast, body: newBody });
        }
      } catch {
        // parsing error — leave as-is
      }
    }
  }

  return result;
}
