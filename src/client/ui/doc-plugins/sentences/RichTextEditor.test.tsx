/**
 * The DOM ↔ model selection mapping, driven through the real contenteditable.
 *
 * The scenario every test here shares is the *cursor-registration push*: moving
 * the caret mints Automerge cursor tokens, registering them makes the worker
 * re-push the subscription, and that push carries a NEW spans array with
 * IDENTICAL content. So the editor re-renders — and its caret-restore effect runs
 * — many times per gesture, including on every step of a mouse drag. What the
 * restore does to the selection at that moment is what these tests pin.
 *
 * RichTextEditor takes spans/onOps as props and touches no worker API, so it
 * renders here directly with no mock.
 */
import { render, screen } from '@testing-library/preact';
import { createRef } from 'preact';
import { RichTextEditor, type RichTextEditorApi, type SelectionState } from './RichTextEditor';
import { markdownToSpans } from './markdown';
import { applyOpsToSpans } from './spans-model';
import type { RichTextOp, RichTextSpan } from '../../../../shared/rich-text-ops';

const blockSpan = (type: string): RichTextSpan => ({ type: 'block', value: { type, parents: [] } });
const textSpan = (value: string): RichTextSpan => ({ type: 'text', value });

const setup = (spans: RichTextSpan[]) => {
  const ops: RichTextOp[][] = [];
  const apiRef = createRef<RichTextEditorApi>();
  // onSelectionState is what makes the editor remember the selection at all
  // (reportSelection is a no-op without it), so the real container's wiring is
  // load-bearing for every restore below.
  const selStates: (SelectionState | null)[] = [];
  const view = (s: RichTextSpan[]) => (
    <RichTextEditor
      spans={s}
      editable
      onOps={o => ops.push(o)}
      onSelectionState={s => selStates.push(s)}
      apiRef={apiRef}
    />
  );
  const { rerender } = render(view(spans));
  const root = screen.getByTestId('rt-editor') as HTMLElement;
  root.focus();
  return {
    root, ops, apiRef, selStates,
    /** The re-render a cursor registration causes: same content, fresh array. */
    push: (next: RichTextSpan[] = spans) => rerender(view(next.map(s => ({ ...s })))),
  };
};

/** The text node of the run element whose text is `text`. */
const runNode = (root: HTMLElement, text: string): Text => {
  const el = Array.from(root.querySelectorAll('[data-from]'))
    .find(e => e.textContent === text) as HTMLElement;
  expect(el).toBeTruthy();
  return el.firstChild as Text;
};

const put = (anchor: Node, anchorOffset: number, focus: Node, focusOffset: number) => {
  window.getSelection()!.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  document.dispatchEvent(new Event('selectionchange'));
};

/** Where the DOM selection actually is, as (text, offset) pairs. */
const where = () => {
  const s = window.getSelection()!;
  return {
    anchor: [s.anchorNode?.textContent, s.anchorOffset],
    focus: [s.focusNode?.textContent, s.focusOffset],
  };
};

describe('caret at a block boundary', () => {
  it('stays at the end of a paragraph instead of jumping to the next one', () => {
    const spans = markdownToSpans('one\n\ntwo');
    const { root, push } = setup(spans);
    const one = runNode(root, 'one');
    put(one, 3, one, 3); // "one|" — global index 4, which is also marker #2
    push();
    // Resolving that index to the *next* block clamped it up to that block's
    // textFrom, dropping the caret in front of "two".
    expect(where()).toEqual({ anchor: ['one', 3], focus: ['one', 3] });
  });

  it('does not cascade through empty paragraphs', () => {
    // ￼one￼￼￼two — two blank lines between the paragraphs.
    const spans = [
      blockSpan('paragraph'), textSpan('one'),
      blockSpan('paragraph'),
      blockSpan('paragraph'),
      blockSpan('paragraph'), textSpan('two'),
    ];
    const { root, push } = setup(spans);
    const empty = root.querySelector('[data-bi="1"]') as HTMLElement;
    put(empty, 0, empty, 0); // in the first blank line
    push();
    const s = window.getSelection()!;
    expect((s.anchorNode as HTMLElement).dataset?.bi).toBe('1');
    // An empty block's only index is the next block's marker index, so the old
    // backwards resolution hopped one block per push until it reached text.
    push();
    expect((window.getSelection()!.anchorNode as HTMLElement).dataset?.bi).toBe('1');
  });

  it('reports the block the caret is really in to the toolbar', () => {
    const spans = markdownToSpans('one\n\n- item');
    const { root, selStates } = setup(spans);
    const one = runNode(root, 'one');
    put(one, 3, one, 3); // end of the paragraph, right before a list item
    const last = selStates[selStates.length - 1];
    expect(last?.blockType).toBe('paragraph');
    expect(last?.inList).toBe(false);
  });

  it('keeps a caret at the end of a list item inside that item', () => {
    const spans = markdownToSpans('- a\n\nplain');
    const { root, push } = setup(spans);
    const a = runNode(root, 'a');
    put(a, 1, a, 1);
    push();
    expect(where().anchor).toEqual(['a', 1]);
  });

  // The cases above are satisfied by leaving the DOM alone. These re-place the
  // caret for real, because the edit changed the text — so they exercise the
  // offset → DOM point mapping instead of the skip.
  it('leaves the caret after the typed character, not in the next paragraph', () => {
    const spans = markdownToSpans('one\n\ntwo');
    const { root, ops, push } = setup(spans);
    const one = runNode(root, 'one');
    put(one, 3, one, 3);
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true }));
    expect(ops[0]).toEqual([{ op: 'splice', index: 4, del: 0, text: 'x' }]);
    push(applyOpsToSpans(spans, ops[0]));
    expect(where().anchor).toEqual(['onex', 4]);
  });

  it('puts the caret in the new list item after Enter', () => {
    const spans = markdownToSpans('- a\n\nplain');
    const { root, ops, push } = setup(spans);
    const a = runNode(root, 'a');
    put(a, 1, a, 1); // "- a|", with a paragraph following
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true }));
    push(applyOpsToSpans(spans, ops[0]));
    // The new (empty) item is block 1; the caret must land in it rather than
    // skipping ahead into "plain".
    const sel = window.getSelection()!;
    const bi = (sel.anchorNode as HTMLElement).dataset?.bi
      ?? (sel.anchorNode!.parentElement?.closest('[data-bi]') as HTMLElement)?.dataset.bi;
    expect(bi).toBe('1');
    expect(root.querySelectorAll('.rt-li')).toHaveLength(2);
  });
});

describe('selection direction', () => {
  it('preserves a backward selection across a push', () => {
    const spans = markdownToSpans('hello world');
    const { root, push } = setup(spans);
    const t = runNode(root, 'hello world');
    put(t, 11, t, 6); // dragged right-to-left: anchor at the END
    push();
    // Restoring through a Range (inherently forward) moved the anchor to offset
    // 6, so the browser's next drag step / shift-arrow extended from the wrong
    // end and the highlight collapsed.
    expect(where()).toEqual({ anchor: ['hello world', 11], focus: ['hello world', 6] });
  });

  it('leaves a forward selection forward', () => {
    const spans = markdownToSpans('hello world');
    const { root, push } = setup(spans);
    const t = runNode(root, 'hello world');
    put(t, 6, t, 11);
    push();
    expect(where()).toEqual({ anchor: ['hello world', 6], focus: ['hello world', 11] });
  });

  it('keeps a backward selection backward after formatting it', () => {
    const spans = markdownToSpans('hello world');
    const { root, ops, apiRef, push } = setup(spans);
    const t = runNode(root, 'hello world');
    put(t, 11, t, 6); // "world" selected right-to-left
    apiRef.current!.toggleMark('strong');
    expect(ops[0]).toEqual([{ op: 'mark', start: 7, end: 12, name: 'strong', value: true, expand: 'after' }]);
    // The parent applies the ops and pushes the result back, where "world" is
    // its own bold run — so the restore places both ends afresh, and must still
    // put the anchor at the selection's end.
    push(applyOpsToSpans(spans, ops[0]));
    expect(where()).toEqual({ anchor: ['world', 5], focus: ['world', 0] });
  });
});

describe('redundant pushes leave the DOM selection alone', () => {
  /**
   * The mid-drag bug this guards against can only be *seen* in a real browser
   * (see the drag specs in tests-pw/ui/sentences.spec.ts): rewriting the
   * selection while the mouse is down resets the browser's drag anchor, so the
   * highlight collapses on every step. jsdom has no drag tracking, so what's
   * checkable here is the contract that produces it — a push that changes
   * nothing must not touch the selection API at all.
   */
  const countWrites = () => {
    const sel = window.getSelection()!;
    const spy = jest.spyOn(Object.getPrototypeOf(sel) as Selection, 'setBaseAndExtent');
    spy.mockClear();
    return spy;
  };

  it('does not rewrite the selection for a caret', () => {
    const spans = markdownToSpans('one\n\ntwo');
    const { root, push } = setup(spans);
    const one = runNode(root, 'one');
    put(one, 3, one, 3);
    const spy = countWrites();
    push();
    push();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not rewrite the selection for a range', () => {
    const spans = markdownToSpans('hello world');
    const { root, push } = setup(spans);
    const t = runNode(root, 'hello world');
    put(t, 11, t, 6);
    const spy = countWrites();
    push();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // That the guard doesn't over-skip — a push whose text really changed still
  // moves the caret — is covered by the two "real restore" cases above.
});

/**
 * What each block/run type actually renders. These were Playwright-only, which
 * meant a real render regression could only surface behind a two-peer boot, a
 * production build, and a reload — and the reload's persistence race is what
 * eventually reported it. None of it needs a browser: the divider is markup, and
 * list indentation is an inline style, not a stylesheet rule.
 */
describe('block and run rendering', () => {
  it('renders a divider as an hr between its neighbours', () => {
    const { root } = setup(markdownToSpans('para\n\n---\n\nafter'));
    const divider = root.querySelector('.rt-divider') as HTMLElement;
    expect(divider.querySelector('hr')).toBeTruthy();
    // Its `contentEditable={false}` is deliberately NOT asserted: jsdom has no
    // contentEditable property, so Preact takes the attribute path and drops a
    // `false`. The atomicity it buys is pinned model-side instead — see
    // edit-ops.test.ts's backspace-into-divider case.
    expect(Array.from(root.children).map(c => c.tagName.toLowerCase()))
      .toEqual(['p', 'div', 'p']);
  });

  it('renders a link as a real anchor carrying its href', () => {
    const { root } = setup(markdownToSpans('see [the docs](https://example.com/docs) now'));
    const anchor = root.querySelector('a.rt-link') as HTMLAnchorElement;
    expect(anchor.textContent).toBe('the docs');
    expect(anchor.getAttribute('href')).toBe('https://example.com/docs');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps strong/em classes on a link run', () => {
    const { root } = setup(markdownToSpans('[**bold link**](https://example.com/)'));
    expect(root.querySelector('a.rt-link')!.className).toContain('rt-strong');
  });

  it('indents a nested list item further than its parent', () => {
    const { root } = setup(markdownToSpans('- first\n  - second'));
    const items = Array.from(root.querySelectorAll('.rt-li')) as HTMLElement[];
    expect(items).toHaveLength(2);
    const pad = (el: HTMLElement) => parseFloat(el.style.paddingLeft);
    expect(pad(items[1])).toBeGreaterThan(pad(items[0]));
  });

  it('numbers an ordered list', () => {
    const { root } = setup(markdownToSpans('1. one\n2. two'));
    expect(Array.from(root.querySelectorAll('.rt-marker')).map(m => m.textContent))
      .toEqual(['1.', '2.']);
  });

  it('bullets an unordered list', () => {
    const { root } = setup(markdownToSpans('- one\n- two'));
    expect(Array.from(root.querySelectorAll('.rt-marker')).map(m => m.textContent))
      .toEqual(['•', '•']);
  });
});

describe('root-level selection points', () => {
  // What Chrome's Ctrl+A yields in a contenteditable: the root itself, child
  // index 0 → child count. The root carries no data-from/data-bfrom of its own,
  // and returning null for such points made select-all + type a silent no-op
  // (beforeinput has already preventDefault'd) and let any drag that left the
  // text strand lastSelectionRef at a stale range.
  const selectAll = (root: HTMLElement) => put(root, 0, root, root.childNodes.length);
  const typeX = (root: HTMLElement) =>
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true }));

  it('maps a select-all to the whole document and replaces it', () => {
    const { root, ops } = setup(markdownToSpans('one\n\ntwo'));
    selectAll(root);
    typeX(root);
    expect(ops[0]).toEqual([{ op: 'splice', index: 1, del: 7, text: 'x' }]);
  });

  it('keeps a select-all across a cursor push', () => {
    const { root, ops, push } = setup(markdownToSpans('one\n\ntwo'));
    selectAll(root);
    push();
    typeX(root);
    expect(ops[0]).toEqual([{ op: 'splice', index: 1, del: 7, text: 'x' }]);
  });
});
