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
  CellError,
  ErrorType,
} from 'hyperformula';
import { distributionMean, type DistributionInfo } from './distributions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type CellValue = any;

// ---------------------------------------------------------------------------
// Distribution registry — populated during HF evaluation, read by MC engine
// ---------------------------------------------------------------------------

const distRegistry = new Map<string, DistributionInfo>();

export function getDistributionRegistry(): Map<string, DistributionInfo> {
  return distRegistry;
}

export function clearDistributionRegistry(): void {
  distRegistry.clear();
}

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
    if (range.width <= 1 && range.height <= 1) return ArraySize.scalar();
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
    if (range.width <= 1 && range.height <= 1) return ArraySize.scalar();
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
  // Guard against an empty range: `data[0]` is undefined, which would throw below.
  if (data.length === 0 || (data[0]?.length ?? 0) === 0) {
    return SimpleRangeValue.onlyValues([['' as CellValue]]);
  }
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
  // Guard against an empty range: `data[0]` is undefined, which would throw below.
  if (data.length === 0 || (data[0]?.length ?? 0) === 0) {
    return SimpleRangeValue.onlyValues([['' as CellValue]]);
  }
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
// FILTER — filters rows from a range by one or more conditions
// FILTER(range, condition1, [condition2, ...])
// Overrides HyperFormula's built-in FILTER which requires identical dimensions
// for data and condition ranges. This implementation matches Google Sheets:
// conditions only need matching row count.
// ---------------------------------------------------------------------------

class FilterPlugin extends FunctionPlugin {
  static implementedFunctions = {
    'FILTER': {
      method: 'filter',
      parameters: [
        { argumentType: FunctionArgumentType.RANGE },
        { argumentType: FunctionArgumentType.RANGE },
      ],
      repeatLastArgs: 1,
      sizeOfResultArrayMethod: 'filterArraySize',
      enableArrayArithmeticForArguments: true,
    },
  };

  filter(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('FILTER'),
      (...args: any[]) => {
        const data = (args[0] as SimpleRangeValue).data;
        const rowCount = data.length;
        const colCount = data[0]?.length ?? 1;

        // Build a boolean mask: row passes if ALL conditions are truthy
        const mask = new Array(rowCount).fill(true);
        for (let ci = 1; ci < args.length; ci++) {
          const cond = args[ci] as SimpleRangeValue;
          const condData = cond.data;
          if (condData.length !== rowCount) {
            return new CellError(ErrorType.NA, 'Ranges need to be of equal length.');
          }
          for (let r = 0; r < rowCount; r++) {
            if (mask[r]) {
              const v = condData[r][0];
              if (!v || v === EmptyValue || v === 0) {
                mask[r] = false;
              }
            }
          }
        }

        const result = data.filter((_, i) => mask[i]);
        if (result.length === 0) {
          return new CellError(ErrorType.NA, 'No matches found.');
        }
        // Pad result to match input row count (predicted array size)
        const emptyRow = new Array(colCount).fill(EmptyValue);
        while (result.length < rowCount) {
          result.push([...emptyRow]);
        }
        return SimpleRangeValue.onlyValues(result);
      },
    );
  }

  filterArraySize(ast: any, state: any): ArraySize {
    if (ast.args.length < 1) return ArraySize.error();
    const range = this.arraySizeForAst(ast.args[0], state);
    if (range.width <= 1 && range.height <= 1) return ArraySize.scalar();
    return new ArraySize(range.width, range.height);
  }
}

// ---------------------------------------------------------------------------
// SPLIT — splits a string by a delimiter, returns a horizontal array
// SPLIT(text, delimiter)
// ---------------------------------------------------------------------------

class SplitPlugin extends FunctionPlugin {
  static implementedFunctions = {
    'SPLIT': {
      method: 'split',
      parameters: [
        { argumentType: FunctionArgumentType.STRING },
        { argumentType: FunctionArgumentType.STRING },
      ],
      sizeOfResultArrayMethod: 'splitArraySize',
    },
  };

  split(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('SPLIT'),
      (text: string, delimiter: string) => {
        const parts = text.split(delimiter);
        if (parts.length <= 1) return parts[0] ?? '';
        return SimpleRangeValue.onlyValues([parts]);
      },
    );
  }

  splitArraySize(ast: any, state: any): ArraySize {
    try {
      const subresult = this.evaluateAst(ast.args[0], state);
      const delimResult = this.evaluateAst(ast.args[1], state);
      if (typeof subresult === 'string' && typeof delimResult === 'string') {
        return new ArraySize(subresult.split(delimResult).length, 1);
      }
    } catch {
      // Cell values may not be computed yet during size prediction
    }
    return new ArraySize(1, 1);
  }
}

// ---------------------------------------------------------------------------
// Distribution functions — NORMAL, UNIFORM, TRIANGULAR, PERT, LOGNORMAL
// During normal HF evaluation they return analytical mean and register in
// the distribution registry.  The MC engine reads the registry to sample.
//
// Source: https://docs.getguesstimate.com/docs/functions/distributions
// ---------------------------------------------------------------------------

class DistributionPlugin extends FunctionPlugin {
  static implementedFunctions = {
    'NORMAL': {
      method: 'normal',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'UNIFORM': {
      method: 'uniform',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'TRIANGULAR': {
      method: 'triangular',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'PERT': {
      method: 'pert',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'LOGNORMAL': {
      method: 'lognormal',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'BETA': {
      method: 'betaDist',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'EXPONENTIAL': {
      method: 'exponentialDist',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'GAMMA': {
      method: 'gammaDist',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'CAUCHY': {
      method: 'cauchy',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'WEIBULL': {
      method: 'weibull',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'BERNOULLI': {
      method: 'bernoulli',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'BINOMIAL': {
      method: 'binomial',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
    'POISSON': {
      method: 'poisson',
      parameters: [
        { argumentType: FunctionArgumentType.NUMBER },
      ],
    },
  };

  private register(ast: any, state: any, info: DistributionInfo): void {
    const addr = ast.start ?? state.formulaAddress;
    if (addr) {
      distRegistry.set(`${addr.sheet}:${addr.col}:${addr.row}`, info);
    }
  }

  normal(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('NORMAL'), (mean: number, stdev: number) => {
      const info: DistributionInfo = { type: 'normal', params: [mean, stdev] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  uniform(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('UNIFORM'), (min: number, max: number) => {
      const info: DistributionInfo = { type: 'uniform', params: [min, max] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  triangular(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('TRIANGULAR'), (min: number, max: number, mode: number) => {
      const info: DistributionInfo = { type: 'triangular', params: [min, max, mode] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  pert(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('PERT'), (min: number, mode: number, max: number) => {
      const info: DistributionInfo = { type: 'pert', params: [min, mode, max] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  lognormal(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('LOGNORMAL'), (mu: number, sigma: number) => {
      const info: DistributionInfo = { type: 'lognormal', params: [mu, sigma] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  betaDist(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('BETA'), (alpha: number, beta: number) => {
      const info: DistributionInfo = { type: 'beta', params: [alpha, beta] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  exponentialDist(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('EXPONENTIAL'), (lambda: number) => {
      const info: DistributionInfo = { type: 'exponential', params: [lambda] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  gammaDist(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('GAMMA'), (k: number, theta: number) => {
      const info: DistributionInfo = { type: 'gamma', params: [k, theta] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  cauchy(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('CAUCHY'), (x0: number, g: number) => {
      const info: DistributionInfo = { type: 'cauchy', params: [x0, g] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  weibull(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('WEIBULL'), (lambda: number, k: number) => {
      const info: DistributionInfo = { type: 'weibull', params: [lambda, k] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  bernoulli(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('BERNOULLI'), (p: number) => {
      const info: DistributionInfo = { type: 'bernoulli', params: [p] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  binomial(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('BINOMIAL'), (n: number, p: number) => {
      const info: DistributionInfo = { type: 'binomial', params: [n, p] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }

  poisson(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('POISSON'), (lambda: number) => {
      const info: DistributionInfo = { type: 'poisson', params: [lambda] };
      this.register(ast, state, info);
      return distributionMean(info);
    });
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let registered = false;

export const hfConfig = {
  licenseKey: 'gpl-v3',
  dateFormats: ['MM/DD/YYYY', 'MM/DD/YY', 'YYYY/MM/DD'],
  timeFormats: ['hh:mm', 'hh:mm:ss.sss'],
  currencySymbol: ['$', 'USD'],
  localeLang: 'en-US',
  functionArgSeparator: ',',
  decimalSeparator: '.' as const,
  thousandSeparator: '' as const,
  arrayColumnSeparator: ',' as const,
  arrayRowSeparator: ';' as const,
  nullYear: 30,
  useArrayArithmetic: true,
  leapYear1900: false,
  smartRounding: true,
};

// ---------------------------------------------------------------------------
// SEARCH override — iterative array handling to avoid stack overflow.
// HyperFormula's built-in SEARCH with useArrayArithmetic recursively expands
// range arguments via resultArray, causing stack overflow on large ranges.
// This override detects range arguments and processes them iteratively,
// returning a SimpleRangeValue directly.
// ---------------------------------------------------------------------------

class SearchPlugin extends FunctionPlugin {
  static implementedFunctions = {
    'SEARCH': {
      method: 'search',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.NUMBER, optionalArg: true, defaultValue: 1 },
      ],
      // No sizeOfResultArrayMethod — returning a declared array size causes HyperFormula's
      // build phase to treat cells containing SEARCH as array formulas, which breaks
      // downstream formulas like SPLIT(IFERROR(cell,...),":"). The array expansion is
      // handled internally by _searchArray and consumed by MATCH/INDEX, so the cell
      // result is always scalar.
    },
  };

  search(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('SEARCH'),
      (findText: CellValue, withinText: CellValue, startNum: number) => {
        // If either argument is a range, process iteratively
        if (findText instanceof SimpleRangeValue || withinText instanceof SimpleRangeValue) {
          return this._searchArray(findText, withinText, startNum);
        }
        // Scalar case: standard SEARCH behavior
        return this._searchScalar(String(findText), String(withinText), startNum);
      },
    );
  }

  private _searchScalar(find: string, within: string, startNum: number): number | CellError {
    if (startNum < 1 || startNum > within.length) return new CellError(ErrorType.VALUE, 'Invalid start position.');
    const idx = within.toLowerCase().indexOf(find.toLowerCase(), startNum - 1);
    if (idx === -1) return new CellError(ErrorType.VALUE, 'Pattern not found.');
    return idx + 1; // 1-based
  }

  private _searchArray(findText: CellValue, withinText: CellValue, startNum: number): SimpleRangeValue | CellError {
    // Determine which argument is a range
    const findIsRange = findText instanceof SimpleRangeValue;
    const range = findIsRange ? findText as SimpleRangeValue : withinText as SimpleRangeValue;
    const scalar = findIsRange ? String(withinText) : String(findText);
    const data = range.data;

    const result: CellValue[][] = [];
    for (let r = 0; r < data.length; r++) {
      const row: CellValue[] = [];
      for (let c = 0; c < data[r].length; c++) {
        const cell = data[r][c];
        if (cell === EmptyValue || cell == null || cell instanceof CellError) {
          row.push(new CellError(ErrorType.VALUE, 'Pattern not found.'));
        } else {
          const find = findIsRange ? String(cell) : scalar;
          const within = findIsRange ? scalar : String(cell);
          row.push(this._searchScalar(find, within, startNum));
        }
      }
      result.push(row);
    }
    return SimpleRangeValue.onlyValues(result);
  }

}

// ---------------------------------------------------------------------------
// TEXT — override HyperFormula's built-in TEXT() to properly handle Excel date
// format codes (e.g., "MMM D", "YYYY", "MM/DD/YY").
// ---------------------------------------------------------------------------

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Convert Excel serial number to JS Date (Excel epoch: Jan 0, 1900, with the Lotus 1-2-3 leap year bug). */
function serialToDate(serial: number): Date {
  // Excel serial 1 = Jan 1 1900, but serial 60 = Feb 29 1900 (doesn't exist)
  const adjusted = serial > 60 ? serial - 1 : serial;
  const ms = (adjusted - 1) * 86400000;
  return new Date(Date.UTC(1900, 0, 1) + ms);
}

function applyDateFormat(date: Date, fmt: string): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based
  const d = date.getUTCDate();
  const dow = date.getUTCDay();
  const h = date.getUTCHours();
  const min = date.getUTCMinutes();
  const sec = date.getUTCSeconds();

  let result = fmt;
  // Order matters: replace longer tokens first

  // Year
  result = result.replace(/yyyy/gi, String(y));
  result = result.replace(/yy/gi, String(y).slice(-2));

  // Month: mmmm, mmm, mm, m (but not within 'h:mm' — use context to distinguish)
  // Excel uses 'm' for both month and minute; context: after 'h' or ':' it's minutes
  // Simple heuristic: replace month tokens that aren't preceded by 'h' or ':'
  result = result.replace(/mmmm/gi, MONTH_FULL[m]);
  result = result.replace(/mmm/gi, MONTH_ABBR[m]);
  // For mm and m: distinguish from minutes by checking if preceded by h or :
  result = result.replace(/(?<![h:])\bmm\b(?!:)/gi, String(m + 1).padStart(2, '0'));
  result = result.replace(/(?<![h:])\bm\b(?!m)(?!:)/gi, String(m + 1));

  // Day
  result = result.replace(/dddd/gi, DAY_FULL[dow]);
  result = result.replace(/ddd/gi, DAY_ABBR[dow]);
  result = result.replace(/\bdd\b/gi, String(d).padStart(2, '0'));
  result = result.replace(/\bd\b/gi, String(d));

  // Hours
  result = result.replace(/\bhh\b/gi, String(h).padStart(2, '0'));
  result = result.replace(/\bh\b/gi, String(h));

  // Minutes (after h: or :)
  result = result.replace(/(?<=h|:)mm/gi, String(min).padStart(2, '0'));
  result = result.replace(/(?<=h|:)m\b/gi, String(min));

  // Seconds
  result = result.replace(/\bss\b/gi, String(sec).padStart(2, '0'));
  result = result.replace(/\bs\b/gi, String(sec));

  return result;
}

function applyNumberFormat(num: number, fmt: string): string {
  const absNum = Math.abs(num);
  // Strip color codes, padding, repeats
  let section = fmt.replace(/\[[A-Za-z]+\]/g, '').replace(/_./g, '').replace(/\*./g, '').replace(/"([^"]*)"/g, '$1');
  const hasParen = section.includes('(') && section.includes(')');
  const hasDollar = section.includes('$');
  const hasComma = /[#0],/.test(section) || /,[#0]/.test(section);
  const hasPercent = section.includes('%');
  const decimalMatch = section.match(/\.([0#?]+)/);
  const decimals = decimalMatch ? decimalMatch[1].length : 0;

  let val = hasPercent ? absNum * 100 : absNum;
  let formatted = hasComma
    ? val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : val.toFixed(decimals);
  if (hasDollar) formatted = '$' + formatted;
  if (num < 0 && hasParen) formatted = '(' + formatted + ')';
  else if (num < 0) formatted = '-' + formatted;
  if (hasPercent) formatted += '%';
  return formatted;
}

class TextPlugin extends FunctionPlugin {
  static implementedFunctions = {
    'TEXT': {
      method: 'text',
      parameters: [
        { argumentType: FunctionArgumentType.ANY },
        { argumentType: FunctionArgumentType.STRING },
      ],
    },
  };

  text(ast: any, state: any) {
    return this.runFunction(ast.args, state, this.metadata('TEXT'),
      (value: CellValue, formatStr: string) => {
        if (value instanceof CellError) return value;
        const num = Number(value);
        if (isNaN(num)) return String(value);

        // Check if format string looks like a date format
        const isDateFmt = /[ymdhs]/i.test(formatStr) && /[ymd]/i.test(formatStr);
        if (isDateFmt && num > 0) {
          const date = serialToDate(num);
          return applyDateFormat(date, formatStr);
        }

        return applyNumberFormat(num, formatStr);
      },
    );
  }
}

export function addGoogleSheetsNamedExpressions(hf: HyperFormula) {
  hf.addNamedExpression('TRUE', '=TRUE()');
  hf.addNamedExpression('FALSE', '=FALSE()');
}

export function registerCustomFunctions() {
  if (registered) return;
  registered = true;
  HyperFormula.registerFunctionPlugin(ConcatPlugin, { enGB: { CONCAT: 'CONCAT' } });
  HyperFormula.registerFunctionPlugin(SortPlugin, { enGB: { SORT: 'SORT' } });
  HyperFormula.registerFunctionPlugin(UniquePlugin, { enGB: { UNIQUE: 'UNIQUE' } });
  HyperFormula.registerFunctionPlugin(SplitPlugin, { enGB: { SPLIT: 'SPLIT' } });
  try { HyperFormula.unregisterFunction('FILTER'); } catch { /* may be protected */ }
  HyperFormula.registerFunctionPlugin(FilterPlugin, { enGB: { FILTER: 'FILTER' } });
  try { HyperFormula.unregisterFunction('SEARCH'); } catch { /* may be protected */ }
  HyperFormula.registerFunctionPlugin(SearchPlugin, { enGB: { SEARCH: 'SEARCH' } });
  try { HyperFormula.unregisterFunction('TEXT'); } catch { /* may be protected */ }
  HyperFormula.registerFunctionPlugin(TextPlugin, { enGB: { TEXT: 'TEXT' } });
  HyperFormula.registerFunctionPlugin(DistributionPlugin, {
    enGB: {
      NORMAL: 'NORMAL', UNIFORM: 'UNIFORM', TRIANGULAR: 'TRIANGULAR', PERT: 'PERT', LOGNORMAL: 'LOGNORMAL',
      BETA: 'BETA', EXPONENTIAL: 'EXPONENTIAL', GAMMA: 'GAMMA', CAUCHY: 'CAUCHY', WEIBULL: 'WEIBULL',
      BERNOULLI: 'BERNOULLI', BINOMIAL: 'BINOMIAL', POISSON: 'POISSON',
    },
  });
}
