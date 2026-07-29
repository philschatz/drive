/**
 * Parity: the pure-JS spans emulation (spans-model.ts, used by the jsdom mock
 * and the editor's optimistic echo) must agree with REAL Automerge for the op
 * sequences the editor emits. Runs the same ops through both and compares the
 * resulting spans.
 */
import * as A from '@automerge/automerge';
import { applyRichTextOps, type RichTextOp, type RichTextSpan } from '../../../../shared/rich-text-ops';
import { applyOpsToSpans, flatTextFromSpans, shiftPositionThroughOps, spansFromFlatText } from './spans-model';

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

  it('replacing a selection that spans several markers (select-all + type)', () => {
    // Ctrl+A yields [first block's textFrom, contentLength], so typing over it is
    // one splice deleting every later marker at once — the widest structural
    // delete the editor can emit.
    expectParity([
      { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
      { op: 'splice', index: 1, del: 0, text: 'one' },
      { op: 'splitBlock', index: 4, block: { type: 'unordered-list-item', parents: [] } },
      { op: 'splice', index: 5, del: 0, text: 'two' },
      { op: 'splitBlock', index: 8, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { op: 'splice', index: 9, del: 0, text: 'three' },
      { op: 'splice', index: 1, del: 13, text: 'x' },
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

/**
 * The jsdom mock rebases carets with shiftPositionThroughOps, so if it disagrees
 * with getCursorPosition the container tests would green-light a broken rebase.
 * Mint a real cursor, apply ops, and compare.
 */
describe('cursor-position parity with Automerge', () => {
  // '￼hello world' — a block marker at 0 so positions cross one, length 12.
  const SEED: RichTextOp[] = [
    { op: 'splitBlock', index: 0, block: { type: 'paragraph', parents: [] } },
    { op: 'splice', index: 1, del: 0, text: 'hello world' },
  ];

  function automergeShift(pos: number, ops: RichTextOp[]): number | null {
    let doc = A.from({ content: '' });
    doc = A.change(doc, d => applyRichTextOps(A, d, ['content'], SEED));
    const cursor = A.getCursor(doc, ['content'], pos);
    doc = A.change(doc, d => applyRichTextOps(A, d, ['content'], ops));
    try { return A.getCursorPosition(doc, ['content'], cursor); } catch { return null; }
  }

  const expectCursorParity = (pos: number, ops: RichTextOp[]) =>
    expect(shiftPositionThroughOps(pos, ops)).toBe(automergeShift(pos, ops));

  it('remote insert before the caret shifts it', () => {
    expectCursorParity(7, [{ op: 'splice', index: 1, del: 0, text: 'XY' }]);
  });

  it('remote insert exactly at the caret pushes it right', () => {
    expectCursorParity(7, [{ op: 'splice', index: 7, del: 0, text: 'XY' }]);
  });

  it('remote insert after the caret leaves it alone', () => {
    expectCursorParity(7, [{ op: 'splice', index: 9, del: 0, text: 'XY' }]);
  });

  it('remote delete before the caret shifts it back', () => {
    expectCursorParity(7, [{ op: 'splice', index: 1, del: 3 }]);
  });

  it('deleting the character under the caret keeps the index', () => {
    expectCursorParity(7, [{ op: 'splice', index: 7, del: 1 }]);
  });

  it('a delete spanning the caret collapses it to the range start', () => {
    expectCursorParity(7, [{ op: 'splice', index: 5, del: 4 }]);
  });

  it('replacing the text under the caret', () => {
    expectCursorParity(7, [{ op: 'splice', index: 6, del: 2, text: 'ZZZ' }]);
  });

  it('splitBlock before the caret counts as one character', () => {
    expectCursorParity(7, [{ op: 'splitBlock', index: 4, block: { type: 'paragraph', parents: [] } }]);
  });

  it('joinBlock before the caret removes one character', () => {
    expectCursorParity(2, [{ op: 'joinBlock', index: 0 }]);
  });

  it('marks and block updates move nothing', () => {
    expectCursorParity(7, [
      { op: 'mark', start: 1, end: 6, name: 'strong', value: true, expand: 'after' },
      { op: 'updateBlock', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
    ]);
  });

  it('caret at position 0 is unmoved by a later insert', () => {
    expectCursorParity(0, [{ op: 'splice', index: 5, del: 0, text: 'XY' }]);
  });

  // Documented divergences — asserted so they cannot drift silently.
  it('updateSpans is pessimistic in the emulation but tracked by Automerge', () => {
    const ops: RichTextOp[] = [{ op: 'updateSpans', spans: [{ type: 'text', value: 'XY￼hello world' }] }];
    expect(shiftPositionThroughOps(7, ops)).toBeNull();
    expect(automergeShift(7, ops)).toBe(9); // minimal diff keeps the character
  });

  it('a caret at end-of-content mints a sticky end cursor', () => {
    // getCursor(pos >= length) silently returns 'e', which always resolves to the
    // new length — so an end-of-document caret follows a remote append. The mock
    // models this separately from the shifter (see __mocks__/worker-api.ts).
    let doc = A.from({ content: '' });
    doc = A.change(doc, d => applyRichTextOps(A, d, ['content'], SEED));
    expect(A.getCursor(doc, ['content'], 12)).toBe('e');
    doc = A.change(doc, d => applyRichTextOps(A, d, ['content'], [{ op: 'splice', index: 12, del: 0, text: '!!' }]));
    expect(A.getCursorPosition(doc, ['content'], 'e')).toBe(14);
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
