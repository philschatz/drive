/**
 * Pure helpers for the HyperFormula worker (incremental-update diffing and the
 * Monte-Carlo work budget).
 *
 * Kept UI/worker-free so they can be unit-tested (hf-worker.ts installs a
 * `self.onmessage` handler at import time and can't be loaded in a plain test).
 */

export interface SheetShape {
  name: string;
  rows: string[];
  cols: string[];
  cells: Record<string, { value: string }>;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True when the change between `prev` and `next` is STRUCTURAL — the sheet name
 * or the row/column identity/order changed (or there is no prior snapshot). A
 * structural change requires a full HyperFormula rebuild; anything else can be
 * applied incrementally via setCellContents.
 */
export function sheetStructureChanged(prev: SheetShape | null | undefined, next: SheetShape): boolean {
  if (!prev) return true;
  if (prev.name !== next.name) return true;
  if (!sameOrder(prev.rows, next.rows)) return true;
  if (!sameOrder(prev.cols, next.cols)) return true;
  return false;
}

/**
 * List of "rowId:colId" cell keys whose value differs between `prev` and `next`
 * (added, removed, or changed). Callers must have already confirmed the sheet
 * structure is unchanged (see sheetStructureChanged).
 */
export function changedCellKeys(prev: SheetShape, next: SheetShape): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(prev.cells), ...Object.keys(next.cells)]);
  for (const k of keys) {
    const a = prev.cells[k]?.value;
    const b = next.cells[k]?.value;
    if (a !== b) changed.push(k);
  }
  return changed;
}

// --- Monte-Carlo work budget (H9) ---

export interface McBudgetCaps {
  /** Max cells tracked per iteration. */
  maxSampledCells: number;
  /** Max total (cells × iterations) of Monte-Carlo work. */
  maxTotalSamples: number;
}

export interface McBudgetPlan {
  /** Number of cells to sample per iteration (≤ total). */
  sampledCells: number;
  /** Number of iterations to run (≤ requested). */
  iterations: number;
  cellsTruncated: boolean;
  iterationsReduced: boolean;
}

/**
 * Bound Monte-Carlo work so a hostile distribution function in a large sheet can't
 * pin the worker: cap the sampled-cell count, then cap total work (cells × iterations)
 * by reducing iterations. Pure so the caps are unit-testable.
 */
export function planMonteCarloBudget(
  totalCells: number,
  requestedIterations: number,
  caps: McBudgetCaps,
): McBudgetPlan {
  let sampledCells = totalCells;
  let cellsTruncated = false;
  if (sampledCells > caps.maxSampledCells) {
    sampledCells = caps.maxSampledCells;
    cellsTruncated = true;
  }
  let iterations = requestedIterations;
  let iterationsReduced = false;
  if (sampledCells * iterations > caps.maxTotalSamples) {
    iterations = Math.max(1, Math.floor(caps.maxTotalSamples / Math.max(1, sampledCells)));
    iterationsReduced = true;
  }
  return { sampledCells, iterations, cellsTruncated, iterationsReduced };
}
