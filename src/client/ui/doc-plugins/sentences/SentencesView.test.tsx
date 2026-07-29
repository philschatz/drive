import { render, screen, fireEvent, waitFor, act } from '@testing-library/preact';

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

/**
 * Wait until the document is editable *and* the editor's effects have run.
 * Preact flushes effects after paint, a tick or two behind the commit, and the
 * `selectionchange` listener that turns a DOM selection into editor state is
 * registered there — so a synthetic selection made any earlier is invisible.
 * (Every test here used to click the Edit FAB, whose extra render cycle hid
 * this; with the document editable on mount, nothing forces the flush.)
 */
const editableEditor = async () => {
  await waitFor(() => expect(screen.getByTestId('format-bar')).toBeTruthy());
  await act(() => new Promise(r => setTimeout(r, 150)));
};

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

  it('renders blocks editable, with the formatting bar and no mode to enter', async () => {
    seed('# Title\n\nHello **world**\n\n- item');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Title')).toBeTruthy());

    // Structure renders: heading, bold run, list marker.
    expect(screen.getByText('Title').closest('h1')).toBeTruthy();
    expect(screen.getByText('world').className).toContain('rt-strong');
    expect(screen.getByText('item')).toBeTruthy();

    // Holding the edit role IS edit mode: typeable on mount, bar docked.
    expect(editor().getAttribute('contenteditable')).toBe('true');
    expect(screen.getByTestId('format-bar')).toBeTruthy();

    // So there is nothing to enter and nothing to leave — the leading button is
    // the back link, not a Done checkmark.
    expect(screen.queryByLabelText('Edit sentences')).toBeNull();
    expect(screen.queryByLabelText('Done')).toBeNull();
    expect(screen.getByLabelText('Back')).toBeTruthy();
  });

  it('bolds a selection from the formatting bar', async () => {
    seed('Hello world');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('Hello world')).toBeTruthy());
    await editableEditor();

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
    await editableEditor();

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
    await editableEditor();

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
    await editableEditor();

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
    await editableEditor();

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

  /**
   * A caret inside formatted text is a target, not just a place to type next:
   * the toolbar shows the mark active there, so tapping it has to change the
   * text the caret is in rather than only arming the next keystroke.
   */
  it('unformats the whole run from a caret inside it', async () => {
    seed('plain **bold** plain');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('bold')).toBeTruthy());
    await editableEditor();

    // Caret in the middle of "bold" — no selection at all.
    selectText('bold', 2, 2);
    await waitFor(() => expect((screen.getByTestId('fmt-format_bold') as HTMLElement).className)
      .toContain('bg-secondary-container')); // the button reads as active
    fireEvent.click(screen.getByTestId('fmt-format_bold'));
    await waitFor(() => expect(currentMarkdown()).toBe('plain bold plain'));
  });

  it('leaves a caret in plain text to arm the next keystroke', async () => {
    seed('plain text');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('plain text')).toBeTruthy());
    await editableEditor();

    selectText('plain text', 2, 2);
    fireEvent.click(screen.getByTestId('fmt-format_bold'));
    // Nothing is bolded by the click itself…
    await new Promise(r => setTimeout(r, 20));
    expect(currentMarkdown()).toBe('plain text');
    // …but what gets typed next is.
    fireEvent(editor(), new InputEvent('beforeinput', {
      inputType: 'insertText', data: 'X', bubbles: true, cancelable: true,
    }));
    await waitFor(() => expect(currentMarkdown()).toBe('pl**X**ain text'));
  });

  /**
   * An always-editable document swallows link clicks (they place the caret), so
   * the Link sheet is how an editor follows one.
   */
  it('opens the caret\'s link from the Link sheet', async () => {
    seed('read [the docs](https://x.dev) now');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('the docs')).toBeTruthy());
    await editableEditor();

    selectText('the docs', 0, 8);
    fireEvent.click(screen.getByTestId('fmt-link'));
    await waitFor(() => expect(screen.getByTestId('link-open')).toBeTruthy());

    const openSpy = jest.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(screen.getByTestId('link-open'));
    expect(openSpy).toHaveBeenCalledWith('https://x.dev', '_blank', 'noopener');
    // The document is untouched — Open is not an edit.
    expect(currentMarkdown()).toBe('read [the docs](https://x.dev) now');
    openSpy.mockRestore();
  });

  it('edits and removes a link from a caret inside it', async () => {
    seed('read [the docs](https://x.dev) now');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('the docs')).toBeTruthy());
    await editableEditor();

    // Caret inside the link, nothing selected: the sheet opens on that link…
    selectText('the docs', 4, 4);
    // The bar renders from reported selection state, a render behind the caret.
    await waitFor(() => expect((screen.getByTestId('fmt-link') as HTMLElement).className)
      .toContain('bg-secondary-container'));
    fireEvent.click(screen.getByTestId('fmt-link'));
    await waitFor(() => expect((screen.getByTestId('link-input') as HTMLInputElement).value)
      .toBe('https://x.dev'));

    // …and Apply retargets the whole link, not a zero-width slice of it.
    fireEvent.input(screen.getByTestId('link-input'), { target: { value: 'https://y.dev' } });
    fireEvent.submit(screen.getByTestId('link-input').closest('form')!);
    await waitFor(() => expect(currentMarkdown()).toBe('read [the docs](https://y.dev) now'));

    selectText('the docs', 4, 4);
    await waitFor(() => expect((screen.getByTestId('fmt-link') as HTMLElement).className)
      .toContain('bg-secondary-container'));
    fireEvent.click(screen.getByTestId('fmt-link'));
    await waitFor(() => expect(screen.getByText('Remove')).toBeTruthy());
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(currentMarkdown()).toBe('read the docs now'));
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

  /**
   * The caret is an Automerge cursor, so a peer editing before it must not shift
   * it. Asserting through the NEXT KEYSTROKE is the point: the editor feeds the
   * restored index into opsForInsertText, so a stale caret does not merely look
   * wrong, it splices text at the wrong offset.
   */
  const renderWithCaret = async (md: string, runText: string, offset: number) => {
    seed(md);
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText(runText)).toBeTruthy());
    await editableEditor();
    editor().focus();
    selectText(runText, offset, offset);
    // The caret's cursor token is minted through the worker; it is registered
    // for resolution once it lands.
    await waitFor(() => expect(mock.__getCursorSubs(DOC, ['content']).length).toBe(2));
  };

  const typeChar = (ch: string) => fireEvent(editor(), new InputEvent('beforeinput', {
    inputType: 'insertText', data: ch, bubbles: true, cancelable: true,
  }));

  it('rebases the local caret when a peer inserts before it', async () => {
    // Flat text '￼hello world'; offset 8 in the run = flat 9, i.e. "hello wo|rld".
    await renderWithCaret('hello world', 'hello world', 8);

    // A peer inserts at the start of the paragraph (flat index 1).
    mock.__applyRemoteOps(DOC, ['content'], [{ op: 'splice', index: 1, del: 0, text: 'XY' }]);
    await waitFor(() => expect(currentMarkdown()).toBe('XYhello world'));

    typeChar('!');
    // Rebased 9 → 11. Without it the caret would still be 9 and produce
    // 'XYhello !world'.
    await waitFor(() => expect(currentMarkdown()).toBe('XYhello wo!rld'));
  });

  it('rebases the local caret when a peer deletes before it', async () => {
    await renderWithCaret('hello world', 'hello world', 8);

    mock.__applyRemoteOps(DOC, ['content'], [{ op: 'splice', index: 1, del: 6 }]); // drop "hello "
    await waitFor(() => expect(currentMarkdown()).toBe('world'));

    typeChar('!');
    await waitFor(() => expect(currentMarkdown()).toBe('wo!rld'));
  });

  it('leaves the caret alone when the peer edits after it', async () => {
    await renderWithCaret('hello world', 'hello world', 5); // flat 6, "hello| world"

    mock.__applyRemoteOps(DOC, ['content'], [{ op: 'splice', index: 12, del: 0, text: '!!' }]);
    await waitFor(() => expect(currentMarkdown()).toBe('hello world!!'));

    typeChar('X');
    await waitFor(() => expect(currentMarkdown()).toBe('helloX world!!'));
  });

  it('rebases again on a second remote edit (tokens are re-keyed, not re-minted)', async () => {
    await renderWithCaret('hello world', 'hello world', 8); // flat 9

    mock.__applyRemoteOps(DOC, ['content'], [{ op: 'splice', index: 1, del: 0, text: 'XY' }]);
    await waitFor(() => expect(currentMarkdown()).toBe('XYhello world'));
    mock.__applyRemoteOps(DOC, ['content'], [{ op: 'splice', index: 1, del: 0, text: 'ZW' }]);
    await waitFor(() => expect(currentMarkdown()).toBe('ZWXYhello world'));

    typeChar('!');
    // 9 → 11 → 13. If the second push had been refused as stale the caret would
    // still be 11, giving 'ZWXYhello !world'.
    await waitFor(() => expect(currentMarkdown()).toBe('ZWXYhello wo!rld'));
  });

  it('rebases a selection, keeping formatting on the same characters', async () => {
    seed('hello world');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeTruthy());
    await editableEditor();
    editor().focus();

    selectText('hello world', 6, 11); // "world" → flat [7, 12)
    await waitFor(() => expect(mock.__getCursorSubs(DOC, ['content']).length).toBe(2));

    mock.__applyRemoteOps(DOC, ['content'], [{ op: 'splice', index: 1, del: 0, text: 'XY' }]);
    await waitFor(() => expect(currentMarkdown()).toBe('XYhello world'));

    fireEvent.click(screen.getByTestId('fmt-format_bold'));
    // Both ends moved by 2, so "world" is still what got bolded.
    await waitFor(() => expect(currentMarkdown()).toBe('XYhello **world**'));
  });

  it('does not touch the caret when the editor is not focused', async () => {
    seed('hello world');
    render(<SentencesView docId={DOC} />);
    await waitFor(() => expect(screen.getByText('hello world')).toBeTruthy());

    // Editable but never focused, so no local cursor is registered at all and a
    // remote edit is a plain spans replacement.
    mock.__applyRemoteOps(DOC, ['content'], [{ op: 'splice', index: 1, del: 0, text: 'XY' }]);
    await waitFor(() => expect(currentMarkdown()).toBe('XYhello world'));
    expect(mock.__getCursorSubs(DOC, ['content'])).toEqual([]);
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

    // Cursor withdrawn (the peer's caret left the document) → it disappears.
    mock.__setPresence(DOC, {
      'peer-2': {
        peerId: 'peer-2',
        value: { viewing: true, userGroupId: 'group-b', focusedField: null },
      },
    });
    await waitFor(() => expect(screen.queryByTestId('peer-caret')).toBeNull());
  });

  it('stays read-only without the edit role', async () => {
    seed('nope [docs](https://x.dev)');
    render(<SentencesView docId={DOC} readOnly />);
    await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());

    expect(editor().getAttribute('contenteditable')).not.toBe('true');
    expect(screen.queryByTestId('format-bar')).toBeNull();
    // Nothing offers a way in — there is no FAB and no gesture that used to be one.
    expect(screen.queryByLabelText('Edit sentences')).toBeNull();
    fireEvent.dblClick(screen.getByText('docs'));
    await new Promise(r => setTimeout(r, 10));
    expect(screen.queryByTestId('format-bar')).toBeNull();
    expect(editor().getAttribute('contenteditable')).not.toBe('true');

    // A viewer's links are live (the editable editor is what swallows clicks).
    expect(screen.getByText('docs').closest('a')?.getAttribute('href')).toBe('https://x.dev');
  });
});
