import type { DocTypePlugin, DocViewProps } from '../types';
import { kitchenSchemaPlugin } from '../../../../shared/schemas/kitchen';
import { lazyView } from '../../common/lazy-view';

const Kitchen = lazyView(() => import('./Kitchen').then(m => m.Kitchen));

/** The open recipe rides in the URL as `recipe/<id>` — the only kitchen state
 * the URL carries. Must be recomputed every render so back/forward-driven rest
 * changes keep reaching the view (see datagrid/plugin.tsx). */
function recipeIdFromRest(rest?: string): string | undefined {
  const id = rest?.match(/^recipe\/([^/]+)/)?.[1];
  return id === undefined ? undefined : decodeURIComponent(id);
}

function KitchenView(p: DocViewProps) {
  return <Kitchen docId={p.docId} recipeId={recipeIdFromRest(p.rest)} readOnly={p.readOnly} />;
}

export const kitchenPlugin: DocTypePlugin = {
  ...kitchenSchemaPlugin,
  label: 'kitchen',
  icon: 'skillet',
  createLabel: 'Kitchen',
  createInitialDoc: name => ({ '@type': 'Kitchen', name, recipes: {}, inventory: {}, cookLog: {}, shopping: {} }),
  View: KitchenView,
};
