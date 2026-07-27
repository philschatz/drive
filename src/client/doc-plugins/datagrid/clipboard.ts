import { internalToR1C1, getDisplayValue } from './helpers';
import type { DataGridCell, DataGridCellFormat } from '../../../shared/schemas/datagrid';
import { formatToCss } from './formatting';

// ============================================================
// Shared types
// ============================================================

export type CellRange = { minRow: number; maxRow: number; minCol: number; maxCol: number };

export type ClipboardEntry = {
  values: string[][];
  formats: (DataGridCellFormat | undefined)[][];
  mode: 'copy' | 'cut';
  range: CellRange;
};

// ============================================================
// Pure utility functions
// ============================================================

export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Parse LibreOffice / Google Sheets HTML clipboard into a 2-D array of values.
 *  Prefers data-sheets-formula (R1C1) when present, falls back to text content. */
export function parseHtmlClipboard(html: string): string[][] | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells: string[] = [];
    for (const td of tr.querySelectorAll('td, th')) {
      const formula = td.getAttribute('data-sheets-formula');
      cells.push(formula ?? td.textContent ?? '');
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows.length > 0 ? rows : null;
}

/** Derive the selection range from selectedCell and selectionAnchor. */
export function getEffectiveRange(
  selectedCell: [number, number] | null,
  selectionAnchor: [number, number] | null,
): CellRange | null {
  if (!selectedCell) return null;
  if (selectionAnchor) {
    return {
      minCol: Math.min(selectedCell[0], selectionAnchor[0]),
      maxCol: Math.max(selectedCell[0], selectionAnchor[0]),
      minRow: Math.min(selectedCell[1], selectionAnchor[1]),
      maxRow: Math.max(selectedCell[1], selectionAnchor[1]),
    };
  }
  return { minRow: selectedCell[1], maxRow: selectedCell[1], minCol: selectedCell[0], maxCol: selectedCell[0] };
}

/**
 * Build clipboard payload from a sheet's cells. Returns values (R1C1 formulas), formats, TSV text, and HTML.
 *
 * `gridRowIds`/`gridColIds` index the range in the space the range is expressed in
 * (VISIBLE space, when the selection can span hidden rows/cols) and are used for
 * the cell KEY. `refRowIds`/`refColIds` (default: the grid ids) are the FULL sorted
 * ids used for R1C1 formula conversion and format-cache lookup, so A1/R1C1 labels
 * and formatCache indices stay consistent with the rest of the grid (H4).
 */
export function buildClipboardData(
  cells: Record<string, DataGridCell> | null,
  computedValues: Map<string, string | number> | null,
  range: CellRange,
  gridRowIds: string[],
  gridColIds: string[],
  sheetId: string,
  formatCache?: Map<string, DataGridCellFormat>,
  refRowIds?: string[],
  refColIds?: string[],
): { values: string[][]; formats: (DataGridCellFormat | undefined)[][]; tsv: string; html: string } | null {
  if (!cells) return null;

  const rRows = refRowIds ?? gridRowIds;
  const rCols = refColIds ?? gridColIds;

  const values: string[][] = [];
  const formats: (DataGridCellFormat | undefined)[][] = [];
  const tsvRows: string[] = [];
  const htmlTrs: string[] = [];

  for (let r = range.minRow; r <= range.maxRow; r++) {
    const row: string[] = [];
    const fmtRow: (DataGridCellFormat | undefined)[] = [];
    const tsvCols: string[] = [];
    const htmlTds: string[] = [];
    for (let c = range.minCol; c <= range.maxCol; c++) {
      const rowId = gridRowIds[r];
      const colId = gridColIds[c];
      const key = `${rowId}:${colId}`;
      const raw = cells[key]?.value || '';
      // Ref indices in the FULL sorted space (for label-consistent R1C1 + format lookup).
      const refR = refRowIds ? refRowIds.indexOf(rowId) : r;
      const refC = refColIds ? refColIds.indexOf(colId) : c;
      const clipVal = raw.startsWith('=')
        ? internalToR1C1(raw, refR, refC, rRows, rCols)
        : raw;
      row.push(clipVal);

      const cellFmt = formatCache?.get(`${refR}:${refC}`);
      fmtRow.push(cellFmt);

      tsvCols.push(clipVal);
      const display = escHtml(getDisplayValue(computedValues, raw, sheetId, rowId, colId));
      const inlineStyle = cellFmt ? formatToInlineStyle(cellFmt) : '';
      const formulaAttr = raw.startsWith('=') ? ` data-sheets-formula="${escHtml(clipVal)}"` : '';
      htmlTds.push(`<td${formulaAttr}${inlineStyle ? ` style="${escHtml(inlineStyle)}"` : ''}>${display}</td>`);
    }
    values.push(row);
    formats.push(fmtRow);
    tsvRows.push(tsvCols.join('\t'));
    htmlTrs.push(`<tr>${htmlTds.join('')}</tr>`);
  }

  const tsv = tsvRows.join('\n');
  const html = `<table><tbody>${htmlTrs.join('')}</tbody></table>`;
  return { values, formats, tsv, html };
}

function formatToInlineStyle(fmt: DataGridCellFormat): string {
  const css = formatToCss(fmt);
  if (!css) return '';
  return Object.entries(css)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}:${v}`)
    .join(';');
}

/** Write TSV + HTML to the OS clipboard, falling back to plain text. */
export function writeClipboard(tsv: string, html: string): void {
  navigator.clipboard.write([
    new ClipboardItem({
      'text/plain': new Blob([tsv], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    }),
  ]).catch(() => {
    navigator.clipboard.writeText(tsv).catch(() => {});
  });
}
