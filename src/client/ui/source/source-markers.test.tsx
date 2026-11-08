import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';

// The source inspector against the in-memory mock, which backs `allRichText` with
// the same spansStore that stands in for Automerge's mark/block-marker storage.
// That is the point of this file: markers are invisible to the jq projection the
// rest of the inspector renders, so nothing else here can prove they reach the
// screen — or that editing one emits the right ops instead of the scalar
// assignment that used to flatten the whole field.
jest.mock('../worker-api');
import * as api from '../worker-api';
import type { DocMarker, RichTextSpan } from '../../../shared/rich-text-ops';
import { SourceViewer } from './SourceViewer';
import { markerClass, markerSlots } from './Markers';

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
    expect(chip!.textContent).toBe('¶h1');
    // The numbers live in the list only; the text carries colour and a tap.
    expect(document.querySelectorAll('[data-testid="field-text"] .src-footnote')).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid="row-footnote"]')).toHaveLength(3);
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
    const chips = Array.from(document.querySelectorAll('.src-marker-chip'));
    expect(chips.map(c => c.textContent)).toEqual(['¶ul', '¶ul·1']);
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

    // Every marker is a numbered token, so the whole field is editable as text —
    // including where its blocks and marks sit.
    fireEvent.click(screen.getByTestId('field-edit-text'));
    const input = await waitFor(() => screen.getByTestId('value-field') as HTMLTextAreaElement);
    expect(input.value).toBe('⟦1 h1⟧⟨2 strong⟩Hello ⟨/2⟩⟨3 link⟩world⟨/3⟩');
    fireEvent.input(input, { target: { value: '⟦1 h1⟧⟨2 strong⟩Hello ⟨/2⟩brave ⟨3 link⟩world⟨/3⟩' } });
    fireEvent.click(screen.getByTestId('value-save'));

    await waitFor(() => expect(mock.__getDoc(DOC).content).toBe('￼Hello brave world'));
    // A scalar assignment would have left literal `￼` characters and no marks at
    // all; the diffed ops keep every marker.
    expect(contentSpans()[0]).toEqual({ type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 } } });
    expect(marksAt(1)).toEqual({ strong: true });
    expect(marksAt(16)).toEqual({ link: HREF }); // "world" is still linked
  });

  it('adds a block marker by typing an unnumbered token into the string', async () => {
    await renderWithMarkers();

    fireEvent.click(screen.getByTestId('field-edit-text'));
    const input = await waitFor(() => screen.getByTestId('value-field') as HTMLTextAreaElement);
    fireEvent.input(input, { target: { value: '⟦1 h1⟧⟨2 strong⟩Hello ⟨/2⟩⟦⟧⟨3 link⟩world⟨/3⟩' } });
    fireEvent.click(screen.getByTestId('value-save'));

    await waitFor(() => expect(rows()).toHaveLength(4));
    // A typed token is a real block marker (a default paragraph), not a literal
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

/**
 * The text and the marker list show the same markers; the footnote number ties
 * one to the other. A tap on either side flashes and scrolls to its twin on the
 * other — the list row is still what opens the sheet, so the number in a row is
 * its own button.
 */
describe('text ↔ marker list jumps', () => {
  const revealedRows = () => rows().filter(r => r.className.includes('src-revealed'));

  it('tapping a marked run reveals that mark\'s row, without opening its sheet', async () => {
    await renderWithMarkers();
    fireEvent.click(document.querySelector('[data-testid="marked-run"][data-marker-index="1"]')!);
    await waitFor(() => expect(revealedRows()).toHaveLength(1));
    expect(revealedRows()[0].getAttribute('data-marker-index')).toBe('1');
    expect(screen.queryByTestId('marker-sheet')).toBeNull();
  });

  it('tapping a block chip reveals the block marker\'s row', async () => {
    await renderWithMarkers();
    fireEvent.click(document.querySelector('[data-testid="marker-chip"]')!);
    await waitFor(() => expect(revealedRows().map(r => r.getAttribute('data-marker-index'))).toEqual(['0']));
  });

  it('tapping a row\'s number reveals its text and does not open the sheet', async () => {
    await renderWithMarkers();
    fireEvent.click(within(rows()[2]).getByTestId('row-footnote'));
    await waitFor(() => {
      const run = document.querySelector('[data-testid="marked-run"][data-marker-index="2"]')!;
      expect(run.className).toContain('src-revealed');
    });
    // Only the link run lit up, and only on the text side.
    expect(document.querySelector('[data-testid="marked-run"][data-marker-index="1"]')!.className).not.toContain('src-revealed');
    expect(revealedRows()).toHaveLength(0);
    expect(screen.queryByTestId('marker-sheet')).toBeNull();
  });
});

/**
 * "Edit text" shows every marker as a numbered token. Moving, deleting or
 * pasting a token moves, removes or duplicates the marker it names — and the
 * marker stays what it was, which is the whole point: the old flat-text diff
 * could only turn a moved heading into a paragraph.
 */
describe('Edit text tokens', () => {
  async function saveMarkup(value: string) {
    fireEvent.click(screen.getByTestId('field-edit-text'));
    const input = await waitFor(() => screen.getByTestId('value-field') as HTMLTextAreaElement);
    fireEvent.input(input, { target: { value } });
    fireEvent.click(screen.getByTestId('value-save'));
  }
  const blockTypes = () => contentSpans().filter(s => s.type === 'block').map(s => (s.value as any).type);

  it('moves a marker with its token, keeping what it is', async () => {
    await renderWithMarkers();
    await saveMarkup('⟨2 strong⟩Hello ⟨/2⟩⟦1 h1⟧⟨3 link⟩world⟨/3⟩');

    await waitFor(() => expect(mock.__getDoc(DOC).content).toBe('Hello ￼world'));
    expect(contentSpans()[1]).toEqual({ type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 } } });
    expect(marksAt(0)).toEqual({ strong: true });
    expect(marksAt(7)).toEqual({ link: HREF });
  });

  it('removes a marker whose token is deleted, and nothing else', async () => {
    await renderWithMarkers();
    await saveMarkup('⟦1 h1⟧⟨2 strong⟩Hello ⟨/2⟩world');

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(marksAt(7)).toEqual({});
    expect(marksAt(1)).toEqual({ strong: true });
    expect(mock.__getDoc(DOC).content).toBe('￼Hello world');
  });

  it('duplicates a marker whose token is pasted twice', async () => {
    await renderWithMarkers();
    await saveMarkup('⟦1 h1⟧⟨2 strong⟩Hello ⟨/2⟩⟦1 h1⟧⟨2 strong⟩world⟨/2⟩');

    await waitFor(() => expect(blockTypes()).toEqual(['heading', 'heading']));
    // The copy carries the original's attrs, not a default.
    expect((contentSpans()[2].value as any).attrs).toEqual({ level: 1 });
    expect(marksAt(8)).toEqual({ strong: true });
    expect(rows()).toHaveLength(4);
  });
});

/**
 * Colour and line style follow the marker's TYPE, from one fixed palette, and
 * the text and the list paint from the same slot — that is what lets a reader
 * learn "dotted orange is a heading" once.
 */
describe('marker colours', () => {
  const strong = (start: number): DocMarker => ({ kind: 'mark', name: 'strong', value: true, start, end: start + 1 });
  const blockOf = (type: string): DocMarker => ({ kind: 'block', index: 0, block: { type, parents: [] } });
  const slot = markerSlots([blockOf('heading'), strong(0), blockOf('aside'), blockOf('note')]);

  it('follow the marker type, not its position', () => {
    expect(slot(strong(0))).toEqual(slot(strong(40)));
    expect(slot(blockOf('heading'))).toEqual(slot(blockOf('heading')));
    expect(slot(strong(0))).not.toEqual(slot({ ...strong(0), name: 'em' }));
    expect(slot(blockOf('heading'))).not.toEqual(slot(blockOf('unordered-list-item')));
  });

  it('are fixed for the known vocabulary, so a heading looks the same in every document', () => {
    expect(markerSlots([])(blockOf('heading'))).toEqual(markerSlots([strong(0), blockOf('heading')])(blockOf('heading')));
  });

  it('give an unknown type the next slot, by first appearance, stably', () => {
    expect(slot(blockOf('aside'))).toEqual(slot(blockOf('aside')));
    expect(slot(blockOf('aside'))).not.toEqual(slot(blockOf('note')));
  });

  it('never repeat a colour without changing the line, across any 24 types', () => {
    const types = Array.from({ length: 24 }, (_, i) => blockOf(`t${i}`));
    const classes = new Set(types.map(t => markerClass(markerSlots(types)(t))));
    expect(classes.size).toBe(24);
  });

  it('paint the text and the row from the same slot, as classes rather than inline hex', async () => {
    await renderWithMarkers();
    const chip = document.querySelector('[data-testid="marker-chip"]')!;
    const run = document.querySelector('[data-testid="marked-run"][data-marker-index="1"]')!;
    const [headingRow, strongRow] = rows().map(r => within(r).getByTestId('row-footnote'));
    const mk = (el: Element) => Array.from(el.classList).filter(c => /^src-mk-(c\d|solid|dotted|dashed)$/.test(c)).sort();
    expect(mk(chip)).toEqual(mk(headingRow));
    expect(mk(run)).toEqual(mk(strongRow));
    expect(mk(chip)).not.toEqual(mk(run));
    expect(chip.getAttribute('style')).toBeNull();
    expect(run.getAttribute('style')).toBeNull();
  });

  it('stack overlapping marks as nested lines, each in its own slot', async () => {
    await renderWithMarkers(undefined, [text('Hel', { strong: true }), text('lo', { strong: true, em: true })]);
    // "lo" is strong AND em: the em line nests inside the strong run, one step deeper.
    const inner = document.querySelector('[data-testid="mark-line"]')!;
    expect(inner.getAttribute('data-marker-index')).toBe('1');
    expect(inner.className).toContain('src-mk-d1');
    expect(inner.parentElement!.getAttribute('data-testid')).toBe('marked-run');
    expect(inner.parentElement!.className).toContain('src-mk-d0');
    expect(markerSlots([])({ kind: 'mark', name: 'em', value: true, start: 0, end: 1 }))
      .not.toEqual(markerSlots([])(strong(0)));
  });
});
