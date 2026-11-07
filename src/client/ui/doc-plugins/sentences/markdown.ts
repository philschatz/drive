/**
 * Spans ↔ Markdown. Covers exactly the document vocabulary (headings, quotes,
 * nested lists, dividers, pipe tables, strong/em/links) — no images or code by
 * design. Round-trip stable: markdownToSpans(spansToMarkdown(s)) preserves
 * structure.
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

// ── Tables ───────────────────────────────────────────────────────────────────

/**
 * A pipe-table row's cells, or null when the line has no unescaped `|` at all.
 * One leading and one trailing pipe are decoration; `\|` stays in the cell as
 * written, so the inline parser's escape rule turns it into a literal pipe.
 */
function splitRow(line: string): string[] | null {
  let s = line.trim();
  if (!/(^|[^\\])\|/.test(s)) return null;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { buf += ch + s[i + 1]; i++; continue; }
    if (ch === '|') { cells.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

/** `| --- | :-: |`: the row that makes the line above it a header. Alignment
 * colons are accepted and ignored — columns have no alignment here. */
const isDelimiterRow = (cells: string[] | null): cells is string[] =>
  !!cells && cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const HEADING_RE = /^(#{1,6}) (.*)$/;
const QUOTE_RE = /^> ?(.*)$/;
const BULLET_RE = /^(\s*)[-*+] (.*)$/;
const NUMBERED_RE = /^(\s*)\d+\. (.*)$/;

/** A line that opens a block of its own — what ends a table's body. */
const startsBlock = (line: string): boolean =>
  HR_RE.test(line.trim()) || HEADING_RE.test(line) || QUOTE_RE.test(line) ||
  BULLET_RE.test(line) || NUMBERED_RE.test(line);

export function markdownToSpans(md: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  let paragraphOpen = false; // last emitted block is a paragraph accepting continuation lines

  const push = (block: BlockValue, inline: string) => {
    spans.push({ type: 'block', value: { ...block, attrs: block.attrs ?? {} } });
    for (const r of parseInline(inline)) {
      spans.push(r.marks ? { type: 'text', value: r.text, marks: r.marks } : { type: 'text', value: r.text });
    }
  };

  const lines = md.split('\n').map(l => l.replace(/\s+$/, ''));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { paragraphOpen = false; continue; }

    // A table: a row of cells whose NEXT line is a delimiter row of the same
    // width. The rules are ordered, so a later task-item rule (`- [ ]`) would
    // sit just before the bullet one.
    const header = startsBlock(line) ? null : splitRow(line);
    const delim = header && i + 1 < lines.length ? splitRow(lines[i + 1]) : null;
    if (header && isDelimiterRow(delim) && delim.length === header.length) {
      const columns = header.length;
      header.forEach((cell, col) => push({ type: 'table-cell', parents: [], attrs: { col, header: true } }, cell));
      let j = i + 2;
      for (; j < lines.length; j++) {
        const body = lines[j];
        if (body.trim() === '' || startsBlock(body)) break;
        const cells = splitRow(body) ?? [body.trim()];
        for (let col = 0; col < columns; col++) {
          push({ type: 'table-cell', parents: [], attrs: { col } }, cells[col] ?? '');
        }
      }
      i = j - 1;
      paragraphOpen = false;
      continue;
    }

    let m: RegExpExecArray | null;
    if (HR_RE.test(line.trim())) {
      spans.push({ type: 'block', value: { type: 'divider', parents: [], attrs: {} } });
      paragraphOpen = false;
    } else if ((m = HEADING_RE.exec(line))) {
      push({ type: 'heading', parents: [], attrs: { level: m[1].length } }, m[2]);
      paragraphOpen = false;
    } else if ((m = QUOTE_RE.exec(line))) {
      push({ type: 'blockquote', parents: [] }, m[1]);
      paragraphOpen = false;
    } else if ((m = BULLET_RE.exec(line))) {
      const depth = Math.floor(m[1].length / 2);
      push({ type: 'unordered-list-item', parents: Array(depth).fill('unordered-list-item') }, m[2]);
      paragraphOpen = false;
    } else if ((m = NUMBERED_RE.exec(line))) {
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
