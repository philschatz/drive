/**
 * Pure doc-mutation helpers for DataGrid formatting/layout, shared by the bridge
 * (inside `updateDoc` callbacks) and unit tests. Each function mutates a plain
 * sheet object in place — the same shape Automerge hands the `updateDoc` callback
 * — so it can be exercised against a literal object with no WASM/model needed.
 *
 * Formatting is stored the legacy way: `sheet.formats` is a map of `FormatRange`
 * (bounds by row/col id + a `DataGridCellFormat`), reused by identical bounds and
 * index-ordered (higher index wins). Column width / row height / freeze live on
 * the individual `columns[id]` / `rows[id]` entries.
 */
import type { DataGridCellFormat, FormatRange } from './schema';

export interface MutSheet {
  rows: Record<string, { index: number; height?: number; frozen?: boolean }>;
  columns: Record<string, { index: number; width?: number; frozen?: boolean }>;
  cells: Record<string, { value: string }>;
  formats?: Record<string, FormatRange>;
}

export interface RangeBounds {
  rangeRowStart: string; rangeRowEnd: string; rangeColStart: string; rangeColEnd: string;
}

/**
 * Merge a format patch onto the range, reusing a FormatRange with identical
 * bounds (else creating one). `undefined` patch values delete that property; a
 * range whose format becomes empty is removed.
 */
export function applyFormatPatch(
  sheet: MutSheet, bounds: RangeBounds, patch: Partial<DataGridCellFormat>, newId: () => string,
): void {
  if (!sheet.formats) sheet.formats = {};
  let existingId: string | null = null;
  for (const [id, f] of Object.entries(sheet.formats)) {
    if (f.rangeRowStart === bounds.rangeRowStart && f.rangeRowEnd === bounds.rangeRowEnd &&
        f.rangeColStart === bounds.rangeColStart && f.rangeColEnd === bounds.rangeColEnd) { existingId = id; break; }
  }
  if (existingId) {
    const range = sheet.formats[existingId];
    if (!range.format) range.format = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (range.format as any)[k];
      else (range.format as any)[k] = v;
    }
    if (Object.keys(range.format).length === 0) delete sheet.formats[existingId];
  } else {
    let maxIndex = 0;
    for (const f of Object.values(sheet.formats)) if (f.index > maxIndex) maxIndex = f.index;
    sheet.formats[newId()] = { index: maxIndex + 1, ...bounds, format: { ...patch } };
  }
}

/** Delete FormatRanges lying entirely within the given cell-index rectangle. */
export function clearFormatRanges(
  sheet: MutSheet, orderedRowIds: string[], orderedColIds: string[],
  r0: number, r1: number, c0: number, c1: number,
): void {
  const fmts = sheet.formats; if (!fmts) return;
  for (const [id, fr] of Object.entries(fmts)) {
    const fr0 = orderedRowIds.indexOf(fr.rangeRowStart), fr1 = orderedRowIds.indexOf(fr.rangeRowEnd);
    const fc0 = orderedColIds.indexOf(fr.rangeColStart), fc1 = orderedColIds.indexOf(fr.rangeColEnd);
    if (fr0 < 0 || fr1 < 0 || fc0 < 0 || fc1 < 0) continue;
    if (fr0 >= r0 && fr1 <= r1 && fc0 >= c0 && fc1 <= c1) delete fmts[id];
  }
}

/** Set pixel width on the given columns. */
export function setColumnWidths(sheet: MutSheet, colIds: string[], width: number): void {
  for (const cid of colIds) { const c = sheet.columns[cid]; if (c) c.width = width; }
}

/** Set pixel height on the given rows. */
export function setRowHeights(sheet: MutSheet, rowIds: string[], height: number): void {
  for (const rid of rowIds) { const r = sheet.rows[rid]; if (r) r.height = height; }
}

/** Freeze the first `count` rows (in display order); unfreeze the rest. */
export function setFrozenRows(sheet: MutSheet, orderedRowIds: string[], count: number): void {
  orderedRowIds.forEach((rid, i) => {
    const r = sheet.rows[rid]; if (!r) return;
    if (i < count) r.frozen = true; else delete r.frozen;
  });
}

/** Freeze the first `count` columns (in display order); unfreeze the rest. */
export function setFrozenColumns(sheet: MutSheet, orderedColIds: string[], count: number): void {
  orderedColIds.forEach((cid, i) => {
    const c = sheet.columns[cid]; if (!c) return;
    if (i < count) c.frozen = true; else delete c.frozen;
  });
}

/** Number of contiguous frozen rows from the top (what IronCalc's frozen count expects). */
export function frozenRowCount(sheet: MutSheet, orderedRowIds: string[]): number {
  let n = 0;
  for (const rid of orderedRowIds) { if (sheet.rows[rid]?.frozen) n++; else break; }
  return n;
}

/** Number of contiguous frozen columns from the left. */
export function frozenColCount(sheet: MutSheet, orderedColIds: string[]): number {
  let n = 0;
  for (const cid of orderedColIds) { if (sheet.columns[cid]?.frozen) n++; else break; }
  return n;
}
