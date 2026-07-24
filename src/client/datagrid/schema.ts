import {
  type ValidationError, type DocSchemaPlugin,
  str, num, bool, obj, record,
  HEX_COLOR_RE,
} from '../../shared/schemas/core';

/**
 * Sheet / column / row ids are all minted by `shortId()`
 * (`Math.random().toString(36).slice(2, 10)`), i.e. up to 8 base-36 chars. The
 * lenient bound tolerates the odd short draw. Cell keys (`rowId:colId`) are
 * validated more thoroughly — including that both halves exist — in checkDeps.
 */
export const DATAGRID_ID_RE = /^[0-9a-z]{1,12}$/;

export interface DataGridColumn {
  index: number;
  name: string;
  width?: number;
  hidden?: boolean;
  frozen?: boolean;
}

export interface DataGridRow {
  index: number;
  height?: number;
  hidden?: boolean;
  frozen?: boolean;
}

export interface DataGridBorder {
  style?: string;
  color?: string;
}

export interface DataGridCellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  bgColor?: string;
  hAlign?: string;
  vAlign?: string;
  wrapText?: boolean;
  numFmt?: string;
  borderTop?: DataGridBorder;
  borderBottom?: DataGridBorder;
  borderLeft?: DataGridBorder;
  borderRight?: DataGridBorder;
}

export interface DataGridCell {
  value: string;
}

export interface FormatRange {
  index: number;
  rangeRowStart: string;
  rangeRowEnd: string;
  rangeColStart: string;
  rangeColEnd: string;
  format: DataGridCellFormat;
}

export interface ConditionalFormatRange {
  rangeRowStart: string;
  rangeRowEnd: string;
  rangeColStart: string;
  rangeColEnd: string;
}

export interface ConditionalFormatRule {
  index: number;
  ranges: Record<string, ConditionalFormatRange>;
  conditionType: string;
  conditionValue?: string;
  format: DataGridCellFormat;
}

export interface DataGridSheet {
  '@type': 'Sheet';
  name: string;
  index: number;
  hidden?: boolean;
  columns: Record<string, DataGridColumn>;
  rows: Record<string, DataGridRow>;
  cells: Record<string, DataGridCell>;
  formats?: Record<string, FormatRange>;
  conditionalFormats?: Record<string, ConditionalFormatRule>;
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
  frozen: bool({ optional: true }),
});

const dataGridRowSchema = obj({
  index: num({ min: 0 }),
  height: num({ min: 0, optional: true }),
  hidden: bool({ optional: true }),
  frozen: bool({ optional: true }),
});

const dataGridBorderSchema = obj({
  style: str({ enum: ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'], optional: true }),
  color: str({ pattern: HEX_COLOR_RE, optional: true }),
}, { optional: true });

const dataGridCellFormatSchema = obj({
  bold: bool({ optional: true }),
  italic: bool({ optional: true }),
  underline: bool({ optional: true }),
  strikethrough: bool({ optional: true }),
  fontFamily: str({ optional: true }),
  fontSize: num({ min: 1, max: 400, optional: true }),
  // Colors are written exclusively by <input type="color"> / the preset swatches,
  // which always emit `#rrggbb`; HEX_COLOR_RE also tolerates `#rgb`/`#rrggbbaa`.
  textColor: str({ pattern: HEX_COLOR_RE, optional: true }),
  bgColor: str({ pattern: HEX_COLOR_RE, optional: true }),
  hAlign: str({ enum: ['left', 'center', 'right', 'justify'], optional: true }),
  vAlign: str({ enum: ['top', 'middle', 'bottom'], optional: true }),
  wrapText: bool({ optional: true }),
  numFmt: str({ optional: true }),
  borderTop: dataGridBorderSchema,
  borderBottom: dataGridBorderSchema,
  borderLeft: dataGridBorderSchema,
  borderRight: dataGridBorderSchema,
}, { optional: true });

const dataGridCellSchema = obj({
  value: str(),
});

const formatRangeSchema = obj({
  index: num({ min: 0 }),
  rangeRowStart: str(),
  rangeRowEnd: str(),
  rangeColStart: str(),
  rangeColEnd: str(),
  format: dataGridCellFormatSchema,
});

const conditionalFormatRangeSchema = obj({
  rangeRowStart: str(),
  rangeRowEnd: str(),
  rangeColStart: str(),
  rangeColEnd: str(),
});

const conditionalFormatRuleSchema = obj({
  index: num({ min: 0 }),
  ranges: record(conditionalFormatRangeSchema),
  conditionType: str({ enum: ['gt', 'lt', 'eq', 'neq', 'gte', 'lte',
    'textContains', 'textStartsWith', 'textEndsWith',
    'isEmpty', 'isNotEmpty', 'customFormula'] }),
  conditionValue: str({ optional: true }),
  format: dataGridCellFormatSchema,
});

const dataGridSheetSchema = obj({
  '@type': str({ enum: ['Sheet'] }),
  name: str(),
  index: num(),
  hidden: bool({ optional: true }),
  columns: record(dataGridColumnSchema, { keyPattern: DATAGRID_ID_RE }),
  rows: record(dataGridRowSchema, { keyPattern: DATAGRID_ID_RE }),
  cells: record(dataGridCellSchema),
  formats: record(formatRangeSchema, { optional: true }),
  conditionalFormats: record(conditionalFormatRuleSchema, { optional: true }),
});

export const dataGridDocumentSchema = obj({
  '@type': str({ enum: ['DataGrid'] }),
  name: str(),
  description: str({ optional: true }),
  sheets: record(dataGridSheetSchema, { keyPattern: DATAGRID_ID_RE }),
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

  const formats = sheet.formats;
  if (formats) {
    for (const [id, fmt] of Object.entries(formats)) {
      validateRangeIds(fmt, id, rows, columns, [...pathPrefix, 'formats'], errors);
    }
  }

  const conditionalFormats = sheet.conditionalFormats;
  if (conditionalFormats) {
    for (const [id, rule] of Object.entries(conditionalFormats)) {
      const ranges = (rule as any).ranges;
      if (ranges) {
        for (const [rangeId, range] of Object.entries(ranges)) {
          validateRangeIds(range, `${id}.ranges.${rangeId}`, rows, columns, [...pathPrefix, 'conditionalFormats'], errors);
        }
      }
    }
  }

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

function validateRangeIds(
  rangeObj: any,
  rangeId: string,
  rows: Record<string, any>,
  columns: Record<string, any>,
  pathPrefix: string[],
  errors: ValidationError[],
): void {
  // A range is stored as start/end row+column IDs. Beyond checking those IDs
  // exist, a "reversed" range (start after end, e.g. an A1 range entered as
  // `C10:A1`) silently matches no cells at render time — the containment test
  // requires start <= idx <= end. We compare the entities' `.index` because the
  // renderers order rows/columns by that field.
  const checkAxis = (
    startField: 'rangeRowStart' | 'rangeColStart',
    endField: 'rangeRowEnd' | 'rangeColEnd',
    entities: Record<string, any>,
    kind: 'row' | 'column',
  ) => {
    const startId = rangeObj[startField];
    const endId = rangeObj[endField];
    const startExists = typeof startId === 'string' && startId in entities;
    const endExists = typeof endId === 'string' && endId in entities;

    if (typeof startId === 'string' && !startExists) {
      errors.push({
        path: [...pathPrefix, rangeId, startField],
        message: `References non-existent ${kind} "${startId}"`,
        kind: 'dependency',
      });
    }
    if (typeof endId === 'string' && !endExists) {
      errors.push({
        path: [...pathPrefix, rangeId, endField],
        message: `References non-existent ${kind} "${endId}"`,
        kind: 'dependency',
      });
    }

    if (startExists && endExists) {
      const startIdx = entities[startId]?.index;
      const endIdx = entities[endId]?.index;
      if (typeof startIdx === 'number' && typeof endIdx === 'number' && startIdx > endIdx) {
        errors.push({
          path: [...pathPrefix, rangeId, startField],
          message: `Range ${kind} start "${startId}" is after end "${endId}" (reversed range)`,
          kind: 'dependency',
        });
      }
    }
  };

  checkAxis('rangeRowStart', 'rangeRowEnd', rows, 'row');
  checkAxis('rangeColStart', 'rangeColEnd', columns, 'column');
}

/** Worker-safe plugin core — registered in src/shared/schemas (validation) and
 * spread into the full data-grid plugin (src/client/datagrid/plugin.tsx). */
export const dataGridSchemaPlugin: DocSchemaPlugin = {
  type: 'DataGrid',
  schema: dataGridDocumentSchema,
  checkDeps: checkDataGridDependencies,
};