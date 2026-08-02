/**
 * Version restore (undo/redo, history rollback) must not flatten Peritext
 * fields: plain `syncToTarget` string assignment would replace the text object
 * with a scalar string — literal `￼` characters, no marks, no blocks — and
 * mark-only differences (equal flat strings) would not restore at all.
 * `richTextAwareStringSync` reconciles those fields via updateSpans instead.
 */
import * as A from '@automerge/automerge';
import { syncToTarget } from '../src/shared/sync-to-target';
import { applyRichTextOps, richTextAwareStringSync, type RichTextOp } from '../src/shared/rich-text-ops';
import { spansToMarkdown } from '../src/shared/rich-text-markdown';

const build = (ops: RichTextOp[]) => {
  let doc = A.from({ '@type': 'Sentences', name: 'Doc', content: '' });
  doc = A.change(doc, d => applyRichTextOps(A, d, ['content'], ops));
  return doc;
};

const restore = (doc: any, target: any) =>
  A.change(doc, (d: any) => syncToTarget(d, target, richTextAwareStringSync(A, target)));

describe('rich-text-aware version restore', () => {
  it('restores structure and marks after a text edit', () => {
    const v1 = build([
      { op: 'splitBlock', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { op: 'splice', index: 1, del: 0, text: 'Title' },
      { op: 'mark', start: 1, end: 6, name: 'strong', value: true, expand: 'after' },
    ]);
    const v2 = A.change(v1, (d: any) => applyRichTextOps(A, d, ['content'], [
      { op: 'splice', index: 6, del: 0, text: ' tail' },
    ]));

    const restored = restore(v2, v1);
    expect(A.spans(restored, ['content'])).toEqual(A.spans(v1, ['content']));
    // Not flattened: the block marker survives as a real block, not a ￼ char.
    expect((A.toJS(restored) as any).content).toBe('￼Title');
  });

  it('restores mark-only differences (flat strings identical)', () => {
    const v1 = build([{ op: 'splice', index: 0, del: 0, text: 'hello world' }]);
    const v2 = A.change(v1, (d: any) => applyRichTextOps(A, d, ['content'], [
      { op: 'mark', start: 0, end: 5, name: 'strong', value: true, expand: 'after' },
    ]));

    // Undo the bold: flat text is identical in both versions.
    const restored = restore(v2, v1);
    expect(A.spans(restored, ['content'])).toEqual(A.spans(v1, ['content']));
  });

  /**
   * Undo SCOPE over a divider. This was unpinned everywhere: the Playwright test
   * that nominally covered it asserted `not.toContainText('tail')`, which "tai"
   * satisfies — so an undo that ate the divider along with the character looked
   * identical to a correct one.
   */
  it('takes back one edit after a divider without taking the divider', () => {
    const v1 = build([
      { op: 'splice', index: 0, del: 0, text: 'body' },
      { op: 'splitBlock', index: 4, block: { type: 'divider', parents: [], attrs: {} } },
      { op: 'splitBlock', index: 5, block: { type: 'paragraph', parents: [], attrs: {} } },
    ]);
    const v2 = A.change(v1, (d: any) => applyRichTextOps(A, d, ['content'], [
      { op: 'splice', index: 6, del: 0, text: 'tail' },
    ]));
    expect((A.toJS(v2) as any).content).toBe('body￼￼tail');

    const restored = restore(v2, v1);
    // The divider and its trailing paragraph are both still there; only the
    // typed run is gone.
    expect(A.spans(restored, ['content'])).toEqual(A.spans(v1, ['content']));
    const blocks = A.spans(restored, ['content'])
      .filter((s: any) => s.type === 'block')
      .map((s: any) => s.value.type);
    expect(blocks).toEqual(['divider', 'paragraph']);
  });

  it('leaves plain string fields on the default assignment path', () => {
    const v1 = A.from({ name: 'first', content: '' });
    const v2 = A.change(v1, (d: any) => { d.name = 'second'; });
    const restored = restore(v2, v1);
    expect((restored as any).name).toBe('first');
  });
});

describe('binary export format (snapshot tier)', () => {
  it('preserves markup that the JSON projection drops', () => {
    const doc = build([
      { op: 'splitBlock', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { op: 'splice', index: 1, del: 0, text: 'Title' },
      { op: 'mark', start: 1, end: 6, name: 'strong', value: true, expand: 'after' },
    ]);

    // The readable JSON projection is flat — the mark exists only in the binary.
    const projection = JSON.parse(JSON.stringify(doc));
    expect(projection.content).toBe('￼Title');
    expect(JSON.stringify(projection)).not.toContain('strong');
    expect(A.spans(doc, ['content']).some((s: any) => s.type === 'text' && s.marks?.strong)).toBe(true);

    // Automerge.save → load round-trips the markup; the binary is the lossless form.
    const restored = A.load(A.save(doc));
    expect(A.spans(restored, ['content'])).toEqual(A.spans(doc, ['content']));
  });

  it('renders headings, marks and links as Markdown', () => {
    const doc = build([
      { op: 'splitBlock', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { op: 'splice', index: 1, del: 0, text: 'Title' },
      { op: 'splice', index: 6, del: 0, text: ' and ' },
      { op: 'splice', index: 11, del: 0, text: 'bold' },
      { op: 'splice', index: 15, del: 0, text: ' link' },
      { op: 'mark', start: 1, end: 6, name: 'strong', value: true, expand: 'after' },
      { op: 'mark', start: 11, end: 15, name: 'strong', value: true, expand: 'after' },
      { op: 'mark', start: 16, end: 20, name: 'link', value: JSON.stringify({ href: 'https://example.com' }), expand: 'after' },
    ]);
    expect(spansToMarkdown(A.spans(doc, ['content']))).toBe('# **Title** and **bold** [link](https://example.com)');
  });
});
