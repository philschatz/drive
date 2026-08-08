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
import { applyOpsToSpans, flatTextFromSpans } from './spans-model';
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
  let live = spans;
  let applied = 0;
  return {
    root, ops, apiRef, selStates,
    /** The re-render a cursor registration causes: same content, fresh array. */
    push: (next: RichTextSpan[] = spans) => rerender(view(next.map(s => ({ ...s })))),
    /**
     * What the real container does after a gesture: apply the emitted ops to its
     * own copy (the optimistic echo) and re-render from the result. Returns the
     * live document, so a test can assert the model the user would actually have.
     */
    settle: () => {
      while (applied < ops.length) live = applyOpsToSpans(live, ops[applied++]);
      rerender(view(live.map(s => ({ ...s }))));
      return live;
    },
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

/**
 * GBoard driving the editor, replayed exactly as Chrome on Android sends it.
 *
 * The ordering is the whole point: the browser mutates the DOM FIRST and only
 * then fires a NON-cancelable `beforeinput`, so `preventDefault()` is a no-op
 * and the editor cannot stop the text landing. Android composes ordinary Latin
 * typing, so this — not `insertText` — is the normal typing path there, which is
 * why the desktop suite above never exercised any of it.
 */
const gboard = {
  start: (root: HTMLElement) =>
    root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),

  /** One composed character: the browser writes it, then tells us. */
  type: (root: HTMLElement, node: Text, at: number, ch: string) => {
    node.data = node.data.slice(0, at) + ch + node.data.slice(at);
    window.getSelection()!.setBaseAndExtent(node, at + ch.length, node, at + ch.length);
    document.dispatchEvent(new Event('selectionchange'));
    root.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertCompositionText', data: ch,
      isComposing: true, cancelable: false, bubbles: true,
    }));
  },

  end: (root: HTMLElement, data: string) =>
    root.dispatchEvent(new CompositionEvent('compositionend', { data, bubbles: true })),

  /** Compose a whole word at `at`, the way tapping out one word does. */
  word: (root: HTMLElement, node: Text, at: number, word: string) => {
    gboard.start(root);
    [...word].forEach((ch, i) => gboard.type(root, node, at + i, ch));
    gboard.end(root, word);
  },
};

/** A cancelable gesture from a hardware keyboard / the space bar. */
const key = (root: HTMLElement, inputType: string, data?: string) =>
  root.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }));

/** The document the emitted ops actually produce (`￼` per block marker). */
const modelOf = (spans: RichTextSpan[], ops: RichTextOp[][]) =>
  flatTextFromSpans(ops.reduce((s, o) => applyOpsToSpans(s, o), spans));

describe('Android composition (GBoard)', () => {
  const para = (text: string): RichTextSpan[] => [blockSpan('paragraph'), textSpan(text)];

  it('saves a composed word to the document', () => {
    const spans = para('hello ');
    const { root, ops } = setup(spans);
    gboard.word(root, runNode(root, 'hello '), 6, 'wo');
    // Nothing during the composition — the IME owns the DOM until it ends.
    expect(ops).toEqual([[{ op: 'splice', index: 7, del: 0, text: 'wo' }]]);
    expect(modelOf(spans, ops)).toBe('￼hello wo');
  });

  it('does not drift the caret one word per word typed', () => {
    // The reported symptom: each composed word left the model behind, so the
    // model-coordinate caret read off the (now stale) data-from attributes was
    // wrong by the length of everything composed so far. The next cancelable
    // gesture — the space bar — then spliced at that bogus index.
    const spans = para('a');
    const { root, settle } = setup(spans);
    gboard.word(root, runNode(root, 'a'), 1, 'bc');
    settle();
    key(root, 'insertText', ' ');
    settle();
    gboard.word(root, runNode(root, 'abc '), 4, 'de');
    expect(flatTextFromSpans(settle())).toBe('￼abc de');
  });

  it('ignores a spans push that lands mid-composition', () => {
    // Registering a cursor token re-pushes identical spans in a fresh array, and
    // the caret moves on every keystroke — so on a device a push lands inside
    // essentially every word. Re-rendering there rewrites the text node the IME
    // owns and yanks the caret to a pre-composition offset.
    const spans = para('hello ');
    const { root, ops, push } = setup(spans);
    const t = runNode(root, 'hello ');
    gboard.start(root);
    gboard.type(root, t, 6, 'w');
    gboard.type(root, t, 7, 'o');

    const sel = window.getSelection()!;
    const spy = jest.spyOn(Object.getPrototypeOf(sel) as Selection, 'setBaseAndExtent');
    spy.mockClear();
    push();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // The composed text must survive the render untouched.
    expect(root.textContent).toBe('hello wo');
    gboard.end(root, 'wo');
    expect(modelOf(spans, ops)).toBe('￼hello wo');
  });

  it('freezes selection reporting while the IME is composing', () => {
    // The toolbar's selection state is in MODEL coordinates; mid-composition the
    // DOM holds characters the model has never seen, so every reading is wrong.
    const spans = para('hello ');
    const { root, selStates } = setup(spans);
    const t = runNode(root, 'hello ');
    gboard.start(root);
    const before = selStates.length;
    gboard.type(root, t, 6, 'w');
    gboard.type(root, t, 7, 'o');
    expect(selStates.length).toBe(before);
  });

  it('normalizes the non-breaking space Chrome inserts', () => {
    // A contenteditable without `white-space: pre-wrap` gets U+00A0 for any
    // space that would collapse — measured in Chromium. Desktop never sees it
    // because insertText is intercepted and the model writes the real space.
    const spans = para('hi');
    const { root, ops } = setup(spans);
    const t = runNode(root, 'hi');
    gboard.start(root);
    t.data = 'hi there';
    window.getSelection()!.setBaseAndExtent(t, 8, t, 8);
    gboard.end(root, ' there');
    expect(modelOf(spans, ops)).toBe('￼hi there');
  });

  it('leaves the caret in the composed block, not the next one', () => {
    // The DOM caret already counts the composed characters, so carrying it
    // through the ops that insert them counts them twice — which walks the caret
    // off the end of the block and into the following paragraph. A document that
    // ends with the composition hides this, because the restore clamps.
    const spans = [blockSpan('paragraph'), textSpan('hello'), blockSpan('paragraph'), textSpan('world')];
    const { root, settle } = setup(spans);
    gboard.word(root, runNode(root, 'hello'), 5, 'X');
    settle();
    // The next keystroke is the proof: it splices at whatever caret was left.
    key(root, 'insertText', '!');
    expect(flatTextFromSpans(settle())).toBe('￼helloX!￼world');
  });

  it('actually receives compositionstart', () => {
    // The bug this whole block exists for. `onCompositionStart` as a JSX prop
    // registers the literal event name 'CompositionStart' — Preact only
    // lowercases an onFoo prop when the lowercase form is an IDL property of the
    // element, and `oncompositionstart` is not one. Nothing fires that name, so
    // the handlers had never run in any browser and every composed word was
    // dropped. If this fails, the listeners went back on JSX props.
    const { root, apiRef } = setup(para('hello '));
    expect(apiRef.current!.isComposing()).toBe(false);
    gboard.start(root);
    expect(apiRef.current!.isComposing()).toBe(true);
    gboard.end(root, '');
    expect(apiRef.current!.isComposing()).toBe(false);
  });

  it('lets a cancelable gesture mid-composition commit the composed text first', () => {
    // Enter (and backspace, and tapping a suggestion) stay cancelable even while
    // an IME is composing, so they take the normal intercepted path — but only
    // after what the IME has already written is folded in, or they would compute
    // against a model that disagrees with the screen.
    const spans = para('hello ');
    const { root, ops } = setup(spans);
    const t = runNode(root, 'hello ');
    gboard.start(root);
    gboard.type(root, t, 6, 'w');
    gboard.type(root, t, 7, 'o');
    key(root, 'insertParagraph');
    expect(ops[0]).toEqual([{ op: 'splice', index: 7, del: 0, text: 'wo' }]);
    expect(ops[1]?.[0]?.op).toBe('splitBlock');
    expect(modelOf(spans, ops)).toBe('￼hello wo￼');
  });

  it('rebuilds a block the browser wrote into behind our back', () => {
    // Preact writes a text node only when the VDOM text changed, so a block the
    // browser touched but the model never learned about could never be repaired
    // by an ordinary re-render — the stray characters would survive forever
    // while every data-from after them stayed stale.
    const { root, push } = setup(para('hello'));
    runNode(root, 'hello').parentElement!.appendChild(document.createTextNode('!!'));
    expect(root.textContent).toBe('hello!!');
    push(); // any later render at all
    expect(root.textContent).toBe('hello');
  });

  it('recovers when the composition ends outside a block element', () => {
    // Reading the block from the DOM selection made every unusual anchor a
    // silent no-op — and a no-op here is permanent divergence, since the model
    // never learns about text the browser already rendered.
    const spans = para('hello ');
    const { root, ops } = setup(spans);
    const t = runNode(root, 'hello ');
    gboard.start(root);
    t.data = 'hello wo';
    window.getSelection()!.setBaseAndExtent(root, 0, root, 0); // anchor on the root
    gboard.end(root, 'wo');
    expect(modelOf(spans, ops)).toBe('￼hello wo');
  });
});

describe('autocorrect (insertReplacementText)', () => {
  /** What a real beforeinput carries: the range the gesture targets, which for a
   *  correction is the mistyped word — NOT the selection. jsdom has no
   *  getTargetRanges, so it is stubbed onto the event the way the browser sets it. */
  const withTargetRange = (e: InputEvent, node: Node, start: number, end: number) => {
    Object.defineProperty(e, 'getTargetRanges', {
      configurable: true,
      value: () => [{ startContainer: node, startOffset: start, endContainer: node, endOffset: end }],
    });
    return e;
  };

  it('replaces the word it targets, not the text at the caret', () => {
    const spans = [blockSpan('paragraph'), textSpan('teh cat')];
    const { root, ops } = setup(spans);
    const t = runNode(root, 'teh cat');
    put(t, 3, t, 3); // the caret sits after the word, as it does on a device
    root.dispatchEvent(withTargetRange(
      new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: 'the', bubbles: true, cancelable: true }),
      t, 0, 3,
    ));
    // Using the selection spliced the correction in without deleting what it
    // was correcting, so autocorrect produced "tehthe cat".
    expect(ops[0]).toEqual([{ op: 'splice', index: 1, del: 3, text: 'the' }]);
    expect(modelOf(spans, ops)).toBe('￼the cat');
  });

  it('falls back to the selection where getTargetRanges is unavailable', () => {
    const spans = [blockSpan('paragraph'), textSpan('teh cat')];
    const { root, ops } = setup(spans);
    const t = runNode(root, 'teh cat');
    put(t, 0, t, 3);
    root.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertReplacementText', data: 'the', bubbles: true, cancelable: true,
    }));
    expect(modelOf(spans, ops)).toBe('￼the cat');
  });
});

describe('mobile input affordances', () => {
  it('opts the editor out of machine translation', () => {
    // Google Translate rewrites contenteditable subtrees wholesale, with no
    // beforeinput at all. `translate` is an IDL property, so the string "no"
    // would be assigned to it and any non-empty string is truthy — yielding
    // translate="yes", the exact opposite of what is wanted.
    const { root } = setup(markdownToSpans('hello'));
    expect(root.getAttribute('translate')).toBe('no');
  });

  it('asks the soft keyboard for a plain Enter key and sentence casing', () => {
    const { root } = setup(markdownToSpans('hello'));
    expect(root.getAttribute('enterkeyhint')).toBe('enter');
    expect(root.getAttribute('autocapitalize')).toBe('sentences');
  });
});

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
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));
    expect(ops[0]).toEqual([{ op: 'splice', index: 4, del: 0, text: 'x' }]);
    push(applyOpsToSpans(spans, ops[0]));
    expect(where().anchor).toEqual(['onex', 4]);
  });

  it('puts the caret in the new list item after Enter', () => {
    const spans = markdownToSpans('- a\n\nplain');
    const { root, ops, push } = setup(spans);
    const a = runNode(root, 'a');
    put(a, 1, a, 1); // "- a|", with a paragraph following
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
    push(applyOpsToSpans(spans, ops[0]));
    // The new (empty) item is block 1; the caret must land in it rather than
    // skipping ahead into "plain".
    const sel = window.getSelection()!;
    const bi = (sel.anchorNode as HTMLElement).dataset?.bi
      ?? (sel.anchorNode!.parentElement?.closest('[data-bi]') as HTMLElement)?.dataset.bi;
    expect(bi).toBe('1');
    expect(root.querySelectorAll('.rt-li')).toHaveLength(2);
    // And it lands ON the block element, exactly as an empty paragraph does.
    // This is the mobile bug: an empty list item used to wrap its (absent) text
    // in an inline `<span class="rt-li-text">`, so the caret was anchored inside
    // an empty INLINE box. Blink on Android adjusts such a selection into one
    // spanning the whole line and draws it with selection handles — so Enter in a
    // list "selected the current line" instead of starting a new item, while
    // paragraphs (whose empty caret target is the block itself) worked fine.
    expect(sel.anchorNode).toBe(root.querySelector('[data-bi="1"]'));
    expect(sel.isCollapsed).toBe(true);
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

  // The bullet/number is drawn by a CSS ::before from `data-marker`, so it is not
  // a DOM node at all. Two Android hazards go away with it: Blink mis-selects a
  // caret anchored in an empty inline box (which the old `.rt-li-text` wrapper
  // was, in an empty item), and it selects a `contenteditable=false` inline child
  // when that child is tapped. A pseudo-element is invisible to the Selection and
  // Range APIs, so neither can arise. (The absent contentEditable is not asserted
  // here for the same reason as the divider above: jsdom has no such property.)
  const shape = (el: Element) => Array.from(el.children).map(c => c.tagName.toLowerCase());

  it('numbers an ordered list', () => {
    const { root } = setup(markdownToSpans('1. one\n2. two'));
    expect(Array.from(root.querySelectorAll('.rt-li')).map(m => m.getAttribute('data-marker')))
      .toEqual(['1.', '2.']);
  });

  it('bullets an unordered list', () => {
    const { root } = setup(markdownToSpans('- one\n- two'));
    expect(Array.from(root.querySelectorAll('.rt-li')).map(m => m.getAttribute('data-marker')))
      .toEqual(['•', '•']);
  });

  it('gives a list item the same DOM shape as a paragraph', () => {
    const { root } = setup(markdownToSpans('- one\n\ntwo'));
    const li = root.querySelector('.rt-li')!;
    // Runs are direct children, with nothing wrapping them — so every DOM point
    // inside a list item is a point inside a run, as it is in a paragraph.
    expect(shape(li)).toEqual(shape(root.querySelector('.rt-p')!));
    expect(shape(li)).toEqual(['span']);
  });

  it('gives an EMPTY list item the same DOM shape as an empty paragraph', () => {
    // The shape that decides where the caret goes after Enter: a lone <br> whose
    // parent is the block itself, so `domPointAt` resolves to the block element.
    const { root } = setup([blockSpan('unordered-list-item'), blockSpan('paragraph')]);
    expect(shape(root.querySelector('.rt-li')!)).toEqual(['br']);
    expect(shape(root.querySelector('.rt-p')!)).toEqual(['br']);
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
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));

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
