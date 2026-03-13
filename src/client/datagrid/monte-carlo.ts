/**
 * Monte Carlo simulation engine for probabilistic distributions in the datagrid.
 *
 * Creates a temporary HyperFormula instance, replaces distribution cells with
 * sampled scalar values each iteration, and reads all cell results.
 */
import HyperFormula from 'hyperformula';
import { sampleDistribution, computeStats, type DistributionInfo, type DistributionStats } from './distributions';
import { getDistributionRegistry, clearDistributionRegistry } from './hf-functions';
import { buildSheetData, sortedEntries } from './helpers';
import { registerCustomFunctions } from './hf-functions';
import type { DataGridDocument } from './schema';

export interface MCResults {
  cells: Map<string, DistributionStats>;  // key: "sheetIdx:col:row"
  sources: Set<string>;                   // keys of cells that ARE distributions
}

const MC_SAMPLES = 500;
const CHUNK_SIZE = 50;

/**
 * Run Monte Carlo simulation synchronously.
 */
export function runMonteCarlo(doc: DataGridDocument, registry: Map<string, DistributionInfo>): MCResults {
  if (registry.size === 0) return { cells: new Map(), sources: new Set() };

  registerCustomFunctions();
  const order = sortedEntries(doc.sheets);
  const sheetNameLookup = (id: string) => doc.sheets[id]?.name;
  const sheetRowColFn = (id: string) => {
    const s = doc.sheets[id];
    if (!s) return undefined;
    return { rowIds: sortedEntries(s.rows).map(([r]) => r), colIds: sortedEntries(s.columns).map(([c]) => c) };
  };

  // Build sheet data for temp HF
  const sheetsData: Record<string, (string | number | boolean | null)[][]> = {};
  const sheetMeta: { name: string; rows: number; cols: number }[] = [];
  for (const [, sheet] of order) {
    const rIds = sortedEntries(sheet.rows).map(([r]) => r);
    const cIds = sortedEntries(sheet.columns).map(([c]) => c);
    sheetsData[sheet.name] = buildSheetData(sheet.cells, rIds, cIds, sheetNameLookup, sheetRowColFn);
    sheetMeta.push({ name: sheet.name, rows: rIds.length, cols: cIds.length });
  }

  // Parse registry keys → addresses
  const distCells: { sheet: number; col: number; row: number; info: DistributionInfo; key: string }[] = [];
  for (const [key, info] of registry) {
    const parts = key.split(':');
    distCells.push({ sheet: Number(parts[0]), col: Number(parts[1]), row: Number(parts[2]), info, key });
  }

  // Collect samples
  const allSamples: Map<string, number[]> = new Map();

  // Track all cells that depend on distributions
  const allCellKeys = new Set<string>();
  for (let si = 0; si < sheetMeta.length; si++) {
    for (let r = 0; r < sheetMeta[si].rows; r++) {
      for (let c = 0; c < sheetMeta[si].cols; c++) {
        allCellKeys.add(`${si}:${c}:${r}`);
      }
    }
  }

  for (let iter = 0; iter < MC_SAMPLES; iter++) {
    const hf = HyperFormula.buildFromSheets(sheetsData, { licenseKey: 'gpl-v3' });

    // Replace distribution cells with sampled values
    for (const dc of distCells) {
      const val = sampleDistribution(dc.info);
      hf.setCellContents({ sheet: dc.sheet, col: dc.col, row: dc.row }, [[val]]);
    }

    // Read all cell values
    for (const cellKey of allCellKeys) {
      const [si, c, r] = cellKey.split(':').map(Number);
      const val = hf.getCellValue({ sheet: si, col: c, row: r });
      if (typeof val === 'number') {
        if (!allSamples.has(cellKey)) allSamples.set(cellKey, []);
        allSamples.get(cellKey)!.push(val);
      }
    }

    hf.destroy();
  }

  // Compute stats
  const sources = new Set(distCells.map(dc => dc.key));
  const results = new Map<string, DistributionStats>();

  for (const [key, samples] of allSamples) {
    if (samples.length < MC_SAMPLES * 0.5) continue; // skip cells that aren't consistently numeric
    // Only include cells that actually vary OR are distribution sources
    if (sources.has(key)) {
      results.set(key, computeStats(samples));
    } else {
      const stats = computeStats(samples);
      if (stats.stdev > 1e-10) results.set(key, stats);
    }
  }

  return { cells: results, sources };
}

/**
 * Run Monte Carlo simulation asynchronously in chunks.
 * Returns a cancel function.
 */
export function runMonteCarloAsync(
  doc: DataGridDocument,
  registry: Map<string, DistributionInfo>,
  onComplete: (results: MCResults) => void,
): () => void {
  let cancelled = false;

  if (registry.size === 0) {
    onComplete({ cells: new Map(), sources: new Set() });
    return () => { cancelled = true; };
  }

  registerCustomFunctions();
  const order = sortedEntries(doc.sheets);
  const sheetNameLookup = (id: string) => doc.sheets[id]?.name;
  const sheetRowColFn = (id: string) => {
    const s = doc.sheets[id];
    if (!s) return undefined;
    return { rowIds: sortedEntries(s.rows).map(([r]) => r), colIds: sortedEntries(s.columns).map(([c]) => c) };
  };

  const sheetsData: Record<string, (string | number | boolean | null)[][]> = {};
  const sheetMeta: { name: string; rows: number; cols: number }[] = [];
  for (const [, sheet] of order) {
    const rIds = sortedEntries(sheet.rows).map(([r]) => r);
    const cIds = sortedEntries(sheet.columns).map(([c]) => c);
    sheetsData[sheet.name] = buildSheetData(sheet.cells, rIds, cIds, sheetNameLookup, sheetRowColFn);
    sheetMeta.push({ name: sheet.name, rows: rIds.length, cols: cIds.length });
  }

  const distCells: { sheet: number; col: number; row: number; info: DistributionInfo; key: string }[] = [];
  for (const [key, info] of registry) {
    const parts = key.split(':');
    distCells.push({ sheet: Number(parts[0]), col: Number(parts[1]), row: Number(parts[2]), info, key });
  }

  const allCellKeys: string[] = [];
  for (let si = 0; si < sheetMeta.length; si++) {
    for (let r = 0; r < sheetMeta[si].rows; r++) {
      for (let c = 0; c < sheetMeta[si].cols; c++) {
        allCellKeys.push(`${si}:${c}:${r}`);
      }
    }
  }

  const allSamples: Map<string, number[]> = new Map();
  let iterDone = 0;

  function runChunk() {
    if (cancelled) return;
    const end = Math.min(iterDone + CHUNK_SIZE, MC_SAMPLES);
    for (let iter = iterDone; iter < end; iter++) {
      const hf = HyperFormula.buildFromSheets(sheetsData, { licenseKey: 'gpl-v3' });
      for (const dc of distCells) {
        hf.setCellContents({ sheet: dc.sheet, col: dc.col, row: dc.row }, [[sampleDistribution(dc.info)]]);
      }
      for (const cellKey of allCellKeys) {
        const [si, c, r] = cellKey.split(':').map(Number);
        const val = hf.getCellValue({ sheet: si, col: c, row: r });
        if (typeof val === 'number') {
          if (!allSamples.has(cellKey)) allSamples.set(cellKey, []);
          allSamples.get(cellKey)!.push(val);
        }
      }
      hf.destroy();
    }
    iterDone = end;

    if (iterDone >= MC_SAMPLES) {
      const sources = new Set(distCells.map(dc => dc.key));
      const results = new Map<string, DistributionStats>();
      for (const [key, samples] of allSamples) {
        if (samples.length < MC_SAMPLES * 0.5) continue;
        if (sources.has(key)) {
          results.set(key, computeStats(samples));
        } else {
          const stats = computeStats(samples);
          if (stats.stdev > 1e-10) results.set(key, stats);
        }
      }
      if (!cancelled) onComplete({ cells: results, sources });
    } else {
      setTimeout(runChunk, 0);
    }
  }

  setTimeout(runChunk, 0);
  return () => { cancelled = true; };
}
