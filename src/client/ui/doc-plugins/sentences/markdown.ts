/**
 * Spans ↔ Markdown. Covers exactly the document vocabulary (headings, quotes,
 * nested lists, dividers, strong/em/links) — no tables or images by design.
 * Round-trip stable: markdownToSpans(spansToMarkdown(s)) preserves structure.
 *
 * `spansToMarkdown` (the export direction) lives in src/shared so the worker's
 * backup export can render it; this module re-exports it for the UI.
 */
import type { BlockValue, RichTextSpan } from '../../../../shared/rich-text-ops';
import { spansToMarkdown } from '../../../../shared/rich-text-markdown';

export { spansToMarkdown };

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
