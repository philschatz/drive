/**
 * HyperFormula evaluation worker.
 *
 * Owns a persistent HyperFormula instance. Communicates with the automerge
 * worker via a MessageChannel port using the standard subscribe-query protocol.
 * Only subscribes to formula cells on the active sheet and their transitive
 * cross-sheet dependencies.
 */

import HyperFormula, { CellValueDetailedType } from 'hyperformula';
import { registerCustomFunctions, getDistributionRegistry, clearDistributionRegistry, hfConfig, addGoogleSheetsNamedExpressions } from './hf-functions';
import { buildSheetData, cellToHfValue, sortedEntries, internalToA1, a1ToInternal } from './helpers';
import { runMonteCarlo, type MCResults } from './monte-carlo';
import { sampleDistribution, computeStats, type DistributionInfo, type DistributionStats } from './distributions';
import { sheetStructureChanged, changedCellKeys, planMonteCarloBudget } from './hf-diff';
import { parseInternal, extractCellRefs, type FormulaAST, type CellRef } from './formula-parser';

registerCustomFunctions();

// --- Untrusted-content work caps (H9) ---
// A hostile shared sheet can contain a distribution function (=NORMAL(0,1)) or a
// customFormula conditional-format rule over a huge range; without caps these pin
// the worker. Caps bound the work and log (never silently drop) when they truncate.
const MC_SAMPLES = 500;
const MC_MAX_SAMPLED_CELLS = 2000;       // max cells tracked per Monte-Carlo iteration
const MC_MAX_TOTAL_SAMPLES = 400_000;    // max (cells × iterations) of Monte-Carlo work
const MC_MAX_DIST_CELLS = 500;           // max distinct distribution source cells
const COND_FORMAT_MAX_CELLS = 20_000;    // max cells evaluated across all customFormula rules

// --- Types ---

interface SheetInfo {
  name: string;
  rows: string[];
  cols: string[];
  cells: Record<string, { value: string }>;
}

interface CondFormatRuleMsg {
  id: string;
  conditionType: string;
  conditionValue?: string;
  ranges: { rangeRowStart: string; rangeRowEnd: string; rangeColStart: string; rangeColEnd: string }[];
}

type MainToHf =
  | { type: 'init'; port: MessagePort }
  | { type: 'watch'; docId: string; activeSheet: string }
  | { type: 'switch-sheet'; sheetId: string }
  | { type: 'unwatch' }
  | { type: 'set-cell'; sheetId: string; rowId: string; colId: string; value: string }
  | { type: 'eval-cond-formats'; rules: CondFormatRuleMsg[] };

// --- State ---

let port: MessagePort | null = null;
let hf: HyperFormula | null = null;
let docId = '';
let activeSheetId = '';

// Subscription IDs for the two automerge-worker queries
let formulaSubId = 0;
let depsSubId = 0;
let nextSubId = 1;

// Cached data from subscription 1 (formula cells on active sheet)
let formulaData: SheetInfo | null = null;

// Cached data from subscription 2 (dependency cells, any sheet)
const depsData = new Map<string, SheetInfo>();

// Set of dependency cell keys we're currently subscribed to,
// grouped by sheetId: Map<sheetId, Set<"rowId:colId">>
const depCells = new Map<string, Set<string>>();

// Cached conditional format rules with customFormula
let pendingCondFormatRules: CondFormatRuleMsg[] = [];

/** Merge formula cells and dep cells into a unified view per sheet. */
function getMergedSheetData(): Map<string, SheetInfo> {
  const merged = new Map<string, SheetInfo>();

  // Start with formula data for the active sheet
  if (formulaData) {
    merged.set(activeSheetId, { ...formulaData, cells: { ...formulaData.cells } });
  }

  // Overlay dep cells
  for (const [sid, depInfo] of depsData) {
    const existing = merged.get(sid);
    if (existing) {
      // Merge dep cells into existing sheet (formula cells + dep cells)
      for (const [key, cell] of Object.entries(depInfo.cells)) {
        if (cell) existing.cells[key] = cell;
      }
    } else {
      merged.set(sid, { ...depInfo, cells: { ...depInfo.cells } });
    }
  }

  return merged;
}

// --- Helpers ---

/** Format a HyperFormula cell value, converting date/time serial numbers to strings. */
function formatCellValue(addr: { sheet: number; col: number; row: number }): { value: string | number | null; errorMessage?: string } {
  const computed = hf!.getCellValue(addr);
  if (computed == null) return { value: '' };
  if (typeof computed === 'object' && 'value' in computed) {
    return { value: String(computed.value), errorMessage: (computed as any).message || undefined };
  }
  if (typeof computed === 'number') {
    const detailedType = hf!.getCellValueDetailedType(addr);
    if (detailedType === CellValueDetailedType.NUMBER_DATE) {
      const d = hf!.numberToDate(computed) as { year: number; month: number; day: number };
      return { value: `${String(d.month).padStart(2, '0')}/${String(d.day).padStart(2, '0')}/${d.year}` };
    }
    if (detailedType === CellValueDetailedType.NUMBER_DATETIME) {
      const dt = hf!.numberToDateTime(computed) as { year: number; month: number; day: number; hours: number; minutes: number; seconds: number };
      return { value: `${String(dt.month).padStart(2, '0')}/${String(dt.day).padStart(2, '0')}/${dt.year} ${String(dt.hours).padStart(2, '0')}:${String(dt.minutes).padStart(2, '0')}` };
    }
    if (detailedType === CellValueDetailedType.NUMBER_TIME) {
      const t = hf!.numberToTime(computed) as { hours: number; minutes: number; seconds: number };
      return { value: `${String(t.hours).padStart(2, '0')}:${String(t.minutes).padStart(2, '0')}:${String(Math.round(t.seconds)).padStart(2, '0')}` };
    }
    return { value: computed };
  }
  if (typeof computed === 'string') return { value: computed };
  return { value: String(computed) };
}

/** Extract all cell refs from an internal-format formula, grouped by sheet ID.
 *  Parses the formula with the real parser, so ref-shaped text inside string
 *  literals is ignored. An unparseable formula yields no refs. */
function extractRefs(formula: string, currentSheetId: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();

  let ast: FormulaAST;
  try {
    ast = parseInternal(formula);
  } catch {
    return refs;
  }

  const addRef = (ref: CellRef) => {
    if (ref.row.id === '*' || ref.col.id === '*') {
      // Whole-row/column ref: no specific cell IDs, but a cross-sheet one
      // (S{sheetId} part) still pins the sheet dependency.
      if (ref.sheet && !refs.has(ref.sheet.id)) refs.set(ref.sheet.id, new Set());
      return;
    }
    const sheetId = ref.sheet?.id ?? currentSheetId;
    if (!refs.has(sheetId)) refs.set(sheetId, new Set());
    refs.get(sheetId)!.add(`${ref.row.id}:${ref.col.id}`);
  };

  for (const node of extractCellRefs(ast)) {
    if (node.type === 'range') {
      addRef(node.from);
      addRef(node.to);
    } else {
      addRef(node);
    }
  }

  return refs;
}

/** Build the jq query for all cells on the active sheet. */
function buildFormulaQuery(sheetId: string): string {
  // Returns all cells (not just formulas) because HyperFormula needs input values
  // that formulas reference. Cross-sheet deps are handled by subscription 2.
  return `.sheets["${sheetId}"] | { name, rows: (.rows | to_entries | sort_by(.value.index) | map(.key)), cols: (.columns | to_entries | sort_by(.value.index) | map(.key)), cells }`;
}

/** Build a jq query for cross-sheet dependency cells.
 *  Fetches ALL cells for each dependency sheet because extractRefs only captures
 *  range endpoints, but HyperFormula needs every cell within a range (e.g. SUMIFS). */
function buildDepsQuery(deps: Map<string, Set<string>>): string | null {
  if (deps.size === 0) return null;
  const parts: string[] = [];
  for (const [sheetId] of deps) {
    if (sheetId === activeSheetId) continue; // active sheet cells are in subscription 1
    parts.push(`"${sheetId}": (.sheets["${sheetId}"] | { name, rows: (.rows | to_entries | sort_by(.value.index) | map(.key)), cols: (.columns | to_entries | sort_by(.value.index) | map(.key)), cells })`);
  }
  if (parts.length === 0) return null;
  return `{ ${parts.join(', ')} }`;
}

/** Subscribe to a jq query on the automerge worker via the port. */
function subscribe(filter: string): number {
  const subId = nextSubId++;
  port!.postMessage({ type: 'subscribe-query', subId, docId, filter });
  return subId;
}

function unsubscribe(subId: number) {
  if (subId && port) {
    port.postMessage({ type: 'unsubscribe-query', subId });
  }
}

// HF sheet index i ↔ document sheetId. Set on every full rebuild; stays valid
// across incremental (non-structural) updates so evaluateAndPost can map results.
let sheetOrder: string[] = [];

const sheetNameLookupFor = (merged: Map<string, SheetInfo>) => (id: string) => merged.get(id)?.name;
const sheetRowColLookupFor = (merged: Map<string, SheetInfo>) => (id: string) => {
  const s = merged.get(id);
  if (!s) return undefined;
  return { rowIds: s.rows, colIds: s.cols };
};

/**
 * Full rebuild: destroy + buildFromSheets (re-parses EVERY formula). Only needed
 * for structural changes (row/col set, sheet set, cross-sheet deps). Plain cell
 * value edits use the incremental path (applyIncrementalCells) instead — H6.
 */
function buildWorkbook(): boolean {
  if (!formulaData && depsData.size === 0) return false;
  const merged = getMergedSheetData();
  if (merged.size === 0) return false;

  const sheetsHfData: Record<string, (string | number | boolean | null)[][]> = {};
  const order: string[] = [];
  const sheetNameLookup = sheetNameLookupFor(merged);
  const sheetRowColLookup = sheetRowColLookupFor(merged);

  // Active sheet first, then deps
  const activeInfo = merged.get(activeSheetId);
  if (activeInfo) {
    sheetsHfData[activeInfo.name] = buildSheetData(
      activeInfo.cells, activeInfo.rows, activeInfo.cols,
      sheetNameLookup, sheetRowColLookup,
    );
    order.push(activeSheetId);
  }
  for (const [sid, info] of merged) {
    if (sid === activeSheetId) continue;
    sheetsHfData[info.name] = buildSheetData(
      info.cells, info.rows, info.cols,
      sheetNameLookup, sheetRowColLookup,
    );
    order.push(sid);
  }

  hf?.destroy();
  clearDistributionRegistry();
  hf = HyperFormula.buildFromSheets(sheetsHfData, hfConfig);
  addGoogleSheetsNamedExpressions(hf);
  sheetOrder = order;

  // Work around HyperFormula's build-phase array analysis: formulas containing
  // SEARCH with range arguments get marked as array formulas, causing downstream
  // cells (e.g. SPLIT) to receive ranges instead of scalars. Re-setting error
  // cells forces HF to re-evaluate without the stale array marking.
  const errorAddrs: { sheet: number; col: number; row: number; formula: string }[] = [];
  for (let si = 0; si < order.length; si++) {
    const info = merged.get(order[si])!;
    for (let row = 0; row < info.rows.length; row++) {
      for (let col = 0; col < info.cols.length; col++) {
        const addr = { sheet: si, col, row };
        const val = hf.getCellValue(addr);
        if (typeof val === 'object' && val && 'type' in val && val.type === 'VALUE') {
          const formula = hf.getCellFormula(addr);
          if (formula) errorAddrs.push({ ...addr, formula });
        }
      }
    }
  }
  if (errorAddrs.length > 0) {
    hf.suspendEvaluation();
    for (const { sheet, col, row, formula } of errorAddrs) {
      hf.setCellContents({ sheet, col, row }, formula);
    }
    hf.resumeEvaluation();
  }

  return true;
}

/**
 * Apply cell-value changes to the existing HyperFormula instance via the
 * incremental setCellContents API (no destroy/rebuild → no full re-parse). All
 * changes must target the given already-built sheet. Returns false if any change
 * can't be resolved to a known HF address, so the caller can fall back to rebuild.
 */
function applyIncrementalCells(sheetId: string, cellKeys: string[]): boolean {
  if (!hf || cellKeys.length === 0) return !!hf;
  const merged = getMergedSheetData();
  const info = merged.get(sheetId);
  if (!info) return false;
  const sheetNum = hf.getSheetId(info.name);
  if (sheetNum === undefined) return false;
  const rowIdx = new Map(info.rows.map((id, i) => [id, i]));
  const colIdx = new Map(info.cols.map((id, i) => [id, i]));
  const sheetNameLookup = sheetNameLookupFor(merged);
  const sheetRowColLookup = sheetRowColLookupFor(merged);

  let ok = true;
  hf.suspendEvaluation();
  try {
    for (const key of cellKeys) {
      const sep = key.indexOf(':');
      const rowId = key.slice(0, sep);
      const colId = key.slice(sep + 1);
      const r = rowIdx.get(rowId);
      const c = colIdx.get(colId);
      if (r === undefined || c === undefined) { ok = false; break; }
      const raw = info.cells[key]?.value;
      const val = cellToHfValue(raw, r, c, info.rows, info.cols, sheetNameLookup, sheetRowColLookup);
      hf.setCellContents({ sheet: sheetNum, col: c, row: r }, val);
    }
  } finally {
    hf.resumeEvaluation();
  }
  return ok;
}

/**
 * Re-read every formula/spill cell from the current HF instance and post results.
 * Cheap relative to a rebuild (reads, no parsing). Monte Carlo is only run on a
 * full rebuild (runMC=true) because its distribution registry is populated during
 * the full evaluation pass.
 */
function evaluateAndPost(runMC: boolean) {
  if (!hf) return;
  const merged = getMergedSheetData();

  // Evaluate all formula cells and collect results
  const values: Record<string, string | number> = {};
  const errors: Record<string, string> = {};
  for (let si = 0; si < sheetOrder.length; si++) {
    const sid = sheetOrder[si];
    const info = merged.get(sid);
    if (!info) continue;
    for (let row = 0; row < info.rows.length; row++) {
      for (let col = 0; col < info.cols.length; col++) {
        const cellKey = `${info.rows[row]}:${info.cols[col]}`;
        const cell = info.cells[cellKey];
        if (cell?.value?.startsWith('=')) {
          const { value: computed, errorMessage } = formatCellValue({ sheet: si, col, row });
          if (computed != null) {
            const fullKey = `${sid}:${cellKey}`;
            values[fullKey] = computed;
            if (errorMessage) errors[fullKey] = errorMessage;
          }
        }
      }
    }
  }

  // Detect spill targets (cells that receive array formula results).
  // Use HF's sheet dimensions since spilling can expand the grid beyond the document's row/col count.
  const spillTargetKeys: string[] = [];
  for (let si = 0; si < sheetOrder.length; si++) {
    const sid = sheetOrder[si];
    const info = merged.get(sid);
    if (!info) continue;
    const { width, height } = hf.getSheetDimensions(si);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        // Skip cells within document bounds that have formulas (already handled)
        if (row < info.rows.length && col < info.cols.length) {
          const cell = info.cells[`${info.rows[row]}:${info.cols[col]}`];
          if (cell?.value?.startsWith('=')) continue;
        }
        const cellType = hf.getCellType({ sheet: si, col, row });
        if (cellType === 'ARRAY') {
          // Map HF indices back to document IDs; skip if beyond document grid
          if (row >= info.rows.length || col >= info.cols.length) continue;
          const { value: computed, errorMessage } = formatCellValue({ sheet: si, col, row });
          if (computed != null) {
            const cellKey = `${info.rows[row]}:${info.cols[col]}`;
            const key = `${sid}:${cellKey}`;
            values[key] = computed;
            if (errorMessage) errors[key] = errorMessage;
            spillTargetKeys.push(key);
          }
        }
      }
    }
  }

  (self as any).postMessage({ type: 'computed-values', values, spillTargets: spillTargetKeys, errors });

  // Evaluate conditional format custom formulas
  if (pendingCondFormatRules.length > 0) {
    const activeInfo = merged.get(activeSheetId);
    if (activeInfo) evaluateCondFormats(activeInfo);
  }

  // Auto-run Monte Carlo only after a full rebuild (registry is populated then).
  if (runMC) {
    const registry = getDistributionRegistry();
    if (registry.size > 0) maybeRunMonteCarlo(merged, registry);
  }
}

/** Full rebuild + evaluate. Use for structural changes and initial load. */
function rebuildAndEvaluate() {
  if (!buildWorkbook()) return;
  evaluateAndPost(true);
}

/** Gate/budget Monte Carlo auto-run so hostile distribution content can't pin the worker (H9). */
function maybeRunMonteCarlo(merged: Map<string, SheetInfo>, registry: Map<string, DistributionInfo>) {
  if (registry.size > MC_MAX_DIST_CELLS) {
    console.warn(`[hf-worker] Monte Carlo skipped: ${registry.size} distribution cells exceeds cap ${MC_MAX_DIST_CELLS}`);
    return;
  }
  runMCInWorker(sheetOrder, merged, registry);
}

/**
 * Evaluate conditional format rules that use customFormula.
 * For each cell in the rule's range, evaluates the formula relative to that cell
 * using the already-built HyperFormula instance.
 */
function evaluateCondFormats(activeInfo: SheetInfo) {
  if (!hf || pendingCondFormatRules.length === 0) return;

  const rows = activeInfo.rows;
  const cols = activeInfo.cols;

  // Build lookup maps
  const rowIdxMap = new Map<string, number>();
  rows.forEach((id, i) => rowIdxMap.set(id, i));
  const colIdxMap = new Map<string, number>();
  cols.forEach((id, i) => colIdxMap.set(id, i));

  // results: ruleId -> list of matching "rowId:colId" keys
  const results: Record<string, string[]> = {};

  // Use a temporary cell position: one row beyond the sheet grid in sheet 0
  const tmpRow = rows.length;
  const tmpCol = 0;
  // Ensure HF has room for the temp cell by adding a row
  hf.addRows(0, [tmpRow, 1]);

  // H9: cap the total cells evaluated across all customFormula rules. A hostile
  // rule over a huge range would otherwise parse+set+eval per cell with no bound.
  let budget = COND_FORMAT_MAX_CELLS;
  let truncated = false;

  outer:
  for (const rule of pendingCondFormatRules) {
    if (rule.conditionType !== 'customFormula' || !rule.conditionValue) continue;

    const formula = rule.conditionValue; // R1C1 (relative to each target cell)
    const matches: string[] = [];

    for (const range of rule.ranges) {
      const rStart = rowIdxMap.get(range.rangeRowStart);
      const rEnd = rowIdxMap.get(range.rangeRowEnd);
      const cStart = colIdxMap.get(range.rangeColStart);
      const cEnd = colIdxMap.get(range.rangeColEnd);
      if (rStart === undefined || rEnd === undefined || cStart === undefined || cEnd === undefined) continue;

      for (let r = rStart; r <= rEnd; r++) {
        for (let c = cStart; c <= cEnd; c++) {
          if (budget <= 0) { truncated = true; results[rule.id] = matches; break outer; }
          budget--;
          // Re-anchor R1C1 offsets to this cell, then serialize to A1 for HyperFormula.
          // a1ToInternal parses R1C1 with (r, c) as anchor so R[0]C[0] resolves to the
          // current cell; internalToA1 produces the absolute A1 address to evaluate.
          const canonical = a1ToInternal(formula, r, c, rows, cols);
          const a1Formula = internalToA1(canonical, r, c, rows, cols, undefined, undefined, true);
          try {
            hf.setCellContents({ sheet: 0, col: tmpCol, row: tmpRow }, a1Formula);
            const val = hf.getCellValue({ sheet: 0, col: tmpCol, row: tmpRow });
            // Truthy check: true, non-zero number, non-empty string
            const truthy = val === true || (typeof val === 'number' && val !== 0) || (typeof val === 'string' && val !== '');
            if (truthy) {
              matches.push(`${rows[r]}:${cols[c]}`);
            }
          } catch {
            // Formula evaluation failed for this cell — skip
          }
        }
      }
    }

    results[rule.id] = matches;
  }

  if (truncated) {
    console.warn(`[hf-worker] Conditional formatting: customFormula evaluation truncated at ${COND_FORMAT_MAX_CELLS} cells`);
  }

  // Clear the temp row
  try { hf.removeRows(0, [tmpRow, 1]); } catch { /* ok */ }

  (self as any).postMessage({ type: 'cond-format-results', results });
}

function runMCInWorker(sheetOrder: string[], mergedData: Map<string, SheetInfo>, registry: Map<string, DistributionInfo>) {
  if (!hf || registry.size === 0) return;

  const distCells: { sheet: number; col: number; row: number; info: DistributionInfo; key: string }[] = [];
  for (const [key, info] of registry) {
    const parts = key.split(':');
    distCells.push({ sheet: Number(parts[0]), col: Number(parts[1]), row: Number(parts[2]), info, key });
  }

  // Save original contents
  const originalContents = distCells.map(dc =>
    hf!.getCellSerialized({ sheet: dc.sheet, col: dc.col, row: dc.row })
  );

  const sheetNames = hf.getSheetNames();
  let allCellKeys: string[] = [];
  for (let si = 0; si < sheetNames.length; si++) {
    const { height, width } = hf.getSheetDimensions(si);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        allCellKeys.push(`${si}:${c}:${r}`);
      }
    }
  }

  // H9: bound Monte-Carlo work so a distribution in a huge sheet can't pin the worker.
  const totalCells = allCellKeys.length;
  const budget = planMonteCarloBudget(totalCells, MC_SAMPLES, {
    maxSampledCells: MC_MAX_SAMPLED_CELLS,
    maxTotalSamples: MC_MAX_TOTAL_SAMPLES,
  });
  if (budget.cellsTruncated) {
    // Always keep the distribution source cells; truncate the rest.
    const sourceKeySet = new Set(distCells.map(dc => `${dc.sheet}:${dc.col}:${dc.row}`));
    const sourceCells = allCellKeys.filter(k => sourceKeySet.has(k));
    const others = allCellKeys.filter(k => !sourceKeySet.has(k))
      .slice(0, Math.max(0, budget.sampledCells - sourceCells.length));
    console.warn(`[hf-worker] Monte Carlo: sampling ${sourceCells.length + others.length} of ${totalCells} cells (capped at ${MC_MAX_SAMPLED_CELLS})`);
    allCellKeys = [...sourceCells, ...others];
  }
  const iterations = budget.iterations;
  if (budget.iterationsReduced) {
    console.warn(`[hf-worker] Monte Carlo: reduced to ${iterations} iterations (cell×iteration budget ${MC_MAX_TOTAL_SAMPLES})`);
  }

  const allSamples = new Map<string, number[]>();

  for (let iter = 0; iter < iterations; iter++) {
    // Replace distribution cells with sampled values
    for (const dc of distCells) {
      hf!.setCellContents({ sheet: dc.sheet, col: dc.col, row: dc.row }, [[sampleDistribution(dc.info)]]);
    }
    // Read all cell values
    for (const cellKey of allCellKeys) {
      const [si, c, r] = cellKey.split(':').map(Number);
      const val = hf!.getCellValue({ sheet: si, col: c, row: r });
      if (typeof val === 'number') {
        if (!allSamples.has(cellKey)) allSamples.set(cellKey, []);
        allSamples.get(cellKey)!.push(val);
      }
    }
  }

  // Restore original contents
  for (let i = 0; i < distCells.length; i++) {
    const dc = distCells[i];
    hf!.setCellContents({ sheet: dc.sheet, col: dc.col, row: dc.row }, [[originalContents[i]]]);
  }

  // Compute stats and convert keys from HF indices to sheetId:rowId:colId
  const sources = new Set(distCells.map(dc => dc.key));
  const cells: [string, DistributionStats][] = [];
  const sourceKeys: string[] = [];

  for (const [key, samples] of allSamples) {
    if (samples.length < iterations * 0.5) continue;
    const stats = computeStats(samples);
    if (sources.has(key) || stats.stdev > 1e-10) {
      // Convert numeric key "si:c:r" to "sheetId:rowId:colId"
      const [si, c, r] = key.split(':').map(Number);
      const sid = sheetOrder[si];
      const info = sid ? mergedData.get(sid) : undefined;
      if (info && r < info.rows.length && c < info.cols.length) {
        const idKey = `${sid}:${info.rows[r]}:${info.cols[c]}`;
        cells.push([idKey, stats]);
        if (sources.has(key)) sourceKeys.push(idKey);
      }
    }
  }

  (self as any).postMessage({ type: 'mc-results', cells, sources: sourceKeys });
}

/** Resolve transitive cross-sheet dependencies and update subscription 2.
 *  Returns true when the set of dependency sheets changed (a structural change
 *  that forces a full rebuild once the new deps arrive). */
function resolveDeps(): boolean {
  const newDepSheets = new Set<string>();

  // Scan all formula cells in all loaded sheets for cross-sheet refs
  const merged = getMergedSheetData();
  for (const [sid, info] of merged) {
    for (const [, cell] of Object.entries(info.cells)) {
      if (cell?.value?.startsWith('=')) {
        const refs = extractRefs(cell.value, sid);
        for (const refSheet of refs.keys()) {
          if (refSheet !== activeSheetId) newDepSheets.add(refSheet);
        }
      }
    }
  }

  // Check if set of dependency sheets changed
  let changed = newDepSheets.size !== depCells.size;
  if (!changed) {
    for (const sid of newDepSheets) {
      if (!depCells.has(sid)) { changed = true; break; }
    }
  }

  if (changed) {
    depCells.clear();
    for (const sid of newDepSheets) depCells.set(sid, new Set());
    // Resubscribe
    unsubscribe(depsSubId);
    depsSubId = 0;
    const query = buildDepsQuery(depCells);
    if (query) {
      depsSubId = subscribe(query);
    }
  }

  return changed;
}

// --- Port message handler (from automerge worker) ---

function handlePortMessage(e: MessageEvent) {
  const msg = e.data;
  if (msg.type !== 'query-result') return;

  if (msg.subId === formulaSubId) {
    // Active sheet formula cells
    if (msg.error || !msg.result) return;
    const prev = formulaData;
    const next = msg.result as SheetInfo;
    formulaData = next;
    const depsChanged = resolveDeps();
    // Structural change (or new deps, or no HF yet) → full rebuild. Otherwise apply
    // only the changed cells incrementally so a plain value edit doesn't re-parse the
    // whole workbook (H6). For a local edit already applied via `set-cell`, the diff
    // is empty here → just re-post (no rebuild).
    if (depsChanged || !hf || sheetStructureChanged(prev, next)) {
      rebuildAndEvaluate();
    } else {
      const changes = changedCellKeys(prev!, next);
      if (changes.length === 0) {
        evaluateAndPost(false);
      } else if (applyIncrementalCells(activeSheetId, changes)) {
        evaluateAndPost(false);
      } else {
        rebuildAndEvaluate();
      }
    }
  } else if (msg.subId === depsSubId) {
    // Dependency cells (any sheet, including active)
    if (msg.error || !msg.result) return;
    const sheets = msg.result as Record<string, SheetInfo>;
    let newRefsFound = false;
    for (const [sid, info] of Object.entries(sheets)) {
      const prev = depsData.get(sid);
      depsData.set(sid, info);
      if (!prev) newRefsFound = true;
    }
    if (newRefsFound) resolveDeps();
    rebuildAndEvaluate();
  }
}

// --- Main message handler (from main thread) ---

function unsubscribeAll() {
  unsubscribe(formulaSubId);
  unsubscribe(depsSubId);
  formulaSubId = 0;
  depsSubId = 0;
  formulaData = null;
  depsData.clear();
  depCells.clear();
  hf?.destroy();
  hf = null;
}

self.onmessage = (e: MessageEvent<MainToHf>) => {
  const msg = e.data;

  if (msg.type === 'init') {
    port = msg.port;
    port.onmessage = handlePortMessage;
  }

  if (msg.type === 'watch') {
    unsubscribeAll();
    docId = msg.docId;
    activeSheetId = msg.activeSheet;
    formulaSubId = subscribe(buildFormulaQuery(activeSheetId));
  }

  if (msg.type === 'switch-sheet') {
    unsubscribeAll();
    activeSheetId = msg.sheetId;
    formulaSubId = subscribe(buildFormulaQuery(activeSheetId));
  }

  if (msg.type === 'unwatch') {
    unsubscribeAll();
    docId = '';
    activeSheetId = '';
  }

  if (msg.type === 'set-cell') {
    // Incremental local edit — update cached formula/dep data and re-evaluate.
    const info = msg.sheetId === activeSheetId ? formulaData : depsData.get(msg.sheetId);
    if (info) {
      const cellKey = `${msg.rowId}:${msg.colId}`;
      if (msg.value === '') {
        delete info.cells[cellKey];
      } else {
        info.cells[cellKey] = { value: msg.value };
      }
      // A new cross-sheet ref changes the dependency set → full rebuild (structural).
      const depsChanged = msg.value.startsWith('=') ? resolveDeps() : false;
      if (depsChanged || !hf) {
        // No HF yet, or deps changed — rebuild (deps data will also arrive and rebuild).
        rebuildAndEvaluate();
      } else if (applyIncrementalCells(msg.sheetId, [cellKey])) {
        // Fast path: patch the single edited cell, no full re-parse (H6).
        evaluateAndPost(false);
      } else {
        rebuildAndEvaluate();
      }
    }
  }

  if (msg.type === 'eval-cond-formats') {
    pendingCondFormatRules = msg.rules;
    // Re-evaluate if HF is already built
    if (hf && formulaData) {
      evaluateCondFormats(formulaData);
    }
  }
};
