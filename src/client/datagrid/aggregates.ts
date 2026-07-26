/**
 * Selection aggregates for the bottom editor bar (Sum / Avg / Min / Max /
 * Count over the numeric cells of a multi-cell selection).
 * Pure — Jest-testable without the DOM.
 */

export interface SelectionCell {
  /** Effective display value (computed value for formulas), pre-numFmt. */
  display: string;
  /** The cell's resolved number format, if any. */
  numFmt?: string;
}

export interface SelectionAggregates {
  sum: number;
  avg: number;
  min: number;
  max: number;
  /** Number of numeric cells in the selection. */
  count: number;
  /**
   * The shared number format — set only when every numeric cell has the same
   * (defined) numFmt, so the aggregate values can be rendered the same way
   * (e.g. all currency ⇒ currency-formatted sum).
   */
  numFmt?: string;
}

/**
 * Returns null when the selection has fewer than two cells or contains no
 * numeric values (nothing worth aggregating).
 */
export function computeSelectionAggregates(cells: SelectionCell[]): SelectionAggregates | null {
  if (cells.length < 2) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  let numFmt: string | undefined;
  let sharedFmt = true;
  for (const cell of cells) {
    const text = cell.display.trim();
    if (text === '') continue;
    const n = Number(text);
    if (isNaN(n)) continue;
    sum += n;
    if (n < min) min = n;
    if (n > max) max = n;
    if (count === 0) numFmt = cell.numFmt;
    else if (cell.numFmt !== numFmt) sharedFmt = false;
    count++;
  }
  if (count === 0) return null;
  return {
    sum,
    avg: sum / count,
    min,
    max,
    count,
    numFmt: sharedFmt ? numFmt : undefined,
  };
}
