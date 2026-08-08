import {
  type ValidationError, type DocSchemaPlugin,
  str, obj, num, bool, json,
} from './core';

/**
 * Sentences — the word-processing document type. `content` is an Automerge Peritext text field:
 * inline formatting lives in marks and block structure in block markers —
 * neither is visible to the JSON projection, where `content` is a flat string
 * with a `￼` (object-replacement) character per block marker. Rich structure
 * reaches the UI as spans (see `spansPath` on subscribeQuery) and mutations go
 * through plain-JSON rich-text ops (src/shared/rich-text-ops.ts).
 *
 * The block and mark vocabulary is declared on `content` below rather than
 * described here, so it is enforced: `validateMarkers` checks the markers a
 * caller reads out of Automerge against it (the engine does this on every change
 * for every path `richTextPathsFor` returns). `parents` — the nesting chain — is
 * deliberately unconstrained.
 */
export interface SentencesDocument {
  '@type': 'Sentences';
  name: string;
  content: string;
}

export const sentencesSchema = obj({
  '@type': str({ enum: ['Sentences'] }),
  name: str(),
  content: str({
    richText: {
      // strong/em are valueless in the UI sense; Automerge always stores *a*
      // value, and this app's is `true`.
      marks: {
        strong: bool({ literal: true }),
        em: bool({ literal: true }),
        link: json(obj({ href: str() })),
      },
      // An `ordered-list-item` `start` or a code block's `language` would be
      // declared here; neither is implemented.
      blocks: {
        paragraph: obj({}),
        heading: obj({ level: num({ min: 1, max: 6, integer: true }) }),
        'unordered-list-item': obj({}),
        'ordered-list-item': obj({}),
        blockquote: obj({}),
        divider: obj({}),
      },
    },
  }),
});

export function checkSentencesDependencies(_doc: any, _errors: ValidationError[]): void {
  // Nothing cross-field to check: the shape is three scalars, and everything
  // structural lives in markers, which `validateMarkers` handles from the
  // `richText` declaration above.
}

/** Worker-safe plugin core — registered in src/shared/schemas (validation) and
 * spread into the full document plugin (./plugin.tsx). */
export const sentencesSchemaPlugin: DocSchemaPlugin = {
  type: 'Sentences',
  schema: sentencesSchema,
  checkDeps: checkSentencesDependencies,
};
