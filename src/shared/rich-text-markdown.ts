/**
 * Spans → Markdown. The readable export form for Sentences documents: the JSON
 * projection is a flat string (marks and block markers live only in the
 * Automerge binary), so backup export renders the lossless `markdown` from
 * `Automerge.spans`. Covers exactly the document vocabulary (headings, quotes,
 * nested lists, dividers, strong/em/links) — no tables or images by design.
 *
 * Lives in src/shared (not the UI) because the export runs inside the worker;
 * the UI's markdown.ts re-exports it so there is one implementation.
 */
import type { BlockValue, RichTextSpan } from './rich-text-ops';

// ── Spans → Markdown ─────────────────────────────────────────────────────────

const ESCAPE_RE = /([\\`*_[\]])/g;

function escapeText(s: string): string {
  return s.replace(ESCAPE_RE, '\\$1');
}

function linkHref(marks: Record<string, unknown> | null): string | null {
  const raw = marks?.link;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.href === 'string' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Inline runs → markdown with well-nested delimiters (link ⊃ strong ⊃ em). */
function runsToMarkdown(runs: InlineRun[]): string {
  type Open = { name: 'link' | 'strong' | 'em'; href?: string };
  const stack: Open[] = [];
  let out = '';

  const closeSym = (o: Open) => (o.name === 'link' ? `](${o.href ?? ''})` : o.name === 'strong' ? '**' : '*');
  const openSym = (o: Open) => (o.name === 'link' ? '[' : o.name === 'strong' ? '**' : '*');

  for (const r of runs) {
    const href = linkHref(r.marks);
    const want: Open[] = [];
    if (href !== null) want.push({ name: 'link', href });
    if (r.marks?.strong) want.push({ name: 'strong' });
    if (r.marks?.em) want.push({ name: 'em' });

    // Keep the longest common prefix open; close the rest (innermost first).
    let common = 0;
    while (
      common < stack.length && common < want.length &&
      stack[common].name === want[common].name &&
      stack[common].href === want[common].href
    ) common++;
    while (stack.length > common) out += closeSym(stack.pop()!);
    for (let i = common; i < want.length; i++) { stack.push(want[i]); out += openSym(want[i]); }

    out += escapeText(r.text);
  }
  while (stack.length > 0) out += closeSym(stack.pop()!);
  return out;
}

interface InlineRun {
  text: string;
  marks: Record<string, unknown> | null;
}

interface BlockNode {
  type: string;
  parents: string[];
  attrs: Record<string, unknown>;
  /** Text before the first marker (an implicit leading paragraph). */
  implicit: boolean;
  runs: InlineRun[];
  text: string;
}

/** Group spans into blocks (markers start a block; runs append to it). */
function blocksFromSpans(spans: RichTextSpan[]): BlockNode[] {
  const blocks: BlockNode[] = [];
  let current: BlockNode | null = null;

  const open = (block: BlockValue | null) => {
    current = {
      type: (block?.type as string) ?? 'paragraph',
      parents: [...(block?.parents ?? [])],
      attrs: { ...(block?.attrs ?? {}) },
      implicit: block === null,
      runs: [],
      text: '',
    };
    blocks.push(current);
  };

  for (const s of spans) {
    if (s.type === 'block') {
      open(s.value as BlockValue);
    } else {
      if (!current) open(null);
      const c = current!;
      c.runs.push({ text: s.value, marks: s.marks && Object.keys(s.marks).length > 0 ? s.marks : null });
      c.text += s.value;
    }
  }

  if (blocks.length === 0) open(null);
  return blocks;
}

function isListItem(b: BlockNode): boolean {
  return b.type === 'unordered-list-item' || b.type === 'ordered-list-item';
}

/**
 * Ordered-list numbering: each ordered item's 1-based position within its run
 * of consecutive same-depth list items. Deeper items don't interrupt an outer
 * run; a non-list block or a shallower item ends it; an unordered sibling
 * restarts the count.
 */
function orderedListNumbers(blocks: BlockNode[]): (number | null)[] {
  const counts = new Map<number, number>();
  return blocks.map(b => {
    if (!isListItem(b)) {
      counts.clear();
      return null;
    }
    const depth = b.parents.length;
    for (const d of [...counts.keys()]) if (d > depth) counts.delete(d);
    if (b.type === 'ordered-list-item') {
      const n = (counts.get(depth) ?? 0) + 1;
      counts.set(depth, n);
      return n;
    }
    counts.set(depth, 0);
    return null;
  });
}

function blockPrefix(b: BlockNode, num: number | null): string {
  switch (b.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(b.attrs?.level) || 1));
      return '#'.repeat(level) + ' ';
    }
    case 'blockquote': return '> ';
    case 'unordered-list-item': return '  '.repeat(b.parents.length) + '- ';
    case 'ordered-list-item': return '  '.repeat(b.parents.length) + `${num ?? 1}. `;
    default: return '';
  }
}

export function spansToMarkdown(spans: RichTextSpan[]): string {
  const blocks = blocksFromSpans(spans);
  const numbers = orderedListNumbers(blocks);
  const lines: string[] = [];
  let prevType: string | null = null;

  blocks.forEach((b, i) => {
    const t = b.type;
    if (b.implicit && b.text.length === 0 && blocks.length > 1) return; // empty implicit leader
    const line = t === 'divider' ? '---' : blockPrefix(b, numbers[i]) + runsToMarkdown(b.runs);
    if (lines.length > 0) {
      // Consecutive list items / quote lines sit on adjacent lines; everything
      // else gets a blank line between blocks.
      const tight =
        ((t === 'unordered-list-item' || t === 'ordered-list-item') &&
          (prevType === 'unordered-list-item' || prevType === 'ordered-list-item')) ||
        (t === 'blockquote' && prevType === 'blockquote');
      if (!tight) lines.push('');
    }
    lines.push(line);
    prevType = t;
  });
  return lines.join('\n');
}
