/**
 * Document validation, dispatched through the worker-safe halves of the
 * document-type plugins (see DocSchemaPlugin in ./core).
 *
 * `validateDocument` runs inside the automerge worker after every document
 * change — local edits and synced remote edits alike — and on the main thread
 * for the source inspector. WORKER BOUNDARY: this module (and everything it
 * imports, including the feature schema modules below) must never import
 * Preact/UI code such as src/client/doc-plugins or any plugin.tsx.
 */

export type { ValidationError, DocSchemaPlugin } from './core';
export type {
  UTCDateTime, LocalDateTime, Duration, PatchObject,
  Relation, RelationType,
  Link, VirtualLocation, Location, Participant,
  Alert, OffsetTrigger, AbsoluteTrigger,
  TimeZone, TimeZoneRule,
} from './core';
export { validateNode } from './core';

import { type ValidationError, type DocSchemaPlugin, validateNode } from './core';
import { calendarSchemaPlugin } from '../../client/calendar/schema';
import { taskListSchemaPlugin } from '../../client/tasks/schema';
import { dataGridSchemaPlugin } from '../../client/datagrid/schema';
import { countersSchemaPlugin } from '../../client/counters/schema';

/** Every known document type's validation core. Adding a document type means
 * registering its schema core here and its full plugin in src/client/doc-plugins. */
export const SCHEMA_PLUGINS: DocSchemaPlugin[] = [
  calendarSchemaPlugin,
  taskListSchemaPlugin,
  dataGridSchemaPlugin,
  countersSchemaPlugin,
];

/**
 * Validate an Automerge document against its schema and data-dependency rules.
 * Returns an empty array if the document is valid. Scans the array so schema
 * cores registered dynamically (pushed onto SCHEMA_PLUGINS later) are found too.
 */
export function validateDocument(doc: unknown): ValidationError[] {
  if (!doc || typeof doc !== 'object') {
    return [{ path: [], message: 'Document is not an object' }];
  }

  const docType = (doc as any)['@type'];
  const plugin = SCHEMA_PLUGINS.find(p => p.type === docType);
  if (!plugin) {
    return [{ path: ['@type'], message: `Unknown document type "${docType}"` }];
  }

  const errors: ValidationError[] = [];
  validateNode(doc, plugin.schema, [], errors);
  plugin.checkDeps(doc, errors);
  return errors;
}
