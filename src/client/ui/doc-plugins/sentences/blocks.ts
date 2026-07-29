/**
 * Spans → renderable block model. Global indices address the flat text where
 * each block marker occupies one position (matching Automerge splice indices),
 * so the DOM ↔ model mapping in the editor is pure integer arithmetic.
 */
import type { BlockValue, RichTextSpan } from '../../../../shared/rich-text-ops';

export type BlockType =
  | 'paragraph' | 'heading' | 'unordered-list-item' | 'ordered-list-item'
  | 'blockquote' | 'divider';

export interface InlineRun {
  text: string;
  marks: Record<string, unknown> | null;
  /** Global index of the run's first character. */
  from: number;
}

export interface BlockNode {
  /** null = text before the first marker (an implicit leading paragraph). */
  block: BlockValue | null;
  /** Global index of the `￼` marker (null for the implicit block). */
  markerIndex: number | null;
  /** Global range of the block's text (marker excluded). */
  textFrom: number;
  textTo: number;
  runs: InlineRun[];
  text: string;
}

export function blockType(b: BlockNode): BlockType {
  return (b.block?.type as BlockType) ?? 'paragraph';
}

export function blockDepth(b: BlockNode): number {
  return b.block?.parents.length ?? 0;
}

export function isListItem(b: BlockNode): boolean {
  const t = blockType(b);
  return t === 'unordered-list-item' || t === 'ordered-list-item';
}

/**
 * Build the block list. Always returns at least one block: an empty document
 * (or one with no leading marker) starts with an implicit paragraph.
 */
export function blocksFromSpans(spans: RichTextSpan[]): BlockNode[] {
  const blocks: BlockNode[] = [];
  let index = 0;
  let current: BlockNode | null = null;

  const open = (block: BlockValue | null, markerIndex: number | null) => {
    current = { block, markerIndex, textFrom: index, textTo: index, runs: [], text: '' };
    blocks.push(current);
  };

  for (const s of spans) {
    if (s.type === 'block') {
      const { type, parents, attrs } = s.value as BlockValue;
      const markerIndex = index;
      index += 1;
      open({ type, parents: [...(parents ?? [])], attrs: { ...(attrs ?? {}) } }, markerIndex);
    } else {
      if (!current) open(null, null);
      const c = current!;
      c.runs.push({ text: s.value, marks: s.marks && Object.keys(s.marks).length > 0 ? s.marks : null, from: index });
      c.text += s.value;
      index += s.value.length;
      c.textTo = index;
    }
  }

  if (blocks.length === 0) open(null, null);
  return blocks;
}

/** Total length of the flat text (markers included). */
export function contentLength(blocks: BlockNode[]): number {
  const last = blocks[blocks.length - 1];
  return last.textTo;
}

/**
 * The block whose text contains the caret position `index`.
 *
 * Boundaries are ambiguous by construction: block N's `textTo` IS block N+1's
 * `markerIndex`, since the marker occupies that one position. The op builders
 * resolve that index as the END of block N — backspace there deletes N's last
 * character, Enter there splits N, delete-forward there joins N+1 in — so this
 * scans FORWARD and returns the first block whose text ends at or after `index`.
 * (Scanning backwards instead returned N+1, which walked the caret into the next
 * paragraph and made Enter inherit the following block's type.)
 */
export function blockIndexAt(blocks: BlockNode[], index: number): number {
  for (let i = 0; i < blocks.length; i++) if (index <= blocks[i].textTo) return i;
  return blocks.length - 1;
}

/**
 * Ordered-list numbering: each ordered item's 1-based position within its run
 * of consecutive same-depth list items. Deeper items don't interrupt an outer
 * run; a non-list block or a shallower item ends it; an unordered sibling
 * restarts the count.
 */
export function orderedListNumbers(blocks: BlockNode[]): (number | null)[] {
  const counts = new Map<number, number>();
  return blocks.map(b => {
    if (!isListItem(b)) {
      counts.clear();
      return null;
    }
    const depth = blockDepth(b);
    for (const d of [...counts.keys()]) if (d > depth) counts.delete(d);
    if (blockType(b) === 'ordered-list-item') {
      const n = (counts.get(depth) ?? 0) + 1;
      counts.set(depth, n);
      return n;
    }
    counts.set(depth, 0);
    return null;
  });
}

/** Marks present under a caret / across an entire selection (for toolbar
 * toggle state). For a caret, the marks of the character before it (matching
 * `after` expansion — what typing would inherit). */
export function marksInRange(blocks: BlockNode[], from: number, to: number): Record<string, unknown> {
  if (from === to) {
    for (const b of blocks) {
      for (const r of b.runs) {
        if (from > r.from && from <= r.from + r.text.length) return r.marks ?? {};
      }
    }
    return {};
  }
  let acc: Record<string, unknown> | null = null;
  for (const b of blocks) {
    for (const r of b.runs) {
      const rFrom = r.from;
      const rTo = r.from + r.text.length;
      if (rTo <= from || rFrom >= to) continue;
      const marks = r.marks ?? {};
      if (acc === null) acc = { ...marks };
      else {
        for (const k of Object.keys(acc)) {
          if (!(k in marks)) delete acc[k];
        }
      }
      if (Object.keys(acc).length === 0) return {};
    }
  }
  return acc ?? {};
}

/**
 * The whole stretch of formatted text a caret sits in: the contiguous
 * characters around `index` carrying mark `name`, or null if it carries none.
 *
 * This is what makes a caret-only format gesture act on something. With nothing
 * selected, tapping Bold inside a bold word un-bolds the *word* (rather than
 * only arming the next keystroke), and the Link sheet edits the link the caret
 * is in. `index` is read the same way `marksInRange` reads a caret — the
 * character BEFORE it — so the toolbar's active state and the action it performs
 * can never disagree.
 *
 * Adjacent runs merge only when the mark's value matches too, so two different
 * links (or two different-coloured spans) side by side stay separate, and the
 * walk stops at the block edge: a heading's bold is not the next paragraph's.
 */
export function markExtentAt(
  blocks: BlockNode[],
  index: number,
  name: string,
): { from: number; to: number; value: unknown } | null {
  for (const b of blocks) {
    for (let i = 0; i < b.runs.length; i++) {
      const r = b.runs[i];
      if (!(index > r.from && index <= r.from + r.text.length)) continue;
      if (!r.marks || !(name in r.marks)) return null;
      const value = r.marks[name];
      const same = (run: InlineRun) => !!run.marks && name in run.marks && run.marks[name] === value;
      let from = r.from;
      let to = r.from + r.text.length;
      for (let j = i - 1; j >= 0 && same(b.runs[j]); j--) from = b.runs[j].from;
      for (let j = i + 1; j < b.runs.length && same(b.runs[j]); j++) to = b.runs[j].from + b.runs[j].text.length;
      return { from, to, value };
    }
  }
  return null;
}
