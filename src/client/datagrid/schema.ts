import {
  type ValidationError,
  str, num, bool, obj, record,
} from '../../shared/schemas/core';

export interface DataGridColumn {
  index: number;
  name: string;
  width?: number;
  hidden?: boolean;
}

export interface DataGridRow {
  index: number;
  height?: number;
  hidden?: boolean;
}

export interface DataGridCell {
  value: string;
}

export interface DataGridSheet {
  '@type': 'Sheet';
  name: string;
  index: number;
  hidden?: boolean;
  columns: Record<string, DataGridColumn>;
  rows: Record<string, DataGridRow>;
  cells: Record<string, DataGridCell>;
}

export interface DataGridDocument {
  '@type': 'DataGrid';
  name: string;
  description?: string;
  sheets: Record<string, DataGridSheet>;
}

const dataGridColumnSchema = obj({
  index: num({ min: 0 }),
  name: str({ optional: true }),
  width: num({ min: 0, optional: true }),
  hidden: bool({ optional: true }),
});

const dataGridRowSchema = obj({
  index: num({ min: 0 }),
  height: num({ min: 0, optional: true }),
  hidden: bool({ optional: true }),
});

const dataGridCellSchema = obj({
  value: str(),
});

const dataGridSheetSchema = obj({
  '@type': str({ enum: ['Sheet'] }),
  name: str(),
  index: num(),
  hidden: bool({ optional: true }),
  columns: record(dataGridColumnSchema),
  rows: record(dataGridRowSchema),
  cells: record(dataGridCellSchema),
});

export const dataGridDocumentSchema = obj({
  '@type': str({ enum: ['DataGrid'] }),
  name: str(),
  description: str({ optional: true }),
  sheets: record(dataGridSheetSchema),
});

function checkSheetDependencies(
  sheet: any,
  sheetId: string,
  allSheets: Record<string, any>,
  allSheetIds: ReadonlySet<string>,
  pathPrefix: string[],
  errors: ValidationError[],
): void {
  const columns = sheet.columns;
  const rows = sheet.rows;
  const cells = sheet.cells;

  if (!columns || !rows || !cells) return;

  const colIds = new Set(Object.keys(columns));
  const rowIds = new Set(Object.keys(rows));

  const colIndices = new Map<number, string>();
  for (const [id, col] of Object.entries(columns)) {
    const idx = (col as any).index;
    if (colIndices.has(idx)) {
      errors.push({
        path: [...pathPrefix, 'columns', id, 'index'],
        message: `Duplicate column index ${idx} (also used by column "${colIndices.get(idx)}")`,
        kind: 'dependency',
      });
    } else {
      colIndices.set(idx, id);
    }
  }

  const rowIndicesMap = new Map<number, string>();
  for (const [id, row] of Object.entries(rows)) {
    const idx = (row as any).index;
    if (rowIndicesMap.has(idx)) {
      errors.push({
        path: [...pathPrefix, 'rows', id, 'index'],
        message: `Duplicate row index ${idx} (also used by row "${rowIndicesMap.get(idx)}")`,
        kind: 'dependency',
      });
    } else {
      rowIndicesMap.set(idx, id);
    }
  }

  for (const [key, cell] of Object.entries(cells)) {
    const sep = key.indexOf(':');
    if (sep === -1) {
      errors.push({ path: [...pathPrefix, 'cells', key], message: `Cell key "${key}" is not in rowId:colId format`, kind: 'dependency' });
      continue;
    }
    const rowId = key.substring(0, sep);
    const colId = key.substring(sep + 1);
    if (!rowIds.has(rowId)) {
      errors.push({ path: [...pathPrefix, 'cells', key], message: `Cell references non-existent row "${rowId}"`, kind: 'dependency' });
    }
    if (!colIds.has(colId)) {
      errors.push({ path: [...pathPrefix, 'cells', key], message: `Cell references non-existent column "${colId}"`, kind: 'dependency' });
    }

    const value = (cell as any)?.value;
    if (typeof value === 'string' && value.startsWith('=')) {
      // Validate formula references: {R{id}C{id}}, {C{id}} (whole-col), {R{id}} (whole-row)
      const refPattern = /\{(?:R(\{([^}]+)\}|\[[^\]]*\]))?(?:C(\{([^}]+)\}|\[[^\]]*\]))?(?:S\{([^}]+)\})?\}/g;
      let match;
      while ((match = refPattern.exec(value)) !== null) {
        // Skip if neither R nor C part was captured (empty match)
        if (!match[1] && !match[3]) continue;
        const absRowId = match[2]; // captured from R{...}
        const absColId = match[4]; // captured from C{...}
        const referencedSheetId = match[5];
        if (referencedSheetId && !allSheetIds.has(referencedSheetId)) {
          errors.push({
            path: [...pathPrefix, 'cells', key, 'value'],
            message: `Formula references non-existent sheet "${referencedSheetId}"`,
            kind: 'dependency',
          });
        }
        // Validate row/col IDs against the target sheet (or current sheet if no S{} part)
        const targetSheet = referencedSheetId ? allSheets[referencedSheetId] : sheet;
        const targetRowIds = targetSheet?.rows ? new Set(Object.keys(targetSheet.rows)) : rowIds;
        const targetColIds = targetSheet?.columns ? new Set(Object.keys(targetSheet.columns)) : colIds;
        if (absRowId && !targetRowIds.has(absRowId)) {
          errors.push({
            path: [...pathPrefix, 'cells', key, 'value'],
            message: `Formula references non-existent row "${absRowId}"`,
            kind: 'dependency',
          });
        }
        if (absColId && !targetColIds.has(absColId)) {
          errors.push({
            path: [...pathPrefix, 'cells', key, 'value'],
            message: `Formula references non-existent column "${absColId}"`,
            kind: 'dependency',
          });
        }
      }
    }
  }
}

export function checkDataGridDependencies(doc: any, errors: ValidationError[]): void {
  const sheets = doc.sheets;
  if (!sheets) return;

  const allSheetIds = new Set(Object.keys(sheets));

  const sheetIndices = new Map<number, string>();
  for (const [id, sheet] of Object.entries(sheets)) {
    const idx = (sheet as any).index;
    if (typeof idx === 'number' && sheetIndices.has(idx)) {
      errors.push({
        path: ['sheets', id, 'index'],
        message: `Duplicate sheet index ${idx} (also used by sheet "${sheetIndices.get(idx)}")`,
        kind: 'dependency',
      });
    } else if (typeof idx === 'number') {
      sheetIndices.set(idx, id);
    }

    checkSheetDependencies(sheet, id, sheets, allSheetIds, ['sheets', id], errors);
  }
}

/** Wrap a legacy flat-structure doc into the multi-sheet shape (read-only view).
 *  Used when displaying historical snapshots that predate the multi-sheet migration. */
export function asMultiSheet(doc: any): DataGridDocument {
  if (doc.sheets) return doc;
  return {
    '@type': 'DataGrid',
    name: doc.name ?? 'Spreadsheet',
    description: doc.description,
    sheets: {
      _legacy: {
        '@type': 'Sheet',
        name: 'Sheet 1',
        index: 1,
        columns: doc.columns ?? {},
        rows: doc.rows ?? {},
        cells: doc.cells ?? {},
      },
    },
  };
}

/** Migrate a legacy flat-structure DataGrid doc to the multi-sheet format.
 *  Must run inside handle.change(). We cannot assign existing Automerge objects
 *  to a new location (they already have CRDT identities), so we create the sheet
 *  with empty containers and copy each entry individually as fresh values. */
export function migrateDataGridDocument(d: any): boolean {
  if (d.sheets) return false;
  const sid = Math.random().toString(36).slice(2, 10);
  d.sheets = { [sid]: { '@type': 'Sheet', name: 'Sheet 1', index: 1, columns: {}, rows: {}, cells: {} } };
  const sheet = d.sheets[sid];
  // Copy each entry as a fresh plain object so Automerge creates new CRDT nodes
  for (const key of Object.keys(d.columns ?? {})) {
    sheet.columns[key] = { ...d.columns[key] };
  }
  for (const key of Object.keys(d.rows ?? {})) {
    sheet.rows[key] = { ...d.rows[key] };
  }
  for (const key of Object.keys(d.cells ?? {})) {
    sheet.cells[key] = { ...d.cells[key] };
  }
  delete d.columns;
  delete d.rows;
  delete d.cells;
  return true;
}
