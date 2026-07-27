import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

// Back the worker API with the in-memory mock (which emulates Peritext spans
// via spans-model.ts) so the real SentencesView container runs in jsdom.
jest.mock('../../worker-api');
import * as api from '../../worker-api';
import { SentencesView } from './SentencesView';
import { markdownToSpans, spansToMarkdown } from './markdown';

const mock = api as any;

// Guards the positional __mocks__ resolution: if src/client/ui/__mocks__/ ever
// drifts away from worker-api.ts, jest.mock() above silently loads the real
// module and every assertion below fails for an unrelated-looking reason.
it('uses the manual worker-api mock', () => expect(mock.__isMock).toBe(true));
const DOC = 'doc-paper';

const seed = (md: string) => {
  mock.__setDoc(DOC, { '@type': 'Sentences', name: 'My Doc', content: '' });
  mock.__setSpans(DOC, ['content'], markdownToSpans(md));
};

const editor = () => screen.getByTestId('rt-editor');

/** Select [start, end) inside the text node of the run element containing `text`. */
const selectText = (text: string, start: number, end: number) => {
  const runEl = Array.from(editor().querySelectorAll('[data-from]'))
    .find(el => el.textContent === text) as HTMLElement;
  expect(runEl).toBeTruthy();
  const node = runEl.firstChild!;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
};

const currentMarkdown = () => spansToMarkdown(mock.__getSpans(DOC, ['content']));

describe('SentencesView container', () => {
  beforeEach(() => { mock.__reset(); });

  it('renders blocks read-only and enters edit mode via the FAB', async () => {
    seed('# Title\n\nHello **world**\n\n- item');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy());

    // Structure renders: heading, bold run, list marker.
    expect(screen.getByText('Title').closest('h1')).toBeTruthy();
    expect(screen.getByText('world').className).toContain('rt-strong');
    expect(screen.getByText('item')).toBeTruthy();

    // View mode: no formatting bar, not editable.
    expect(editor().getAttribute('contenteditable')).not.toBe('true');
    expect(screen.queryByTestId('format-bar')).toBeNull();

    fireEvent.click(screen.getByLabelText('Edit sentences'));
    await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());
    expect(editor().getAttribute('contenteditable')).toBe('true');

    // Done returns to the read-only view.
    fireEvent.click(screen.getByLabelText('Done'));
    await waitFor(() => expect(screen.queryByTestId('format-bar')).toBeNull());
    expect(editor().getAttribute('contenteditable')).not.toBe('true');
  });

  it('bolds a selection from the formatting bar', async () => {
    seed('Hello world');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Hello world')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Edit sentences'));
    await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());

    selectText('Hello world', 0, 5);
    fireEvent.click(screen.getByTestId('fmt-format_bold'));
    await waitFor(() => expect(currentMarkdown()).toBe('**Hello** world'));

    // Toggle back off (the re-render split the text into runs).
    selectText('Hello', 0, 5);
    fireEvent.click(screen.getByTestId('fmt-format_bold'));
    await waitFor(() => expect(currentMarkdown()).toBe('Hello world'));
  });

  it('retypes a block as a heading through the style sheet', async () => {
    seed('plain text');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('plain text')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Edit sentences'));
    await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());

    selectText('plain text', 2, 2);
    fireEvent.click(screen.getByTestId('fmt-notes')); // opens the style sheet
    await waitFor(() => expect(screen.getByText('Heading 2')).toBeTruthy());
    fireEvent.click(screen.getByText('Heading 2').closest('md-list-item')!);
    await waitFor(() => expect(currentMarkdown()).toBe('## plain text'));
    expect(screen.getByText('plain text').closest('h2')).toBeTruthy();
  });

  it('turns paragraphs into a list and indents', async () => {
    seed('one\n\ntwo');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('two')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Edit sentences'));
    await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());

    selectText('two', 1, 1);
    fireEvent.click(screen.getByTestId('fmt-format_list_bulleted'));
    await waitFor(() => expect(currentMarkdown()).toBe('one\n\n- two'));

    selectText('two', 1, 1);
    fireEvent.click(screen.getByTestId('fmt-format_list_numbered'));
    await waitFor(() => expect(currentMarkdown()).toBe('one\n\n1. two'));
  });

  it('inserts typed text through beforeinput', async () => {
    seed('helo');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('helo')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Edit sentences'));
    await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());

    selectText('helo', 3, 3);
    fireEvent(editor(), new InputEvent('beforeinput', {
      inputType: 'insertText', data: 'l', bubbles: true, cancelable: true,
    }));
    await waitFor(() => expect(currentMarkdown()).toBe('hello'));
    expect(mock.__getDoc(DOC).content).toBe('￼hello');
  });

  it('sets a link over the selection', async () => {
    seed('read the docs now');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('read the docs now')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Edit sentences'));
    await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());

    selectText('read the docs now', 5, 13); // "the docs"
    fireEvent.click(screen.getByTestId('fmt-link'));
    await waitFor(() => expect(screen.getByTestId('link-input')).toBeTruthy());
    fireEvent.input(screen.getByTestId('link-input'), { target: { value: 'https://x.dev' } });
    fireEvent.submit(screen.getByTestId('link-input').closest('form')!);
    await waitFor(() => expect(currentMarkdown()).toBe('read [the docs](https://x.dev) now'));

    // The rendered run is an anchor.
    const a = screen.getByText('the docs') as HTMLAnchorElement;
    expect(a.closest('a')?.getAttribute('href')).toBe('https://x.dev');
  });

  it('imports a Markdown file, replacing the content', async () => {
    seed('old text');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('old text')).toBeTruthy());

    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const input = screen.getByTestId('import-md-input') as HTMLInputElement;
    const file = new File(['# Imported\n\nSome **bold** text'], 'notes.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    // Native dispatch: testing-library's fireEvent.change doesn't reach this
    // listener under preact/compat (cf. the focusout gotcha in Tasks.test).
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => expect(currentMarkdown()).toBe('# Imported\n\nSome **bold** text'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByText('Imported').closest('h1')).toBeTruthy();

    // Declining the confirmation leaves the document alone.
    confirmSpy.mockReturnValue(false);
    const file2 = new File(['nope'], 'nope.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file2], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30)); // let the FileReader + confirm path settle
    expect(currentMarkdown()).toBe('# Imported\n\nSome **bold** text');
    confirmSpy.mockRestore();
  });

  it('renders peer carets from cursor presence (and clears them)', async () => {
    seed('hello world');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeTruthy());

    // A peer broadcasting focusedField = ['content', <fromCursor>, <toCursor>]
    // (the mock's cursors encode indices as 'c:<n>').
    mock.__setPresence(DOC, {
      'peer-2': {
        peerId: 'peer-2',
        value: { viewing: true, userGroupId: 'group-b', focusedField: ['content', 'c:3', 'c:3'] },
      },
    });
    await waitFor(() => expect(screen.getByTestId('peer-caret')).toBeTruthy());
    const caret = screen.getByTestId('peer-caret') as HTMLElement;
    expect(caret.style.background).toBeTruthy(); // peer identity color
    // The name tip above the caret shows the contact's display name.
    const tip = screen.getByTestId('peer-tip') as HTMLElement;
    expect(tip.textContent).toBeTruthy();
    expect(tip.style.background).toBe(caret.style.background);

    // Cursor withdrawn (peer left edit mode) → the caret disappears.
    mock.__setPresence(DOC, {
      'peer-2': {
        peerId: 'peer-2',
        value: { viewing: true, userGroupId: 'group-b', focusedField: null },
      },
    });
    await waitFor(() => expect(screen.queryByTestId('peer-caret')).toBeNull());
  });

  it('double-clicking the viewed text starts editing (but not on links)', async () => {
    seed('see [docs](https://x.dev) here');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('here')).toBeTruthy());

    // Double-click on a link keeps the viewer (the link owns that gesture).
    fireEvent.dblClick(screen.getByText('docs'));
    expect(screen.queryByTestId('format-bar')).toBeNull();

    fireEvent.dblClick(screen.getByText('here'));
    await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());
    expect(editor().getAttribute('contenteditable')).toBe('true');
  });

  it('hides the edit FAB when the view is read-only', async () => {
    seed('nope');
    render(<SentencesView docId={DOC} readOnly />);
    await waitFor(() => expect(screen.getByText('nope')).toBeTruthy());
    expect(screen.queryByLabelText('Edit sentences')).toBeNull();

    // Double-click can't start editing without the edit role either.
    fireEvent.dblClick(screen.getByText('nope'));
    await new Promise(r => setTimeout(r, 10));
    expect(screen.queryByTestId('format-bar')).toBeNull();
    expect(editor().getAttribute('contenteditable')).not.toBe('true');
  });
});
