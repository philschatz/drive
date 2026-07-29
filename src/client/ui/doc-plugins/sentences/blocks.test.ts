/**
 * The spans → block model, and above all `blockIndexAt`.
 *
 * Block boundaries are ambiguous by construction: block N's `textTo` IS block
 * N+1's `markerIndex`, because the marker occupies that one position. Which
 * block wins there decides where the caret lands, which type Enter inherits and
 * which block the toolbar reports — so every boundary index is pinned here.
 */
import { blocksFromSpans, blockIndexAt, blockType, contentLength } from './blocks';
import type { BlockValue, RichTextSpan } from '../../../../shared/rich-text-ops';

const block = (type: string, attrs?: Record<string, unknown>): RichTextSpan =>
  ({ type: 'block', value: { type, parents: [], attrs } as BlockValue & Record<string, unknown> });
const text = (value: string): RichTextSpan => ({ type: 'text', value });

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
