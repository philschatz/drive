/**
 * Controlled contenteditable renderer for a Peritext spans model.
 *
 * The DOM is always a pure function of `spans`: every editing gesture is
 * intercepted in `beforeinput` (preventDefault), translated to RichTextOps by
 * the pure builders in edit-ops.ts, and emitted via `onOps` — the parent
 * applies them optimistically (spans-model) and to the worker doc, and the
 * re-render puts the caret back. The only browser-driven mutation allowed is
 * IME composition, reconciled by a text diff on compositionend.
 *
 * Position mapping is integer arithmetic over data attributes: every inline
 * run carries `data-from` (global index of its first char) and every block
 * `data-bfrom`/`data-bi`, so DOM points ↔ global offsets without guessing.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { RichTextOp, RichTextSpan } from '../../../../shared/rich-text-ops';
import {
  blocksFromSpans, blockDepth, blockIndexAt, blockType, contentLength, isListItem, marksInRange, orderedListNumbers,
  type BlockNode, type BlockType, type InlineRun,
} from './blocks';
import {
  opsForDeleteBackward, opsForDeleteForward, opsForInsertParagraph, opsForInsertText, opsForPasteText,
  toggleMarkOps, setLinkOps, setBlockTypeOps, toggleListOps, indentOps, outdentOps, insertDividerOps,
  type Edit, type PendingMarks,
} from './edit-ops';
import { applyOpsToSpans } from './spans-model';

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
  if (node instanceof HTMLElement && node.classList.contains('rt-marker')) return 0;
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
  const container = (blockEl.querySelector('.rt-li-text') as HTMLElement | null) ?? blockEl;
  return { node: container, offset: 0 };
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
      return (
        <div {...attrs} className="rt-li" style={{ paddingLeft: `${1.5 + blockDepth(b) * 1.5}rem` }}>
          <span className="rt-marker" contentEditable={false} aria-hidden="true">
            {t === 'ordered-list-item' ? `${num ?? 1}.` : '•'}
          </span>
          <span className="rt-li-text">{children}</span>
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
  const blocks = useMemo(() => blocksFromSpans(spans), [spans]);
  const numbers = useMemo(() => orderedListNumbers(blocks), [blocks]);
  // The live model can be AHEAD of the rendered DOM: a keystroke's optimistic
  // ops advance it immediately, while the parent's setState → re-render lands a
  // beat later. Rapid input (typing faster than a render cycle) must compute
  // against the advanced model + caret, never the stale DOM selection —
  // otherwise characters land at outdated positions and scramble.
  const spansPropRef = useRef(spans);
  const spansLiveRef = useRef(spans);
  const blocksRef = useRef(blocks);
  if (spansPropRef.current !== spans) {
    spansPropRef.current = spans;
    spansLiveRef.current = spans;
    blocksRef.current = blocks;
  }
  // Caret (global offsets) to restore after the next spans render; while set,
  // it IS the selection (the DOM hasn't caught up yet).
  const pendingCaretRef = useRef<Sel | null>(null);
  // Last known selection, so remote-edit re-renders don't drop the caret.
  const lastSelectionRef = useRef<Sel | null>(null);
  const pendingMarksRef = useRef<PendingMarks>({});
  const composingRef = useRef(false);

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
    return readDomSelection();
  };

  const sameSel = (a: Sel | null, b: Sel | null): boolean =>
    !!a && !!b && a.from === b.from && a.to === b.to && a.backward === b.backward;

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

  const handleBeforeInput = (e: InputEvent) => {
    if (!editable) { e.preventDefault(); return; }
    const type = e.inputType;
    if (type === 'insertCompositionText' || composingRef.current) return; // IME owns the DOM until compositionend
    e.preventDefault();
    const sel = readSelection();
    if (!sel) return;
    const bl = blocksRef.current;

    switch (type) {
      case 'insertText':
      case 'insertReplacementText': {
        const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
        if (text) emitEdit(opsForInsertText(bl, sel.from, sel.to, text, pendingMarksRef.current));
        break;
      }
      case 'insertParagraph':
      case 'insertLineBreak':
        emitEdit(opsForInsertParagraph(bl, sel.from, sel.to));
        break;
      case 'deleteContentBackward':
      case 'deleteWordBackward':
      case 'deleteSoftLineBackward':
      case 'deleteByCut':
        emitEdit(opsForDeleteBackward(bl, sel.from, sel.to));
        break;
      case 'deleteContentForward':
      case 'deleteWordForward':
        emitEdit(opsForDeleteForward(bl, sel.from, sel.to));
        break;
      case 'insertFromPaste':
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
        break; // swallowed (preventDefault above): unsupported gestures are no-ops
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

  const handleCompositionEnd = () => {
    composingRef.current = false;
    const root = rootRef.current;
    if (!root) return;
    const domSel = window.getSelection();
    const anchorEl = domSel?.anchorNode instanceof Element
      ? domSel.anchorNode : domSel?.anchorNode?.parentElement;
    const blockEl = (anchorEl as Element | null)?.closest?.('[data-bi]') as HTMLElement | null;
    if (!blockEl) return;
    const bi = Number(blockEl.dataset.bi);
    const b = blocksRef.current[bi];
    if (!b) return;
    const domText = runTextLength(blockEl) === 0 ? '' : collectText(blockEl);
    if (domText === b.text) return;
    // Common prefix/suffix diff between the model text and the composed DOM.
    let p = 0;
    while (p < b.text.length && p < domText.length && b.text[p] === domText[p]) p++;
    let s = 0;
    while (
      s < b.text.length - p && s < domText.length - p &&
      b.text[b.text.length - 1 - s] === domText[domText.length - 1 - s]
    ) s++;
    const inserted = domText.slice(p, domText.length - s);
    emitEdit({
      ops: [{ op: 'splice', index: b.textFrom + p, del: b.text.length - s - p, text: inserted }],
      caret: b.textFrom + p + inserted.length,
    });
  };

  const collectText = (blockEl: HTMLElement): string => {
    let out = '';
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue ?? ''; return; }
      if (n instanceof HTMLElement && (n.classList.contains('rt-marker') || n.tagName === 'BR')) return;
      for (const c of Array.from(n.childNodes)) walk(c);
    };
    walk(blockEl);
    return out;
  };

  const api: RichTextEditorApi = {
    toggleMark(name) {
      const sel = readSelection() ?? lastSelectionRef.current;
      if (!sel) return;
      const bl = blocksRef.current;
      if (sel.from === sel.to) {
        // Collapsed: toggle a pending mark for the next insertion.
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
      if (!sel || sel.from === sel.to) return;
      emitFormat(setLinkOps(blocksRef.current, sel.from, sel.to, href), sel);
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
    const target = pendingCaretRef.current ??
      (root.contains(document.activeElement) ? lastSelectionRef.current : null);
    pendingCaretRef.current = null;
    if (!target) return;
    // Registering a cursor token re-pushes IDENTICAL spans (the push exists to
    // carry resolved peer caret positions), so most renders here need no write at
    // all. Writing anyway reset the browser's drag anchor and selection
    // granularity mid-gesture, which collapsed the highlight on every drag step.
    if (!sameSel(readDomSelection(), target)) setDomSelection(target);
    reportSelection();
  }, [spans, editable]);

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
        data-testid="rt-editor"
        onBeforeInput={handleBeforeInput as any}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={handleCompositionEnd}
      >
        {blocks.map((b, bi) => (
          <BlockEl key={bi} b={b} bi={bi} num={numbers[bi]} editable={editable} />
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
