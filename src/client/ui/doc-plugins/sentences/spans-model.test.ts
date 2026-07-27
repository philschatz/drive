/**
 * Parity: the pure-JS spans emulation (spans-model.ts, used by the jsdom mock
 * and the editor's optimistic echo) must agree with REAL Automerge for the op
 * sequences the editor emits. Runs the same ops through both and compares the
 * resulting spans.
 */
import * as A from '@automerge/automerge';
import { applyRichTextOps, type RichTextOp, type RichTextSpan } from '../../../../shared/rich-text-ops';
import { applyOpsToSpans, flatTextFromSpans, spansFromFlatText } from './spans-model';

/** Real-Automerge reference: fresh doc, apply all ops, read spans back. */
function automergeApply(ops: RichTextOp[]): RichTextSpan[] {
  let doc = A.from({ content: '' });
  doc = A.change(doc, d => applyRichTextOps(A, d, ['content'], ops));
  return JSON.parse(JSON.stringify(A.spans(doc, ['content'])));
}

function emulate(ops: RichTextOp[]): RichTextSpan[] {
  return applyOpsToSpans([], ops);
}

function expectParity(ops: RichTextOp[]) {
  expect(emulate(ops)).toEqual(automergeApply(ops));
}

describe('spans-model parity with Automerge', () => {
  it('plain text insert into an empty doc', () => {
    expectParity([{ op: 'splice', index: 0, del: 0, text: 'Hello world' }]);
  });

  it('block marker + text + heading update', () => {
    expectParity([
      { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'Title' },
      { op: 'updateBlock', index: 0, block: { type: 'heading', parents: [], attrs: { level: 2 } } },
    ]);
  });

  it('bold then typing at the end of the bold run inherits the mark', () => {
    expectParity([
      { op: 'splice', index: 0, del: 0, text: 'bold plain' },
      { op: 'mark', start: 0, end: 4, name: 'strong', value: true, expand: 'after' },
      { op: 'splice', index: 4, del: 0, text: 'er' },
    ]);
  });

  it('typing at the start of a marked run does not inherit (expand after)', () => {
    expectParity([
      { op: 'splice', index: 0, del: 0, text: 'abc' },
      { op: 'mark', start: 0, end: 3, name: 'strong', value: true, expand: 'after' },
      { op: 'splice', index: 0, del: 0, text: 'x' },
    ]);
  });

  it('links never expand', () => {
    expectParity([
      { op: 'splice', index: 0, del: 0, text: 'see docs here' },
      { op: 'mark', start: 4, end: 8, name: 'link', value: JSON.stringify({ href: 'https://x.com' }), expand: 'none' },
      { op: 'splice', index: 8, del: 0, text: 'X' },
    ]);
  });

  it('unmark removes formatting from part of a run', () => {
    expectParity([
      { op: 'splice', index: 0, del: 0, text: 'aaabbbccc' },
      { op: 'mark', start: 0, end: 9, name: 'em', value: true, expand: 'after' },
      { op: 'unmark', start: 3, end: 6, name: 'em', expand: 'after' },
    ]);
  });

  it('splitting a paragraph mid-text', () => {
    expectParity([
      { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'onetwo' },
      { op: 'splitBlock', index: 4, block: { type: 'paragraph', parents: [] } },
    ]);
  });

  it('joinBlock merges two paragraphs', () => {
    expectParity([
      { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'one' },
      { op: 'splitBlock', index: 4, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 5, del: 0, text: 'two' },
      { op: 'joinBlock', index: 4 },
    ]);
  });

  it('nested list structure with parents', () => {
    expectParity([
      { op: 'splitBlock', index: 0, block: { type: 'unordered-list-item', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'outer' },
      { op: 'splitBlock', index: 6, block: { type: 'unordered-list-item', parents: ['unordered-list-item'] } },
      { op: 'splice', index: 7, del: 0, text: 'inner' },
    ]);
  });

  it('deleting across a block marker merges blocks', () => {
    expectParity([
      { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'one' },
      { op: 'splitBlock', index: 4, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 5, del: 0, text: 'two' },
      { op: 'splice', index: 3, del: 3 }, // "e" + marker + "t"
    ]);
  });

  it('updateSpans replaces the whole field (Markdown import)', () => {
    expectParity([
      { op: 'splice', index: 0, del: 0, text: 'old plain text' },
      {
        op: 'updateSpans',
        spans: [
          { type: 'block', value: { type: 'heading', parents: [], attrs: { level: 2 } } },
          { type: 'text', value: 'Imported' },
          { type: 'block', value: { type: 'unordered-list-item', parents: [], attrs: {} } },
          { type: 'text', value: 'with ' },
          { type: 'text', value: 'bold', marks: { strong: true } },
        ],
      },
    ]);
  });

  it('divider blocks (empty text between markers)', () => {
    expectParity([
      { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'above' },
      { op: 'splitBlock', index: 6, block: { type: 'divider', parents: [] } },
      { op: 'splitBlock', index: 7, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 8, del: 0, text: 'below' },
    ]);
  });
});

describe('spans-model helpers', () => {
  it('flatTextFromSpans matches the JSON projection of a real doc', () => {
    const ops: RichTextOp[] = [
      { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'hi' },
      { op: 'splitBlock', index: 3, block: { type: 'paragraph', parents: [] } },
    ];
    let doc = A.from({ content: '' });
    doc = A.change(doc, d => applyRichTextOps(A, d, ['content'], ops));
    expect(flatTextFromSpans(emulate(ops))).toBe((A.toJS(doc) as any).content);
  });

  it('spansFromFlatText reconstructs paragraphs from marker chars', () => {
    expect(spansFromFlatText('￼one￼two')).toEqual([
      { type: 'block', value: { type: 'paragraph', parents: [], attrs: {} } },
      { type: 'text', value: 'one' },
      { type: 'block', value: { type: 'paragraph', parents: [], attrs: {} } },
      { type: 'text', value: 'two' },
    ]);
  });
});
