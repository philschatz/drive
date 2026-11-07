/**
 * The editing brain: intents → ops. Each case applies the produced ops through
 * the (Automerge-parity-tested) spans emulation and asserts the resulting
 * document structure via markdown — testing outcomes, not op shapes.
 */
import { blocksFromSpans, marksInRange, orderedListNumbers } from './blocks';
import {
  opsForInsertText, opsForDeleteBackward, opsForDeleteForward, opsForInsertParagraph, opsForPasteText,
  toggleMarkOps, setLinkOps, setBlockTypeOps, toggleListOps, indentOps, outdentOps, insertDividerOps,
  clampToCells,
} from './edit-ops';
import { markdownToSpans, spansToMarkdown } from './markdown';
import { applyOpsToSpans } from './spans-model';
import type { RichTextSpan } from '../../../../shared/rich-text-ops';

const docOf = (md: string): RichTextSpan[] => markdownToSpans(md);
const mdOf = (spans: RichTextSpan[]): string => spansToMarkdown(spans);
const blocksOf = (spans: RichTextSpan[]) => blocksFromSpans(spans);
const typesOf = (spans: RichTextSpan[]) => blocksOf(spans).map(b => b.block?.type);
// Markdown can't express an empty list item (`- ` loses its trailing space), so
// structural fixtures that need one are built span by span.
const blockSpan = (type: string): RichTextSpan => ({ type: 'block', value: { type, parents: [] } });
const textSpan = (value: string): RichTextSpan => ({ type: 'text', value });

describe('typing', () => {
  it('inserts text at the caret', () => {
    const spans = docOf('helo');
    const { ops, caret } = opsForInsertText(blocksOf(spans), 4, 4, 'l'); // "￼hel|o"
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('hello');
    expect(caret).toBe(5);
  });

  it('replaces a selection', () => {
    const spans = docOf('hello world');
    const { ops, caret } = opsForInsertText(blocksOf(spans), 7, 12, 'there'); // "world" selected
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('hello there');
    expect(caret).toBe(12);
  });

  it('applies pending marks to the inserted text', () => {
    const spans = docOf('ab');
    const { ops } = opsForInsertText(blocksOf(spans), 2, 2, 'X', { strong: true });
    const after = applyOpsToSpans(spans, ops);
    expect(mdOf(after)).toBe('a**X**b');
  });

  it('pending mark = false suppresses inheritance from the previous run', () => {
    const spans = docOf('**bold**');
    const { ops } = opsForInsertText(blocksOf(spans), 5, 5, 'x', { strong: false }); // after "bold"
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('**bold**x');
  });
});

describe('backspace', () => {
  it('deletes the previous character', () => {
    const spans = docOf('abc');
    const { ops, caret } = opsForDeleteBackward(blocksOf(spans), 4, 4);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('ab');
    expect(caret).toBe(3);
  });

  it('deletes the selection', () => {
    const spans = docOf('abcdef');
    const { ops, caret } = opsForDeleteBackward(blocksOf(spans), 2, 5);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('aef');
    expect(caret).toBe(2);
  });

  it('at block start merges into the previous block', () => {
    const spans = docOf('one\n\ntwo');
    // layout: ￼one￼two — caret at start of "two" (index 5)
    const { ops, caret } = opsForDeleteBackward(blocksOf(spans), 5, 5);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('onetwo');
    expect(caret).toBe(4);
  });

  it('at the start of a list item outdents instead of merging', () => {
    const spans = docOf('- a\n  - b');
    // ￼a￼b — caret at start of nested "b" (index 3)
    const first = opsForDeleteBackward(blocksOf(spans), 3, 3);
    const afterOutdent = applyOpsToSpans(spans, first.ops);
    expect(mdOf(afterOutdent)).toBe('- a\n- b');
    const second = opsForDeleteBackward(blocksOf(afterOutdent), 3, 3);
    expect(mdOf(applyOpsToSpans(afterOutdent, second.ops))).toBe('- a\n\nb');
  });

  it('backspacing at a block after a divider removes the divider', () => {
    const spans = docOf('a\n\n---\n\nb');
    // ￼a￼￼b — caret at start of "b" (index 4)
    const { ops, caret } = opsForDeleteBackward(blocksOf(spans), 4, 4);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('a\n\nb');
    expect(caret).toBe(3);
  });

  it('does nothing at the very start of the document', () => {
    const spans = docOf('abc');
    expect(opsForDeleteBackward(blocksOf(spans), 1, 1).ops).toEqual([]);
  });
});

/**
 * Android IMEs do not send backspace as a collapsed-caret gesture. GBoard on
 * Gecko expresses it as `deleteSurroundingText` — "replace this range with
 * nothing" — over the FLAT text it sees, where a block boundary is one
 * character. At a block start that range is `[markerIndex, textFrom)`: the
 * marker alone, no text.
 *
 * Splicing a marker away merges the blocks (pinned against real Automerge in
 * spans-model.test.ts), so every structural backspace silently degraded to a
 * merge on Android — the empty indented list item vanished and the caret landed
 * at the end of the previous item. Paragraphs hid it: merging is what they do
 * anyway. Desktop hides it too, because there the boundary range arrives via
 * `getTargetRanges()`, which `deleteRange` already discards.
 */
describe('backspace over a bare block boundary (Android IME)', () => {
  it('outdents a nested list item instead of merging it', () => {
    const spans = docOf('- a\n  - b');
    // ￼a￼b — the marker of the nested item is index 2, its text starts at 3.
    const { ops, caret } = opsForDeleteBackward(blocksOf(spans), 2, 3);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('- a\n- b');
    expect(caret).toBe(3);
  });

  it('outdents an EMPTY nested list item — the reported case', () => {
    const spans: RichTextSpan[] = [
      blockSpan('unordered-list-item'), textSpan('a'),
      { type: 'block', value: { type: 'unordered-list-item', parents: ['unordered-list-item'] } },
    ];
    const { ops, caret } = opsForDeleteBackward(blocksOf(spans), 2, 3);
    const after = applyOpsToSpans(spans, ops);
    // The item survives, one level shallower — it is not swallowed by "a".
    expect(typesOf(after)).toEqual(['unordered-list-item', 'unordered-list-item']);
    expect(blocksOf(after).map(b => b.block?.parents)).toEqual([[], []]);
    expect(caret).toBe(3);
  });

  it('demotes a blockquote instead of merging it', () => {
    const spans = docOf('a\n\n> b');
    const { ops } = opsForDeleteBackward(blocksOf(spans), 2, 3);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('a\n\nb');
  });

  it('removes a preceding divider instead of merging into it', () => {
    const spans = docOf('a\n\n---\n\nb');
    // ￼a￼￼b — the divider's marker is 2, "b"'s marker is 3.
    const { ops } = opsForDeleteBackward(blocksOf(spans), 3, 4);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('a\n\nb');
  });

  it('still merges a range that covers real text across the boundary', () => {
    // The rule is deliberately narrow: one position, landing exactly on a
    // marker. Dragging over actual characters means what it says.
    const spans = docOf('- a\n  - b');
    const { ops, caret } = opsForDeleteBackward(blocksOf(spans), 1, 3);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('- b');
    expect(caret).toBe(1);
  });
});

describe('delete forward', () => {
  it('deletes the next character', () => {
    const spans = docOf('abc');
    const { ops } = opsForDeleteForward(blocksOf(spans), 1, 1);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('bc');
  });

  it('at block end merges the next block in', () => {
    const spans = docOf('one\n\ntwo');
    const { ops } = opsForDeleteForward(blocksOf(spans), 4, 4); // end of "one"
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('onetwo');
    // Op shape matters here (unusually): index 4 is both "end of one" and the
    // second marker's position, and resolving it to the LATTER produced a raw
    // splice over the marker instead of a structural join.
    expect(ops).toEqual([{ op: 'joinBlock', index: 4 }]);
  });

  it('does nothing at the end of the document', () => {
    const spans = docOf('a');
    expect(opsForDeleteForward(blocksOf(spans), 2, 2).ops).toEqual([]);
  });
});

describe('Enter', () => {
  it('splits a paragraph and keeps the caret in the new block', () => {
    const spans = docOf('onetwo');
    const { ops, caret } = opsForInsertParagraph(blocksOf(spans), 4, 4);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('one\n\ntwo');
    expect(caret).toBe(5);
  });

  it('continues a list', () => {
    const spans = docOf('- item');
    const { ops } = opsForInsertParagraph(blocksOf(spans), 5, 5);
    const after = applyOpsToSpans(spans, ops);
    const blocks = blocksOf(after);
    expect(blocks.map(b => b.block?.type)).toEqual(['unordered-list-item', 'unordered-list-item']);
  });

  it('at the end of a heading starts a paragraph', () => {
    const spans = docOf('# Title');
    const { ops } = opsForInsertParagraph(blocksOf(spans), 6, 6);
    const blocks = blocksOf(applyOpsToSpans(spans, ops));
    expect(blocks.map(b => b.block?.type)).toEqual(['heading', 'paragraph']);
  });

  it('on an empty list item exits the list', () => {
    const spans = docOf('- a');
    // Simulate Enter at end creating an empty item, then Enter again.
    const first = opsForInsertParagraph(blocksOf(spans), 2, 2);
    const mid = applyOpsToSpans(spans, first.ops);
    const second = opsForInsertParagraph(blocksOf(mid), first.caret, first.caret);
    const blocks = blocksOf(applyOpsToSpans(mid, second.ops));
    expect(blocks.map(b => b.block?.type)).toEqual(['unordered-list-item', 'paragraph']);
  });

  // The new block continues the type of the block being SPLIT. At a block's end
  // that index is also the next block's marker, so resolving it forward is what
  // keeps Enter from inheriting whatever happens to follow the list.
  it('at the end of a list item followed by a paragraph makes another list item', () => {
    const spans = docOf('- a\n\nplain'); // ￼a￼plain — caret at end of "a"
    const { ops, caret } = opsForInsertParagraph(blocksOf(spans), 2, 2);
    expect(typesOf(applyOpsToSpans(spans, ops)))
      .toEqual(['unordered-list-item', 'unordered-list-item', 'paragraph']);
    expect(caret).toBe(3);
  });

  it('at the end of a list item followed by a heading makes another list item', () => {
    const spans = docOf('- a\n\n# Title');
    const { ops } = opsForInsertParagraph(blocksOf(spans), 2, 2);
    expect(typesOf(applyOpsToSpans(spans, ops)))
      .toEqual(['unordered-list-item', 'unordered-list-item', 'heading']);
  });

  it('on an empty list item followed by another block still exits the list', () => {
    // ￼a￼￼plain — the empty item is b1, its only caret position is 3.
    const spans = [
      blockSpan('unordered-list-item'), textSpan('a'),
      blockSpan('unordered-list-item'),
      blockSpan('paragraph'), textSpan('plain'),
    ];
    const { ops } = opsForInsertParagraph(blocksOf(spans), 3, 3);
    expect(typesOf(applyOpsToSpans(spans, ops)))
      .toEqual(['unordered-list-item', 'paragraph', 'paragraph']);
  });
});

describe('inline formatting', () => {
  it('toggles bold on and off over a selection', () => {
    const spans = docOf('hello');
    const on = toggleMarkOps(blocksOf(spans), 1, 6, 'strong');
    const bolded = applyOpsToSpans(spans, on);
    expect(mdOf(bolded)).toBe('**hello**');
    const off = toggleMarkOps(blocksOf(bolded), 1, 6, 'strong');
    expect(mdOf(applyOpsToSpans(bolded, off))).toBe('hello');
  });

  it('sets and clears links', () => {
    const spans = docOf('docs');
    const set = setLinkOps(blocksOf(spans), 1, 5, 'https://x.dev');
    const linked = applyOpsToSpans(spans, set);
    expect(mdOf(linked)).toBe('[docs](https://x.dev)');
    const cleared = setLinkOps(blocksOf(linked), 1, 5, null);
    expect(mdOf(applyOpsToSpans(linked, cleared))).toBe('docs');
  });

  it('marksInRange reports the toolbar toggle state', () => {
    const spans = docOf('**ab**cd');
    const blocks = blocksOf(spans);
    expect('strong' in marksInRange(blocks, 1, 3)).toBe(true);
    expect('strong' in marksInRange(blocks, 1, 5)).toBe(false); // mixed
    expect('strong' in marksInRange(blocks, 2, 2)).toBe(true); // caret inside bold
  });
});

describe('block formatting', () => {
  it('retypes a paragraph as a heading (implicit leading block too)', () => {
    const spans: RichTextSpan[] = [{ type: 'text', value: 'plain' }]; // no marker at all
    const ops = setBlockTypeOps(blocksOf(spans), 2, 2, 'heading', { level: 2 });
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('## plain');
  });

  it('retypes all blocks a selection touches', () => {
    const spans = docOf('one\n\ntwo');
    const ops = setBlockTypeOps(blocksOf(spans), 2, 6, 'blockquote');
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('> one\n> two');
  });

  it('toggles a list on and back off', () => {
    const spans = docOf('one\n\ntwo');
    const on = toggleListOps(blocksOf(spans), 1, 8, 'unordered-list-item');
    const listed = applyOpsToSpans(spans, on);
    expect(mdOf(listed)).toBe('- one\n- two');
    const off = toggleListOps(blocksOf(listed), 1, 8, 'unordered-list-item');
    expect(mdOf(applyOpsToSpans(listed, off))).toBe('one\n\ntwo');
  });

  it('switches an unordered list to ordered, renumbering', () => {
    const spans = docOf('- a\n- b');
    const ops = toggleListOps(blocksOf(spans), 1, 4, 'ordered-list-item');
    const after = applyOpsToSpans(spans, ops);
    expect(mdOf(after)).toBe('1. a\n2. b');
    expect(orderedListNumbers(blocksOf(after))).toEqual([1, 2]);
  });

  it('indents bounded by the previous item, outdent exits at depth 0', () => {
    const spans = docOf('- a\n- b');
    const blocks = blocksOf(spans);
    // First item can't indent (no previous item).
    expect(indentOps(blocks, 1, 1)).toEqual([]);
    const indented = applyOpsToSpans(spans, indentOps(blocks, 3, 3));
    expect(mdOf(indented)).toBe('- a\n  - b');
    const out1 = applyOpsToSpans(indented, outdentOps(blocksOf(indented), 3, 3));
    expect(mdOf(out1)).toBe('- a\n- b');
    const out2 = applyOpsToSpans(out1, outdentOps(blocksOf(out1), 3, 3));
    expect(mdOf(out2)).toBe('- a\n\nb');
  });

  // Block formatting applies to every block the selection touches, and a
  // boundary index belongs to the block that ENDS there — not to the next block,
  // whose marker shares that index.
  it('with the caret at a paragraph end, retypes only that paragraph', () => {
    const spans = docOf('one\n\ntwo');
    const ops = setBlockTypeOps(blocksOf(spans), 4, 4, 'heading', { level: 1 });
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('# one\n\ntwo');
  });

  it('over a whole paragraph, leaves the following paragraph alone', () => {
    const spans = docOf('one\n\ntwo');
    const ops = toggleListOps(blocksOf(spans), 1, 4, 'unordered-list-item');
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('- one\n\ntwo');
  });

  it('inserts a divider and lands in a fresh paragraph', () => {
    const spans = docOf('ab');
    const { ops, caret } = insertDividerOps(blocksOf(spans), 2, 2);
    expect(mdOf(applyOpsToSpans(spans, ops))).toBe('a\n\n---\n\nb');
    expect(caret).toBe(4);
  });
});

/**
 * Tables. A cell's text edits like a paragraph's; its boundaries are the
 * table's shape, which the UI cannot change. So every gesture that would move a
 * cell marker — a join, a split, a range reaching across one — is held inside
 * the cell or stopped at the table's edge, and only a range covering the whole
 * table (the way to delete one) is let through.
 *
 * Fixture: `x` ¶, a 2×2 table, `y` ¶ — flat `￼x￼a￼b￼c￼d￼y`:
 *   x: marker 0, text [1,2)   a: 2,[3,4)   b: 4,[5,6)   c: 6,[7,8)   d: 8,[9,10)   y: 10,[11,12)
 */
describe('tables', () => {
  const TABLE = '| a | b |\n| --- | --- |\n| c | d |';
  const DOC = `x\n\n${TABLE}\n\ny`;
  const spans = () => docOf(DOC);
  const CELLS = ['table-cell', 'table-cell', 'table-cell', 'table-cell'];

  it('clamps a range to the cell it starts in, or stops it before a table', () => {
    const bl = blocksOf(spans());
    expect(clampToCells(bl, 3, 7)).toEqual({ from: 3, to: 4 });   // a… into c → a's end
    expect(clampToCells(bl, 1, 5)).toEqual({ from: 1, to: 2 });   // x… into b → before the table
    expect(clampToCells(bl, 2, 10)).toEqual({ from: 2, to: 10 }); // the whole table: allowed
    expect(clampToCells(bl, 9, 12)).toEqual({ from: 9, to: 10 }); // d… into y → d's end
    expect(clampToCells(bl, 11, 12)).toEqual({ from: 11, to: 12 }); // outside: untouched
  });

  it('types inside a cell', () => {
    const s = spans();
    const { ops, caret } = opsForInsertText(blocksOf(s), 4, 4, 'Z');
    expect(mdOf(applyOpsToSpans(s, ops))).toBe(`x\n\n| aZ | b |\n| --- | --- |\n| c | d |\n\ny`);
    expect(caret).toBe(5);
  });

  it('a replacement that started in a cell stays in that cell', () => {
    const s = spans();
    const { ops } = opsForInsertText(blocksOf(s), 3, 7, 'Z');
    expect(mdOf(applyOpsToSpans(s, ops))).toBe(`x\n\n| Z | b |\n| --- | --- |\n| c | d |\n\ny`);
  });

  it('a deletion dragged from a paragraph into the table stops at the table', () => {
    const s = spans();
    const { ops } = opsForDeleteBackward(blocksOf(s), 1, 5);
    expect(typesOf(applyOpsToSpans(s, ops))).toEqual(['paragraph', ...CELLS, 'paragraph']);
    expect(mdOf(applyOpsToSpans(s, ops))).toBe(`\n\n${TABLE}\n\ny`);
  });

  it('a range covering the whole table deletes it', () => {
    const s = spans();
    const { ops, caret } = opsForDeleteBackward(blocksOf(s), 2, 10);
    expect(mdOf(applyOpsToSpans(s, ops))).toBe('x\n\ny');
    expect(caret).toBe(2);
  });

  it('Enter in a cell starts a paragraph after the table', () => {
    const s = spans();
    const { ops, caret } = opsForInsertParagraph(blocksOf(s), 3, 3);
    expect(typesOf(applyOpsToSpans(s, ops))).toEqual(['paragraph', ...CELLS, 'paragraph', 'paragraph']);
    expect(caret).toBe(11); // the new, empty paragraph between d and y
  });

  it('Enter over a selection in a cell deletes it first, then leaves the table', () => {
    const s = spans();
    const { ops, caret } = opsForInsertParagraph(blocksOf(s), 3, 4);
    const after = applyOpsToSpans(s, ops);
    expect(mdOf(after)).toBe(`x\n\n|  | b |\n| --- | --- |\n| c | d |\n\n\n\ny`);
    expect(caret).toBe(10);
  });

  it('backspace at a cell start, and at the block after a table, is a no-op', () => {
    const bl = blocksOf(spans());
    expect(opsForDeleteBackward(bl, 3, 3).ops).toEqual([]);   // start of a
    expect(opsForDeleteBackward(bl, 7, 7).ops).toEqual([]);   // start of c
    expect(opsForDeleteBackward(bl, 11, 11).ops).toEqual([]); // start of y: prev is a cell
    // The Android bare-marker ranges for the same gestures.
    expect(opsForDeleteBackward(bl, 2, 3).ops).toEqual([]);
    expect(opsForDeleteBackward(bl, 10, 11).ops).toEqual([]);
  });

  it('delete-forward at a cell end, and at the block before a table, is a no-op', () => {
    const bl = blocksOf(spans());
    expect(opsForDeleteForward(bl, 4, 4).ops).toEqual([]);  // end of a
    expect(opsForDeleteForward(bl, 10, 10).ops).toEqual([]); // end of d
    expect(opsForDeleteForward(bl, 2, 2).ops).toEqual([]);  // end of x: next is a cell
  });

  it('retyping, listing, indenting and dividers skip cells', () => {
    const bl = blocksOf(spans());
    expect(setBlockTypeOps(bl, 3, 3, 'heading', { level: 1 })).toEqual([]);
    expect(toggleListOps(bl, 3, 9, 'unordered-list-item')).toEqual([]);
    expect(indentOps(bl, 3, 3)).toEqual([]);
    expect(outdentOps(bl, 3, 3)).toEqual([]);
    expect(insertDividerOps(bl, 3, 3).ops).toEqual([]);
    // A selection spanning x and the table still retypes x.
    expect(setBlockTypeOps(bl, 1, 5, 'heading', { level: 1 }))
      .toEqual([{ op: 'updateBlock', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } }]);
  });

  it('bold across cells marks the text in both (marks do not touch structure)', () => {
    const s = spans();
    const ops = toggleMarkOps(blocksOf(s), 3, 6, 'strong');
    expect(mdOf(applyOpsToSpans(s, ops))).toBe(`x\n\n| **a** | **b** |\n| --- | --- |\n| c | d |\n\ny`);
  });

  describe('pasting', () => {
    it('a table into an empty document', () => {
      const s = docOf('');
      const { ops, caret } = opsForPasteText(blocksOf(s), 0, 0, TABLE);
      const after = applyOpsToSpans(s, ops);
      expect(typesOf(after)).toEqual([...CELLS, 'paragraph']);
      expect(mdOf(after)).toBe(`${TABLE}\n\n`);
      expect(caret).toBe(9); // in the paragraph after the table
    });

    it('a table into an empty paragraph retypes that paragraph into the first cell', () => {
      const s: RichTextSpan[] = [blockSpan('paragraph'), textSpan('x'), blockSpan('paragraph')];
      const { ops } = opsForPasteText(blocksOf(s), 3, 3, TABLE);
      expect(typesOf(applyOpsToSpans(s, ops))).toEqual(['paragraph', ...CELLS, 'paragraph']);
    });

    it('a table mid-paragraph puts the text after the caret in a paragraph after the table', () => {
      const s = docOf('hello world');
      const { ops, caret } = opsForPasteText(blocksOf(s), 7, 7, TABLE); // "￼hello |world"
      const after = applyOpsToSpans(s, ops);
      expect(mdOf(after)).toBe(`hello \n\n${TABLE}\n\nworld`);
      expect(caret).toBe(16); // start of "world"
    });

    it('structured text into a cell is flattened to one line', () => {
      const s = spans();
      const { ops } = opsForPasteText(blocksOf(s), 4, 4, '# T\n\n- one\n- **two**');
      expect(mdOf(applyOpsToSpans(s, ops))).toBe(`x\n\n| aT one **two** | b |\n| --- | --- |\n| c | d |\n\ny`);
    });

    it('a table into a cell is flattened too', () => {
      const s = spans();
      const { ops } = opsForPasteText(blocksOf(s), 4, 4, TABLE);
      expect(typesOf(applyOpsToSpans(s, ops))).toEqual(['paragraph', ...CELLS, 'paragraph']);
      expect(mdOf(applyOpsToSpans(s, ops))).toContain('| aa b c d | b |');
    });

    it('a plain word into a cell types like typing', () => {
      const s = spans();
      const { ops } = opsForPasteText(blocksOf(s), 4, 4, 'zz');
      expect(ops).toEqual([{ op: 'splice', index: 4, del: 0, text: 'zz' }]);
    });
  });
});
