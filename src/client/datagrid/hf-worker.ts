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

// Cached sheet data received from automerge worker
const sheetData = new Map<string, SheetInfo>();

// Set of cross-sheet dependency cell keys we're currently subscribed to,
// grouped by sheetId: Map<sheetId, Set<"rowId:colId">>
const depCells = new Map<string, Set<string>>();

// --- Helpers ---

/** Extract cross-sheet refs and same-sheet cell refs from an internal-format formula. */
function extractRefs(formula: string, currentSheetId: string): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();

  // Match all cell references: {R{rowId}C{colId}} or {R{rowId}C{colId}S{sheetId}}
  // Also handles relative refs: {R[id]C[id]} etc.
  const refPattern = /\{R[\{[]([^\}\]]+)[\}\]]C[\{[]([^\}\]]+)[\}\]](?:S\{([^}]+)\})?\}/g;
  let m;
  while ((m = refPattern.exec(formula)) !== null) {
    const rowId = m[1];
    const colId = m[2];
    const sheetId = m[3] || currentSheetId;
    // Skip relative refs (they reference the same sheet's grid which we already have)
    if (m[0].includes('R[') || m[0].includes('C[')) continue;
    if (!refs.has(sheetId)) refs.set(sheetId, new Set());
    refs.get(sheetId)!.add(`${rowId}:${colId}`);
  }
  return refs;
}

/** Build the jq query for active sheet formula cells. */
function buildFormulaQuery(sheetId: string): string {
  // Extract: sheet name, sorted row IDs, sorted col IDs, and only cells whose value starts with "="
  return `.sheets["${sheetId}"] | { name, rows: (.rows | to_entries | sort_by(.value.index) | map(.key)), cols: (.columns | to_entries | sort_by(.value.index) | map(.key)), cells: (.cells | to_entries | [.[] | select(.value.value | startswith("="))] | from_entries) }`;
}

/** Build the jq query for cross-sheet dependency cells. */
function buildDepsQuery(deps: Map<string, Set<string>>): string | null {
  if (deps.size === 0) return null;
  const parts: string[] = [];
  for (const [sheetId, cellKeys] of deps) {
    if (sheetId === activeSheetId) continue; // active sheet is handled by subscription 1
    const cellSelectors = [...cellKeys].map(k => `"${k}": .cells["${k}"]`).join(', ');
    parts.push(`"${sheetId}": (.sheets["${sheetId}"] | { name, rows: (.rows | to_entries | sort_by(.value.index) | map(.key)), cols: (.columns | to_entries | sort_by(.value.index) | map(.key)), cells: { ${cellSelectors} } })`);
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
  if (sheetData.size === 0) return;

  // Build sheets data for HyperFormula
  const sheetsHfData: Record<string, (string | number | boolean | null)[][]> = {};
  const sheetOrder: string[] = []; // track sheet IDs in order

  // Active sheet first, then deps
  const activeInfo = sheetData.get(activeSheetId);
  if (activeInfo) {
    const sheetNameLookup = (id: string) => sheetData.get(id)?.name;
    const sheetRowColLookup = (id: string) => {
      const s = sheetData.get(id);
      if (!s) return undefined;
      return { rowIds: s.rows, colIds: s.cols };
    };
    sheetsHfData[activeInfo.name] = buildSheetData(
      activeInfo.cells, activeInfo.rows, activeInfo.cols,
      sheetNameLookup, sheetRowColLookup,
    );
    sheetOrder.push(activeSheetId);
  }

  for (const [sid, info] of sheetData) {
    if (sid === activeSheetId) continue;
    const sheetNameLookup = (id: string) => sheetData.get(id)?.name;
    const sheetRowColLookup = (id: string) => {
      const s = sheetData.get(id);
      if (!s) return undefined;
      return { rowIds: s.rows, colIds: s.cols };
    };
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
    const info = sheetData.get(sid)!;
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

  (self as any).postMessage({ type: 'computed-values', values });

  // Auto-run Monte Carlo if distributions were detected
  const registry = getDistributionRegistry();
  if (registry.size > 0) {
    runMCInWorker(sheetOrder, registry);
  }
}

function runMCInWorker(sheetOrder: string[], registry: Map<string, DistributionInfo>) {
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
      const info = sid ? sheetData.get(sid) : undefined;
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
  const newDeps = new Map<string, Set<string>>();

  // Scan all formula cells in all loaded sheets for cross-sheet refs
  for (const [sid, info] of sheetData) {
    for (const [cellKey, cell] of Object.entries(info.cells)) {
      if (cell.value.startsWith('=')) {
        const refs = extractRefs(cell.value, sid);
        for (const [refSheet, refCells] of refs) {
          if (!newDeps.has(refSheet)) newDeps.set(refSheet, new Set());
          for (const ck of refCells) newDeps.get(refSheet)!.add(ck);
        }
      }
    }
  }

  // Check if deps changed
  let changed = false;
  for (const [sid, cells] of newDeps) {
    if (sid === activeSheetId) continue;
    const existing = depCells.get(sid);
    if (!existing || existing.size !== cells.size) { changed = true; break; }
    for (const c of cells) { if (!existing.has(c)) { changed = true; break; } }
    if (changed) break;
  }
  // Also check if we had deps that are no longer needed
  if (!changed) {
    for (const sid of depCells.keys()) {
      if (sid !== activeSheetId && !newDeps.has(sid)) { changed = true; break; }
    }
  }

  if (changed) {
    depCells.clear();
    for (const [sid, cells] of newDeps) {
      if (sid !== activeSheetId) depCells.set(sid, cells);
    }
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
  if (msg.type !== 'sub-result') return;

  if (msg.subId === formulaSubId) {
    // Active sheet formula cells
    if (msg.error || !msg.result) return;
    const result = msg.result as SheetInfo;
    sheetData.set(activeSheetId, result);
    resolveDeps();
    rebuildAndEvaluate();
  } else if (msg.subId === depsSubId) {
    // Cross-sheet dependency cells
    if (msg.error || !msg.result) return;
    const sheets = msg.result as Record<string, SheetInfo>;
    let newRefsFound = false;
    for (const [sid, info] of Object.entries(sheets)) {
      const prev = sheetData.get(sid);
      sheetData.set(sid, info);
      // Check if any newly received cells are formulas we haven't seen
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
  sheetData.clear();
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
    // Incremental local edit — update cached sheet data and re-evaluate
    const info = sheetData.get(msg.sheetId);
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
