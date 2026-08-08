/**
 * The pure marker helpers: the discrete view of `spans()`, the flat-text diff
 * that keeps a hand edit from flattening a Peritext field, and the ops for
 * changing one marker.
 *
 * `applyRichTextOps` itself is not tested here — it is a 1:1 mapping onto the
 * Automerge API and is exercised against the real thing by spans-model.test.ts.
 */
import * as A from '@automerge/automerge';
import {
  BLOCK_MARKER, applyRichTextOps, flatTextEditOps, flatTextFromSpans, markerEditOps, markersFromSpans,
  strayBlockMarkers,
  type DocMarker, type RichTextOp, type RichTextSpan,
} from './rich-text-ops';

const text = (value: string, marks?: Record<string, unknown>): RichTextSpan =>
  marks ? { type: 'text', value, marks } : { type: 'text', value };
const block = (type: string, attrs: Record<string, unknown> = {}): RichTextSpan =>
  ({ type: 'block', value: { type, parents: [], attrs } });

describe('markersFromSpans', () => {
  it('reports a mark spanning several runs as one range', () => {
    // "one two" all bold, but split into two runs by an em on "two".
    expect(markersFromSpans([
      text('one ', { strong: true }),
      text('two', { strong: true, em: true }),
    ])).toEqual([
      { kind: 'mark', name: 'strong', value: true, start: 0, end: 7 },
      { kind: 'mark', name: 'em', value: true, start: 4, end: 7 },
    ]);
  });

  it('keeps adjacent marks of the same name apart when their values differ', () => {
    const a = JSON.stringify({ href: 'https://a.example' });
    const b = JSON.stringify({ href: 'https://b.example' });
    expect(markersFromSpans([text('aaa', { link: a }), text('bbb', { link: b })])).toEqual([
      { kind: 'mark', name: 'link', value: a, start: 0, end: 3 },
      { kind: 'mark', name: 'link', value: b, start: 3, end: 6 },
    ]);
  });

  it('merges adjacent runs carrying the same name AND value', () => {
    expect(markersFromSpans([text('aaa', { strong: true }), text('bbb', { strong: true })]))
      .toEqual([{ kind: 'mark', name: 'strong', value: true, start: 0, end: 6 }]);
  });

  it('reports block markers as points and closes marks at them', () => {
    const markers = markersFromSpans([
      block('heading', { level: 1 }),
      text('Title', { strong: true }),
      block('paragraph'),
      text('Body'),
    ]);
    expect(markers).toEqual([
      { kind: 'block', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { kind: 'mark', name: 'strong', value: true, start: 1, end: 6 },
      { kind: 'block', index: 6, block: { type: 'paragraph', parents: [], attrs: {} } },
    ]);
    // The block marker occupies index 6 — one position in the flat text.
    expect(flatTextFromSpans([block('heading'), text('Title'), block('paragraph'), text('Body')]))
      .toBe(`${BLOCK_MARKER}Title${BLOCK_MARKER}Body`);
  });

  it('handles overlapping marks that start and end at different points', () => {
    // strong over [0,6), link over [3,9)
    const href = JSON.stringify({ href: 'https://x.example' });
    expect(markersFromSpans([
      text('abc', { strong: true }),
      text('def', { strong: true, link: href }),
      text('ghi', { link: href }),
    ])).toEqual([
      { kind: 'mark', name: 'strong', value: true, start: 0, end: 6 },
      { kind: 'mark', name: 'link', value: href, start: 3, end: 9 },
    ]);
  });

  it('returns nothing for plain text', () => {
    expect(markersFromSpans([text('nothing to see')])).toEqual([]);
  });
});

describe('strayBlockMarkers', () => {
  it('finds nothing in a healthy field', () => {
    expect(strayBlockMarkers([block('paragraph'), text('one'), block('paragraph'), text('two')]))
      .toEqual([]);
  });

  it('finds the literal ￼ characters a flattened field is left with', () => {
    // What `doc.content = '￼one￼two'` produces: one text span, no markers.
    expect(strayBlockMarkers([text(`${BLOCK_MARKER}one${BLOCK_MARKER}two`)])).toEqual([0, 4]);
  });

  it('counts positions past a real marker correctly', () => {
    expect(strayBlockMarkers([block('paragraph'), text(`ab${BLOCK_MARKER}`)])).toEqual([3]);
  });
});

describe('flatTextEditOps', () => {
  const M = BLOCK_MARKER;

  it('is empty for an unchanged string', () => {
    expect(flatTextEditOps('abc', 'abc')).toEqual([]);
  });

  it('splices inserted text at the divergence point', () => {
    expect(flatTextEditOps('one two', 'one big two')).toEqual([
      { op: 'splice', index: 4, del: 0, text: 'big ' },
    ]);
  });

  it('splices out deleted text', () => {
    expect(flatTextEditOps('one big two', 'one two')).toEqual([
      { op: 'splice', index: 4, del: 4 },
    ]);
  });

  it('inserts a block marker as splitBlock, not as a character', () => {
    expect(flatTextEditOps(`${M}one two`, `${M}one${M}two`)).toEqual([
      { op: 'splice', index: 4, del: 1 },
      { op: 'splitBlock', index: 4, block: { type: 'paragraph', parents: [], attrs: {} } },
    ]);
  });

  it('deletes a block marker as joinBlock', () => {
    expect(flatTextEditOps(`${M}one${M}two`, `${M}onetwo`)).toEqual([
      { op: 'joinBlock', index: 4 },
    ]);
  });

  it('deletes a run spanning a marker back to front, so indices stay valid', () => {
    // Remove "e￼t" from "￼oneXtwo" → the splice after the marker is
    // emitted first, then the joinBlock, then the splice before it.
    expect(flatTextEditOps(`${M}one${M}two`, `${M}onwo`)).toEqual([
      { op: 'splice', index: 5, del: 1 },
      { op: 'joinBlock', index: 4 },
      { op: 'splice', index: 3, del: 1 },
    ]);
  });

  it('replaces a hunk containing a marker with plain text', () => {
    expect(flatTextEditOps(`a${M}b`, 'aXb')).toEqual([
      { op: 'joinBlock', index: 1 },
      { op: 'splice', index: 1, del: 0, text: 'X' },
    ]);
  });

  it('handles insertion at the very start and very end', () => {
    expect(flatTextEditOps('bc', 'abc')).toEqual([{ op: 'splice', index: 0, del: 0, text: 'a' }]);
    expect(flatTextEditOps('ab', 'abc')).toEqual([{ op: 'splice', index: 2, del: 0, text: 'c' }]);
  });

  it('handles emptying and filling a field', () => {
    expect(flatTextEditOps('abc', '')).toEqual([{ op: 'splice', index: 0, del: 3 }]);
    expect(flatTextEditOps('', 'abc')).toEqual([{ op: 'splice', index: 0, del: 0, text: 'abc' }]);
  });

  it('does not let prefix and suffix overlap on a repeated string', () => {
    // Naive prefix+suffix matching would count the middle 'a' twice.
    const ops = flatTextEditOps('aaa', 'aa');
    expect(ops).toEqual([{ op: 'splice', index: 2, del: 1 }]);
  });
});

describe('markerEditOps', () => {
  const mark = (over: Partial<Extract<DocMarker, { kind: 'mark' }>> = {}): DocMarker =>
    ({ kind: 'mark', name: 'strong', value: true, start: 2, end: 5, ...over });

  it('deletes a mark with unmark over its own range', () => {
    expect(markerEditOps(mark(), null)).toEqual([
      { op: 'unmark', start: 2, end: 5, name: 'strong', expand: 'none' },
    ]);
  });

  it('re-marks in place for a value-only change, without unmarking first', () => {
    const href = JSON.stringify({ href: 'https://new.example' });
    expect(markerEditOps(mark({ name: 'link', value: 'old' }), mark({ name: 'link', value: href })))
      .toEqual([{ op: 'mark', start: 2, end: 5, name: 'link', value: href, expand: 'none' }]);
  });

  it('unmarks the old range before marking a moved one', () => {
    expect(markerEditOps(mark(), mark({ start: 0, end: 9 }))).toEqual([
      { op: 'unmark', start: 2, end: 5, name: 'strong', expand: 'none' },
      { op: 'mark', start: 0, end: 9, name: 'strong', value: true, expand: 'none' },
    ]);
  });

  it('updates and deletes block markers', () => {
    const b: DocMarker = { kind: 'block', index: 4, block: { type: 'paragraph', parents: [], attrs: {} } };
    const heading: DocMarker = { kind: 'block', index: 4, block: { type: 'heading', parents: [], attrs: { level: 2 } } };
    expect(markerEditOps(b, heading)).toEqual([
      { op: 'updateBlock', index: 4, block: { type: 'heading', parents: [], attrs: { level: 2 } } },
    ]);
    expect(markerEditOps(b, null)).toEqual([{ op: 'joinBlock', index: 4 }]);
  });

  it('moves a block marker as a removal plus a re-insertion, re-reading the index', () => {
    const at = (index: number): DocMarker =>
      ({ kind: 'block', index, block: { type: 'paragraph', parents: [], attrs: {} } });
    const block = { type: 'paragraph', parents: [], attrs: {} };
    // Moving later: the joinBlock shifts the target down by one.
    expect(markerEditOps(at(4), at(9))).toEqual([
      { op: 'joinBlock', index: 4 },
      { op: 'splitBlock', index: 8, block },
    ]);
    // Moving earlier: positions before the removal are unaffected.
    expect(markerEditOps(at(4), at(1))).toEqual([
      { op: 'joinBlock', index: 4 },
      { op: 'splitBlock', index: 1, block },
    ]);
  });

  it('refuses to turn a mark into a block marker', () => {
    const b: DocMarker = { kind: 'block', index: 4, block: { type: 'paragraph', parents: [], attrs: {} } };
    expect(() => markerEditOps(mark(), b)).toThrow(/cannot change a mark/);
    expect(() => markerEditOps(b, mark())).toThrow(/cannot change a block marker/);
  });
});

/**
 * Against REAL Automerge, not the pure emulation: these op builders are what
 * the source inspector writes with, and the whole point of routing an edit
 * through them is that Automerge keeps the surrounding markers. An op sequence
 * that merely type-checks proves nothing — `joinBlock` at the wrong index or a
 * `mark` with the wrong expansion silently corrupts a field.
 */
describe('against real Automerge', () => {
  /** Build a doc from spans, apply ops, read the resulting spans back. */
  function run(initial: RichTextSpan[], ops: RichTextOp[]): RichTextSpan[] {
    let doc = A.from({ content: '' });
    doc = A.change(doc, (d: any) => applyRichTextOps(A, d, ['content'], [{ op: 'updateSpans', spans: initial }]));
    doc = A.change(doc, (d: any) => applyRichTextOps(A, d, ['content'], ops));
    return JSON.parse(JSON.stringify(A.spans(doc, ['content'])));
  }
  const flat = (spans: RichTextSpan[]) => flatTextFromSpans(spans);

  /** `￼Hello world` with a heading marker, a bold run and a linked run. */
  const href = JSON.stringify({ href: 'https://example.com' });
  const DOC: RichTextSpan[] = [
    { type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 } } },
    { type: 'text', value: 'Hello ', marks: { strong: true } },
    { type: 'text', value: 'world', marks: { link: href } },
  ];

  it('splices edited text in, and text lands inside the mark it was typed into', () => {
    const after = run(DOC, flatTextEditOps(flat(DOC), '￼Hello brave world'));
    expect(flat(after)).toBe('￼Hello brave world');
    expect(markersFromSpans(after)).toEqual([
      { kind: 'block', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      // "brave " went in at index 7 — the end of the bold run — and `strong`
      // expands `after`, so it absorbs the insertion (1..7 becomes 1..13). That
      // is Automerge's own rule, the same one that continues bold when you type
      // at the end of a bold word in the editor, and not something the diff
      // chooses. The link, inserted BEFORE, simply shifts.
      { kind: 'mark', name: 'strong', value: true, start: 1, end: 13 },
      { kind: 'mark', name: 'link', value: href, start: 13, end: 18 },
    ]);
  });

  it('turns a typed ￼ into a real block marker, not a character', () => {
    const after = run(DOC, flatTextEditOps(flat(DOC), '￼Hello ￼world'));
    expect(markersFromSpans(after).filter(m => m.kind === 'block')).toEqual([
      { kind: 'block', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { kind: 'block', index: 7, block: { type: 'paragraph', parents: [], attrs: {} } },
    ]);
  });

  it('removes a block marker when its ￼ is deleted, keeping the text', () => {
    const after = run(DOC, flatTextEditOps(flat(DOC), 'Hello world'));
    expect(flat(after)).toBe('Hello world');
    expect(markersFromSpans(after).some(m => m.kind === 'block')).toBe(false);
  });

  it('deletes a run spanning a block marker, back to front', () => {
    const src: RichTextSpan[] = [
      { type: 'text', value: 'one' },
      { type: 'block', value: { type: 'paragraph', parents: [], attrs: {} } },
      { type: 'text', value: 'two' },
    ];
    const after = run(src, flatTextEditOps(flat(src), 'onwo'));
    expect(flat(after)).toBe('onwo');
    expect(markersFromSpans(after)).toEqual([]);
  });

  it('widens a mark exactly to the range given, without expanding', () => {
    const strong = markersFromSpans(DOC).find(m => m.kind === 'mark' && m.name === 'strong')!;
    const after = run(DOC, markerEditOps(strong, { ...(strong as any), end: 12 }));
    expect(markersFromSpans(after)).toEqual([
      { kind: 'block', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { kind: 'mark', name: 'strong', value: true, start: 1, end: 12 },
      { kind: 'mark', name: 'link', value: href, start: 7, end: 12 },
    ]);
  });

  it('deletes a mark and leaves the text and the other markers alone', () => {
    const link = markersFromSpans(DOC).find(m => m.kind === 'mark' && m.name === 'link')!;
    const after = run(DOC, markerEditOps(link, null));
    expect(flat(after)).toBe('￼Hello world');
    expect(markersFromSpans(after)).toEqual([
      { kind: 'block', index: 0, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { kind: 'mark', name: 'strong', value: true, start: 1, end: 7 },
    ]);
  });

  it('retypes a block marker in place', () => {
    const heading = markersFromSpans(DOC).find(m => m.kind === 'block')!;
    const after = run(DOC, markerEditOps(heading, {
      kind: 'block', index: 0, block: { type: 'blockquote', parents: [], attrs: {} },
    }));
    expect((after[0] as any).value.type).toBe('blockquote');
    expect(flat(after)).toBe('￼Hello world');
  });

  it('moves a block marker to a later index', () => {
    const heading = markersFromSpans(DOC).find(m => m.kind === 'block')!;
    const after = run(DOC, markerEditOps(heading, {
      kind: 'block', index: 7, block: { type: 'heading', parents: [], attrs: { level: 1 } } },
    ));
    // The marker left index 0 and landed after "Hello " in the shortened text.
    expect(flat(after)).toBe('Hello ￼world');
    expect(markersFromSpans(after).find(m => m.kind === 'block')).toEqual(
      { kind: 'block', index: 6, block: { type: 'heading', parents: [], attrs: { level: 1 } } });
  });
});
