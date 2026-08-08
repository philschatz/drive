import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// The source inspector against the in-memory mock, which backs `allRichText`
// with the same spansStore that stands in for Automerge's mark/block-marker
// storage. That is the point of this file: markers are invisible to the jq
// projection the rest of the tree renders, so nothing else here can prove they
// reach the screen — or that editing one emits the right ops instead of the
// scalar assignment that used to flatten the whole field.
jest.mock('../worker-api');
import * as api from '../worker-api';
import type { RichTextSpan } from '../../../shared/rich-text-ops';
import { SourceViewer } from './SourceViewer';

const mock = api as any;

// Guards the positional __mocks__ resolution: if src/client/ui/__mocks__/ ever
// drifts away from worker-api.ts, jest.mock() above silently loads the real
// module and every assertion below fails for an unrelated-looking reason.
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));

const DOC = 'doc-source-markers';
const HREF = JSON.stringify({ href: 'https://example.com' });

const text = (value: string, marks?: Record<string, unknown>): RichTextSpan =>
  marks ? { type: 'text', value, marks } : { type: 'text', value };
const block = (type: string, attrs: Record<string, unknown> = {}): RichTextSpan =>
  ({ type: 'block', value: { type, parents: [], attrs } });

/** `￼Hello world` — a heading marker, a bold run, then a linked run. */
const SPANS: RichTextSpan[] = [
  block('heading', { level: 1 }),
  text('Hello ', { strong: true }),
  text('world', { link: HREF }),
];

const rows = () => Array.from(document.querySelectorAll('.source-marker-row')) as HTMLElement[];
const contentSpans = () => mock.__getSpans(DOC, ['content']) as RichTextSpan[];
/** The marks on the character at `index`, as the spans currently say. */
const marksAt = (index: number): Record<string, unknown> => {
  let at = 0;
  for (const s of contentSpans()) {
    const len = s.type === 'block' ? 1 : s.value.length;
    if (index < at + len) return s.type === 'block' ? {} : (s.marks ?? {});
    at += len;
  }
  return {};
};

/** Click a click-to-edit cell, type `value`, commit with Enter. */
const editCell = (cell: HTMLElement, value: string) => {
  fireEvent.click(cell);
  const input = document.querySelector('input.source-edit-input') as HTMLInputElement;
  expect(input).toBeTruthy();
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
};

async function renderWithMarkers(doc?: any, spans: RichTextSpan[] = SPANS) {
  mock.__setDoc(DOC, doc ?? { '@type': 'Sentences', name: 'Notes', content: '' });
  // Mirrors the flat text into the doc, so the projection and the spans agree.
  mock.__setSpans(DOC, ['content'], spans);
  render(<SourceViewer docId={DOC} />);
  await waitFor(() => expect(document.querySelector('.source-tree')).toBeTruthy());
}

describe('source inspector markers', () => {
  beforeEach(() => { mock.__reset(); });

  it('lists every marker of a rich-text field with its range', async () => {
    await renderWithMarkers();

    // Three markers: the block marker at 0, strong over [1,7), link over [7,12).
    const [heading, strong, link] = rows();
    expect(rows()).toHaveLength(3);

    expect(within(heading).getByTitle('Block type').textContent).toBe('¶ heading');
    expect(within(heading).getByTitle('Position in the flat text').textContent).toBe('0');
    expect(within(heading).getByTitle('Block attrs (JSON)').textContent).toBe('{"level":1}');

    expect(within(strong).getByTitle('Mark name').textContent).toBe('strong');
    expect(within(strong).getByTitle('Range start').textContent).toBe('1');
    expect(within(strong).getByTitle('Range end').textContent).toBe('7');

    expect(within(link).getByTitle('Mark name').textContent).toBe('link');
    expect(within(link).getByTitle('Mark value').textContent).toBe(HREF);
  });

  it('shows the block marker inline as a chip instead of an invisible character', async () => {
    await renderWithMarkers();
    const chip = document.querySelector('.source-marker-chip');
    expect(chip).toBeTruthy();
    // The block's type reaches the chip — `¶` alone would not say which it is.
    expect(chip!.textContent).toContain('¶h1');
    // One footnote per marker, tying each highlight to its row below.
    expect(document.querySelectorAll('.source-marker-footnote').length).toBeGreaterThanOrEqual(6);
  });

  it('widens a mark by editing its range, as unmark + mark', async () => {
    await renderWithMarkers();
    expect(marksAt(7)).toEqual({ link: HREF }); // not bold yet

    editCell(within(rows()[1]).getByTitle('Range end'), '12');

    await waitFor(() => expect(marksAt(7).strong).toBe(true));
    // The whole run is bold now, and the link it overlaps is untouched.
    expect(marksAt(1)).toEqual({ strong: true });
    expect(marksAt(11)).toEqual({ strong: true, link: HREF });
  });

  it('deletes a mark without touching the text or the other markers', async () => {
    await renderWithMarkers();

    fireEvent.click(within(rows()[2]).getByTitle('Delete marker'));

    await waitFor(() => expect(marksAt(7).link).toBeUndefined());
    expect(marksAt(1)).toEqual({ strong: true });
    expect(mock.__getDoc(DOC).content).toBe('￼Hello world');
    // The block marker survives, so the field is still two markers deep.
    expect(rows()).toHaveLength(2);
  });

  it('shows and edits list nesting, which is stored only as the parents chain', async () => {
    await renderWithMarkers({ '@type': 'Sentences', name: 'List', content: '' }, [
      { type: 'block', value: { type: 'unordered-list-item', parents: [], attrs: {} } },
      text('top'),
      { type: 'block', value: { type: 'unordered-list-item', parents: ['unordered-list-item'], attrs: {} } },
      text('nested'),
    ]);

    // Two identically-typed items; only `parents` tells them apart, so both the
    // chip and the list have to surface it.
    // The chip carries its footnote in a <sup>; drop it to read the label.
    const chipLabel = (c: Element) => Array.from(c.childNodes)
      .filter(n => n.nodeName !== 'SUP').map(n => n.textContent).join('');
    const chips = Array.from(document.querySelectorAll('.source-marker-chip'));
    expect(chips.map(chipLabel)).toEqual(['¶ul', '¶ul·1']);

    const parentsCell = within(rows()[1]).getByTitle(/Block parents/);
    expect(parentsCell.textContent).toBe('["unordered-list-item"]');

    // Outdenting is popping the chain.
    editCell(parentsCell, '[]');
    await waitFor(() => expect((contentSpans()[2].value as any).parents).toEqual([]));
  });

  it('retypes a block marker as a different type', async () => {
    await renderWithMarkers();

    editCell(within(rows()[0]).getByTitle('Block type'), 'blockquote');

    await waitFor(() => expect((contentSpans()[0].value as any).type).toBe('blockquote'));
  });

  it('edits the string itself without flattening its markers', async () => {
    await renderWithMarkers();
    const node = screen.getByText('"content"').closest('.source-node') as HTMLElement;

    // `￼` is the escape the value renders block markers as, so the whole
    // field is editable as text — including where its blocks sit.
    fireEvent.click(within(node).getByTitle('Edit'));
    const input = document.querySelector('input.source-edit-input') as HTMLInputElement;
    expect(input.value).toBe('\\uFFFCHello world');
    fireEvent.input(input, { target: { value: '\\uFFFCHello brave world' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(mock.__getDoc(DOC).content).toBe('￼Hello brave world'));
    // A scalar assignment would have left literal `￼` characters and no marks
    // at all; the diffed ops keep every marker.
    expect(contentSpans()[0]).toEqual({ type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 } } });
    expect(marksAt(1)).toEqual({ strong: true });
    expect(marksAt(16)).toEqual({ link: HREF }); // "world" is still linked
  });

  it('adds a block marker by typing its escape into the string', async () => {
    await renderWithMarkers();
    const node = screen.getByText('"content"').closest('.source-node') as HTMLElement;

    fireEvent.click(within(node).getByTitle('Edit'));
    const input = document.querySelector('input.source-edit-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '\\uFFFCHello \\uFFFCworld' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(rows()).toHaveLength(4));
    // A typed marker is a real block marker (a default paragraph), not a
    // literal character — the difference the whole rich-text edit path exists for.
    expect(contentSpans().filter(s => s.type === 'block').map(s => (s.value as any).type))
      .toEqual(['heading', 'paragraph']);
  });

  it('surfaces markers on a field no schema declares, as a warning', async () => {
    await renderWithMarkers(
      { '@type': 'Sentences', name: 'Notes', content: '' },
      SPANS,
    );
    // `name` is a plain string in the Sentences schema, but the inspector reads
    // markers from the document rather than from the schema, so it shows them.
    mock.__setSpans(DOC, ['name'], [text('Notes', { strong: true })]);

    await waitFor(() => expect(rows().length).toBe(4));
    expect(screen.getByText(/does not declare richText/)).toBeTruthy();
    // Still fully editable — an undeclared field is flagged, not walled off.
    expect(within(rows()[0]).getByTitle('Mark name').textContent).toBe('strong');
  });
});
