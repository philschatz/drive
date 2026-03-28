/**
 * HyperFormula evaluation worker.
 *
 * Owns a persistent HyperFormula instance. Communicates with the automerge
 * worker via a MessageChannel port using the standard subscribe-query protocol.
 * Only subscribes to formula cells on the active sheet and their transitive
 * cross-sheet dependencies.
 */

import HyperFormula from 'hyperformula';
import { registerCustomFunctions, getDistributionRegistry, clearDistributionRegistry } from './hf-functions';
import { buildSheetData, cellToHfValue, sortedEntries } from './helpers';
import { runMonteCarlo, type MCResults } from './monte-carlo';
import { sampleDistribution, computeStats, type DistributionInfo, type DistributionStats } from './distributions';

registerCustomFunctions();

// --- Types ---

interface SheetInfo {
  name: string;
  rows: string[];
  cols: string[];
  cells: Record<string, { value: string }>;
}

type MainToHf =
  | { type: 'init'; port: MessagePort }
  | { type: 'watch'; docId: string; activeSheet: string }
  | { type: 'switch-sheet'; sheetId: string }
  | { type: 'unwatch' }
  | { type: 'set-cell'; sheetId: string; rowId: string; colId: string; value: string };

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

/** Extract all cell refs from an internal-format formula, grouped by sheet ID. */
function extractRefs(formula: string, currentSheetId: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();

  // Match cell references: {R{rowId}C{colId}}, {R[rowId]C[colId]}, {R{id}C{id}S{sheetId}}, etc.
  // Both absolute {id} and relative [id] contain actual row/col IDs in the internal format.
  const refPattern = /\{R[\{[]([^\}\]]+)[\}\]]C[\{[]([^\}\]]+)[\}\]](?:S\{([^}]+)\})?\}/g;
  let m;
  while ((m = refPattern.exec(formula)) !== null) {
    const rowId = m[1];
    const colId = m[2];
    const sheetId = m[3] || currentSheetId;
    if (!refs.has(sheetId)) refs.set(sheetId, new Set());
    refs.get(sheetId)!.add(`${rowId}:${colId}`);
  }

  // Also match column-only refs {C{colId}S{sheetId}} (whole-column cross-sheet refs).
  // These don't have specific row IDs, but we still need to track the sheet dependency.
  const colOnlyPattern = /\{C[\{[]([^\}\]]+)[\}\]]S\{([^}]+)\}\}/g;
  while ((m = colOnlyPattern.exec(formula)) !== null) {
    const sheetId = m[2];
    if (!refs.has(sheetId)) refs.set(sheetId, new Set());
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

/** Rebuild HyperFormula from all collected sheet data and evaluate. */
function rebuildAndEvaluate() {
  if (!formulaData && depsData.size === 0) return;
  const merged = getMergedSheetData();
  if (merged.size === 0) return;

  // Build sheets data for HyperFormula
  const sheetsHfData: Record<string, (string | number | boolean | null)[][]> = {};
  const sheetOrder: string[] = []; // track sheet IDs in order

  const sheetNameLookup = (id: string) => merged.get(id)?.name;
  const sheetRowColLookup = (id: string) => {
    const s = merged.get(id);
    if (!s) return undefined;
    return { rowIds: s.rows, colIds: s.cols };
  };

  // Active sheet first, then deps
  const activeInfo = merged.get(activeSheetId);
  if (activeInfo) {
    sheetsHfData[activeInfo.name] = buildSheetData(
      activeInfo.cells, activeInfo.rows, activeInfo.cols,
      sheetNameLookup, sheetRowColLookup,
    );
    sheetOrder.push(activeSheetId);
  }

  for (const [sid, info] of merged) {
    if (sid === activeSheetId) continue;
    sheetsHfData[info.name] = buildSheetData(
      info.cells, info.rows, info.cols,
      sheetNameLookup, sheetRowColLookup,
    );
    sheetOrder.push(sid);
  }

  // Rebuild HF
  hf?.destroy();
  clearDistributionRegistry();
  hf = HyperFormula.buildFromSheets(sheetsHfData, { licenseKey: 'gpl-v3' });

  // Evaluate all formula cells and collect results
  const values: Record<string, string | number> = {};
  for (let si = 0; si < sheetOrder.length; si++) {
    const sid = sheetOrder[si];
    const info = merged.get(sid)!;
    for (let row = 0; row < info.rows.length; row++) {
      for (let col = 0; col < info.cols.length; col++) {
        const cellKey = `${info.rows[row]}:${info.cols[col]}`;
        const cell = info.cells[cellKey];
        if (cell?.value?.startsWith('=')) {
          const computed = hf.getCellValue({ sheet: si, col, row });
          if (computed != null) {
            if (typeof computed === 'object' && 'value' in computed) {
              values[`${sid}:${cellKey}`] = String(computed.value);
            } else {
              values[`${sid}:${cellKey}`] = typeof computed === 'string' || typeof computed === 'number' ? computed : String(computed);
            }
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
    const info = merged.get(sid)!;
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
          const computed = hf.getCellValue({ sheet: si, col, row });
          if (computed != null) {
            // Map HF indices back to document IDs; skip if beyond document grid
            if (row >= info.rows.length || col >= info.cols.length) continue;
            const cellKey = `${info.rows[row]}:${info.cols[col]}`;
            const key = `${sid}:${cellKey}`;
            values[key] = typeof computed === 'string' || typeof computed === 'number' ? computed : String(computed);
            spillTargetKeys.push(key);
          }
        }
      }
    }
  }

  (self as any).postMessage({ type: 'computed-values', values, spillTargets: spillTargetKeys });

  // Auto-run Monte Carlo if distributions were detected
  const registry = getDistributionRegistry();
  if (registry.size > 0) {
    runMCInWorker(sheetOrder, merged, registry);
  }
}

function runMCInWorker(sheetOrder: string[], mergedData: Map<string, SheetInfo>, registry: Map<string, DistributionInfo>) {
  if (!hf || registry.size === 0) return;

  const MC_SAMPLES = 500;
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
  const allCellKeys: string[] = [];
  for (let si = 0; si < sheetNames.length; si++) {
    const { height, width } = hf.getSheetDimensions(si);
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        allCellKeys.push(`${si}:${c}:${r}`);
      }
    }
  }

  const allSamples = new Map<string, number[]>();

  for (let iter = 0; iter < MC_SAMPLES; iter++) {
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
    if (samples.length < MC_SAMPLES * 0.5) continue;
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

/** Resolve transitive cross-sheet dependencies and update subscription 2. */
function resolveDeps() {
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
}

// --- Port message handler (from automerge worker) ---

function handlePortMessage(e: MessageEvent) {
  const msg = e.data;
  if (msg.type !== 'query-result') return;

  if (msg.subId === formulaSubId) {
    // Active sheet formula cells
    if (msg.error || !msg.result) return;
    formulaData = msg.result as SheetInfo;
    resolveDeps();
    rebuildAndEvaluate();
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
    // Incremental local edit — update cached formula/dep data and re-evaluate
    const info = msg.sheetId === activeSheetId ? formulaData : depsData.get(msg.sheetId);
    if (info) {
      const cellKey = `${msg.rowId}:${msg.colId}`;
      if (msg.value === '') {
        delete info.cells[cellKey];
      } else {
        info.cells[cellKey] = { value: msg.value };
      }
      // Check if this introduced new cross-sheet deps
      if (msg.value.startsWith('=')) {
        resolveDeps();
      }
      rebuildAndEvaluate();
    }
  }
};
