import type { ComponentType } from 'preact';
import type { DocSchemaPlugin } from '../../../shared/schemas';

export interface DocViewProps {
  docId: string;
  /** Deep-link remainder after the docId in `#/d/<docId>/<rest>`, owned by the
   * plugin — e.g. `events/<uid>`, `tasks/<uid>`, `sheets/<sid>/cells/<r>:<c>`. */
  rest?: string;
  /** Set when the user must not edit: view-only access, or an older document version. */
  readOnly?: boolean;
}

/**
 * A document-type plugin: everything drive needs to validate, create, list and
 * render one `@type`. Extends the worker-safe DocSchemaPlugin (type + schema +
 * checkDeps — see src/shared/schemas/core.ts), whose validation runs after every
 * edit, local or synced. Register instances in src/client/doc-plugins/index.ts.
 */
export interface DocTypePlugin extends DocSchemaPlugin {
  /** Lowercase noun for prose ("calendar", "task list", "spreadsheet"). */
  label: string;
  /** Material Symbols icon name shown in document lists. */
  icon: string;
  /** Item label in Home's "New" menu. */
  createLabel: string;
  /** Initial Automerge JSON for a new document of this type. */
  createInitialDoc: (name: string) => Record<string, unknown>;
  /** Renders the document editor; the readOnly prop flips it into a viewer. */
  View: ComponentType<DocViewProps>;
}
