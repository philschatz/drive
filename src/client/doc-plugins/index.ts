/**
 * Registry of document-type plugins. Routing (DocRoute), Home's "New" menu and
 * document lists all dispatch through here instead of hardcoding types.
 *
 * Adding a document type = one plugin.tsx in its feature dir + one entry here
 * + its schema core in SCHEMA_PLUGINS (src/shared/schemas). This module imports
 * Preact components, so it must never be imported from src/shared/** or the
 * automerge worker.
 */
import type { DocTypePlugin } from './types';
import { calendarPlugin } from './calendar/plugin';
import { taskListPlugin } from './tasks/plugin';
import { dataGridPlugin } from './datagrid/plugin';
import { countersPlugin } from './counters/plugin';

export type { DocTypePlugin, DocViewProps } from './types';

export const DOC_PLUGINS: DocTypePlugin[] = [
  calendarPlugin,
  taskListPlugin,
  dataGridPlugin,
  countersPlugin,
];

/** Look up the plugin for a document `@type`; undefined for unknown/missing types
 * (those render in the source inspector instead). Scans the array so plugins
 * registered dynamically (pushed onto DOC_PLUGINS later) are found too. */
export function getDocPlugin(type: string | null | undefined): DocTypePlugin | undefined {
  return type ? DOC_PLUGINS.find(p => p.type === type) : undefined;
}

export function iconForType(type: string | null | undefined): string {
  return getDocPlugin(type)?.icon ?? 'help';
}

export function docTypeLabel(type: string | null | undefined): string {
  return getDocPlugin(type)?.label ?? 'document';
}
