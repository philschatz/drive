/**
 * DOM → model reconciliation: the ops that turn the rendered blocks back into
 * what the browser now actually shows.
 *
 * Needed because one editing path is not ours. An IME owns the DOM between
 * `compositionstart` and `compositionend` — and on Android that is *ordinary
 * typing*, since GBoard composes every Latin word — so the browser writes text
 * we never translated into ops. This is how it gets folded back in.
 *
 * Pure, like edit-ops.ts: strings and BlockNodes in, RichTextOps out. The
 * caller does the DOM reading, which is what makes the whole diff node-testable.
 *
 * Two rules earn their keep:
 *
 * - **Blocks are matched positionally, never by `data-bi`.** That attribute is a
 *   render-relative index, and the live model is reset by any push and advanced
 *   ahead of the DOM by every optimistic edit — so `blocks[Number(el.dataset.bi)]`
 *   can name a different paragraph entirely. The i-th child of the root IS the
 *   i-th rendered block; nothing else is trustworthy.
 * - **The diff is against the blocks that produced the current DOM**, never the
 *   live model. The caller passes `rendered`, not `blocksRef.current`, whenever
 *   the two can differ.
 */
import type { RichTextOp } from '../../../../shared/rich-text-ops';
import { blockType, type BlockNode } from './blocks';

export interface Reconciliation {
  /** Ops to apply, highest model index first (so earlier indices stay valid). */
  ops: RichTextOp[];
  /**
   * The DOM's block structure could not be read as the model's. The aligned
   * blocks in `ops` are still correct; the rest must be rebuilt from the model,
   * because guessing a block's type/level/nesting from DOM shape destroys it.
   */
  resync: boolean;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Longest common prefix/suffix diff, never splitting a surrogate pair — editing
 * next to an emoji otherwise emits a lone surrogate, which is not valid text.
 */
export function diffText(
  from: string,
  to: string,
): { at: number; del: number; ins: string } | null {
  if (from === to) return null;
  let p = 0;
  const max = Math.min(from.length, to.length);
  while (p < max && from[p] === to[p]) p++;
  if (p > 0 && isHighSurrogate(from.charCodeAt(p - 1))) p--;
  let s = 0;
  while (
    s < from.length - p && s < to.length - p &&
    from[from.length - 1 - s] === to[to.length - 1 - s]
  ) s++;
  if (s > 0 && isLowSurrogate(from.charCodeAt(from.length - s))) s--;
  return { at: p, del: from.length - p - s, ins: to.slice(p, to.length - s) };
}

/** A block whose text the browser may not rewrite, so never diff it. */
const isAtomic = (b: BlockNode) => blockType(b) === 'divider';

function spliceFor(b: BlockNode, domText: string): RichTextOp | null {
  if (isAtomic(b)) return null;
  const d = diffText(b.text, domText);
  if (!d) return null;
  return { op: 'splice', index: b.textFrom + d.at, del: d.del, text: d.ins };
}

/**
 * `rendered[i]` vs `domTexts[i]` — the ops that make the model say what the DOM
 * says.
 *
 * When the block counts match, every block is diffed and the result is exact.
 *
 * When they don't, the browser created or removed a block element, and there is
 * no honest way to attribute the text: which DOM block is which model block is
 * exactly the unknown, and a wrong guess writes text into the wrong paragraph or
 * invents a block whose type/heading level/list nesting we made up. So nothing
 * is emitted and `resync` asks the caller to rebuild the DOM from the model —
 * losing at most the text of an in-flight composition, never corrupting the
 * document. This stays rare by construction: the browser only gets to author
 * DOM while an IME composes, and the structural gestures that would split a
 * block (Enter, backspace at a block start) are cancelable, so the editor
 * intercepts them and reconciles before letting them through.
 */
export function reconcileDomToOps(rendered: BlockNode[], domTexts: string[]): Reconciliation {
  if (rendered.length !== domTexts.length) return { ops: [], resync: true };

  const ops: RichTextOp[] = [];
  // Highest index first: each op's index then still addresses the original
  // model as the earlier ones are applied. Same reason edit-ops reverses.
  for (let i = rendered.length - 1; i >= 0; i--) {
    const op = spliceFor(rendered[i], domTexts[i]);
    if (op) ops.push(op);
  }
  return { ops, resync: false };
}
