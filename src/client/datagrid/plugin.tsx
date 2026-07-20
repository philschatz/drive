import type { DocTypePlugin, DocViewProps } from '../doc-plugins/types';
import { dataGridSchemaPlugin } from './schema';
import { DataGrid } from './DataGrid';

const sid = () => Math.random().toString(36).slice(2, 10);

/** The grid's sheet selection rides in the URL as `sheets/<sheetId>[/<rest>]`.
 * Split it out of the generic rest so DataGrid keeps its dedicated sheetId prop.
 * Must be recomputed every render so back/forward-driven rest changes keep
 * reaching DataGrid's sheet-switch effect. */
function splitGridRest(rest?: string): { sheetId?: string; rest?: string } {
  const m = rest?.match(/^sheets\/([^/]+)(?:\/(.*))?$/);
  return m ? { sheetId: m[1], rest: m[2] || undefined } : { rest };
}

function DataGridView(p: DocViewProps) {
  const g = splitGridRest(p.rest);
  return <DataGrid docId={p.docId} sheetId={g.sheetId} rest={g.rest} readOnly={p.readOnly} />;
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
