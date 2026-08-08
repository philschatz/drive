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
export type { RichTextDecl } from './core';
export { validateNode, schemaAt, richTextPathsFor, validateMarkers } from './core';

import { type ValidationError, type DocSchemaPlugin, validateNode, schemaAt, validateMarkers, richTextPathsFor } from './core';
import { markersFromSpans, strayBlockMarkers, type RichTextSpan } from '../rich-text-ops';
import { calendarSchemaPlugin } from './calendar';
import { taskListSchemaPlugin } from './tasks';
import { dataGridSchemaPlugin } from './datagrid';
import { countersSchemaPlugin } from './counters';
import { sentencesSchemaPlugin } from './sentences';
import { driveSettingsSchemaPlugin, DRIVE_SETTINGS_TYPE, createDriveSettingsDocJson } from './drive-settings';

/** DriveSettings special-case surface shared with the engine (type + fresh-doc seed). */
export { DRIVE_SETTINGS_TYPE, createDriveSettingsDocJson } from './drive-settings';

/** Every known document type's validation core. Adding a document type means
 * registering its schema core here and its full plugin in src/client/doc-plugins.
 * `DriveSettings` is the exception: it has no editor View, so it is registered
 * here (validation) but intentionally NOT in DOC_PLUGINS. */
export const SCHEMA_PLUGINS: DocSchemaPlugin[] = [
  calendarSchemaPlugin,
  taskListSchemaPlugin,
  dataGridSchemaPlugin,
  countersSchemaPlugin,
  sentencesSchemaPlugin,
  driveSettingsSchemaPlugin,
];

/** A field's Peritext spans, read from Automerge by the caller (see below). */
export interface MarkerField {
  path: (string | number)[];
  spans: RichTextSpan[];
}

/**
 * The marker data for every path this document's schema declares as rich text.
 * The caller supplies `readSpans` (i.e. `Automerge.spans` bound to the doc)
 * because this module must never import Automerge; it returns undefined for a
 * path that isn't a text field.
 *
 * This is the schema doing the discovery — cost is bounded by the declaration,
 * so a document type that declares no rich text pays nothing.
 */
export function markerFieldsFor(
  doc: unknown,
  readSpans: (path: (string | number)[]) => RichTextSpan[] | undefined,
): MarkerField[] {
  if (!doc || typeof doc !== 'object') return [];
  const plugin = SCHEMA_PLUGINS.find(p => p.type === (doc as any)['@type']);
  if (!plugin) return [];
  const fields: MarkerField[] = [];
  for (const path of richTextPathsFor(plugin.schema, doc)) {
    const spans = readSpans(path);
    if (spans) fields.push({ path, spans });
  }
  return fields;
}

/**
 * Validate an Automerge document against its schema and data-dependency rules.
 * Returns an empty array if the document is valid. Scans the array so schema
 * cores registered dynamically (pushed onto SCHEMA_PLUGINS later) are found too.
 *
 * `markerFields` is marker DATA, not a declaration, and must be supplied by the
 * caller: this module is pure and projection-based — the CalDAV server and the
 * CLI import it, and it must never touch Automerge — while markers only exist
 * inside the WASM document. The schema says which paths to look at
 * (`richTextPathsFor`); the caller does the looking. Omit it and marker
 * validation is simply skipped.
 */
export function validateDocument(doc: unknown, markerFields?: MarkerField[]): ValidationError[] {
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
  for (const field of markerFields ?? []) {
    validateMarkers(markersFromSpans(field.spans), schemaAt(plugin.schema, field.path), field.path, errors);
    // A literal `￼` means this field's rich text was flattened. Worth its own
    // error because the projection cannot show it: the string reads identically
    // whether its markers are real or were turned into characters.
    const stray = strayBlockMarkers(field.spans);
    if (stray.length > 0) {
      errors.push({
        path: field.path,
        message: `Contains ${stray.length} literal U+FFFC character${stray.length === 1 ? '' : 's'} (at ${stray.join(', ')}) instead of block markers — this field's rich text was flattened`,
      });
    }
  }
  return errors;
}
