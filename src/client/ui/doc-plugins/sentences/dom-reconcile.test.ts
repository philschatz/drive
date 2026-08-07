/**
 * The DOM → model diff that folds IME-composed text back into the document.
 *
 * Pure, so it is exercised here rather than through a contenteditable: the
 * caller reads the block texts out of the DOM, and everything that can actually
 * go wrong — which block an edit belongs to, what order the ops must be in,
 * whether a surrogate pair survives — is string and index arithmetic.
 */
import { blocksFromSpans } from './blocks';
import { diffText, reconcileDomToOps } from './dom-reconcile';
import type { RichTextSpan } from '../../../../shared/rich-text-ops';

const block = (type: string): RichTextSpan => ({ type: 'block', value: { type, parents: [] } });
const text = (value: string): RichTextSpan => ({ type: 'text', value });

/** ￼one￼two￼three — three paragraphs, so block N's text starts at 3N+1. */
const threeParas = blocksFromSpans([
  block('paragraph'), text('one'),
  block('paragraph'), text('two'),
  block('paragraph'), text('three'),
]);

describe('diffText', () => {
  it('returns null when nothing changed', () => {
    expect(diffText('hello', 'hello')).toBeNull();
  });

  it('finds a pure insertion', () => {
    expect(diffText('hello', 'hello wo')).toEqual({ at: 5, del: 0, ins: ' wo' });
  });

  it('finds a pure deletion', () => {
    expect(diffText('hello', 'helo')).toEqual({ at: 3, del: 1, ins: '' });
  });

  it('finds a replacement in the middle', () => {
    expect(diffText('teh cat', 'the cat')).toEqual({ at: 1, del: 2, ins: 'he' });
  });

  it('replaces one emoji with another wholesale, not a lone surrogate', () => {
    // The pair shares a high surrogate, so a scan in UTF-16 code units stops
    // between the halves and emits `{at:1, del:1, ins:'\uDE01'}` — a lone
    // surrogate, which is not valid text and corrupts the document.
    expect(diffText('😀', '😁')).toEqual({ at: 0, del: 2, ins: '😁' });
  });

  it('deletes a whole emoji rather than one code unit', () => {
    expect(diffText('😀', 'x')).toEqual({ at: 0, del: 2, ins: 'x' });
  });

  it('round-trips, leaving no unpaired surrogate, for edits next to an emoji', () => {
    const cases: [string, string][] = [
      ['a😀b', 'a😀'], ['a😀', 'b😀'], ['😀', 'x😀'], ['a😀b', 'a😀xb'], ['😀😁', '😁'],
    ];
    for (const [from, to] of cases) {
      const d = diffText(from, to)!;
      expect(from.slice(0, d.at) + d.ins + from.slice(d.at + d.del)).toBe(to);
      // The kept prefix must not end on an unpaired HIGH surrogate (ending on a
      // low one is fine — that is the second half of a complete pair).
      const last = from.charCodeAt(d.at - 1);
      expect(d.at === 0 || !(last >= 0xd800 && last <= 0xdbff)).toBe(true);
    }
  });
});

describe('reconcileDomToOps', () => {
  it('emits nothing when the DOM matches the model', () => {
    expect(reconcileDomToOps(threeParas, ['one', 'two', 'three']))
      .toEqual({ ops: [], resync: false });
  });

  it('splices a composed word into the right block', () => {
    // Block 1's text spans [5, 8); appending lands at 8.
    expect(reconcileDomToOps(threeParas, ['one', 'twoX', 'three']))
      .toEqual({ ops: [{ op: 'splice', index: 8, del: 0, text: 'X' }], resync: false });
  });

  it('orders several changed blocks highest index first', () => {
    // So each op's index still addresses the ORIGINAL model as the earlier ones
    // are applied — an ascending order would shift every later index.
    const { ops } = reconcileDomToOps(threeParas, ['oneX', 'two', 'threeX']);
    expect(ops).toEqual([
      { op: 'splice', index: 14, del: 0, text: 'X' },
      { op: 'splice', index: 4, del: 0, text: 'X' },
    ]);
  });

  it('ignores data-bi entirely — position is what identifies a block', () => {
    // The regression this guards: the old diff looked the block up by the
    // element's data-bi, a render-relative index that any push invalidates, so
    // the splice landed in a different paragraph. Nothing here reads an
    // attribute; the caller passes texts in document order.
    const { ops } = reconcileDomToOps(threeParas, ['one', 'two', 'threeZ']);
    expect(ops).toEqual([{ op: 'splice', index: 14, del: 0, text: 'Z' }]);
  });

  it('never rewrites a divider', () => {
    const withDivider = blocksFromSpans([
      block('paragraph'), text('a'),
      block('divider'),
      block('paragraph'), text('b'),
    ]);
    // A divider is atomic and renders no text; a stray reading must not become
    // a splice into it.
    expect(reconcileDomToOps(withDivider, ['a', 'junk', 'b']))
      .toEqual({ ops: [], resync: false });
  });

  it('emits nothing and asks for a resync when the block count changed', () => {
    // Which DOM block is which model block is precisely the unknown here, so
    // guessing would write text into the wrong paragraph. Bail instead: the
    // caller rebuilds the DOM from the model, costing at most an in-flight
    // composed word and never corrupting the document.
    for (const dom of [
      ['one', 'two', 'thr', 'ee'],       // a block was split
      ['oneX', 'two', 'spl', 'it'],      // split, plus a text edit elsewhere
      ['one', 'two'],                    // a block vanished
      ['one', 'two', 'new', 'three'],    // a block appeared
    ]) {
      expect(reconcileDomToOps(threeParas, dom)).toEqual({ ops: [], resync: true });
    }
  });

  it('handles a document whose first block is implicit', () => {
    // Text before any marker is an implicit leading paragraph starting at 0.
    const implicit = blocksFromSpans([text('lead'), block('paragraph'), text('next')]);
    expect(reconcileDomToOps(implicit, ['leadX', 'next']))
      .toEqual({ ops: [{ op: 'splice', index: 4, del: 0, text: 'X' }], resync: false });
  });
});
