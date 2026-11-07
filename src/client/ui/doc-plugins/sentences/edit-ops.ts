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
  blockDepth, blockIndexAt, blockType, contentLength, isListItem, isTableCell, marksInRange, tableAt, tableGroups,
} from './blocks';
import { markdownToSpans } from './markdown';

export interface Edit {
  ops: RichTextOp[];
  caret: number;
}

/**
 * Keep a range inside the table structure it touches.
 *
 * A table's rows and columns are not editable, and in the flat text they are
 * nothing but the cells' block markers — so any range that straddles a cell
 * boundary would splice a marker away and silently reshape the table. Starting
 * inside a cell, a range ends at that cell's end; starting before a table, it
 * stops short of the table's first marker. A range that covers a whole table
 * (first marker to last cell's end) is left alone: deleting it is how a table
 * is removed.
 */
export function clampToCells(blocks: BlockNode[], from: number, to: number): { from: number; to: number } {
  if (to <= from) return { from, to };
  const fromBlock = blocks[blockIndexAt(blocks, from)];
  if (isTableCell(fromBlock)) return { from, to: Math.min(to, fromBlock.textTo) };
  for (const g of tableGroups(blocks)) {
    const start = blocks[g.start].markerIndex!;
    const end = blocks[g.end - 1].textTo;
    if (from >= end) continue;   // a table before the range
    if (to <= start) break;      // tables from here on are past it
    if (from <= start && to >= end) continue;
    return { from, to: start };
  }
  return { from, to };
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
  ({ from, to } = clampToCells(blocks, from, to));
  const ops: RichTextOp[] = [];
  const b = blocks[blockIndexAt(blocks, from)];
  if (isDivider(b) && b.markerIndex !== null) {
    // The caret on a divider's line sits BEFORE the rule (see the divider
    // notes above caretOnDivider), and the block draws an <hr>, never its
    // text — so typing there opens a paragraph before the divider and goes
    // into that, in the same change. The new paragraph's text starts where
    // the divider's did, so `from` needs no shift.
    ops.push({ op: 'splitBlock', index: b.markerIndex, block: P() });
    to = from;
  }
  ops.push({ op: 'splice', index: from, del: to - from, text });
  for (const [name, value] of Object.entries(pending ?? {})) {
    if (value === false) ops.push({ op: 'unmark', start: from, end: from + text.length, name, expand: 'after' });
    else ops.push({ op: 'mark', start: from, end: from + text.length, name, value: value as any, expand: 'after' });
  }
  return { ops, caret: from + text.length };
}

/**
 * Dividers. A divider block has exactly one caret position — its own (empty)
 * text — and the editor draws that position as a line ABOVE the rule, so a
 * caret there reads as "before the divider". Every builder honours that
 * reading: typing or pasting opens a paragraph before the divider, Enter
 * opens one before it (after it only when the divider ends the document,
 * since nothing else could reach that spot), Backspace steps up to the block
 * above, Delete removes the rule the caret sits in front of. Without this a
 * table followed by a divider had no position between them at all — and
 * nothing is inserted until something is typed.
 */
const isDivider = (b: BlockNode | undefined): boolean => !!b && blockType(b) === 'divider';

export function opsForDeleteBackward(blocks: BlockNode[], from: number, to: number): Edit {
  // A range covering exactly one block marker and no text IS a caret at that
  // block's start — not something to splice away.
  //
  // Android IMEs never send backspace as a collapsed-caret gesture: GBoard on
  // Gecko expresses it as `deleteSurroundingText`, which Gecko performs by
  // selecting the range and deleting it, over the FLAT text the IME sees — where
  // a block boundary is one character. Splicing a marker away MERGES the blocks,
  // so every structural backspace (outdent, blockquote demote, divider removal)
  // silently degraded to a merge there. Paragraphs hid it, merging being what
  // they do anyway, and desktop hid it because the boundary range arrives via
  // `getTargetRanges()` instead, which the editor's `deleteRange` discards.
  //
  // Deliberately narrow — one position, landing exactly on a marker. A drag over
  // real characters that happens to cross a boundary still means what it says.
  if (to - from === 1) {
    const b = blocks.find(x => x.markerIndex === from);
    // Collapsed, so this cannot re-enter the branch.
    if (b) return opsForDeleteBackward(blocks, b.textFrom, b.textFrom);
  }
  // After the marker rule: a bare cell marker clamps to nothing, and the
  // collapsed caret that left behind would then eat the previous block's text.
  ({ from, to } = clampToCells(blocks, from, to));
  if (to > from) return { ops: [{ op: 'splice', index: from, del: to - from }], caret: from };
  if (from === 0) return { ops: [], caret: from };

  const bi = blockIndexAt(blocks, from);
  const b = blocks[bi];
  if (b.markerIndex !== null && from === b.textFrom) {
    // Caret at the start of a block: structural backspace.
    const t = blockType(b);
    // A cell's start is a table boundary, and so is the start of the block
    // after a table: neither joins (a joinBlock would move text into or out of
    // a cell and so reshape the table). The caret simply stays.
    if (isTableCell(b)) return { ops: [], caret: from };
    // On a divider's line the caret is before the rule: step up to the end of
    // the block above rather than delete what is after the caret. A leading
    // divider falls through to the first-block rule and becomes a paragraph.
    if (isDivider(b) && bi > 0) return { ops: [], caret: blocks[bi - 1].textTo };
    if (isListItem(b)) return { ops: outdentBlockOps(b), caret: from };
    if (t === 'blockquote') return { ops: [{ op: 'updateBlock', index: b.markerIndex, block: P() }], caret: from };
    if (bi === 0) {
      // First block: nothing above to merge into — demote a heading, else no-op.
      if (t !== 'paragraph') return { ops: [{ op: 'updateBlock', index: b.markerIndex, block: P() }], caret: from };
      return { ops: [], caret: from };
    }
    const prev = blocks[bi - 1];
    if (prev && isTableCell(prev)) return { ops: [], caret: from };
    if (prev && blockType(prev) === 'divider' && prev.markerIndex !== null) {
      // Backspacing "into" a divider removes the divider, not the merge.
      return { ops: [{ op: 'joinBlock', index: prev.markerIndex }], caret: from - 1 };
    }
    return { ops: [{ op: 'joinBlock', index: b.markerIndex }], caret: from - 1 };
  }
  return { ops: [{ op: 'splice', index: from - 1, del: 1 }], caret: from - 1 };
}

export function opsForDeleteForward(blocks: BlockNode[], from: number, to: number): Edit {
  ({ from, to } = clampToCells(blocks, from, to));
  if (to > from) return { ops: [{ op: 'splice', index: from, del: to - from }], caret: from };
  if (from >= contentLength(blocks)) return { ops: [], caret: from };

  const bi = blockIndexAt(blocks, from);
  const b = blocks[bi];
  if (from === b.textTo) {
    const next = blocks[bi + 1];
    // The end of a cell and the end of the block before a table are table
    // boundaries — see opsForDeleteBackward.
    if (isTableCell(b) || (next && isTableCell(next))) return { ops: [], caret: from };
    // Delete "in" a divider removes the divider; joining the next block into it
    // would hide that block's text behind the <hr>.
    if (isDivider(b) && b.markerIndex !== null) return { ops: [{ op: 'joinBlock', index: b.markerIndex }], caret: from - 1 };
    if (next?.markerIndex != null) return { ops: [{ op: 'joinBlock', index: next.markerIndex }], caret: from };
    return { ops: [], caret: from };
  }
  return { ops: [{ op: 'splice', index: from, del: 1 }], caret: from };
}

export function opsForInsertParagraph(blocks: BlockNode[], from: number, to: number): Edit {
  ({ from, to } = clampToCells(blocks, from, to));
  const ops: RichTextOp[] = [];
  if (to > from) ops.push({ op: 'splice', index: from, del: to - from });

  const bi = blockIndexAt(blocks, from);
  const b = blocks[bi];
  const t = blockType(b);

  // A cell cannot split (that would add a cell), so Enter leaves the table: a
  // fresh paragraph after its last cell, which is also the only way to write
  // after a table that ends the document.
  const table = tableAt(blocks, bi);
  if (table) {
    const end = blocks[table.end - 1].textTo - (to - from);
    ops.push({ op: 'splitBlock', index: end, block: P() });
    return { ops, caret: end + 1 };
  }

  // Enter on a divider's line: a paragraph before the rule, caret in it — the
  // caret sits before the rule, so that is where the new line goes. A divider
  // that ENDS the document gets the paragraph after it instead: typing already
  // reaches "before", and nothing else can reach "after".
  if (isDivider(b) && b.markerIndex !== null) {
    if (bi === blocks.length - 1) {
      ops.push({ op: 'splitBlock', index: from, block: P() });
      return { ops, caret: from + 1 };
    }
    ops.push({ op: 'splitBlock', index: b.markerIndex, block: P() });
    return { ops, caret: from };
  }

  // Enter on an empty list item exits the list (outdent step by step).
  if (isListItem(b) && b.text.length === 0 && from === b.textFrom && b.markerIndex !== null) {
    return { ops: [...ops, ...outdentBlockOps(b)], caret: from };
  }

  // Splitting at the end of a heading (or anywhere in a divider) starts a
  // plain paragraph; otherwise the new block continues the current type — attrs
  // included, so a per-item attr that must NOT carry over (a task item's
  // `checked`, were one added) would need resetting here.
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

/** Every block a selection touches. A collapsed caret touches exactly one, and a
 * range reaches into the next block only when it covers some of that block's
 * TEXT — comparing against its `markerIndex` instead pulled in the following
 * block for any selection ending at a block boundary. */
function intersectingBlocks(blocks: BlockNode[], from: number, to: number): BlockNode[] {
  const hit = from === to
    ? [blocks[blockIndexAt(blocks, from)]]
    : blocks.filter(b => from <= b.textTo && to >= b.textFrom);
  // Every caller retypes or re-nests the blocks it gets, and a cell is neither
  // retypable nor nestable: a heading cell would break the table it is in.
  return hit.filter(b => !isTableCell(b));
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

/** Pasted blocks as one block's runs: block boundaries become single spaces.
 * What a cell can take, since it cannot hold blocks. */
function flattenToOneBlock(spans: RichTextSpan[]): RichTextSpan[] {
  const out: RichTextSpan[] = [{ type: 'block', value: { type: 'paragraph', parents: [], attrs: {} } }];
  let pendingSpace = false;
  for (const s of spans) {
    if (s.type === 'block') { pendingSpace = out.length > 1; continue; }
    if (pendingSpace) { out.push({ type: 'text', value: ' ' }); pendingSpace = false; }
    out.push(s);
  }
  return out;
}

/**
 * Paste plain text, read as Markdown. A single unformatted line splices in
 * like typing (inheriting surrounding marks); anything structured (multiple
 * blocks or inline formatting) inserts explicit blocks/marks, neutralizing
 * mark inheritance so pasted plain runs stay plain.
 *
 * Tables: inside a cell the paste is flattened to one line of runs. Elsewhere a
 * pasted table never merges into the caret's block (its first cell is a block
 * of its own — the caret's block is retyped into it only when that block is an
 * empty paragraph), and it is followed by a fresh paragraph so the caret and any
 * text after it have a home, the same shape `insertDividerOps` leaves.
 */
export function opsForPasteText(blocks: BlockNode[], from: number, to: number, text: string): Edit {
  ({ from, to } = clampToCells(blocks, from, to));
  const b = blocks[blockIndexAt(blocks, from)];
  const pasted: RichTextSpan[] = isTableCell(b) ? flattenToOneBlock(markdownToSpans(text)) : markdownToSpans(text);
  // One block and one plain run is "a line of text" — unless that block is a
  // cell, which is a table however small.
  const simple = pasted.length === 2 && pasted[0].type === 'block' && pasted[0].value.type !== 'table-cell'
    && pasted[1].type === 'text' && !pasted[1].marks;
  if (pasted.length === 0 || (pasted.length === 1 && pasted[0].type === 'block')) return { ops: [], caret: from };
  if (simple) return opsForInsertText(blocks, from, to, (pasted[1] as any).value);

  const ops: RichTextOp[] = [];
  if (to > from) ops.push({ op: 'splice', index: from, del: to - from });
  let pos = from;
  // An empty paragraph the caret sits in takes the first pasted block's type
  // (a pasted heading on an empty line IS a heading; a pasted table's first
  // cell takes it over rather than leaving an empty line above the table).
  let emptyParagraphMarker: number | null =
    b.markerIndex !== null && blockType(b) === 'paragraph' && b.text.length === 0 && from === b.textFrom
      ? b.markerIndex : null;
  if (isDivider(b) && b.markerIndex !== null) {
    // Nothing can go into a divider: paste into a paragraph opened before it
    // (whose text starts where the divider's did, so `pos` stays).
    ops.push({ op: 'splitBlock', index: b.markerIndex, block: P() });
    emptyParagraphMarker = b.markerIndex;
  }
  let first = true;
  let lastBlockIsCell = false;
  for (const s of pasted) {
    if (s.type === 'block') {
      const isCell = s.value.type === 'table-cell';
      const block: BlockValue = { type: s.value.type, parents: s.value.parents, attrs: s.value.attrs ?? {} };
      if (first) {
        first = false;
        if (emptyParagraphMarker !== null) {
          if (s.value.type !== 'paragraph') ops.push({ op: 'updateBlock', index: emptyParagraphMarker, block });
          lastBlockIsCell = isCell;
          continue;
        }
        // The first pasted block merges into the block the caret is in —
        // unless it is a cell, which must stay a block of its own.
        if (!isCell) continue;
      }
      ops.push({ op: 'splitBlock', index: pos, block });
      pos += 1;
      lastBlockIsCell = isCell;
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
  if (lastBlockIsCell) {
    ops.push({ op: 'splitBlock', index: pos, block: P() });
    pos += 1;
  }
  return { ops, caret: pos };
}

/** Insert a divider at the caret; the caret lands in a fresh paragraph after
 * it (splitting any text that followed the caret into that paragraph). */
export function insertDividerOps(blocks: BlockNode[], from: number, to: number): Edit {
  ({ from, to } = clampToCells(blocks, from, to));
  if (isTableCell(blocks[blockIndexAt(blocks, from)])) return { ops: [], caret: from };
  const ops: RichTextOp[] = [];
  if (to > from) ops.push({ op: 'splice', index: from, del: to - from });
  ops.push({ op: 'splitBlock', index: from, block: { type: 'divider', parents: [] } });
  ops.push({ op: 'splitBlock', index: from + 1, block: P() });
  return { ops, caret: from + 2 };
}
