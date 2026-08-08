/**
 * Pure-JS emulation of Automerge's Peritext span model — apply `RichTextOp`s to
 * a spans array without the WASM module. Used for the editor's optimistic local
 * echo (the authoritative spans arrive from the worker a beat later) and to
 * back the jsdom worker-api mock. A node-Jest parity test keeps this in line
 * with real Automerge for the op sequences the editor emits.
 *
 * Indices address the flat text where each block marker occupies one position,
 * exactly like `Automerge.splice` on a text field with blocks.
 */
import type { BlockValue, RichTextOp, RichTextSpan } from '../../../../shared/rich-text-ops';
import { BLOCK_MARKER } from '../../../../shared/rich-text-ops';

// Both live in shared/rich-text-ops.ts so the schema validator and the source
// inspector can reason about block markers without importing a doc plugin.
export { BLOCK_MARKER, flatTextFromSpans } from '../../../../shared/rich-text-ops';

/** One character of the text sequence: a block marker or a marked-up char. */
interface Atom {
  ch: string;
  marks: Record<string, unknown> | null;
  block?: BlockValue;
}

function markKey(marks: Record<string, unknown> | null): string {
  if (!marks) return '';
  const keys = Object.keys(marks).sort();
  return JSON.stringify(keys.map(k => [k, marks[k]]));
}

function atomsFromSpans(spans: RichTextSpan[]): Atom[] {
  const atoms: Atom[] = [];
  for (const s of spans) {
    if (s.type === 'block') {
      const { type, parents, attrs } = s.value as BlockValue;
      atoms.push({ ch: BLOCK_MARKER, marks: null, block: { type, parents: [...(parents ?? [])], attrs: { ...(attrs ?? {}) } } });
    } else {
      const marks = s.marks && Object.keys(s.marks).length > 0 ? s.marks : null;
      for (const ch of s.value) atoms.push({ ch, marks });
    }
  }
  return atoms;
}

function spansFromAtoms(atoms: Atom[]): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  let run: { text: string; marks: Record<string, unknown> | null; key: string } | null = null;
  const flush = () => {
    if (run) {
      spans.push(run.marks ? { type: 'text', value: run.text, marks: run.marks } : { type: 'text', value: run.text });
      run = null;
    }
  };
  for (const a of atoms) {
    if (a.block) {
      flush();
      spans.push({ type: 'block', value: { type: a.block.type, parents: [...a.block.parents], attrs: { ...(a.block.attrs ?? {}) } } });
    } else {
      const key = markKey(a.marks);
      if (run && run.key === key) run.text += a.ch;
      else { flush(); run = { text: a.ch, marks: a.marks ? { ...a.marks } : null, key }; }
    }
  }
  flush();
  return spans;
}

/**
 * Marks inherited by text inserted at `index` — Automerge's default expansion
 * for the marks this editor uses: strong/em expand `after` (typing at the end
 * of a bold run continues bold), links never expand.
 */
function inheritedMarks(atoms: Atom[], index: number): Record<string, unknown> | null {
  const prev = atoms[index - 1];
  if (!prev || prev.block || !prev.marks) return null;
  const marks: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prev.marks)) {
    if (k === 'link') continue;
    marks[k] = v;
  }
  return Object.keys(marks).length > 0 ? marks : null;
}

/** Apply ops to a spans array, returning the new spans (input untouched). */
export function applyOpsToSpans(spans: RichTextSpan[], ops: RichTextOp[]): RichTextSpan[] {
  let atoms = atomsFromSpans(spans);
  for (const o of ops) {
    switch (o.op) {
      case 'splice': {
        const marks = inheritedMarks(atoms, o.index);
        const inserted: Atom[] = [...(o.text ?? '')].map(ch => ({ ch, marks: marks ? { ...marks } : null }));
        atoms.splice(o.index, o.del, ...inserted);
        break;
      }
      case 'mark': {
        for (let i = o.start; i < o.end && i < atoms.length; i++) {
          const a = atoms[i];
          if (a.block) continue;
          a.marks = { ...(a.marks ?? {}), [o.name]: o.value };
        }
        break;
      }
      case 'unmark': {
        for (let i = o.start; i < o.end && i < atoms.length; i++) {
          const a = atoms[i];
          if (a.block || !a.marks) continue;
          const { [o.name]: _gone, ...rest } = a.marks;
          a.marks = Object.keys(rest).length > 0 ? rest : null;
        }
        break;
      }
      case 'splitBlock':
        atoms.splice(o.index, 0, {
          ch: BLOCK_MARKER, marks: null,
          block: { type: o.block.type, parents: [...o.block.parents], attrs: { ...(o.block.attrs ?? {}) } },
        });
        break;
      case 'joinBlock':
        if (atoms[o.index]?.block) atoms.splice(o.index, 1);
        break;
      case 'updateBlock': {
        const a = atoms[o.index];
        if (a?.block) a.block = { type: o.block.type, parents: [...o.block.parents], attrs: { ...(o.block.attrs ?? {}) } };
        break;
      }
      case 'updateSpans':
        atoms = atomsFromSpans(o.spans);
        break;
    }
  }
  return spansFromAtoms(atoms);
}

/**
 * Where a cursor at `pos` lands after `ops` are applied — the emulation of
 * `Automerge.getCursorPosition` that lets the jsdom mock rebase a caret.
 * Mirrors Automerge's default `move: 'after'`, which the parity test pins:
 *
 * - insert of `L` at `i` shifts when `i <= pos` (text inserted *at* a cursor
 *   lands before it, so the cursor is pushed right)
 * - delete of `[i, i+d)` leaves `pos <= i` alone, shifts `pos >= i+d` back, and
 *   collapses a position inside the range to `i` (resolve toward `length`)
 * - a block marker is one character, so splitBlock/joinBlock are insert/delete of 1
 *
 * Returns null for `updateSpans`, which is a DELIBERATE divergence: Automerge
 * diffs it minimally and so really does keep the cursor (a 3-char prefix moves
 * 6 → 9), but reproducing that diff here is not worth it. The emulation is
 * pessimistic — a jsdom test sees "caret not rebased" where the real engine
 * rebases. `updateSpans` only fires on Markdown import and version restore.
 */
export function shiftPositionThroughOps(pos: number, ops: RichTextOp[]): number | null {
  let p = pos;
  const del = (i: number, d: number) => {
    if (d <= 0) return;
    if (p <= i) return;
    p = p >= i + d ? p - d : i;
  };
  const ins = (i: number, len: number) => {
    if (len > 0 && i <= p) p += len;
  };
  for (const o of ops) {
    switch (o.op) {
      case 'splice':
        // Automerge deletes at `index` first, then inserts there.
        del(o.index, o.del);
        ins(o.index, (o.text ?? '').length);
        break;
      case 'splitBlock':
        ins(o.index, 1);
        break;
      case 'joinBlock':
        del(o.index, 1);
        break;
      case 'updateSpans':
        return null;
      // mark/unmark/updateBlock change no positions.
    }
  }
  return p;
}

/** Spans for a flat string that carries `￼` block markers but no mark info —
 * how the mock seeds spans for a doc set via plain `__setDoc`. */
export function spansFromFlatText(text: string): RichTextSpan[] {
  const spans: RichTextSpan[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === BLOCK_MARKER) {
      if (buf) { spans.push({ type: 'text', value: buf }); buf = ''; }
      spans.push({ type: 'block', value: { type: 'paragraph', parents: [], attrs: {} } });
    } else buf += ch;
  }
  if (buf) spans.push({ type: 'text', value: buf });
  return spans;
}
