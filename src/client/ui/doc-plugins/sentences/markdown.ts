/**
 * Spans ↔ Markdown. Covers exactly the document vocabulary (headings, quotes,
 * nested lists, dividers, strong/em/links) — no tables or images by design.
 * Round-trip stable: markdownToSpans(spansToMarkdown(s)) preserves structure.
 */
import type { BlockValue, RichTextSpan } from '../../../../shared/rich-text-ops';
import { blocksFromSpans, blockDepth, blockType, orderedListNumbers, type BlockNode, type InlineRun } from './blocks';

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

function blockPrefix(b: BlockNode, num: number | null): string {
  switch (blockType(b)) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(b.block?.attrs?.level) || 1));
      return '#'.repeat(level) + ' ';
    }
    case 'blockquote': return '> ';
    case 'unordered-list-item': return '  '.repeat(blockDepth(b)) + '- ';
    case 'ordered-list-item': return '  '.repeat(blockDepth(b)) + `${num ?? 1}. `;
    default: return '';
  }
}

export function spansToMarkdown(spans: RichTextSpan[]): string {
  const blocks = blocksFromSpans(spans);
  const numbers = orderedListNumbers(blocks);
  const lines: string[] = [];
  let prevType: string | null = null;

  blocks.forEach((b, i) => {
    const t = blockType(b);
    if (b.block === null && b.text.length === 0 && blocks.length > 1) return; // empty implicit leader
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

// ── Markdown → Spans ─────────────────────────────────────────────────────────

interface ParsedRun { text: string; marks: Record<string, unknown> | null; }

/** Minimal inline parser: `**strong**`, `*em*` / `_em_`, `[text](href)`, `\x`. */
function parseInline(src: string, inherited: Record<string, unknown> = {}): ParsedRun[] {
  const runs: ParsedRun[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      runs.push({ text: buf, marks: Object.keys(inherited).length > 0 ? { ...inherited } : null });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) { buf += src[i + 1]; i += 2; continue; }

    if (ch === '[') {
      const m = /^\[((?:\\.|[^\]])*)\]\(([^)]*)\)/.exec(src.slice(i));
      if (m) {
        flush();
        runs.push(...parseInline(m[1], { ...inherited, link: JSON.stringify({ href: m[2] }) }));
        i += m[0].length;
        continue;
      }
    }

    const delim = src.startsWith('***', i) || src.startsWith('___', i)
      ? { sym: src.slice(i, i + 3), marks: { strong: true, em: true } }
      : src.startsWith('**', i) || src.startsWith('__', i)
        ? { sym: src.slice(i, i + 2), marks: { strong: true } }
        : ch === '*' || ch === '_'
          ? { sym: ch, marks: { em: true } }
          : null;
    if (delim) {
      const close = src.indexOf(delim.sym, i + delim.sym.length);
      const inner = close > i ? src.slice(i + delim.sym.length, close) : '';
      if (close > i && inner.length > 0) {
        flush();
        runs.push(...parseInline(inner, { ...inherited, ...delim.marks }));
        i = close + delim.sym.length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();

  // Merge adjacent runs with identical marks.
  const merged: ParsedRun[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && JSON.stringify(prev.marks) === JSON.stringify(r.marks)) prev.text += r.text;
    else merged.push({ ...r });
  }
  return merged;
}

export function markdownToSpans(md: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  let paragraphOpen = false; // last emitted block is a paragraph accepting continuation lines

  const push = (block: BlockValue, inline: string) => {
    spans.push({ type: 'block', value: { ...block, attrs: block.attrs ?? {} } });
    for (const r of parseInline(inline)) {
      spans.push(r.marks ? { type: 'text', value: r.text, marks: r.marks } : { type: 'text', value: r.text });
    }
  };

  for (const rawLine of md.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') { paragraphOpen = false; continue; }

    let m: RegExpExecArray | null;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      spans.push({ type: 'block', value: { type: 'divider', parents: [], attrs: {} } });
      paragraphOpen = false;
    } else if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
      push({ type: 'heading', parents: [], attrs: { level: m[1].length } }, m[2]);
      paragraphOpen = false;
    } else if ((m = /^> ?(.*)$/.exec(line))) {
      push({ type: 'blockquote', parents: [] }, m[1]);
      paragraphOpen = false;
    } else if ((m = /^(\s*)[-*+] (.*)$/.exec(line))) {
      const depth = Math.floor(m[1].length / 2);
      push({ type: 'unordered-list-item', parents: Array(depth).fill('unordered-list-item') }, m[2]);
      paragraphOpen = false;
    } else if ((m = /^(\s*)\d+\. (.*)$/.exec(line))) {
      const depth = Math.floor(m[1].length / 2);
      push({ type: 'ordered-list-item', parents: Array(depth).fill('ordered-list-item') }, m[2]);
      paragraphOpen = false;
    } else if (paragraphOpen) {
      // Soft-wrapped continuation of the previous paragraph.
      spans.push({ type: 'text', value: ' ' });
      for (const r of parseInline(line)) {
        spans.push(r.marks ? { type: 'text', value: r.text, marks: r.marks } : { type: 'text', value: r.text });
      }
    } else {
      push({ type: 'paragraph', parents: [] }, line);
      paragraphOpen = true;
    }
  }
  return spans;
}
