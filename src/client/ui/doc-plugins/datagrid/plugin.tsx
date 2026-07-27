import type { DocTypePlugin, DocViewProps } from '../types';
import { dataGridSchemaPlugin } from '../../../../shared/schemas/datagrid';
import { lazyView } from '../../common/lazy-view';

const DataGrid = lazyView(() => import('./DataGrid').then(m => m.DataGrid));

const sid = () => Math.random().toString(36).slice(2, 10);

/** The grid's sheet selection rides in the URL as `sheets/<sheetId>`, the only
 * grid state the URL carries. Pull it out of the generic rest so DataGrid keeps
 * its dedicated sheetId prop. Must be recomputed every render so
 * back/forward-driven rest changes keep reaching DataGrid's sheet-switch effect. */
function gridSheetId(rest?: string): string | undefined {
  return rest?.match(/^sheets\/([^/]+)/)?.[1];
}

function DataGridView(p: DocViewProps) {
  return <DataGrid docId={p.docId} sheetId={gridSheetId(p.rest)} readOnly={p.readOnly} />;
}

export const dataGridPlugin: DocTypePlugin = {
  ...dataGridSchemaPlugin,
  label: 'spreadsheet',
  icon: 'grid_on',
  createLabel: 'Spreadsheet',
  createInitialDoc: name => {
    const rows: Record<string, { index: number }> = {};
    for (let i = 1; i <= 10; i++) rows[sid()] = { index: i };
    return {
      '@type': 'DataGrid',
      name,
      sheets: {
        [sid()]: {
          '@type': 'Sheet',
          name: 'Sheet 1',
          index: 1,
          columns: { [sid()]: { index: 1 }, [sid()]: { index: 2 }, [sid()]: { index: 3 } },
          rows,
          cells: {},
        },
      },
    };
  },
  View: DataGridView,
};
