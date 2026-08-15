/**
 * Controlled contenteditable renderer for a Peritext spans model.
 *
 * Normally the DOM is a pure function of `spans`: every editing gesture is
 * intercepted in `beforeinput` (preventDefault), translated to RichTextOps by
 * the pure builders in edit-ops.ts, and emitted via `onOps` — the parent applies
 * them optimistically (spans-model) and to the worker doc, and the re-render puts
 * the caret back.
 *
 * Position mapping is integer arithmetic over data attributes: every inline run
 * carries `data-from` (global index of its first char) and every block
 * `data-bfrom`/`data-bi`, so DOM points ↔ global offsets without guessing.
 *
 * ── The exception: IME composition ──
 *
 * Between `compositionstart` and `compositionend` the browser owns the DOM and
 * we cannot stop it — `insertCompositionText` is not cancelable. This is not an
 * edge case: Android's GBoard composes *ordinary Latin typing*, so on a phone it
 * is the only typing path there is. For that window the editor inverts:
 *
 *  - the model is frozen (`blocksRef` keeps describing what the DOM was built
 *    from) and the rendered blocks come from it, not from the incoming prop — so
 *    every text vnode is unchanged and Preact leaves the composed characters be;
 *  - no selection is written and no selection state is reported, since DOM
 *    offsets mid-composition are not valid model indices;
 *  - at the end, dom-reconcile.ts diffs the DOM back into the model. Pushes keep
 *    arriving during the composition, so the two halves genuinely fork and that
 *    reconcile is a three-way merge (see `reconcileFromDom`).
 *
 * `resyncEpoch` is the backstop for anything the reconcile cannot express:
 * Preact writes a text node only when the vdom text changed, so a block the
 * browser wrote into that the model never learned about could otherwise never be
 * repaired. Changing the block keys discards those subtrees instead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { RichTextOp, RichTextSpan } from '../../../../shared/rich-text-ops';
import {
  blocksFromSpans, blockDepth, blockIndexAt, blockType, contentLength, isListItem, markExtentAt, marksInRange, orderedListNumbers,
  type BlockNode, type BlockType, type InlineRun,
} from './blocks';
import {
  opsForDeleteBackward, opsForDeleteForward, opsForInsertParagraph, opsForInsertText, opsForPasteText,
  toggleMarkOps, setLinkOps, setBlockTypeOps, toggleListOps, indentOps, outdentOps, insertDividerOps,
  type Edit, type PendingMarks,
} from './edit-ops';
import { applyOpsToSpans, shiftPositionThroughOps } from './spans-model';
import { reconcileDomToOps } from './dom-reconcile';
import { createLogger } from '../../../../shared/logger';

const log = createLogger('sentences');

/** How long a composition may go silent before we assume the IME dropped its
 * `compositionend` (Android does, on an app or keyboard switch). */
const COMPOSITION_TIMEOUT_MS = 4000;

export function linkHrefOf(marks: Record<string, unknown> | null | undefined): string | null {
  const raw = marks?.link;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.href === 'string' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** What the formatting toolbar needs to render its toggle states. */
export interface SelectionState {
  from: number;
  to: number;
  /** Effective marks (selection/caret marks + pending toggles). */
  marks: Record<string, unknown>;
  blockType: BlockType;
  headingLevel: number | null;
  inList: boolean;
  linkHref: string | null;
}

/** Another user's caret, derived from presence (see SentencesView). Positions are
 * flat-text indices; the overlay clamps them, so a slightly stale index during
 * concurrent edits just lands the line nearby until the next broadcast. */
export interface RemoteCursor {
  /** Stable identity key (user-group id / device id) — one caret per user. */
  id: string;
  from: number;
  to: number;
  color: string;
  label: string;
}

/** Imperative surface for the toolbar (all selection-relative). */
export interface RichTextEditorApi {
  toggleMark(name: 'strong' | 'em'): void;
  setLink(href: string | null): void;
  setBlockType(type: BlockType, attrs?: Record<string, unknown>): void;
  toggleList(kind: 'unordered-list-item' | 'ordered-list-item'): void;
  indent(): void;
  outdent(): void;
  insertDivider(): void;
  getSelection(): { from: number; to: number } | null;
  /** True when the caret genuinely lives in this editor. `getSelection` falls
   *  back to the last known selection, so an unfocused editor must not be taken
   *  to own a caret. */
  isFocused(): boolean;
  /** True while an IME owns the DOM (between compositionstart and
   *  compositionend). The editor renders frozen blocks and writes no selection
   *  for the duration; nothing outside should try to move the caret either. */
  isComposing(): boolean;
  /**
   * Move the caret to `next` for the spans about to be committed — the rebase
   * for a concurrent remote edit, resolved from an Automerge cursor. Applies only
   * if the editor still believes it is at `expect`; a resolution the local user
   * has since typed past must lose to the pending local caret. Returns whether
   * it applied.
   */
  rebaseCaret(expect: { from: number; to: number }, next: { from: number; to: number }): boolean;
  focus(): void;
}

// ── DOM point ↔ global offset ────────────────────────────────────────────────

/**
 * A selection in global offsets, always normalized so `from <= to` (every op
 * builder wants it that way), plus the DOM direction it was made in.
 * `backward` = the anchor sits at `to` and the focus at `from`, i.e. the user
 * selected right-to-left. Restoring such a selection forward moves the anchor to
 * the other end, so the browser's next shift-arrow or drag-step extends from the
 * wrong side and the highlight collapses.
 */
interface Sel { from: number; to: number; backward: boolean }

function posFromDomPoint(root: HTMLElement, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const el = (node.parentElement)?.closest('[data-from]') as HTMLElement | null;
    if (el && root.contains(el)) return Number(el.dataset.from) + offset;
    const blockEl = (node.parentElement)?.closest('[data-bfrom]') as HTMLElement | null;
    if (blockEl && root.contains(blockEl)) return Number(blockEl.dataset.bfrom) + offset;
    return null;
  }
  if (!(node instanceof Element) || !root.contains(node)) return null;
  // Element point: a base index plus the text of the children before `offset`.
  const before = (base: number) => {
    let pos = base;
    for (const k of Array.from(node.childNodes).slice(0, offset)) pos += runTextLength(k);
    return pos;
  };
  // A point on a run element is based at that RUN, not at its block — basing it
  // at the block mismapped every point inside a second or later run.
  const runEl = node.closest('[data-from]') as HTMLElement | null;
  if (runEl && root.contains(runEl)) return before(Number(runEl.dataset.from));
  const blockEl = node.closest('[data-bfrom]') as HTMLElement | null;
  if (blockEl) return before(Number(blockEl.dataset.bfrom));
  // Root-level point: the editor root carries no data-* of its own, and the
  // browser produces one for Ctrl+A, a click in the padding, and a drag that
  // leaves the text. Resolve it to a block edge — returning null instead left
  // `lastSelectionRef` stale (so the next render yanked the selection back) and
  // made select-all + type a silent no-op.
  if (node !== root) return null;
  const kids = Array.from(root.childNodes);
  const isBlock = (k: Node): k is HTMLElement =>
    k instanceof HTMLElement && k.dataset.bfrom !== undefined;
  for (let i = Math.min(offset, kids.length) - 1; i >= 0; i--) {
    const k = kids[i];
    if (isBlock(k)) return Number(k.dataset.bfrom) + runTextLength(k);
  }
  const first = kids.find(isBlock);
  return first ? Number(first.dataset.bfrom) : null;
}

function runTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0;
  let len = 0;
  for (const child of Array.from(node.childNodes)) len += runTextLength(child);
  return len;
}

function domPointAt(root: HTMLElement, blocks: BlockNode[], index: number): { node: Node; offset: number } | null {
  const bi = blockIndexAt(blocks, index);
  const b = blocks[bi];
  const blockEl = root.querySelector(`[data-bi="${bi}"]`) as HTMLElement | null;
  if (!blockEl) return null;
  const i = Math.max(b.textFrom, Math.min(index, b.textTo));
  for (const r of b.runs) {
    if (i >= r.from && i <= r.from + r.text.length) {
      // Prefer the run the caret is *inside*; boundaries fall to the first match.
      if (i === r.from + r.text.length && b.runs.some(o => o.from === i)) continue;
      const runEl = blockEl.querySelector(`[data-from="${r.from}"]`) as HTMLElement | null;
      const textNode = runEl?.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) return { node: textNode, offset: i - r.from };
    }
  }
  // No run matched: the block is empty (or its runs are not in the DOM yet), so
  // the caret goes at the start of the block element itself — where an empty
  // block's lone <br> sits. Every block type resolves the same way here, which is
  // the point: a list item must not offer some inner element instead.
  return { node: blockEl, offset: 0 };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function RunEl({ run, editable }: { run: InlineRun; editable: boolean }) {
  const href = linkHrefOf(run.marks);
  const cls =
    (run.marks?.strong ? ' rt-strong' : '') +
    (run.marks?.em ? ' rt-em' : '');
  if (href !== null) {
    return (
      <a
        href={href}
        data-from={run.from}
        className={'rt-link' + cls}
        target="_blank"
        rel="noopener noreferrer"
        // Editing a link's text shouldn't navigate; view mode keeps real links.
        onClick={editable ? (e: MouseEvent) => e.preventDefault() : undefined}
      >
        {run.text}
      </a>
    );
  }
  return <span data-from={run.from} className={cls || undefined}>{run.text}</span>;
}

function BlockEl({ b, bi, num, editable }: { b: BlockNode; bi: number; num: number | null; editable: boolean }) {
  const t = blockType(b);
  const attrs = { 'data-bfrom': b.textFrom, 'data-bi': bi } as any;
  const children = b.runs.length > 0
    ? b.runs.map(r => <RunEl key={r.from} run={r} editable={editable} />)
    : <br />;

  switch (t) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(b.block?.attrs?.level) || 1));
      const Tag = `h${level}` as any;
      return <Tag {...attrs} className={`rt-h rt-h${level}`}>{children}</Tag>;
    }
    case 'blockquote':
      return <blockquote {...attrs} className="rt-quote">{children}</blockquote>;
    case 'divider':
      // Atomic: not editable, deletable via backspace at the next block start.
      return <div {...attrs} className="rt-divider" contentEditable={false}><hr /></div>;
    case 'unordered-list-item':
    case 'ordered-list-item':
      // The bullet/number is drawn by `.rt-li::before` from `data-marker`, so the
      // item's children are its runs and nothing else — the same shape as a
      // paragraph, deliberately.
      //
      // It used to be a real `contenteditable=false` span, with the runs in a
      // second `.rt-li-text` span, and both halves of that broke touch editing.
      // An EMPTY item's caret target was that wrapper — an empty inline box, which
      // Blink on Android adjusts into a selection over the whole line and draws
      // with selection handles, so Enter in a list appeared to select the current
      // line instead of starting a new item (paragraphs, whose empty caret target
      // is the block element, were unaffected). And tapping a non-editable inline
      // child inside a contenteditable makes Chrome Android select that child.
      // A pseudo-element cannot be reached by the Selection or Range APIs at all,
      // so it also needs no `aria-hidden` and no exclusion from the offset
      // arithmetic in `runTextLength`/`collectText`.
      return (
        <div
          {...attrs}
          className="rt-li"
          data-marker={t === 'ordered-list-item' ? `${num ?? 1}.` : '•'}
          style={{ paddingLeft: `${1.5 + blockDepth(b) * 1.5}rem` }}
        >
          {children}
        </div>
      );
    default:
      return <p {...attrs} className="rt-p">{children}</p>;
  }
}

// ── The editor ───────────────────────────────────────────────────────────────

export function RichTextEditor({
  spans,
  editable,
  onOps,
  onSelectionState,
  onUndo,
  onRedo,
  apiRef,
  remoteCursors = [],
}: {
  spans: RichTextSpan[];
  editable: boolean;
  /** Emit ops upward (parent applies optimistically + to the worker doc). */
  onOps: (ops: RichTextOp[]) => void;
  onSelectionState?: (state: SelectionState | null) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  apiRef?: RefObject<RichTextEditorApi | null>;
  /** Other users' carets, drawn as colored vertical lines over the text. */
  remoteCursors?: RemoteCursor[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Composing = the IME owns the DOM. Declared first because the render itself
  // branches on it (see `model` below).
  const composingRef = useRef(false);
  const compositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocks = useMemo(() => blocksFromSpans(spans), [spans]);
  // The live model can be AHEAD of the rendered DOM: a keystroke's optimistic
  // ops advance it immediately, while the parent's setState → re-render lands a
  // beat later. Rapid input (typing faster than a render cycle) must compute
  // against the advanced model + caret, never the stale DOM selection —
  // otherwise characters land at outdated positions and scramble.
  const spansPropRef = useRef(spans);
  const spansLiveRef = useRef(spans);
  const blocksRef = useRef(blocks);
  // Guarded BEFORE the spansPropRef write, deliberately: the comparison then
  // stays true, so the first render after the composition adopts the prop by
  // itself. Adopting it mid-composition would swap the model out from under the
  // DOM the IME is still writing into.
  if (!composingRef.current && spansPropRef.current !== spans) {
    spansPropRef.current = spans;
    spansLiveRef.current = spans;
    blocksRef.current = blocks;
  }
  // While composing, render the FROZEN blocks rather than the incoming prop:
  // every text vnode is then byte-identical to the last render, so Preact skips
  // its `dom.data` write for the whole subtree and the characters the IME has
  // put there are left strictly alone.
  const model = composingRef.current ? blocksRef.current : blocks;
  const numbers = useMemo(() => orderedListNumbers(model), [model]);
  // Caret (global offsets) to restore after the next spans render; while set,
  // it IS the selection (the DOM hasn't caught up yet).
  const pendingCaretRef = useRef<Sel | null>(null);
  // Last known selection, so remote-edit re-renders don't drop the caret.
  const lastSelectionRef = useRef<Sel | null>(null);
  const pendingMarksRef = useRef<PendingMarks>({});
  /**
   * Bumped into every block's key to force Preact to REBUILD those subtrees.
   *
   * The escape from a trap that would otherwise be permanent: Preact writes a
   * text node only when the vdom text actually changed (diff/index.js), so a
   * block the browser wrote into but the model never learned about can never be
   * repaired by an ordinary re-render — the stray characters survive forever
   * while every data-from after them is stale. Changing the key discards the
   * subtree instead. contentEditable lives on the root, not on the blocks, so
   * remounting them neither blurs the editor nor dismisses the keyboard.
   */
  const [resyncEpoch, setResyncEpoch] = useState(0);
  const resyncPendingRef = useRef(false);
  const requestResync = () => setResyncEpoch(n => n + 1);

  /** The live DOM selection, direction included. */
  const readDomSelection = (): Sel | null => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || !sel.anchorNode || !sel.focusNode) return null;
    const a = posFromDomPoint(root, sel.anchorNode, sel.anchorOffset);
    const f = posFromDomPoint(root, sel.focusNode, sel.focusOffset);
    if (a === null || f === null) return null;
    return { from: Math.min(a, f), to: Math.max(a, f), backward: a > f };
  };

  const readSelection = (): Sel | null => {
    if (pendingCaretRef.current) return { ...pendingCaretRef.current };
    // Mid-composition the DOM carries characters the model has never seen, so a
    // DOM point mapped through the (now stale) data-from attributes is not a
    // valid model index. The last known model caret is.
    if (composingRef.current) {
      return lastSelectionRef.current ? { ...lastSelectionRef.current } : null;
    }
    return readDomSelection();
  };

  const sameSel = (a: Sel | null, b: Sel | null): boolean =>
    !!a && !!b && a.from === b.from && a.to === b.to && a.backward === b.backward;

  /**
   * Whether a DOM point sits INSIDE a rendered block, rather than on the editor
   * root (or on a block we have already detached).
   *
   * The distinction the index arithmetic cannot make: `posFromDomPoint` resolves
   * a root-level point to a block EDGE, so such a point reads as the very index
   * the caret belongs at while painting no caret at all. The browser parks the
   * selection there whenever we REPLACE the element the caret was in — an empty
   * list item outdenting to a paragraph swaps `<div class="rt-li">` for
   * `<p class="rt-p">`, and Preact rebuilds a subtree whose type changed instead
   * of patching it, so the live-range fixup lifts the selection to the root.
   */
  const pointInBlock = (node: Node | null | undefined): boolean => {
    const root = rootRef.current;
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
    const block = el?.closest?.('[data-bfrom]') ?? null;
    return !!root && !!block && root.contains(block);
  };

  const setDomSelection = (target: Sel) => {
    const root = rootRef.current;
    if (!root) return;
    const start = domPointAt(root, blocksRef.current, target.from);
    const end = target.from === target.to ? start : domPointAt(root, blocksRef.current, target.to);
    if (!start || !end) return;
    const sel = window.getSelection();
    if (!sel) return;
    // setBaseAndExtent, not addRange: a Range is inherently forward, so restoring
    // through one silently flipped every right-to-left selection.
    const [anchor, focus] = target.backward ? [end, start] : [start, end];
    sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };

  const reportSelection = () => {
    if (!onSelectionState) return;
    const sel = editable ? readSelection() : null;
    if (!sel) { onSelectionState(null); return; }
    lastSelectionRef.current = sel;
    const bl = blocksRef.current;
    const marks = { ...marksInRange(bl, sel.from, sel.to) };
    for (const [name, v] of Object.entries(pendingMarksRef.current)) {
      if (v === false) delete marks[name];
      else marks[name] = v;
    }
    const b = bl[blockIndexAt(bl, sel.from)];
    const t = blockType(b);
    onSelectionState({
      from: sel.from,
      to: sel.to,
      marks,
      blockType: t,
      headingLevel: t === 'heading' ? Math.min(6, Math.max(1, Number(b.block?.attrs?.level) || 1)) : null,
      inList: isListItem(b),
      linkHref: linkHrefOf(marks) ?? null,
    });
  };

  /** Advance the live model past these ops so the next gesture (possibly
   * arriving before the re-render) computes against fresh state. */
  const advanceLiveModel = (ops: RichTextOp[]) => {
    spansLiveRef.current = applyOpsToSpans(spansLiveRef.current, ops);
    blocksRef.current = blocksFromSpans(spansLiveRef.current);
  };

  const emitEdit = (edit: Edit) => {
    if (edit.ops.length === 0) return;
    pendingCaretRef.current = { from: edit.caret, to: edit.caret, backward: false };
    pendingMarksRef.current = {};
    advanceLiveModel(edit.ops);
    onOps(edit.ops);
  };

  /** Formatting ops keep the selection; caret-only cases keep the caret. */
  const emitFormat = (ops: RichTextOp[], sel: Sel) => {
    if (ops.length === 0) return;
    // Marker inserts before the selection shift it by one.
    const shift = ops.filter(o => o.op === 'splitBlock' && o.index <= sel.from).length;
    pendingCaretRef.current = { from: sel.from + shift, to: sel.to + shift, backward: sel.backward };
    advanceLiveModel(ops);
    onOps(ops);
  };

  /**
   * The range a gesture actually targets, which is NOT always the selection.
   * Autocorrect is the case that matters: `insertReplacementText` targets the
   * mistyped word while the caret sits after it, so using the selection inserted
   * the correction without deleting what it was correcting ("teh" → "tehthe").
   * Absent in jsdom and older Safari, hence the optional call and the fallback.
   */
  const targetRange = (e: InputEvent): { from: number; to: number } | null => {
    const root = rootRef.current;
    const r = e.getTargetRanges?.()[0];
    if (!r || !root) return null;
    const a = posFromDomPoint(root, r.startContainer, r.startOffset);
    const b = posFromDomPoint(root, r.endContainer, r.endOffset);
    if (a === null || b === null) return null;
    return { from: Math.min(a, b), to: Math.max(a, b) };
  };

  const handleBeforeInput = (e: InputEvent) => {
    if (!editable) { e.preventDefault(); return; }
    const type = e.inputType;
    // Non-cancelable by spec — the IME will write to the DOM whatever we do, and
    // compositionend reconciles the result.
    if (type === 'insertCompositionText' || type === 'deleteCompositionText') return;
    if (composingRef.current) {
      // A cancelable gesture arriving mid-composition (a suggestion tap, Enter,
      // backspace). Fold what the IME has put in the DOM into the model FIRST so
      // the gesture below computes against a model that matches what is on
      // screen; endComposition leaves `pendingCaretRef` set, which readSelection
      // prefers, so no intervening render is needed.
      if (!e.cancelable) return;
      endComposition();
    }
    e.preventDefault();
    const sel = readSelection();
    if (!sel) return;
    const bl = blocksRef.current;
    /** Deletions may target a range the selection does not describe (a whole
     *  grapheme cluster for an emoji, a word for GBoard's word-delete) — but only
     *  within one block, so the structural paths in opsForDeleteBackward
     *  (outdent, blockquote demote, joinBlock, backspace-into-divider) still run. */
    const deleteRange = (): Sel => {
      const t = targetRange(e);
      if (!t || t.from === t.to) return sel;
      if (blockIndexAt(bl, t.from) !== blockIndexAt(bl, t.to)) return sel;
      return { ...t, backward: false };
    };

    switch (type) {
      case 'insertText': {
        const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
        if (text) emitEdit(opsForInsertText(bl, sel.from, sel.to, text, pendingMarksRef.current));
        break;
      }
      case 'insertReplacementText':
      case 'insertFromComposition': {
        const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
        const t = targetRange(e) ?? sel;
        if (text) emitEdit(opsForInsertText(bl, t.from, t.to, text, pendingMarksRef.current));
        break;
      }
      case 'insertParagraph':
      case 'insertLineBreak':
        emitEdit(opsForInsertParagraph(bl, sel.from, sel.to));
        break;
      case 'deleteContentBackward':
      case 'deleteWordBackward':
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
      case 'deleteEntireSoftLine':
      case 'deleteByComposition':
      case 'deleteByCut': {
        const d = deleteRange();
        emitEdit(opsForDeleteBackward(bl, d.from, d.to));
        break;
      }
      case 'deleteContentForward':
      case 'deleteWordForward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward': {
        const d = deleteRange();
        emitEdit(opsForDeleteForward(bl, d.from, d.to));
        break;
      }
      case 'insertFromPaste':
      case 'insertFromPasteAsQuotation':
      case 'insertFromDrop': {
        const text = e.dataTransfer?.getData('text/plain') ?? '';
        if (text) emitEdit(opsForPasteText(bl, sel.from, sel.to, text));
        break;
      }
      case 'formatBold':
        api.toggleMark('strong');
        break;
      case 'formatItalic':
        api.toggleMark('em');
        break;
      case 'historyUndo':
        onUndo?.();
        break;
      case 'historyRedo':
        onRedo?.();
        break;
      default:
        // Swallowed by the preventDefault above. Safe precisely because these
        // are cancelable: the browser has not touched the DOM, so dropping the
        // gesture leaves the model and the DOM in step.
        break;
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!editable) return;
    if (e.key === 'Tab') {
      const sel = readSelection();
      if (!sel) return;
      const bl = blocksRef.current;
      const b = bl[blockIndexAt(bl, sel.from)];
      if (isListItem(b)) {
        e.preventDefault();
        emitFormat(e.shiftKey ? outdentOps(bl, sel.from, sel.to) : indentOps(bl, sel.from, sel.to), sel);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); api.toggleMark('strong'); }
      else if (k === 'i') { e.preventDefault(); api.toggleMark('em'); }
      else if (k === 'z') { e.preventDefault(); (e.shiftKey ? onRedo : onUndo)?.(); }
      else if (k === 'y') { e.preventDefault(); onRedo?.(); }
    }
  };

  /** The top-level block elements, which ARE the rendered blocks positionally. */
  const blockEls = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.children).filter((c): c is HTMLElement => c instanceof HTMLElement);

  /** Text offset of a DOM point within `container`, by pure text arithmetic —
   * never through data-from, which the browser's own writes have invalidated. */
  const textOffsetWithin = (container: HTMLElement, node: Node, offset: number): number => {
    let pos = node.nodeType === Node.TEXT_NODE
      ? Math.min(offset, node.nodeValue?.length ?? 0)
      : Array.from(node.childNodes).slice(0, offset).reduce((n, k) => n + runTextLength(k), 0);
    for (let cur: Node | null = node; cur && cur !== container; cur = cur.parentNode) {
      for (let sib = cur.previousSibling; sib; sib = sib.previousSibling) pos += runTextLength(sib);
    }
    return pos;
  };

  /**
   * The caret as (block index, offset within that block's text) — deliberately
   * NOT a global index.
   *
   * A global one would have to be carried through the very ops that insert the
   * composed text, and the DOM caret already counts those characters, so it
   * would double-count and walk off the end of the block into the next
   * paragraph. Block-relative survives untouched: after the reconcile that
   * block's model text equals its DOM text, so the offset is still valid and
   * only its base needs looking up.
   */
  const caretFromDom = (root: HTMLElement, els: HTMLElement[]): { block: number; offset: number } | null => {
    const sel = window.getSelection();
    if (!sel?.focusNode) return null;
    let el: HTMLElement | null = sel.focusNode instanceof HTMLElement
      ? sel.focusNode : sel.focusNode.parentElement;
    while (el && el.parentElement !== root) el = el.parentElement;
    const block = el ? els.indexOf(el) : -1;
    if (block < 0) return null;
    return { block, offset: textOffsetWithin(el!, sel.focusNode, sel.focusOffset) };
  };

  /**
   * Fold browser-authored DOM text back into the model.
   *
   * This is a three-way merge, because while an IME holds the DOM the two
   * halves genuinely fork: pushes keep arriving and re-render the container, but
   * the editor deliberately keeps rendering the frozen blocks so the composition
   * survives. So at the end there are three states — the frozen blocks the DOM
   * was built from (the base), what the browser wrote (ours), and the spans that
   * arrived meanwhile (theirs) — and our ops are in base coordinates while the
   * document they will be applied to is at theirs. Emitting them untransported
   * splices the composed word into the middle of the peer's text.
   */
  const reconcileFromDom = () => {
    const root = rootRef.current;
    if (!root) return;
    const base = blocksRef.current;
    const els = blockEls(root);
    // Explicit arrow, not point-free: Array.map would pass the index as `normalize`.
    const { ops: ourOps, resync } = reconcileDomToOps(base, els.map(el => collectText(el, true)));
    let ops = ourOps;
    const domCaret = caretFromDom(root, els);

    // The prop was withheld from the model during the composition (see the
    // guard on spansPropRef), so this is exactly "a push arrived meanwhile".
    if (spansPropRef.current !== spans) {
      // Derive the peer's edit by diffing base against it — the same diff, used
      // only to transport indices, so an approximation of *how* they got there
      // is fine as long as the text matches.
      const theirs = reconcileDomToOps(base, blocks.map(b => b.text));
      if (theirs.resync) {
        // Their block structure changed under us; nothing in base coordinates
        // can be trusted. Drop the composed text rather than misplace it.
        ops = [];
        requestResync();
      } else {
        // Only the op indices need carrying; the caret is block-relative and so
        // is already independent of where the peer's edits moved things.
        const carry = (i: number) => shiftPositionThroughOps(i, theirs.ops) ?? i;
        ops = ourOps.map(o => (o.op === 'splice' ? { ...o, index: carry(o.index) } : o));
      }
      // Adopt their model: the ops above now address it, and emitEdit advances
      // the live model from here.
      spansPropRef.current = spans;
      spansLiveRef.current = spans;
      blocksRef.current = blocks;
    }

    if (resync) requestResync();
    if (ops.length === 0) return;
    // Resolve the caret against the model these ops PRODUCE, where the block's
    // text matches the DOM again. Falling back to the end of the highest splice
    // keeps the caret in the text just reconciled when the DOM point is
    // unreadable (a composition that ended on the root, say).
    const first = ops[0] as Extract<RichTextOp, { op: 'splice' }>;
    let caret = first.index + (first.text?.length ?? 0);
    if (domCaret) {
      const next = blocksFromSpans(applyOpsToSpans(spansLiveRef.current, ops));
      const b = next[Math.min(domCaret.block, next.length - 1)];
      if (b) caret = Math.min(b.textFrom + domCaret.offset, b.textTo);
    }
    emitEdit({ ops, caret });
  };

  /**
   * Fold whatever the IME left in the DOM back into the model, then leave the
   * composing state. Idempotent — the watchdog and a real compositionend can
   * both reach it.
   */
  const endComposition = () => {
    if (compositionTimerRef.current !== null) {
      clearTimeout(compositionTimerRef.current);
      compositionTimerRef.current = null;
    }
    if (!composingRef.current) return;
    // Cleared before the reconcile, and the notify runs in a `finally`: a throw
    // below would otherwise leave the editor composing forever, and every later
    // gesture would bail at the guard in handleBeforeInput.
    composingRef.current = false;
    reconcileFromDom();
  };

  /** Android does not always send compositionend — switching apps or keyboards
   * can drop it — and an open composition wedges every gesture. Treat silence
   * as an end. */
  const armCompositionWatchdog = () => {
    if (compositionTimerRef.current !== null) clearTimeout(compositionTimerRef.current);
    compositionTimerRef.current = setTimeout(endComposition, COMPOSITION_TIMEOUT_MS);
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
    armCompositionWatchdog();
  };

  /**
   * A block's text as the model would spell it.
   *
   * `normalize` folds U+00A0 back to a plain space: when the BROWSER inserts
   * text — which only the composition path lets it do — Chrome writes a
   * non-breaking space for any space that would otherwise collapse, and it would
   * be spliced into the document verbatim. (`white-space: pre-wrap` on
   * .rt-editor stops that at the source; this catches what is already in the
   * DOM.) One-for-one, so it cannot disturb offset arithmetic.
   *
   * The divergence check deliberately does NOT normalize — a document that
   * legitimately contains a non-breaking space would otherwise look permanently
   * diverged and resync on every render.
   */
  const collectText = (blockEl: HTMLElement, normalize = false): string => {
    let out = '';
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue ?? ''; return; }
      if (n instanceof HTMLElement && n.tagName === 'BR') return;
      for (const c of Array.from(n.childNodes)) walk(c);
    };
    walk(blockEl);
    return normalize ? out.replace(/ /g, ' ') : out;
  };

  const api: RichTextEditorApi = {
    toggleMark(name) {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (!sel) return;
      const bl = blocksRef.current;
      if (sel.from === sel.to) {
        // Collapsed inside formatted text: act on the whole formatted stretch.
        // Arming a pending mark instead would leave the visibly-active button
        // doing nothing to the text the caret is actually sitting in.
        const extent = markExtentAt(bl, sel.from, name);
        if (extent) {
          pendingMarksRef.current = {};
          emitFormat(toggleMarkOps(bl, extent.from, extent.to, name), sel);
          return;
        }
        // Collapsed in plain text: toggle a pending mark for the next insertion.
        const effective = { ...marksInRange(bl, sel.from, sel.to) };
        for (const [n, v] of Object.entries(pendingMarksRef.current)) {
          if (v === false) delete effective[n];
          else effective[n] = v;
        }
        pendingMarksRef.current = { ...pendingMarksRef.current, [name]: name in effective ? false : true };
        reportSelection();
        return;
      }
      emitFormat(toggleMarkOps(bl, sel.from, sel.to, name), sel);
    },
    setLink(href) {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (!sel) return;
      const bl = blocksRef.current;
      if (sel.from === sel.to) {
        // A caret inside a link edits (or removes) that whole link — the sheet
        // opened showing its href, so it has to act on it. A caret in plain text
        // has no target, so there is nothing to link.
        const extent = markExtentAt(bl, sel.from, 'link');
        if (extent) emitFormat(setLinkOps(bl, extent.from, extent.to, href), sel);
        return;
      }
      emitFormat(setLinkOps(bl, sel.from, sel.to, href), sel);
    },
    setBlockType(type, attrs) {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (!sel) return;
      emitFormat(setBlockTypeOps(blocksRef.current, sel.from, sel.to, type, attrs), sel);
    },
    toggleList(kind) {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (!sel) return;
      emitFormat(toggleListOps(blocksRef.current, sel.from, sel.to, kind), sel);
    },
    indent() {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (sel) emitFormat(indentOps(blocksRef.current, sel.from, sel.to), sel);
    },
    outdent() {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (sel) emitFormat(outdentOps(blocksRef.current, sel.from, sel.to), sel);
    },
    insertDivider() {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (sel) emitEdit(insertDividerOps(blocksRef.current, sel.from, sel.to));
    },
    getSelection: () => readSelection() ?? lastSelectionRef.current,
    isFocused: () => !!rootRef.current?.contains(document.activeElement),
    isComposing: () => composingRef.current,
    rebaseCaret(expect, next) {
      // Refuse if the caret has moved on since the position was resolved: the
      // local user typing past it makes the resolution describe an older caret,
      // and the pending local caret is then the correct one.
      const cur = pendingCaretRef.current ?? lastSelectionRef.current;
      if (!cur || cur.from !== expect.from || cur.to !== expect.to) return false;
      // IME owns the DOM until compositionend; moving the caret would kill it.
      if (composingRef.current) return false;
      // Deliberately NOT clamped to the current contentLength: `next` addresses
      // the spans about to render, which are longer/shorter than what blocksRef
      // still holds (clamping here truncated a selection ending at end-of-text).
      // domPointAt clamps against the fresh blocks when the restore effect runs.
      // The tokens still describe the same characters, so the direction the user
      // selected in carries over untouched.
      const target: Sel = { from: next.from, to: next.to, backward: cur.backward };
      lastSelectionRef.current = target;
      // Only claim the DOM selection when the caret really lives here — writing
      // pendingCaretRef while unfocused would make the restore effect steal focus.
      if (rootRef.current?.contains(document.activeElement)) pendingCaretRef.current = target;
      return true;
    },
    focus() {
      rootRef.current?.focus();
    },
  };
  if (apiRef) apiRef.current = api;

  // Restore the caret after the render that applied our (or a remote) edit.
  useLayoutEffect(() => {
    if (!editable) return;
    const root = rootRef.current;
    if (!root) return;
    // The IME owns the DOM *and* the caret until the composition ends. Writing
    // the selection here is what dragged the caret back into the middle of the
    // word being composed — once per push, and a push lands inside nearly every
    // word on Android.
    if (composingRef.current) return;
    // Cheap standing check that the DOM still says what the model says. It is
    // the only thing that catches a browser-authored mutation nobody told us
    // about (Chrome's own async spellcheck replacement, an extension), and
    // without it that block diverges permanently — see resyncEpoch.
    const els = blockEls(root);
    const diverged = els.length !== blocks.length
      || els.some((el, i) => collectText(el) !== blocks[i].text);
    if (!diverged) {
      resyncPendingRef.current = false;
    } else if (!resyncPendingRef.current) {
      // At most ONE rebuild per divergence. This effect re-runs on resyncEpoch,
      // so re-requesting unconditionally would spin the renderer forever in the
      // one case that matters most — the one where the rebuild did not help.
      resyncPendingRef.current = true;
      requestResync();
    } else {
      log.warn('editor DOM still diverges from the model after a rebuild');
    }
    const target = pendingCaretRef.current ??
      (root.contains(document.activeElement) ? lastSelectionRef.current : null);
    pendingCaretRef.current = null;
    if (!target) return;
    // Registering a cursor token re-pushes IDENTICAL spans (the push exists to
    // carry resolved peer caret positions), so most renders here need no write at
    // all. Writing anyway reset the browser's drag anchor and selection
    // granularity mid-gesture, which collapsed the highlight on every drag step.
    //
    // But matching indices are not on their own proof the selection is where we
    // want it: a CARET must also be inside a block. After an edit that changed a
    // block's element type the browser leaves the selection on the root, which
    // resolves to the same index and paints nothing — so backspacing an empty
    // list item into a paragraph read as "the cursor vanished". Ranges are
    // exempt on purpose: Ctrl+A and a drag that leaves the text legitimately sit
    // on the root, and rewriting those is exactly what the skip above prevents.
    const dom = window.getSelection();
    const placed = target.from !== target.to
      || (pointInBlock(dom?.anchorNode) && pointInBlock(dom?.focusNode));
    if (!placed || !sameSel(readDomSelection(), target)) setDomSelection(target);
    reportSelection();
  }, [spans, editable, resyncEpoch]);

  /**
   * Composition listeners, attached imperatively — NOT as JSX props.
   *
   * Preact infers a DOM event name by lowercasing an `onFoo` prop only when the
   * lowercase form is an IDL property of the element (diff/props.js), and
   * `oncompositionstart` is not one: composition handlers are absent from
   * GlobalEventHandlers. So `onCompositionStart` quietly registered a listener
   * for the literal event name 'CompositionStart', which nothing ever fires —
   * these handlers had never run, in any browser. On Android, where GBoard
   * composes ordinary Latin typing, that meant every word typed was written to
   * the DOM and never to the document. Verified in Chromium 149 and jsdom 26.
   *
   * addEventListener takes the name we actually mean, and TypeScript checks it.
   * The ref indirection keeps the listeners off stale closures (they reach
   * `onOps` through emitEdit, and that prop's identity changes every render).
   */
  const compositionHandlersRef = useRef({
    start: handleCompositionStart, update: armCompositionWatchdog, end: endComposition,
  });
  compositionHandlersRef.current = {
    start: handleCompositionStart, update: armCompositionWatchdog, end: endComposition,
  };
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !editable) return;
    const start = () => compositionHandlersRef.current.start();
    const update = () => compositionHandlersRef.current.update();
    const end = () => compositionHandlersRef.current.end();
    root.addEventListener('compositionstart', start);
    root.addEventListener('compositionupdate', update);
    root.addEventListener('compositionend', end);
    // A composition left open would wedge every later gesture at the guard in
    // handleBeforeInput, so it must not survive losing focus or unmounting.
    root.addEventListener('focusout', end);
    return () => {
      root.removeEventListener('compositionstart', start);
      root.removeEventListener('compositionupdate', update);
      root.removeEventListener('compositionend', end);
      root.removeEventListener('focusout', end);
      compositionHandlersRef.current.end();
    };
  }, [editable]);

  // Toolbar state tracking.
  useEffect(() => {
    if (!editable) return;
    const onSelChange = () => {
      if (composingRef.current) return;
      const root = rootRef.current;
      const sel = window.getSelection();
      if (!root || !sel || !sel.anchorNode || !root.contains(sel.anchorNode)) return;
      // Any real selection move invalidates pending mark toggles.
      const now = readSelection();
      const last = lastSelectionRef.current;
      if (now && last && (now.from !== last.from || now.to !== last.to)) pendingMarksRef.current = {};
      reportSelection();
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [editable]);

  // Peer carets: measure each remote cursor — the caret line (collapsed Range
  // at its focus point), the selection's per-line highlight boxes, and a name
  // tip anchored above the line — all in wrapper coordinates. The overlay
  // lives OUTSIDE the contenteditable so it never disturbs selection mapping
  // or the DOM = f(spans) invariant.
  interface Box { left: number; top: number; width: number; height: number }
  interface PeerOverlay { caret: { left: number; top: number; height: number }; highlights: Box[] }
  const [peerOverlays, setPeerOverlays] = useState<Record<string, PeerOverlay>>({});
  useLayoutEffect(() => {
    const root = rootRef.current;
    const wrap = wrapRef.current;
    if (!root || !wrap || remoteCursors.length === 0) {
      setPeerOverlays(prev => (Object.keys(prev).length > 0 ? {} : prev));
      return;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const len = contentLength(blocks);
    const next: Record<string, PeerOverlay> = {};
    for (const c of remoteCursors) {
      const focus = domPointAt(root, blocks, Math.max(0, Math.min(c.to, len)));
      if (!focus) continue;
      let rect: { left: number; top: number; height: number } | undefined;
      if (focus.node.nodeType === Node.TEXT_NODE) {
        try {
          const range = document.createRange();
          range.setStart(focus.node, focus.offset);
          range.collapse(true);
          rect = range.getClientRects()?.[0] ?? range.getBoundingClientRect();
        } catch { /* Range rects unavailable (jsdom) — fall back below */ }
      }
      if (!rect) {
        const el = focus.node instanceof HTMLElement ? focus.node : focus.node.parentElement;
        rect = el?.getBoundingClientRect();
      }
      if (!rect) continue;

      // Selection highlight: one translucent box per rendered line fragment.
      const highlights: Box[] = [];
      if (c.from < c.to) {
        const anchor = domPointAt(root, blocks, Math.max(0, Math.min(c.from, len)));
        try {
          if (anchor) {
            const range = document.createRange();
            range.setStart(anchor.node, anchor.offset);
            range.setEnd(focus.node, focus.offset);
            for (const r of Array.from(range.getClientRects?.() ?? [])) {
              if (r.width <= 0 || r.height <= 0) continue;
              // Browsers report both a parent span's box and its text's box for
              // formatted runs — keep only boxes not contained in an earlier one.
              const contained = highlights.some(h =>
                r.left >= h.left + wrapRect.left - 0.5 && r.top >= h.top + wrapRect.top - 0.5 &&
                r.right <= h.left + h.width + wrapRect.left + 0.5 && r.bottom <= h.top + h.height + wrapRect.top + 0.5);
              if (contained) continue;
              highlights.push({ left: r.left - wrapRect.left, top: r.top - wrapRect.top, width: r.width, height: r.height });
            }
          }
        } catch { /* no Range rects (jsdom) — caret + tip still render */ }
      }

      next[c.id] = {
        caret: { left: rect.left - wrapRect.left, top: rect.top - wrapRect.top, height: rect.height || 20 },
        highlights,
      };
    }
    setPeerOverlays(next);
  }, [spans, remoteCursors, editable]);

  return (
    <div ref={wrapRef} className="rt-wrap">
      <div
        ref={rootRef}
        className={'rt-editor' + (editable ? ' rt-editable' : '')}
        contentEditable={editable}
        spellcheck={editable}
        role="textbox"
        aria-multiline="true"
        autocapitalize="sentences"
        enterkeyhint="enter"
        // Boolean, NOT the string "no": `translate` is an IDL property, so a
        // string would be assigned to it and any non-empty one is truthy —
        // producing translate="yes", the exact opposite. This matters because
        // Google Translate rewrites contenteditable subtrees wholesale, with no
        // beforeinput at all, which the model could never learn about.
        translate={false}
        data-testid="rt-editor"
        onBeforeInput={handleBeforeInput as any}
        onKeyDown={handleKeyDown}
      >
        {model.map((b, bi) => (
          <BlockEl key={`${bi}:${resyncEpoch}`} b={b} bi={bi} num={numbers[bi]} editable={editable} />
        ))}
      </div>
      {remoteCursors.map(c => {
        const o = peerOverlays[c.id];
        if (!o) return null;
        return (
          <div key={c.id}>
            {o.highlights.map((h, i) => (
              <div
                key={i}
                className="rt-peer-highlight"
                data-testid="peer-highlight"
                style={{ left: h.left, top: h.top, width: h.width, height: h.height, background: c.color }}
              />
            ))}
            <div
              className="rt-peer-caret"
              data-testid="peer-caret"
              title={c.label}
              style={{ left: o.caret.left, top: o.caret.top, height: o.caret.height, background: c.color }}
            />
            <div
              className="rt-peer-tip"
              data-testid="peer-tip"
              style={{ left: o.caret.left - 1, top: o.caret.top, background: c.color }}
            >
              {c.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
