/**
 * The bundled example documents must validate.
 *
 * They are what a brand-new install offers to create (Home's "create examples"),
 * and nothing else checks them: `validateDocument` runs in the worker *after* a
 * document exists in the repo, and `createDocsFromItems` swallows a failed
 * payload into a banner rather than failing a build. So an example can rot
 * against a schema rule added later and the only symptom is a red badge in the
 * source inspector, seen by whoever clicks the offer first.
 *
 * Read off disk rather than through `examples/index.ts`, whose `import.meta.glob`
 * does not exist under Jest — this suite deliberately checks the *files*, so a
 * new example is covered the moment it lands in the directory.
 *
 * Every example is authored with relative-date tokens (`{{today-6d@12:41}}`,
 * `{{sa-2w@20:10}}`), so validity is a function of the day it is created on: a
 * weekday anchor resolves within the current ISO week and therefore moves
 * relative to `today`. `expandRelativeDates` takes an explicit `today`, so each
 * example is checked across a full three weeks — every weekday, and both sides
 * of a month boundary — instead of only on whatever day CI happens to run.
 */

import 'temporal-polyfill/global';
import { Temporal } from 'temporal-polyfill';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { validateDocument } from '../src/shared/schemas';
import { expandRelativeDates } from '../src/shared/relative-dates';
import { flatTextFromSpans } from '../src/shared/rich-text-ops';
import { markdownToSpans } from '../src/client/ui/doc-plugins/sentences/markdown';

const EXAMPLES = path.resolve(__dirname, '../src/client/ui/home/examples');

/** Three weeks from a Wednesday: covers every weekday and a month boundary. */
const DAYS = Array.from({ length: 21 }, (_, i) =>
  Temporal.PlainDate.from('2026-07-22').add({ days: i })
);

const files = (ext: string) => readdirSync(EXAMPLES).filter(f => f.endsWith(ext)).sort();

/** Every validation error as one readable line, so a failure names the field. */
const report = (errors: { path: (string | number)[]; message: string }[]) =>
  errors.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n');

describe('bundled example documents', () => {
  it('ships both kinds of example', () => {
    // A glob that silently matches nothing would make every test below vacuous.
    expect(files('.json').length).toBeGreaterThan(0);
    expect(files('.md').length).toBeGreaterThan(0);
  });

  describe.each(files('.json'))('%s', file => {
    const raw = JSON.parse(readFileSync(path.join(EXAMPLES, file), 'utf8'));

    it.each(DAYS.map(d => [d.toString(), d] as const))('validates when created on %s', (_label, day) => {
      const errors = validateDocument(expandRelativeDates(raw, day));
      expect(report(errors)).toBe('');
    });
  });

  // The Markdown examples become Sentences documents, whose structure lives in
  // Automerge marks and block markers rather than in the JSON. `markerFields`
  // exists so a caller outside the worker can supply that marker data itself —
  // which is what lets this run with no Automerge and no browser.
  describe.each(files('.md'))('%s', file => {
    const md = readFileSync(path.join(EXAMPLES, file), 'utf8');

    it.each(DAYS.map(d => [d.toString(), d] as const))('validates when created on %s', (_label, day) => {
      const expanded = expandRelativeDates(md, day);
      const spans = markdownToSpans(expanded);
      const name = /^#[ \t]+(.+?)[ \t]*$/m.exec(expanded)?.[1] ?? file;
      const doc = { '@type': 'Sentences', name, content: flatTextFromSpans(spans) };
      const errors = validateDocument(doc, [{ path: ['content'], spans }]);
      expect(report(errors)).toBe('');
    });
  });
});
