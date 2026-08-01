import { colIndexToLetter } from './helpers';
import type { CellRef, CellRefPart, FormulaAST, FormulaNode, RangeRef } from './formula-ast';

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
