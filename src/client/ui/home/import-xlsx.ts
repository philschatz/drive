/**
 * XLSX/CSV → DataGrid importer. Loaded via dynamic import so the datagrid
 * formula helpers (and the exceljs/buffer chunks it pulls in itself) stay out
 * of the main chunk.
 */

import { createDoc, updateDoc } from '../worker-api';
import { a1ToInternal } from '@/doc-plugins/datagrid/helpers';
import type { ImportProgress } from './import-docs';

/** Google Sheets wraps functions unsupported by Excel as
 *  IFERROR(__xludf.DUMMYFUNCTION("REAL_FORMULA"),"fallback").
 *  Detect and unwrap to get the original formula. */
function unwrapDummyFunction(f: string): string {
  const prefix = 'IFERROR(__xludf.DUMMYFUNCTION("';
  if (!f.toUpperCase().startsWith(prefix.toUpperCase())) return f;
  let i = prefix.length;
  let inner = '';
  while (i < f.length) {
    if (f[i] === '"') {
      if (f[i + 1] === '"') { inner += '"'; i += 2; }
      else break;
    } else { inner += f[i]; i++; }
  }
  return inner || f;
}

/**
 * Parse an .xlsx/.csv file into a new DataGrid document, streaming cells in
 * batches with progress callbacks. Returns the new docId; throws on failure
 * (the document may already exist by then — the caller decides what to show).
 */
export async function importXlsxFile(
  file: File,
  onProgress: (status: ImportProgress) => void,
): Promise<string> {
  const sid = () => Math.random().toString(36).slice(2, 10);
  const name = file.name.replace(/\.(xlsx?|csv)$/i, '') || 'Imported';

  // Create the document before parsing
  onProgress({ label: 'Creating document...', progress: 0 });
  const { docId } = await createDoc({ '@type': 'DataGrid', name, sheets: {} }, { type: 'DataGrid', name });

  onProgress({ label: 'Reading file...', progress: 2 });
  await new Promise(r => setTimeout(r, 0));

  const [{ Buffer: BufferPolyfill }, ExcelJS] = await Promise.all([
    import('buffer/'),
    import('exceljs'),
  ]);
  if (typeof globalThis.Buffer === 'undefined') {
    (globalThis as any).Buffer = BufferPolyfill;
  }
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheetNameToId = new Map<string, string>();
  const sheetIdToRowColIds = new Map<string, {
    rowIds: string[]; colIds: string[];
    onMissingRow: (idx: number) => string;
    onMissingCol: (idx: number) => string;
  }>();
  const sheetDefs: {
    sheetId: string; sheetName: string; hidden: boolean;
    columns: Record<string, { index: number; width?: number; hidden?: boolean; frozen?: boolean }>;
    rowsMap: Record<string, { index: number; hidden?: boolean; frozen?: boolean }>;
    colIds: string[]; rowIds: string[];
    rows2d: any[][]; ws: any;
  }[] = [];

  for (const ws of wb.worksheets) {
    const sheetName = ws.name;
    const sheetId = sid();
    sheetNameToId.set(sheetName, sheetId);

    // Build 2D row data from ExcelJS
    const rows2d: any[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const rowData: any[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        rowData[colNumber - 1] = cell.value;
      });
      rows2d[rowNumber - 1] = rowData;
    });
    // Fill any gaps (eachRow skips fully empty rows)
    const rowCount = ws.rowCount || Math.max(rows2d.length, 1);
    for (let i = 0; i < rowCount; i++) {
      if (!rows2d[i]) rows2d[i] = [];
    }

    const colCount = Math.max(ws.columnCount || 0, rows2d.reduce((max, row) => Math.max(max, row?.length || 0), 0), 1);
    const columns: Record<string, { index: number; width?: number; hidden?: boolean; frozen?: boolean }> = {};
    const colIds: string[] = [];
    for (let c = 0; c < colCount; c++) {
      const cid = sid();
      colIds.push(cid);
      const col: { index: number; width?: number; hidden?: boolean; frozen?: boolean } = { index: c + 1 };
      const wsCol = ws.getColumn(c + 1);
      if (wsCol?.hidden) col.hidden = true;
      // ExcelJS width is in characters; convert to pixels (~7px per character + 12px padding)
      if (wsCol?.width) col.width = Math.round(wsCol.width * 7 + 12);
      columns[cid] = col;
    }

    const rowsMap: Record<string, { index: number; hidden?: boolean; frozen?: boolean }> = {};
    const rowIds: string[] = [];
    for (let r = 0; r < rowCount; r++) {
      const rid = sid();
      rowIds.push(rid);
      const row: { index: number; hidden?: boolean; frozen?: boolean } = { index: r + 1 };
      const wsRow = ws.getRow(r + 1);
      if (wsRow?.hidden) row.hidden = true;
      rowsMap[rid] = row;
    }

    // Import frozen pane information
    const frozenView = Array.isArray(ws.views) && ws.views.find((v: any) => v.state === 'frozen') as any;
    if (frozenView) {
      const xSplit: number = typeof frozenView.xSplit === 'number' ? frozenView.xSplit : 0;
      const ySplit: number = typeof frozenView.ySplit === 'number' ? frozenView.ySplit : 0;
      for (let c = 0; c < xSplit && c < colIds.length; c++) columns[colIds[c]].frozen = true;
      for (let r = 0; r < ySplit && r < rowIds.length; r++) rowsMap[rowIds[r]].frozen = true;
    }

    const sheetHidden = ws.state === 'hidden' || ws.state === 'veryHidden';
    const onMissingRow = (idx: number) => {
      while (rowIds.length <= idx) {
        const rid = sid();
        rowsMap[rid] = { index: rowIds.length + 1 };
        rowIds.push(rid);
      }
      return rowIds[idx];
    };
    const onMissingCol = (idx: number) => {
      while (colIds.length <= idx) {
        const cid = sid();
        columns[cid] = { index: colIds.length + 1 };
        colIds.push(cid);
      }
      return colIds[idx];
    };
    sheetIdToRowColIds.set(sheetId, { rowIds, colIds, onMissingRow, onMissingCol });
    sheetDefs.push({ sheetId, sheetName, hidden: sheetHidden, columns, rowsMap, colIds, rowIds, rows2d, ws });
  }

  const lookupSheetId = (n: string) => sheetNameToId.get(n);
  const lookupSheetRowColIds = (id: string) => sheetIdToRowColIds.get(id);

  const totalRows = sheetDefs.reduce((sum, sd) => sum + sd.rows2d.length, 0);
  let processedRows = 0;
  const BATCH_SIZE = 2000;
  const sentRowCounts = new Map<string, number>();
  const sentColCounts = new Map<string, number>();

  // Helper: extract ARGB color as #RRGGBB
  const argbToHex = (color: any): string | undefined => {
    if (!color) return undefined;
    const argb = color.argb;
    if (argb && typeof argb === 'string' && argb.length >= 6) {
      const hex = argb.slice(-6);
      if (hex !== '000000') return '#' + hex;
    }
    return undefined;
  };

  // Helper: map ExcelJS border to our format
  const mapBorder = (b: any) => {
    if (!b?.style) return undefined;
    const border: Record<string, string> = { style: b.style };
    const c = argbToHex(b.color);
    if (c) border.color = c;
    return border;
  };

  // Helper: map ExcelJS conditional formatting operator to our conditionType
  const operatorMap: Record<string, string> = {
    greaterThan: 'gt', lessThan: 'lt', equal: 'eq', notEqual: 'neq',
    greaterThanOrEqual: 'gte', lessThanOrEqual: 'lte',
  };

  // Helper: parse an A1 ref string (e.g. "A1:C10") into a range using row/col ID arrays
  const parseExcelRef = (ref: string, rowIds: string[], colIds: string[]) => {
    const m = ref.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
    if (!m) return null;
    const letterToIdx = (s: string) => {
      let idx = 0;
      for (let i = 0; i < s.length; i++) idx = idx * 26 + (s.toUpperCase().charCodeAt(i) - 64);
      return idx - 1;
    };
    const c1 = letterToIdx(m[1]);
    const r1 = parseInt(m[2], 10) - 1;
    const c2 = m[3] ? letterToIdx(m[3]) : c1;
    const r2 = m[4] ? parseInt(m[4], 10) - 1 : r1;
    if (r1 >= rowIds.length || r2 >= rowIds.length || c1 >= colIds.length || c2 >= colIds.length) return null;
    if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return null;
    return {
      rangeRowStart: rowIds[r1], rangeRowEnd: rowIds[r2],
      rangeColStart: colIds[c1], rangeColEnd: colIds[c2],
    };
  };

  // Parse each sheet and stream directly into the document
  for (let si = 0; si < sheetDefs.length; si++) {
    const { sheetId, sheetName, columns, rowsMap, colIds, rowIds, rows2d, ws } = sheetDefs[si];
    const processedRowsBefore = processedRows;

    const { hidden } = sheetDefs[si];
    await updateDoc(
      docId,
      (d, sid, sheet) => { (d as any).sheets[sid] = sheet; },
      sheetId, {
      '@type': 'Sheet', name: sheetName, index: si + 1,
      ...(hidden ? { hidden: true } : {}),
      columns, rows: rowsMap, cells: {},
    },
    );
    sentRowCounts.set(sheetId, rowIds.length);
    sentColCounts.set(sheetId, colIds.length);

    const cellFormats: { r: number; c: number; fmt: Record<string, any> }[] = [];
    let cellBatch: Record<string, { value: string }> = {};
    let batchCount = 0;

    for (let r = 0; r < rows2d.length; r++) {
      const row = rows2d[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = ws.getCell(r + 1, c + 1);

        // Extract formatting
        if (cell.style) {
          const s = cell.style;
          const fmt: Record<string, any> = {};
          if (s.font?.bold) fmt.bold = true;
          if (s.font?.italic) fmt.italic = true;
          if (s.font?.underline) fmt.underline = true;
          if (s.font?.strike) fmt.strikethrough = true;
          if (s.font?.name) fmt.fontFamily = s.font.name;
          if (s.font?.size) fmt.fontSize = s.font.size;
          const textColor = argbToHex(s.font?.color);
          if (textColor) fmt.textColor = textColor;
          if (s.fill && (s.fill as any).type === 'pattern') {
            const bgColor = argbToHex((s.fill as any).fgColor);
            if (bgColor) fmt.bgColor = bgColor;
          }
          if (s.alignment?.horizontal && s.alignment.horizontal !== 'general') fmt.hAlign = s.alignment.horizontal;
          if (s.alignment?.vertical) fmt.vAlign = s.alignment.vertical;
          if (s.alignment?.wrapText) fmt.wrapText = true;
          if (s.numFmt) fmt.numFmt = s.numFmt;
          if (s.border?.top) { const b = mapBorder(s.border.top); if (b) fmt.borderTop = b; }
          if (s.border?.bottom) { const b = mapBorder(s.border.bottom); if (b) fmt.borderBottom = b; }
          if (s.border?.left) { const b = mapBorder(s.border.left); if (b) fmt.borderLeft = b; }
          if (s.border?.right) { const b = mapBorder(s.border.right); if (b) fmt.borderRight = b; }
          if (Object.keys(fmt).length > 0) cellFormats.push({ r, c, fmt });
        }

        // Extract cell value
        const formula = cell.formula || cell.sharedFormula;
        const val = row[c];
        if (formula) {
          const unwrapped = unwrapDummyFunction(formula);
          if (/^"[^"]*"$/.test(unwrapped)) continue;
          let stored: string;
          try {
            const sheetLookup = sheetIdToRowColIds.get(sheetId)!;
            stored = a1ToInternal('=' + unwrapped, r, c, rowIds, colIds, lookupSheetId, lookupSheetRowColIds, sheetLookup.onMissingRow, sheetLookup.onMissingCol);
          } catch {
            stored = val != null ? String(val) : '';
          }
          if (stored) cellBatch[`${rowIds[r]}:${colIds[c]}`] = { value: stored };
        } else if (val != null && val !== '') {
          let stored: string;
          if (val instanceof Date) {
            const mm = String(val.getMonth() + 1).padStart(2, '0');
            const dd = String(val.getDate()).padStart(2, '0');
            const yyyy = val.getFullYear();
            stored = `${mm}/${dd}/${yyyy}`;
          } else if (typeof val === 'object' && val !== null && 'result' in val) {
            // ExcelJS formula result objects
            stored = String(val.result ?? '');
          } else {
            stored = String(val);
          }
          if (stored) cellBatch[`${rowIds[r]}:${colIds[c]}`] = { value: stored };
        } else {
          continue;
        }
        batchCount++;

        // Flush batch when full
        if (batchCount >= BATCH_SIZE) {
          const truncName = sheetName.slice(0, 20);
          const rowLabel = rows2d.length < 2000
            ? `row ${r + 1} / ${rows2d.length}`
            : `${Math.round(r / 1000)}k / ${Math.round(rows2d.length / 1000)}k rows`;
          processedRows = processedRowsBefore + r;
          onProgress({
            label: `Importing "${truncName}" — ${rowLabel}`,
            progress: totalRows > 0 ? Math.round(5 + (processedRows / totalRows) * 90) : 50,
          });
          await updateDoc(
            docId,
            (d, sid, cells) => {
              for (const [k, v] of Object.entries(cells)) (d as any).sheets[sid].cells[k] = v;
            },
            sheetId, cellBatch,
          );
          cellBatch = {};
          batchCount = 0;
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }
    processedRows = processedRowsBefore + rows2d.length;

    // Flush remaining cells
    if (batchCount > 0) {
      await updateDoc(
        docId,
        (d, sid, cells) => {
          for (const [k, v] of Object.entries(cells)) (d as any).sheets[sid].cells[k] = v;
        },
        sheetId, cellBatch,
      );
    }

    // Coalesce per-cell formats into FormatRange entries
    if (cellFormats.length > 0) {
      const formats: Record<string, any> = {};
      const byKey = new Map<string, { r: number; c: number }[]>();
      for (const { r, c, fmt } of cellFormats) {
        const key = JSON.stringify(fmt);
        let list = byKey.get(key);
        if (!list) { list = []; byKey.set(key, list); }
        list.push({ r, c });
      }
      let fmtIndex = 1;
      for (const [key, positions] of byKey) {
        const fmt = JSON.parse(key);
        positions.sort((a, b) => a.r - b.r || a.c - b.c);
        const rowSpans: { r: number; cStart: number; cEnd: number }[] = [];
        let cur = { r: positions[0].r, cStart: positions[0].c, cEnd: positions[0].c };
        for (let i = 1; i < positions.length; i++) {
          const p = positions[i];
          if (p.r === cur.r && p.c === cur.cEnd + 1) {
            cur.cEnd = p.c;
          } else {
            rowSpans.push({ ...cur });
            cur = { r: p.r, cStart: p.c, cEnd: p.c };
          }
        }
        rowSpans.push(cur);
        const merged: { rStart: number; rEnd: number; cStart: number; cEnd: number }[] = [];
        for (const span of rowSpans) {
          const prev = merged.length > 0 ? merged[merged.length - 1] : null;
          if (prev && prev.cStart === span.cStart && prev.cEnd === span.cEnd && prev.rEnd + 1 === span.r) {
            prev.rEnd = span.r;
          } else {
            merged.push({ rStart: span.r, rEnd: span.r, cStart: span.cStart, cEnd: span.cEnd });
          }
        }
        for (const rect of merged) {
          formats[sid()] = {
            index: fmtIndex++,
            rangeRowStart: rowIds[rect.rStart],
            rangeRowEnd: rowIds[rect.rEnd],
            rangeColStart: colIds[rect.cStart],
            rangeColEnd: colIds[rect.cEnd],
            format: fmt,
          };
        }
      }
      await updateDoc(
        docId,
        (d, sid, fmts) => { (d as any).sheets[sid].formats = fmts; },
        sheetId, formats,
      );
    }

    // Import conditional formatting rules
    const condFormattings = (ws as any).conditionalFormattings;
    if (condFormattings && Array.isArray(condFormattings) && condFormattings.length > 0) {
      const condRules: Record<string, any> = {};
      let cfIndex = 1;

      for (const cf of condFormattings) {
        const ref = cf.ref || '';
        for (const xlRule of (cf.rules || [])) {
          // Map ExcelJS rule type/operator to our conditionType
          let conditionType: string | null = null;
          let conditionValue: string | undefined;

          if (xlRule.type === 'cellIs' && xlRule.operator && operatorMap[xlRule.operator]) {
            conditionType = operatorMap[xlRule.operator];
            conditionValue = xlRule.formulae?.[0]?.toString();
          } else if (xlRule.type === 'containsText') {
            conditionType = 'textContains';
            conditionValue = xlRule.text;
          } else if (xlRule.type === 'beginsWith') {
            conditionType = 'textStartsWith';
            conditionValue = xlRule.text;
          } else if (xlRule.type === 'endsWith') {
            conditionType = 'textEndsWith';
            conditionValue = xlRule.text;
          } else if (xlRule.type === 'expression') {
            conditionType = 'customFormula';
            const rawFormula = xlRule.formulae?.[0]?.toString();
            if (rawFormula) {
              try {
                const sheetLookup = sheetIdToRowColIds.get(sheetId)!;
                conditionValue = a1ToInternal('=' + rawFormula, 0, 0, rowIds, colIds, lookupSheetId, lookupSheetRowColIds, sheetLookup.onMissingRow, sheetLookup.onMissingCol);
              } catch {
                conditionValue = rawFormula;
              }
            }
          }

          if (!conditionType) continue;

          // Parse ref into ranges (space-separated in Excel, e.g. "A1:C10 E1:E20")
          const ranges: Record<string, any> = {};
          const refs = ref.split(/[\s,]+/);
          for (const r of refs) {
            const parsed = parseExcelRef(r.trim(), rowIds, colIds);
            if (parsed) ranges[sid()] = parsed;
          }
          if (Object.keys(ranges).length === 0) continue;

          // Extract style from rule
          const format: Record<string, any> = {};
          const style = xlRule.style;
          if (style?.font?.bold) format.bold = true;
          if (style?.font?.italic) format.italic = true;
          if (style?.font?.underline) format.underline = true;
          if (style?.font?.strike) format.strikethrough = true;
          if (style?.font?.name) format.fontFamily = style.font.name;
          if (style?.font?.size) format.fontSize = style.font.size;
          const textColor = argbToHex(style?.font?.color);
          if (textColor) format.textColor = textColor;
          // DXF fills use bgColor (not fgColor) for the cell background
          if (style?.fill) {
            const bgColor = argbToHex((style.fill as any).fgColor) || argbToHex((style.fill as any).bgColor);
            if (bgColor) format.bgColor = bgColor;
          }
          if (style?.numFmt) format.numFmt = style.numFmt;
          if (style?.alignment?.horizontal && style.alignment.horizontal !== 'general') format.hAlign = style.alignment.horizontal;
          if (style?.alignment?.vertical) format.vAlign = style.alignment.vertical;
          if (style?.alignment?.wrapText) format.wrapText = true;
          if (style?.border?.top) { const b = mapBorder(style.border.top); if (b) format.borderTop = b; }
          if (style?.border?.bottom) { const b = mapBorder(style.border.bottom); if (b) format.borderBottom = b; }
          if (style?.border?.left) { const b = mapBorder(style.border.left); if (b) format.borderLeft = b; }
          if (style?.border?.right) { const b = mapBorder(style.border.right); if (b) format.borderRight = b; }

          condRules[sid()] = {
            index: cfIndex++,
            ranges,
            conditionType,
            ...(conditionValue !== undefined ? { conditionValue } : {}),
            format,
          };
        }
      }

      if (Object.keys(condRules).length > 0) {
        await updateDoc(
          docId,
          (d, sid, rules) => { (d as any).sheets[sid].conditionalFormats = rules; },
          sheetId, condRules,
        );
      }
    }

  }

  // Final pass: sync rows/columns auto-created by cross-sheet formula refs
  for (const sd of sheetDefs) {
    const sentRows = sentRowCounts.get(sd.sheetId) ?? 0;
    const sentCols = sentColCounts.get(sd.sheetId) ?? 0;
    if (sd.rowIds.length > sentRows || sd.colIds.length > sentCols) {
      const newRows: Record<string, { index: number }> = {};
      const newCols: Record<string, { index: number }> = {};
      for (let i = sentRows; i < sd.rowIds.length; i++) newRows[sd.rowIds[i]] = sd.rowsMap[sd.rowIds[i]];
      for (let i = sentCols; i < sd.colIds.length; i++) newCols[sd.colIds[i]] = sd.columns[sd.colIds[i]];
      await updateDoc(
        docId,
        (d, sid, nr, nc) => {
          for (const [k, v] of Object.entries(nr)) (d as any).sheets[sid].rows[k] = v;
          for (const [k, v] of Object.entries(nc)) (d as any).sheets[sid].columns[k] = v;
        },
        sd.sheetId, newRows, newCols,
      );
    }
  }

  return docId;
}
