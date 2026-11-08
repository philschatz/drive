import { markedText, markedTextOps, parseMarkedText } from './marker-markup';
import { markersFromSpans, type DocMarker, type RichTextSpan } from '../../../shared/rich-text-ops';

const HREF = JSON.stringify({ href: 'https://example.com' });
const text = (value: string, marks?: Record<string, unknown>): RichTextSpan =>
  marks ? { type: 'text', value, marks } : { type: 'text', value };
const block = (type: string, attrs: Record<string, unknown> = {}): RichTextSpan =>
  ({ type: 'block', value: { type, parents: [], attrs } });
const heading = (index: number): DocMarker =>
  ({ kind: 'block', index, block: { type: 'heading', parents: [], attrs: { level: 1 } } });
const paragraph = (index: number): DocMarker =>
  ({ kind: 'block', index, block: { type: 'paragraph', parents: [], attrs: {} } });
const strong = (start: number, end: number): DocMarker => ({ kind: 'mark', name: 'strong', value: true, start, end });
const link = (start: number, end: number): DocMarker => ({ kind: 'mark', name: 'link', value: HREF, start, end });

/** `￼Hello world`: a heading marker, a bold run, a linked run — markers 1, 2, 3. */
const SPANS: RichTextSpan[] = [block('heading', { level: 1 }), text('Hello ', { strong: true }), text('world', { link: HREF })];
const TEXT = '￼Hello world';
const MARKERS = markersFromSpans(SPANS);
const MARKUP = '⟦1 h1⟧⟨2 strong⟩Hello ⟨/2⟩⟨3 link⟩world⟨/3⟩';

const parse = (raw: string) => parseMarkedText(raw, MARKERS);

describe('markedText', () => {
  it('numbers every marker as the list does, with a label for reading', () => {
    expect(markedText(TEXT, MARKERS)).toBe(MARKUP);
  });

  it('closes nested marks like brackets', () => {
    expect(markedText('Hello ', [strong(0, 6), { kind: 'mark', name: 'em', value: true, start: 3, end: 6 }]))
      .toBe('⟨1 strong⟩Hel⟨2 em⟩lo ⟨/2⟩⟨/1⟩');
  });

  it('escapes the delimiters along with the usual escapes', () => {
    expect(markedText('a⟦b\n⟩', [])).toBe('a\\⟦b\\n\\⟩');
  });
});

describe('parseMarkedText', () => {
  it('reads its own output back', () => {
    expect(parse(MARKUP)).toEqual({ text: TEXT, markers: MARKERS });
  });

  it('ignores the label — retyping it is not an edit', () => {
    expect(parse('⟦1 blockquote⟧⟨2 em⟩Hello ⟨/2⟩⟨3 link⟩world⟨/3⟩').markers).toEqual(MARKERS);
  });

  it('moves a marker with its token, keeping its type and attrs', () => {
    // The heading, and every one of its attrs, now sits before "world".
    expect(parse('⟨2 strong⟩Hello ⟨/2⟩⟦1 h1⟧⟨3 link⟩world⟨/3⟩')).toEqual({
      text: 'Hello ￼world',
      markers: [strong(0, 6), heading(6), link(7, 12)],
    });
  });

  it('duplicates a marker whose token is pasted twice', () => {
    expect(parse('⟦1 h1⟧Hello ⟦1 h1⟧world').markers).toEqual([heading(0), heading(7)]);
    expect(parse('⟨2 strong⟩He⟨/2⟩llo ⟨2 strong⟩wor⟨/2⟩ld').markers).toEqual([strong(0, 2), strong(6, 9)]);
  });

  it('removes a marker whose token is gone', () => {
    expect(parse('⟦1 h1⟧Hello world')).toEqual({ text: TEXT, markers: [heading(0)] });
  });

  it('places a default paragraph for a block token naming nothing, and for a typed ￼', () => {
    // Unnumbered, unknown, a mark's number, the escape, and a bare character.
    expect(parse('⟦⟧a⟦9⟧b⟦2⟧c\\uFFFCd￼e')).toEqual({
      text: '￼a￼b￼c￼d￼e',
      markers: [paragraph(0), paragraph(2), paragraph(4), paragraph(6), paragraph(8)],
    });
  });

  it('places nothing for a mark token that is unpaired, unknown, empty, or a block\'s number', () => {
    expect(parse('⟨2⟩⟨/2⟩a⟨3⟩b⟨9⟩c⟨/9⟩⟨1⟩d⟨/1⟩⟨/2⟩')).toEqual({ text: 'abcd', markers: [] });
  });

  it('pairs a duplicated open with its close like brackets', () => {
    expect(parse('⟨2⟩a⟨2⟩b⟨/2⟩c⟨/2⟩').markers).toEqual([strong(0, 3), strong(1, 2)]);
  });

  it('reads an escaped or unterminated delimiter as text', () => {
    expect(parse('\\⟦x\\⟩')).toEqual({ text: '⟦x⟩', markers: [] });
    expect(parse('a⟦b')).toEqual({ text: 'a⟦b', markers: [] });
  });
});

describe('markedTextOps', () => {
  it('is nothing when the markup is unchanged', () => {
    expect(markedTextOps(MARKUP, TEXT, MARKERS)).toEqual([]);
  });

  it('is one updateSpans op carrying the field as the edit left it', () => {
    expect(markedTextOps('⟨2 strong⟩Hello ⟨/2⟩⟦1 h1⟧⟨3 link⟩world⟨/3⟩', TEXT, MARKERS)).toEqual([{
      op: 'updateSpans',
      spans: [text('Hello ', { strong: true }), block('heading', { level: 1 }), text('world', { link: HREF })],
    }]);
  });
});
