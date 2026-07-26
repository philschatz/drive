import {
  type ValidationError, type DocSchemaPlugin,
  str, obj,
} from '../../../shared/schemas/core';

/**
 * Sentences — the word-processing document type. `content` is an Automerge Peritext text field:
 * inline formatting lives in marks and block structure in block markers —
 * neither is visible to the JSON projection, where `content` is a flat string
 * with a `￼` (object-replacement) character per block marker. Rich structure
 * reaches the UI as spans (see `spansPath` on subscribeQuery) and mutations go
 * through plain-JSON rich-text ops (src/shared/rich-text-ops.ts).
 *
 * Block vocabulary (`type` + `parents` nesting chain):
 *   paragraph | heading (attrs.level 1–6) | unordered-list-item |
 *   ordered-list-item | blockquote | divider
 * Inline marks: strong, em, link (value = JSON string {"href"}).
 */
export interface SentencesDocument {
  '@type': 'Sentences';
  name: string;
  content: string;
}

export const sentencesSchema = obj({
  '@type': str({ enum: ['Sentences'] }),
  name: str(),
  content: str(),
});

export function checkSentencesDependencies(_doc: any, _errors: ValidationError[]): void {
  // Structure lives in marks/block markers, which the JSON projection (and so
  // this validator) cannot see — nothing beyond the schema shape to check.
}

/** Worker-safe plugin core — registered in src/shared/schemas (validation) and
 * spread into the full document plugin (./plugin.tsx). */
export const sentencesSchemaPlugin: DocSchemaPlugin = {
  type: 'Sentences',
  schema: sentencesSchema,
  checkDeps: checkSentencesDependencies,
};
