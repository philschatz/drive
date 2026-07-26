import {
  sheetStructureChanged, changedCellKeys, planMonteCarloBudget,
  type SheetShape,
} from './hf-diff';

// These pure helpers gate the HyperFormula worker's incremental-update decision
// (rebuild vs setCellContents) and its Monte-Carlo work budget. The worker itself
// installs a `self.onmessage` handler at import time and needs the HF + worker
// runtime, so it can't be loaded in a plain unit test — but the decision logic
// that keeps a plain value edit off the full-rebuild path lives here and IS tested.

const shape = (over: Partial<SheetShape> = {}): SheetShape => ({
  name: 'S', rows: ['r0', 'r1'], cols: ['c0', 'c1'], cells: {}, ...over,
});

describe('sheetStructureChanged', () => {
  it('is structural when there is no prior snapshot (forces a rebuild)', () => {
    expect(sheetStructureChanged(null, shape())).toBe(true);
  });

  it('is NOT structural for a plain value change (→ incremental, no full rebuild)', () => {
    const prev = shape({ cells: { 'r0:c0': { value: '1' } } });
    const next = shape({ cells: { 'r0:c0': { value: '2' } } });
    expect(sheetStructureChanged(prev, next)).toBe(false);
  });

  it('is structural when row ids change', () => {
    expect(sheetStructureChanged(shape(), shape({ rows: ['r0', 'r2'] }))).toBe(true);
  });

  it('is structural when the row count changes', () => {
    expect(sheetStructureChanged(shape(), shape({ rows: ['r0', 'r1', 'r2'] }))).toBe(true);
  });

  it('is structural when column order changes', () => {
    expect(sheetStructureChanged(shape(), shape({ cols: ['c1', 'c0'] }))).toBe(true);
  });

  it('is structural when the sheet name changes', () => {
    expect(sheetStructureChanged(shape(), shape({ name: 'Renamed' }))).toBe(true);
  });
});

describe('changedCellKeys', () => {
  it('reports changed, added, and removed cells but not unchanged ones', () => {
    const prev = shape({ cells: { 'r0:c0': { value: 'a' }, 'r1:c0': { value: 'x' } } });
    const next = shape({ cells: { 'r0:c0': { value: 'b' }, 'r1:c1': { value: 'y' } } });
    const changed = changedCellKeys(prev, next).sort();
    // r0:c0 changed, r1:c0 removed, r1:c1 added; unchanged: none here
    expect(changed).toEqual(['r0:c0', 'r1:c0', 'r1:c1']);
  });

  it('is empty when nothing changed (local set-cell echo → no rebuild, no work)', () => {
    const prev = shape({ cells: { 'r0:c0': { value: 'a' } } });
    const next = shape({ cells: { 'r0:c0': { value: 'a' } } });
    expect(changedCellKeys(prev, next)).toEqual([]);
  });
});

describe('planMonteCarloBudget (H9 untrusted-content DoS cap)', () => {
  const caps = { maxSampledCells: 2000, maxTotalSamples: 400_000 };

  it('leaves a small sheet fully sampled', () => {
    expect(planMonteCarloBudget(50, 500, caps)).toEqual({
      sampledCells: 50, iterations: 500, cellsTruncated: false, iterationsReduced: false,
    });
  });

  it('caps sampled cells AND reduces iterations for a hostile huge sheet', () => {
    const p = planMonteCarloBudget(1_000_000, 500, caps);
    expect(p.sampledCells).toBe(2000);
    expect(p.cellsTruncated).toBe(true);
    expect(p.iterationsReduced).toBe(true);
    expect(p.iterations).toBe(200); // 400000 / 2000
    expect(p.sampledCells * p.iterations).toBeLessThanOrEqual(caps.maxTotalSamples);
  });

  it('reduces iterations even when cell count is under the cell cap', () => {
    // 1500 cells × 500 iters = 750k > 400k budget
    const p = planMonteCarloBudget(1500, 500, caps);
    expect(p.cellsTruncated).toBe(false);
    expect(p.iterationsReduced).toBe(true);
    expect(p.iterations).toBe(Math.floor(400_000 / 1500));
    expect(p.sampledCells * p.iterations).toBeLessThanOrEqual(caps.maxTotalSamples);
  });

  it('never returns zero iterations', () => {
    const p = planMonteCarloBudget(10_000_000, 500, { maxSampledCells: 10_000_000, maxTotalSamples: 1 });
    expect(p.iterations).toBeGreaterThanOrEqual(1);
  });
});
