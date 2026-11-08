/**
 * The "Edit text" markup: a rich-text field as one editable string in which
 * every marker is a numbered token.
 *
 * The field's screen lists markers as numbered rows; this is the same numbering
 * typed into the text. A block marker is `⟦1 h1⟧` where its `￼` sits, a mark is
 * `⟨2 strong⟩` at its start and `⟨/2⟩` at its end. The word after the number is
 * a label for reading — the parser ignores it, which is precisely how "no
 * attribute editing here" is enforced: a token can be moved, copied or deleted,
 * and that moves, duplicates or removes the marker it names, but what the marker
 * IS is edited in its sheet.
 *
 * The save path is deliberately not a diff of our own. The edited markup parses
 * back to a text and a marker list, {@link spansFromMarkers} turns those into
 * spans, and one `updateSpans` op hands them to Automerge, which reconciles them
 * against the live document — untouched text keeps its identity, and a moved
 * heading stays a heading. The single-hunk `flatTextEditOps` diff this replaces
 * could only ever delete one block and insert a default paragraph.
 */
import {
  BLOCK_MARKER, compareMarkers, spansFromMarkers,
  type BlockValue, type DocMarker, type RichTextOp,
} from '../../../shared/rich-text-ops';
import { blockChipLabel, escapeString, footnoteLabel } from './source-nodes';

const BLOCK_OPEN = '⟦';
const BLOCK_CLOSE = '⟧';
const MARK_OPEN = '⟨';
const MARK_CLOSE = '⟩';
/** The four delimiters — backslash-escaped when they occur in the text itself. */
const DELIMITERS = [BLOCK_OPEN, BLOCK_CLOSE, MARK_OPEN, MARK_CLOSE];

/** The token for block marker `i`: `⟦1 h1⟧`. */
export const blockToken = (i: number, block: BlockValue) =>
  `${BLOCK_OPEN}${footnoteLabel(i)} ${blockChipLabel(block)}${BLOCK_CLOSE}`;
/** The tokens for mark `i`: `⟨2 strong⟩` … `⟨/2⟩`. */
export const markOpenToken = (i: number, name: string) => `${MARK_OPEN}${footnoteLabel(i)} ${name}${MARK_CLOSE}`;
export const markCloseToken = (i: number) => `${MARK_OPEN}/${footnoteLabel(i)}${MARK_CLOSE}`;

/** Escaped like every other string on the inspector, plus the four delimiters. */
function escapeRun(s: string): string {
  return escapeString(s).replace(/[⟦⟧⟨⟩]/g, '\\$&');
}

/**
 * The field as markup: its escaped text with every marker's token in place.
 * At one position the order is closes, then the block, then opens, with closes
 * in reverse so nested marks close like brackets.
 */
export function markedText(text: string, markers: DocMarker[]): string {
  const blocks = new Map<number, string>();
  const opens = new Map<number, string[]>();
  const closes = new Map<number, string[]>();
  const add = (at: Map<number, string[]>, p: number, token: string) => at.set(p, [...(at.get(p) ?? []), token]);
  markers.forEach((m, i) => {
    if (m.kind === 'block') blocks.set(m.index, blockToken(i, m.block));
    else {
      add(opens, m.start, markOpenToken(i, m.name));
      add(closes, m.end, markCloseToken(i));
    }
  });

  let out = '';
  let run = '';
  const flush = () => { out += escapeRun(run); run = ''; };
  for (let p = 0; p <= text.length; p++) {
    const c = closes.get(p);
    const b = blocks.get(p);
    const o = opens.get(p);
    if (c || b || o) {
      flush();
      if (c) out += [...c].reverse().join('');
      if (b) out += b;
      if (o) out += o.join('');
    }
    // A block's token stands in for its `￼`.
    if (p < text.length && !b) run += text[p];
  }
  flush();
  return out;
}

export interface ParsedMarkedText {
  /** The flat text, `￼` per block marker. */
  text: string;
  markers: DocMarker[];
}

/** The marker a token's leading number names, if it names one. */
function numbered(body: string, markers: DocMarker[]): DocMarker | undefined {
  const hit = /^\s*(\d+)/.exec(body);
  return hit ? markers[Number(hit[1]) - 1] : undefined;
}

/**
 * The markup read back: the flat text and the markers the tokens place.
 *
 * - `⟦n …⟧` whose number names a block marker places a copy of that block. Any
 *   other block token — unnumbered, unknown, or naming a mark — places a default
 *   paragraph, as does a typed `￼` or a bare `￼` (which is never content:
 *   U+FFFC is only ever the projection's stand-in for a block marker).
 * - `⟨n …⟩` … `⟨/n⟩` whose number names a mark places a copy of it over the text
 *   between. Pairs nest like brackets, so a duplicated pair is two ranges. An
 *   unpaired open or close, an unknown number, a block's number, or an empty
 *   range places nothing.
 * - Tokens occupy no text; `\⟦` and friends are the delimiters as characters.
 */
export function parseMarkedText(raw: string, markers: DocMarker[]): ParsedMarkedText {
  let text = '';
  const out: DocMarker[] = [];
  /** Where each mark's unmatched opens sit, keyed by the marker it names. */
  const open = new Map<DocMarker, number[]>();
  const paragraph = (): BlockValue => ({ type: 'paragraph', parents: [], attrs: {} });
  const pushBlock = (block: BlockValue) => {
    out.push({ kind: 'block', index: text.length, block });
    text += BLOCK_MARKER;
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') { text += '\n'; i += 2; continue; }
      if (next === 'r') { text += '\r'; i += 2; continue; }
      if (next === 't') { text += '\t'; i += 2; continue; }
      if (next === '\\') { text += '\\'; i += 2; continue; }
      if (DELIMITERS.includes(next)) { text += next; i += 2; continue; }
      if (raw.slice(i + 1, i + 6).toUpperCase() === 'UFFFC') { pushBlock(paragraph()); i += 6; continue; }
      // Not an escape we know, so a literal backslash — as unescapeString reads it.
      text += ch; i += 1; continue;
    }
    if (ch === BLOCK_MARKER) { pushBlock(paragraph()); i += 1; continue; }
    if (ch === BLOCK_OPEN || ch === MARK_OPEN) {
      const end = raw.indexOf(ch === BLOCK_OPEN ? BLOCK_CLOSE : MARK_CLOSE, i + 1);
      // Unterminated: just a character.
      if (end === -1) { text += ch; i += 1; continue; }
      const body = raw.slice(i + 1, end);
      i = end + 1;
      if (ch === BLOCK_OPEN) {
        const m = numbered(body, markers);
        pushBlock(m?.kind === 'block'
          ? { type: m.block.type, parents: [...(m.block.parents ?? [])], attrs: { ...(m.block.attrs ?? {}) } }
          : paragraph());
        continue;
      }
      const closing = body.startsWith('/');
      const m = numbered(closing ? body.slice(1) : body, markers);
      if (m?.kind !== 'mark') continue;
      if (!closing) { open.set(m, [...(open.get(m) ?? []), text.length]); continue; }
      const start = open.get(m)?.pop();
      if (start !== undefined && start < text.length) {
        out.push({ kind: 'mark', name: m.name, value: m.value, start, end: text.length });
      }
      continue;
    }
    text += ch; i += 1;
  }
  return { text, markers: out.sort(compareMarkers) };
}

/**
 * The ops for a saved edit of the markup: nothing when it is unchanged, else one
 * `updateSpans` carrying the whole field as the edit left it.
 */
export function markedTextOps(raw: string, text: string, markers: DocMarker[]): RichTextOp[] {
  if (raw === markedText(text, markers)) return [];
  const next = parseMarkedText(raw, markers);
  return [{ op: 'updateSpans', spans: spansFromMarkers(next.text, next.markers) }];
}
