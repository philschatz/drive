/**
 * JSON Schemas and validation for Automerge document types.
 *
 * Re-exports all public types and per-type validators from sub-modules.
 * `validateDocument` dispatches to the correct schema by `@type`.
 */

export type { ValidationError } from './core';
export type {
  UTCDateTime, LocalDateTime, Duration, PatchObject,
  Relation, RelationType,
  Link, VirtualLocation, Location, Participant,
  Alert, OffsetTrigger, AbsoluteTrigger,
  TimeZone, TimeZoneRule,
} from './core';
export { validateNode } from './core';
export { validateCalendarEvent } from '../../client/calendar/schema';
export type { CalendarDocument, CalendarEvent, RecurrenceRule, NDay } from '../../client/calendar/schema';
export { validateTask } from '../../client/tasks/schema';
export type { TaskDocument, Task } from '../../client/tasks/schema';
export type { DataGridDocument, DataGridSheet, DataGridColumn, DataGridRow, DataGridCell } from '../../client/datagrid/schema';
export { migrateDataGridDocument } from '../../client/datagrid/schema';

import { type ValidationError, type SchemaNode, validateNode } from './core';
import { calendarDocumentSchema, checkCalendarDependencies } from '../../client/calendar/schema';
import { taskDocumentSchema, checkTaskDependencies } from '../../client/tasks/schema';
import { dataGridDocumentSchema, checkDataGridDependencies } from '../../client/datagrid/schema';

const SCHEMAS: Record<string, { schema: SchemaNode; checkDeps: (doc: any, errors: ValidationError[]) => void }> = {
  Calendar: { schema: calendarDocumentSchema, checkDeps: checkCalendarDependencies },
  TaskList: { schema: taskDocumentSchema, checkDeps: checkTaskDependencies },
  DataGrid: { schema: dataGridDocumentSchema, checkDeps: checkDataGridDependencies },
};

/**
 * Validate an Automerge document against its schema and data-dependency rules.
 * Returns an empty array if the document is valid.
 */
export function validateDocument(doc: unknown): ValidationError[] {
  if (!doc || typeof doc !== 'object') {
    return [{ path: [], message: 'Document is not an object' }];
  }

  const docType = (doc as any)['@type'];
  const entry = SCHEMAS[docType];
  if (!entry) {
    return [{ path: ['@type'], message: `Unknown document type "${docType}"` }];
  }

  const errors: ValidationError[] = [];
  validateNode(doc, entry.schema, [], errors);
  entry.checkDeps(doc, errors);
  return errors;
}
