import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// The source inspector against the in-memory mock, which backs `allRichText` with
// the same spansStore that stands in for Automerge's mark/block-marker storage.
// That is the point of this file: markers are invisible to the jq projection the
// rest of the inspector renders, so nothing else here can prove they reach the
// screen — or that editing one emits the right ops instead of the scalar
// assignment that used to flatten the whole field.
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

const rows = () => Array.from(document.querySelectorAll('[data-testid="marker-row"]')) as HTMLElement[];
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

/** Open marker `i`'s sheet, then the `rowId` property's pane. */
async function openPane(i: number, rowId: string) {
  fireEvent.click(rows()[i]);
  await waitFor(() => expect(screen.getByTestId('marker-sheet')).toBeTruthy());
  fireEvent.click(screen.getByTestId(`${rowId}-row`));
  await waitFor(() => expect(screen.getByTestId('marker-field')).toBeTruthy());
}

/** Type into the open pane's single field and Save. `stem` is FieldEditor's testid. */
function savePane(stem: string, value: string) {
  fireEvent.input(screen.getByTestId('marker-field'), { target: { value } });
  fireEvent.click(screen.getByTestId(`${stem}-save`));
}

/**
 * The inspector opened straight onto the rich-text field's own screen — a
 * marker-carrying string is not a row in its parent level, it is a level.
 */
async function renderWithMarkers(doc?: any, spans: RichTextSpan[] = SPANS) {
  mock.__setDoc(DOC, doc ?? { '@type': 'Sentences', name: 'Notes', content: '' });
  // Mirrors the flat text into the doc, so the projection and the spans agree.
  mock.__setSpans(DOC, ['content'], spans);
  render(<SourceViewer docId={DOC} rest="content" />);
  await waitFor(() => expect(document.querySelector('[data-testid="source-field"]')).toBeTruthy());
}

beforeEach(() => {
  mock.__reset();
  window.location.hash = `#/source/${DOC}`;
});

describe('source inspector markers', () => {
  it('lists every marker of a rich-text field with its range', async () => {
    await renderWithMarkers();

    // Three markers: the block marker at 0, strong over [1,7), link over [7,12).
    const [heading, strong, link] = rows();
    expect(rows()).toHaveLength(3);

    // Headline names it; supporting text carries everything else, spelled out
    // rather than hidden in a row of unlabelled cells.
    expect(within(heading).getByText('¶ heading')).toBeTruthy();
    expect(heading.textContent).toContain('at 0');
    expect(heading.textContent).toContain('{"level":1}');

    expect(within(strong).getByText('strong')).toBeTruthy();
    expect(strong.textContent).toContain('[1, 7)');

    expect(within(link).getByText('link')).toBeTruthy();
    expect(link.textContent).toContain(HREF);
  });

  it('names every marker field in its own sheet, not in a tooltip', async () => {
    await renderWithMarkers();

    fireEvent.click(rows()[1]);
    const sheet = await waitFor(() => screen.getByTestId('marker-sheet'));
    // The predecessor's only labels were `title` attributes, invisible on touch.
    expect(within(sheet).getByText('Mark name')).toBeTruthy();
    expect(within(sheet).getByText('Range')).toBeTruthy();
    expect(within(sheet).getByText('Value')).toBeTruthy();
  });

  it('shows the block marker inline as a chip instead of an invisible character', async () => {
    await renderWithMarkers();
    const chip = document.querySelector('.src-marker-chip');
    expect(chip).toBeTruthy();
    // The block's type reaches the chip — `¶` alone would not say which it is.
    expect(chip!.textContent).toContain('¶h1');
    // One reference per marker, tying each highlight to its row below.
    expect(document.querySelectorAll('.src-footnote').length).toBeGreaterThanOrEqual(6);
  });

  it('counts the markers on the field row in the level above', async () => {
    mock.__setDoc(DOC, { '@type': 'Sentences', name: 'Notes', content: '' });
    mock.__setSpans(DOC, ['content'], SPANS);
    render(<SourceViewer docId={DOC} />);

    const row = await waitFor(() => {
      const hit = Array.from(document.querySelectorAll('[data-testid="source-row"]'))
        .find(r => r.getAttribute('data-row-key') === 'content') as HTMLElement;
      if (!hit) throw new Error('no content row yet');
      return hit;
    });
    expect(row.getAttribute('data-kind')).toBe('richtext');
    expect(within(row).getByTestId('marker-count').textContent).toBe('3');
  });

  it('widens a mark by editing its range, as unmark + mark', async () => {
    await renderWithMarkers();
    expect(marksAt(7)).toEqual({ link: HREF }); // not bold yet

    fireEvent.click(rows()[1]);
    await waitFor(() => expect(screen.getByTestId('marker-sheet')).toBeTruthy());
    fireEvent.click(screen.getByTestId('mk-range-row'));
    await waitFor(() => expect(screen.getByTestId('marker-range-end')).toBeTruthy());
    // Both ends are one draft, so widening is a single Automerge change.
    fireEvent.input(screen.getByTestId('marker-range-end'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('marker-range-save'));

    await waitFor(() => expect(marksAt(7).strong).toBe(true));
    // The whole run is bold now, and the link it overlaps is untouched.
    expect(marksAt(1)).toEqual({ strong: true });
    expect(marksAt(11)).toEqual({ strong: true, link: HREF });
  });

  it('deletes a mark without touching the text or the other markers', async () => {
    await renderWithMarkers();

    fireEvent.click(rows()[2]);
    await waitFor(() => expect(screen.getByTestId('marker-delete')).toBeTruthy());
    fireEvent.click(screen.getByTestId('marker-delete'));

    await waitFor(() => expect(marksAt(7).link).toBeUndefined());
    expect(marksAt(1)).toEqual({ strong: true });
    expect(mock.__getDoc(DOC).content).toBe('￼Hello world');
    // The block marker survives, so the field is still two markers deep.
    await waitFor(() => expect(rows()).toHaveLength(2));
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
    // The chip carries its reference number in a trailing span; drop it to read the label.
    const chips = Array.from(document.querySelectorAll('.src-marker-chip'));
    const chipLabel = (c: Element) => Array.from(c.childNodes)
      .filter(n => !(n as HTMLElement).classList?.contains('src-footnote'))
      .map(n => n.textContent).join('');
    expect(chips.map(chipLabel)).toEqual(['¶ul', '¶ul·1']);
    // The rows say the same thing without needing the chip decoded.
    expect(rows()[1].textContent).toContain('depth 1');

    // Outdenting is popping the chain.
    await openPane(1, 'mk-parents');
    savePane('marker-parents', '[]');
    await waitFor(() => expect((contentSpans()[2].value as any).parents).toEqual([]));
  });

  it('retypes a block marker as a different type', async () => {
    await renderWithMarkers();

    await openPane(0, 'mk-type');
    savePane('marker-block-type', 'blockquote');

    await waitFor(() => expect((contentSpans()[0].value as any).type).toBe('blockquote'));
  });

  it('edits the string itself without flattening its markers', async () => {
    await renderWithMarkers();

    // `￼` is the escape the value renders block markers as, so the whole field is
    // editable as text — including where its blocks sit.
    fireEvent.click(screen.getByTestId('field-edit-text'));
    const input = await waitFor(() => screen.getByTestId('value-field') as HTMLTextAreaElement);
    expect(input.value).toBe('\\uFFFCHello world');
    fireEvent.input(input, { target: { value: '\\uFFFCHello brave world' } });
    fireEvent.click(screen.getByTestId('value-save'));

    await waitFor(() => expect(mock.__getDoc(DOC).content).toBe('￼Hello brave world'));
    // A scalar assignment would have left literal `￼` characters and no marks at
    // all; the diffed ops keep every marker.
    expect(contentSpans()[0]).toEqual({ type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 } } });
    expect(marksAt(1)).toEqual({ strong: true });
    expect(marksAt(16)).toEqual({ link: HREF }); // "world" is still linked
  });

  it('adds a block marker by typing its escape into the string', async () => {
    await renderWithMarkers();

    fireEvent.click(screen.getByTestId('field-edit-text'));
    const input = await waitFor(() => screen.getByTestId('value-field') as HTMLTextAreaElement);
    fireEvent.input(input, { target: { value: '\\uFFFCHello \\uFFFCworld' } });
    fireEvent.click(screen.getByTestId('value-save'));

    await waitFor(() => expect(rows()).toHaveLength(4));
    // A typed marker is a real block marker (a default paragraph), not a literal
    // character — the difference the whole rich-text edit path exists for.
    expect(contentSpans().filter(s => s.type === 'block').map(s => (s.value as any).type))
      .toEqual(['heading', 'paragraph']);
  });

  it('warns about markers on a field no schema declares', async () => {
    mock.__setDoc(DOC, { '@type': 'Sentences', name: 'Notes', content: '' });
    mock.__setSpans(DOC, ['content'], SPANS);
    // `name` is a plain string in the Sentences schema, but the inspector reads
    // markers from the document rather than from the schema, so it finds them.
    mock.__setSpans(DOC, ['name'], [text('Notes', { strong: true })]);
    // At the root, where the subtree in scope is the whole document. (On the
    // `content` screen this warning is correctly out of scope — it is about `name`.)
    render(<SourceViewer docId={DOC} />);

    await waitFor(() => expect(screen.getByText(/does not declare richText/)).toBeTruthy());
  });

  it('keeps an undeclared rich-text field fully editable', async () => {
    // Flagged, not walled off: it has markers, so it gets a field screen like any
    // other rich-text field, and they are all editable.
    await renderWithMarkers();
    mock.__setSpans(DOC, ['name'], [text('Notes', { strong: true })]);
    render(<SourceViewer docId={DOC} rest="name" />);

    await waitFor(() => {
      const marks = Array.from(document.querySelectorAll('[data-testid="marker-row"]'))
        .filter(r => r.textContent?.includes('strong'));
      expect(marks.length).toBeGreaterThan(0);
    });
  });
});
