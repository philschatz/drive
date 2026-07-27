/**
 * Pure builders translating editing intents (selection + gesture) into
 * `RichTextOp` lists, plus the caret position after the edit. All positions
 * are global flat-text indices (block markers occupy one position each) over
 * the block model from ./blocks.ts — no DOM here, so the whole editing brain
 * is node-testable.
 */
import type { BlockValue, RichTextOp, RichTextSpan } from '../../../../shared/rich-text-ops';
import {
  type BlockNode, type BlockType,
  blockDepth, blockIndexAt, blockType, contentLength, isListItem, marksInRange,
} from './blocks';
import { markdownToSpans } from './markdown';

export interface Edit {
  ops: RichTextOp[];
  caret: number;
}

/** Marks toggled at a collapsed caret, applied to the next insertion.
 * `false` = explicitly off (overrides what splice would inherit). */
export type PendingMarks = Record<string, unknown | false>;

const P = (): BlockValue => ({ type: 'paragraph', parents: [] });

export function opsForInsertText(
  blocks: BlockNode[],
  from: number,
  to: number,
  text: string,
  pending?: PendingMarks,
): Edit {
  const ops: RichTextOp[] = [{ op: 'splice', index: from, del: to - from, text }];
  for (const [name, value] of Object.entries(pending ?? {})) {
    if (value === false) ops.push({ op: 'unmark', start: from, end: from + text.length, name, expand: 'after' });
    else ops.push({ op: 'mark', start: from, end: from + text.length, name, value: value as any, expand: 'after' });
  }
  return { ops, caret: from + text.length };
}

export function opsForDeleteBackward(blocks: BlockNode[], from: number, to: number): Edit {
  if (to > from) return { ops: [{ op: 'splice', index: from, del: to - from }], caret: from };
  if (from === 0) return { ops: [], caret: from };

  const bi = blockIndexAt(blocks, from);
  const b = blocks[bi];
  if (b.markerIndex !== null && from === b.textFrom) {
    // Caret at the start of a block: structural backspace.
    const t = blockType(b);
    if (isListItem(b)) return { ops: outdentBlockOps(b), caret: from };
    if (t === 'blockquote') return { ops: [{ op: 'updateBlock', index: b.markerIndex, block: P() }], caret: from };
    if (bi === 0) {
      // First block: nothing above to merge into — demote a heading, else no-op.
      if (t !== 'paragraph') return { ops: [{ op: 'updateBlock', index: b.markerIndex, block: P() }], caret: from };
      return { ops: [], caret: from };
    }
    const prev = blocks[bi - 1];
    if (prev && blockType(prev) === 'divider' && prev.markerIndex !== null) {
      // Backspacing "into" a divider removes the divider, not the merge.
      return { ops: [{ op: 'joinBlock', index: prev.markerIndex }], caret: from - 1 };
    }
    return { ops: [{ op: 'joinBlock', index: b.markerIndex }], caret: from - 1 };
  }
  return { ops: [{ op: 'splice', index: from - 1, del: 1 }], caret: from - 1 };
}

export function opsForDeleteForward(blocks: BlockNode[], from: number, to: number): Edit {
  if (to > from) return { ops: [{ op: 'splice', index: from, del: to - from }], caret: from };
  if (from >= contentLength(blocks)) return { ops: [], caret: from };

  const bi = blockIndexAt(blocks, from);
  const b = blocks[bi];
  if (from === b.textTo) {
    const next = blocks[bi + 1];
    if (next?.markerIndex != null) return { ops: [{ op: 'joinBlock', index: next.markerIndex }], caret: from };
    return { ops: [], caret: from };
  }
  return { ops: [{ op: 'splice', index: from, del: 1 }], caret: from };
}

export function opsForInsertParagraph(blocks: BlockNode[], from: number, to: number): Edit {
  const ops: RichTextOp[] = [];
  if (to > from) ops.push({ op: 'splice', index: from, del: to - from });

  const b = blocks[blockIndexAt(blocks, from)];
  const t = blockType(b);

  // Enter on an empty list item exits the list (outdent step by step).
  if (isListItem(b) && b.text.length === 0 && from === b.textFrom && b.markerIndex !== null) {
    return { ops: [...ops, ...outdentBlockOps(b)], caret: from };
  }

  // Splitting at the end of a heading (or anywhere in a divider) starts a
  // plain paragraph; otherwise the new block continues the current type.
  const newBlock: BlockValue =
    t === 'divider' || (t === 'heading' && from === b.textTo)
      ? P()
      : b.block
        ? { type: b.block.type, parents: [...b.block.parents], attrs: { ...(b.block.attrs ?? {}) } }
        : P();
  ops.push({ op: 'splitBlock', index: from, block: newBlock });
  return { ops, caret: from + 1 };
}

/** Toggle a boolean-style inline mark over a selection. Collapsed selections
 * are the caller's business (pending marks). */
export function toggleMarkOps(blocks: BlockNode[], from: number, to: number, name: string, value: string | number | boolean = true): RichTextOp[] {
  if (to <= from) return [];
  const active = name in marksInRange(blocks, from, to);
  return active
    ? [{ op: 'unmark', start: from, end: to, name, expand: 'after' }]
    : [{ op: 'mark', start: from, end: to, name, value, expand: 'after' }];
}

/** Set (href) or clear (null) a link over the selection. Links never expand. */
export function setLinkOps(_blocks: BlockNode[], from: number, to: number, href: string | null): RichTextOp[] {
  if (to <= from) return [];
  return href
    ? [{ op: 'mark', start: from, end: to, name: 'link', value: JSON.stringify({ href }), expand: 'none' }]
    : [{ op: 'unmark', start: from, end: to, name: 'link', expand: 'none' }];
}

function intersectingBlocks(blocks: BlockNode[], from: number, to: number): BlockNode[] {
  return blocks.filter(b => from <= b.textTo && to >= (b.markerIndex ?? b.textFrom));
}

/**
 * Retype every block the selection touches (paragraph / heading / blockquote).
 * Leaves list membership — retyping exits lists (parents cleared).
 */
export function setBlockTypeOps(blocks: BlockNode[], from: number, to: number, type: BlockType, attrs?: Record<string, unknown>): RichTextOp[] {
  const ops: RichTextOp[] = [];
  const targets = intersectingBlocks(blocks, from, to);
  // Reverse order: converting the implicit leading block inserts a marker at 0,
  // shifting every later index — do it after the other blocks' updates.
  for (const b of [...targets].reverse()) {
    const block: BlockValue = { type, parents: [], attrs: attrs ?? {} };
    if (b.markerIndex === null) ops.push({ op: 'splitBlock', index: 0, block });
    else ops.push({ op: 'updateBlock', index: b.markerIndex, block });
  }
  return ops;
}

/** Toggle bulleted/numbered list over the selection: all-already-kind → back
 * to paragraphs, otherwise every touched block becomes an item (depth kept
 * for blocks that were already list items). */
export function toggleListOps(blocks: BlockNode[], from: number, to: number, kind: 'unordered-list-item' | 'ordered-list-item'): RichTextOp[] {
  const targets = intersectingBlocks(blocks, from, to);
  const allKind = targets.every(b => blockType(b) === kind);
  const ops: RichTextOp[] = [];
  for (const b of [...targets].reverse()) {
    const block: BlockValue = allKind
      ? P()
      : { type: kind, parents: isListItem(b) ? [...b.block!.parents] : [] };
    if (b.markerIndex === null) ops.push({ op: 'splitBlock', index: 0, block });
    else ops.push({ op: 'updateBlock', index: b.markerIndex, block });
  }
  return ops;
}

function outdentBlockOps(b: BlockNode): RichTextOp[] {
  if (b.markerIndex === null || !b.block) return [];
  if (blockDepth(b) > 0) {
    return [{ op: 'updateBlock', index: b.markerIndex, block: { type: b.block.type, parents: b.block.parents.slice(0, -1) } }];
  }
  return [{ op: 'updateBlock', index: b.markerIndex, block: P() }];
}

/** Indent list items (one level, bounded by the previous item's depth + 1). */
export function indentOps(blocks: BlockNode[], from: number, to: number): RichTextOp[] {
  const ops: RichTextOp[] = [];
  for (const b of intersectingBlocks(blocks, from, to)) {
    if (!isListItem(b) || b.markerIndex === null || !b.block) continue;
    const i = blocks.indexOf(b);
    const prev = blocks[i - 1];
    const maxDepth = prev && isListItem(prev) ? blockDepth(prev) + 1 : 0;
    if (blockDepth(b) >= maxDepth) continue;
    ops.push({ op: 'updateBlock', index: b.markerIndex, block: { type: b.block.type, parents: [...b.block.parents, b.block.type] } });
  }
  return ops;
}

/** Outdent list items; depth-0 items become paragraphs. */
export function outdentOps(blocks: BlockNode[], from: number, to: number): RichTextOp[] {
  const ops: RichTextOp[] = [];
  for (const b of intersectingBlocks(blocks, from, to)) {
    if (!isListItem(b)) continue;
    ops.push(...outdentBlockOps(b));
  }
  return ops;
}

/**
 * Paste plain text, read as Markdown. A single unformatted line splices in
 * like typing (inheriting surrounding marks); anything structured (multiple
 * blocks or inline formatting) inserts explicit blocks/marks, neutralizing
 * mark inheritance so pasted plain runs stay plain.
 */
export function opsForPasteText(blocks: BlockNode[], from: number, to: number, text: string): Edit {
  const pasted: RichTextSpan[] = markdownToSpans(text);
  const simple = pasted.length === 2 && pasted[0].type === 'block' && pasted[1].type === 'text' && !pasted[1].marks;
  if (pasted.length === 0) return { ops: [], caret: from };
  if (simple) return opsForInsertText(blocks, from, to, (pasted[1] as any).value);

  const ops: RichTextOp[] = [];
  if (to > from) ops.push({ op: 'splice', index: from, del: to - from });
  let pos = from;
  let first = true;
  for (const s of pasted) {
    if (s.type === 'block') {
      // The first pasted block merges into the block the caret is in.
      if (first) { first = false; continue; }
      ops.push({ op: 'splitBlock', index: pos, block: { type: s.value.type, parents: s.value.parents, attrs: s.value.attrs ?? {} } });
      pos += 1;
    } else {
      first = false;
      ops.push({ op: 'splice', index: pos, del: 0, text: s.value });
      const end = pos + s.value.length;
      for (const name of ['strong', 'em', 'link'] as const) {
        const value = s.marks?.[name];
        if (value !== undefined) ops.push({ op: 'mark', start: pos, end, name, value: value as any, expand: name === 'link' ? 'none' : 'after' });
        else ops.push({ op: 'unmark', start: pos, end, name, expand: name === 'link' ? 'none' : 'after' });
      }
      pos = end;
    }
  }
  return { ops, caret: pos };
}

/** Insert a divider at the caret; the caret lands in a fresh paragraph after
 * it (splitting any text that followed the caret into that paragraph). */
export function insertDividerOps(blocks: BlockNode[], from: number, to: number): Edit {
  const ops: RichTextOp[] = [];
  if (to > from) ops.push({ op: 'splice', index: from, del: to - from });
  ops.push({ op: 'splitBlock', index: from, block: { type: 'divider', parents: [] } });
  ops.push({ op: 'splitBlock', index: from + 1, block: P() });
  return { ops, caret: from + 2 };
}
