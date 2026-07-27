/**
 * JSON / Markdown document creation, shared by Home's file importer and the
 * "create examples" offer on the empty home page. Loaded via dynamic import so
 * the Sentences markdown parser stays out of the main chunk.
 */

import { createDoc, updateDoc, richText } from '../worker-api';
import { markdownToSpans } from '@/doc-plugins/sentences/markdown';
import { expandRelativeDates } from '../../../shared/relative-dates';

/**
 * A pending import. `json` is a whole document; `markdown` becomes a Sentences
 * document (see `createDocsFromItems`). Also the shape `examples/` returns.
 */
export type ImportItem =
  | { kind: 'json'; label: string; read: () => Promise<any> }
  | { kind: 'markdown'; label: string; read: () => Promise<string> };

/** Progress-banner state shared by all of Home's importers. */
export type ImportProgress = { label: string; progress: number };

/** The first `# ` heading, used as an imported Markdown document's title. */
function firstHeading(md: string): string | undefined {
  return /^#[ \t]+(.+?)[ \t]*$/m.exec(md)?.[1];
}

/**
 * Create one document per payload, sequentially.
 *
 * Two kinds of payload:
 *  - `json`     — a whole document, created as-is.
 *  - `markdown` — a Sentences document. Its structure (headings, lists, marks)
 *                 lives in Automerge block markers and marks, which JSON can't
 *                 carry, so the doc is created empty and filled with one
 *                 `updateSpans` op — the same path SentencesView's own Markdown
 *                 import uses.
 *
 * Every payload passes through `expandRelativeDates` first, so the examples'
 * `{{today+3d}}` / `{{tu@16:30}}` markup becomes real dates at creation time.
 *
 * Serial rather than parallel: each createDoc is a worker round-trip that
 * mints a keyhive doc and enables sharing. A payload that fails is recorded
 * and skipped — it never aborts the rest of the batch.
 */
export async function createDocsFromItems(
  items: ImportItem[],
  verb: string,
  onProgress: (status: ImportProgress | null) => void,
): Promise<{ created: string[]; failures: string[] }> {
  const created: string[] = [];
  const failures: string[] = [];
  const many = items.length > 1;
  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (many) {
        // Same progress banner the .ics/.xlsx importers use. The yield lets it paint.
        onProgress({ label: `${verb} ${i + 1}/${items.length}: ${item.label}`, progress: Math.round((i / items.length) * 100) });
        await new Promise(r => setTimeout(r, 0));
      }
      try {
        if (item.kind === 'markdown') {
          const md = expandRelativeDates(await item.read());
          const name = firstHeading(md) || item.label.replace(/\.md$/i, '') || 'Sentences';
          const { docId } = await createDoc({ '@type': 'Sentences', name, content: '' }, { type: 'Sentences', name });
          // One updateSpans op → one Automerge change → one undo step.
          await updateDoc(docId, (d, richText, ops) => { richText(d, ['content'], ops); }, richText,
            [{ op: 'updateSpans', spans: markdownToSpans(md) }]);
          created.push(docId);
        } else {
          const data = expandRelativeDates(await item.read());
          if (!data || typeof data !== 'object') throw new Error('Invalid JSON: expected an object');
          const name = data.name || item.label.replace(/\.json$/i, '') || 'Imported';
          const type = typeof data['@type'] === 'string' ? data['@type'] : 'unknown';
          const { docId } = await createDoc(data, { type, name });
          created.push(docId);
        }
      } catch (err: any) {
        failures.push(`${item.label}: ${err?.message ?? err}`);
      }
    }
  } finally {
    onProgress(null);
  }
  return { created, failures };
}
