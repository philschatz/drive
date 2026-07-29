/**
 * The spans → block model, and above all `blockIndexAt`.
 *
 * Block boundaries are ambiguous by construction: block N's `textTo` IS block
 * N+1's `markerIndex`, because the marker occupies that one position. Which
 * block wins there decides where the caret lands, which type Enter inherits and
 * which block the toolbar reports — so every boundary index is pinned here.
 */
import { blocksFromSpans, blockIndexAt, blockType, contentLength, markExtentAt } from './blocks';
import type { BlockValue, RichTextSpan } from '../../../../shared/rich-text-ops';

const block = (type: string, attrs?: Record<string, unknown>): RichTextSpan =>
  ({ type: 'block', value: { type, parents: [], attrs } as BlockValue & Record<string, unknown> });
const text = (value: string, marks?: Record<string, unknown>): RichTextSpan =>
  ({ type: 'text', value, marks } as RichTextSpan);

describe('blocksFromSpans', () => {
  it('indexes markers and text into one flat sequence', () => {
    // ￼one￼two
    const blocks = blocksFromSpans([block('paragraph'), text('one'), block('paragraph'), text('two')]);
    expect(blocks.map(b => [b.markerIndex, b.textFrom, b.textTo])).toEqual([
      [0, 1, 4],
      [4, 5, 8],
    ]);
    expect(contentLength(blocks)).toBe(8);
  });

  it('opens an implicit leading paragraph for text before any marker', () => {
    const blocks = blocksFromSpans([text('plain')]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].markerIndex).toBeNull();
    expect([blocks[0].textFrom, blocks[0].textTo]).toEqual([0, 5]);
  });

  it('gives an empty document one implicit block', () => {
    expect(blocksFromSpans([])).toHaveLength(1);
  });
});

describe('blockIndexAt', () => {
  // ￼one￼two — b0 text 1..4, b1 text 5..8
  const twoParas = blocksFromSpans([block('paragraph'), text('one'), block('paragraph'), text('two')]);

  it('resolves a block-start index to that block', () => {
    expect(blockIndexAt(twoParas, 1)).toBe(0);
    expect(blockIndexAt(twoParas, 5)).toBe(1);
  });

  it('resolves an index inside a block to that block', () => {
    expect(blockIndexAt(twoParas, 2)).toBe(0);
    expect(blockIndexAt(twoParas, 7)).toBe(1);
  });

  it('resolves the END of a paragraph to that paragraph, not the next one', () => {
    // 4 is both b0.textTo and b1.markerIndex. Clicking there must stay in b0 —
    // resolving to b1 walked the caret down into the following paragraph.
    expect(twoParas[0].textTo).toBe(4);
    expect(twoParas[1].markerIndex).toBe(4);
    expect(blockIndexAt(twoParas, 4)).toBe(0);
  });

  it('resolves index 0 to the first block even though its marker sits there', () => {
    expect(blockIndexAt(twoParas, 0)).toBe(0);
  });

  it('clamps past the end of the document to the last block', () => {
    expect(blockIndexAt(twoParas, 8)).toBe(1);
    expect(blockIndexAt(twoParas, 99)).toBe(1);
  });

  it('gives each of several consecutive empty paragraphs its own index', () => {
    // ￼one￼￼￼two — the empties are b1 (5..5), b2 (6..6); b3 text is 7..10.
    const blocks = blocksFromSpans([
      block('paragraph'), text('one'),
      block('paragraph'),
      block('paragraph'),
      block('paragraph'), text('two'),
    ]);
    expect(blocks.map(b => [b.markerIndex, b.textFrom, b.textTo])).toEqual([
      [0, 1, 4], [4, 5, 5], [5, 6, 6], [6, 7, 10],
    ]);
    // An empty block's textFrom === textTo === the NEXT block's markerIndex, so
    // resolving forward is what stops the caret cascading through every blank
    // line until it hits text.
    expect(blockIndexAt(blocks, 4)).toBe(0); // end of "one"
    expect(blockIndexAt(blocks, 5)).toBe(1); // in the first empty paragraph
    expect(blockIndexAt(blocks, 6)).toBe(2); // in the second
    expect(blockIndexAt(blocks, 7)).toBe(3); // start of "two"
  });

  it('resolves within an implicit leading block', () => {
    const blocks = blocksFromSpans([text('plain')]);
    expect(blockIndexAt(blocks, 0)).toBe(0);
    expect(blockIndexAt(blocks, 5)).toBe(0);
  });

  it('reports the block a caret at a boundary really sits in', () => {
    // The toolbar reads blockType through blockIndexAt: a caret at the end of a
    // paragraph before a list item must not report "list item".
    const blocks = blocksFromSpans([
      block('paragraph'), text('one'),
      block('unordered-list-item'), text('two'),
    ]);
    expect(blockType(blocks[blockIndexAt(blocks, 4)])).toBe('paragraph');
    expect(blockType(blocks[blockIndexAt(blocks, 5)])).toBe('unordered-list-item');
  });
});

/**
 * What a caret-only format gesture acts on. The toolbar shows a mark as active
 * from the character BEFORE the caret, so the extent has to be read the same way
 * — otherwise the button lights up for one stretch of text and edits another.
 */
describe('markExtentAt', () => {
  //          1234567890123456
  // flat: ￼plain bold plain   (marker at 0)
  const doc = blocksFromSpans([
    block('paragraph'), text('plain '), text('bold', { strong: true }), text(' plain'),
  ]);

  it('spans the whole formatted run from a caret inside it', () => {
    // "bold" occupies [7, 11).
    expect(markExtentAt(doc, 8, 'strong')).toEqual({ from: 7, to: 11, value: true });
    // Caret at the run's end still reads as inside it (the char before it).
    expect(markExtentAt(doc, 11, 'strong')).toEqual({ from: 7, to: 11, value: true });
  });

  it('reports nothing from plain text, or for an absent mark', () => {
    expect(markExtentAt(doc, 3, 'strong')).toBeNull();
    // At the run's start the character before the caret is unformatted, which is
    // also what makes the toolbar show Bold inactive there.
    expect(markExtentAt(doc, 7, 'strong')).toBeNull();
    expect(markExtentAt(doc, 8, 'em')).toBeNull();
  });

  it('merges adjacent runs carrying the same value', () => {
    // Two runs, both bold, split by an unrelated mark on the second.
    const blocks = blocksFromSpans([
      block('paragraph'), text('one', { strong: true }), text('two', { strong: true, em: true }),
    ]);
    expect(markExtentAt(blocks, 2, 'strong')).toEqual({ from: 1, to: 7, value: true });
    // …but em covers only its own run.
    expect(markExtentAt(blocks, 5, 'em')).toEqual({ from: 4, to: 7, value: true });
  });

  it('keeps two different links apart', () => {
    const a = JSON.stringify({ href: 'https://a.dev' });
    const b = JSON.stringify({ href: 'https://b.dev' });
    const blocks = blocksFromSpans([
      block('paragraph'), text('aaa', { link: a }), text('bbb', { link: b }),
    ]);
    expect(markExtentAt(blocks, 2, 'link')).toEqual({ from: 1, to: 4, value: a });
    expect(markExtentAt(blocks, 5, 'link')).toEqual({ from: 4, to: 7, value: b });
  });

  it('stops at the block edge', () => {
    // A heading's bold is not the following paragraph's bold.
    const blocks = blocksFromSpans([
      block('heading', { level: 1 }), text('head', { strong: true }),
      block('paragraph'), text('body', { strong: true }),
    ]);
    expect(markExtentAt(blocks, 3, 'strong')).toEqual({ from: 1, to: 5, value: true });
    expect(markExtentAt(blocks, 8, 'strong')).toEqual({ from: 6, to: 10, value: true });
  });
});
