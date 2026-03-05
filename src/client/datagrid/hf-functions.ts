/**
 * Custom HyperFormula function plugins for CONCAT, SORT, and UNIQUE.
 *
 * ARRAYFORMULA is already built-in and doesn't need a custom implementation.
 */
import HyperFormula, {
  FunctionPlugin,
  FunctionArgumentType,
  SimpleRangeValue,
  ArraySize,
  EmptyValue,
} from 'hyperformula';

/* eslint-disable @typescript-eslint/no-explicit-any */
type CellValue = any;

// ---------------------------------------------------------------------------
// CONCAT — concatenates ranges/scalars without a delimiter (Excel/Sheets compat)
// Unlike CONCATENATE (which only takes scalar args), CONCAT flattens ranges.
// ---------------------------------------------------------------------------

class ConcatPlugin extends FunctionPlugin {
  static implementedFunctions = {
    'CONCAT': {
      method: 'concat',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
      ],
      repeatLastArgs: 1,
    },
  };

  concat(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('CONCAT'), (...args: any[]) => {
      let result = '';
      for (const arg of args) {
        if (arg && typeof arg === 'object' && 'data' in arg) {
          const range = arg as SimpleRangeValue;
          for (const row of range.data) {
            for (const cell of row) {
              if (cell != null && cell !== EmptyValue) result += String(cell);
            }
          }
        } else if (arg != null && arg !== EmptyValue) {
          result += String(arg);
        }
      }
      return result;
    });
  }
}

// ---------------------------------------------------------------------------
// SORT — sorts a range by a column, returns an array
// SORT(range, [sort_index], [sort_order], [by_col])
//   sort_index: 1-based column/row to sort by (default 1)
//   sort_order: 1 = ascending (default), -1 = descending
//   by_col: FALSE = sort rows (default), TRUE = sort columns
// ---------------------------------------------------------------------------

class SortPlugin extends FunctionPlugin {
  static implementedFunctions = {
    'SORT': {
      method: 'sort',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
        { argumentType: FunctionArgumentType.BOOLEAN, optionalArg: true },
      ],
      sizeOfResultArrayMethod: 'sortArraySize',
      enableArrayArithmeticForArguments: true,
    },
  };

  sort(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('SORT'),
      (range: SimpleRangeValue, sortIndex?: number, sortOrder?: number, byCol?: boolean) => {
        const data = range.data.map(row => [...row]);
        const idx = (sortIndex ?? 1) - 1; // convert to 0-based
        const order = sortOrder ?? 1;      // 1 = asc, -1 = desc

        if (byCol) {
          if (idx < 0 || idx >= data.length) return range;
          const colCount = data[0]?.length ?? 0;
          const colIndices = Array.from({ length: colCount }, (_, i) => i);
          colIndices.sort((a, b) => compareValues(data[idx][a], data[idx][b]) * order);
          const result = data.map(row => colIndices.map(ci => row[ci]));
          return SimpleRangeValue.onlyValues(result);
        } else {
          if (idx < 0 || idx >= (data[0]?.length ?? 0)) return range;
          data.sort((a, b) => compareValues(a[idx], b[idx]) * order);
          return SimpleRangeValue.onlyValues(data);
        }
      },
    );
  }

  sortArraySize(ast: any, state: any): ArraySize {
    if (ast.args.length < 1) return ArraySize.error();
    const range = this.arraySizeForAst(ast.args[0], state);
    if (range.isScalar()) return ArraySize.scalar();
    return new ArraySize(range.width, range.height);
  }
}

// ---------------------------------------------------------------------------
// UNIQUE — returns unique rows (or columns) from a range
// UNIQUE(range, [by_col], [exactly_once])
//   by_col: FALSE = unique rows (default), TRUE = unique columns
//   exactly_once: FALSE = all unique (default), TRUE = only appearing once
// ---------------------------------------------------------------------------

class UniquePlugin extends FunctionPlugin {
  static implementedFunctions = {
    'UNIQUE': {
      method: 'unique',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.BOOLEAN, optionalArg: true },
        { argumentType: FunctionArgumentType.BOOLEAN, optionalArg: true },
      ],
      sizeOfResultArrayMethod: 'uniqueArraySize',
      enableArrayArithmeticForArguments: true,
    },
  };

  unique(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('UNIQUE'),
      (range: SimpleRangeValue, byCol?: boolean, exactlyOnce?: boolean) => {
        if (byCol) return uniqueColumns(range, exactlyOnce ?? false);
        return uniqueRows(range, exactlyOnce ?? false);
      },
    );
  }

  uniqueArraySize(ast: any, state: any): ArraySize {
    if (ast.args.length < 1) return ArraySize.error();
    const range = this.arraySizeForAst(ast.args[0], state);
    if (range.isScalar()) return ArraySize.scalar();
    return new ArraySize(range.width, range.height);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareValues(a: CellValue, b: CellValue): number {
  const ra = sortRank(a);
  const rb = sortRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return 0;
}

function sortRank(v: CellValue): number {
  if (v == null || v === '' || typeof v === 'symbol') return 4;
  if (typeof v === 'number' || (typeof v === 'object' && 'val' in v)) return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3; // errors
}

function rowKey(row: CellValue[]): string {
  return row.map(v => {
    if (v == null || typeof v === 'symbol') return '\0';
    return typeof v + ':' + String(typeof v === 'object' && 'val' in v ? v.val : v);
  }).join('\x01');
}

function uniqueRows(range: SimpleRangeValue, exactlyOnce: boolean): SimpleRangeValue {
  const data = range.data;
  if (exactlyOnce) {
    const counts = new Map<string, number>();
    for (const row of data) {
      const key = rowKey(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const result = data.filter(row => counts.get(rowKey(row)) === 1);
    if (result.length === 0) return SimpleRangeValue.onlyValues([data[0].map(() => '' as CellValue)]);
    return SimpleRangeValue.onlyValues(result);
  }
  const seen = new Set<string>();
  const result: CellValue[][] = [];
  for (const row of data) {
    const key = rowKey(row);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(row);
    }
  }
  return SimpleRangeValue.onlyValues(result);
}

function uniqueColumns(range: SimpleRangeValue, exactlyOnce: boolean): SimpleRangeValue {
  const data = range.data;
  const colCount = data[0]?.length ?? 0;
  const cols: CellValue[][] = [];
  for (let c = 0; c < colCount; c++) {
    cols.push(data.map(row => row[c]));
  }
  if (exactlyOnce) {
    const counts = new Map<string, number>();
    for (const col of cols) {
      const key = rowKey(col);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const uniqueCols = cols.filter(col => counts.get(rowKey(col)) === 1);
    if (uniqueCols.length === 0) return SimpleRangeValue.onlyValues(data.map(() => ['' as CellValue]));
    const result = data.map((_: any, r: number) => uniqueCols.map(col => col[r]));
    return SimpleRangeValue.onlyValues(result);
  }
  const seen = new Set<string>();
  const uniqueCols: CellValue[][] = [];
  for (const col of cols) {
    const key = rowKey(col);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCols.push(col);
    }
  }
  const result = data.map((_: any, r: number) => uniqueCols.map(col => col[r]));
  return SimpleRangeValue.onlyValues(result);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false;

export function registerCustomFunctions() {
  if (registered) return;
  registered = true;
  HyperFormula.registerFunctionPlugin(ConcatPlugin, { enGB: { CONCAT: 'CONCAT' } });
  HyperFormula.registerFunctionPlugin(SortPlugin, { enGB: { SORT: 'SORT' } });
  HyperFormula.registerFunctionPlugin(UniquePlugin, { enGB: { UNIQUE: 'UNIQUE' } });
}
