/**
 * Rich-text (Peritext) operations that cross the worker boundary.
 *
 * The main thread cannot call Automerge's rich-text functions directly (the
 * repo lives in the worker), and `updateDoc` callbacks are serialized so they
 * can't close over anything. Editors therefore describe an edit as a list of
 * plain-JSON `RichTextOp`s and route them through the worker-provided
 * `richText` function (see WORKER_FNS in worker-api.ts), which the engine
 * substitutes with `applyRichTextOps` bound to its own Automerge module:
 *
 *   updateDoc(docId, (d, richText, ops) => richText(d, ['content'], ops), richText, ops);
 *
 * Indices address the flat text sequence where each block marker occupies one
 * position (the `￼` character in the JSON projection).
 */

export type MarkExpand = 'before' | 'after' | 'both' | 'none';

/**
 * The character a block marker occupies in the flat text — U+FFFC OBJECT
 * REPLACEMENT, which is what the JSON projection shows in place of the marker.
 * Lives here rather than in the Sentences plugin so the schema validator and the
 * source inspector can reason about markers without importing a doc plugin.
 */
export const BLOCK_MARKER = '￼';

/** A block marker's value: leaf type + nesting chain + type-specific attrs. */
export interface BlockValue {
  type: string;
  parents: string[];
  attrs?: Record<string, unknown>;
}

export type RichTextOp =
  | { op: 'splice'; index: number; del: number; text?: string }
  | { op: 'mark'; start: number; end: number; name: string; value: string | number | boolean; expand?: MarkExpand }
  | { op: 'unmark'; start: number; end: number; name: string; expand?: MarkExpand }
  | { op: 'splitBlock'; index: number; block: BlockValue }
  | { op: 'joinBlock'; index: number }
  | { op: 'updateBlock'; index: number; block: BlockValue }
  // Replace the whole field with these spans (Automerge diffs minimally, so
  // unchanged text keeps its CRDT identity) — used by Markdown import.
  | { op: 'updateSpans'; spans: RichTextSpan[] };

/**
 * Apply ops in order against a document open inside `handle.change()`.
 * `A` is the engine's Automerge module (injected — this module must not
 * import automerge itself, so the main-thread bundle never pulls the WASM in).
 */
export function applyRichTextOps(
  A: any,
  doc: any,
  path: (string | number)[],
  ops: RichTextOp[],
): void {
  for (const o of ops) {
    switch (o.op) {
      case 'splice':
        A.splice(doc, path, o.index, o.del, o.text ?? '');
        break;
      case 'mark':
        A.mark(doc, path, { start: o.start, end: o.end, expand: o.expand ?? 'after' }, o.name, o.value);
        break;
      case 'unmark':
        A.unmark(doc, path, { start: o.start, end: o.end, expand: o.expand ?? 'after' }, o.name);
        break;
      case 'splitBlock':
        A.splitBlock(doc, path, o.index, { type: o.block.type, parents: o.block.parents, attrs: o.block.attrs ?? {} });
        break;
      case 'joinBlock':
        A.joinBlock(doc, path, o.index);
        break;
      case 'updateBlock':
        A.updateBlock(doc, path, o.index, { type: o.block.type, parents: o.block.parents, attrs: o.block.attrs ?? {} });
        break;
      case 'updateSpans':
        A.updateSpans(doc, path, o.spans, { defaultExpand: 'after', perMarkExpand: { link: 'none' } });
        break;
    }
  }
}

/** The plain-JSON shape of `Automerge.spans()` output as delivered to query
 * subscribers (see `spansPath` in worker-protocol.ts). */
export type RichTextSpan =
  | { type: 'text'; value: string; marks?: Record<string, unknown> }
  | { type: 'block'; value: BlockValue & Record<string, unknown> };

// ---------------------------------------------------------------------------
// Markers — the discrete view of what `spans()` carries
//
// `spans()` reports formatting per text RUN, which is the right shape to render
// but the wrong shape to inspect or validate: one bold word split by a link
// arrives as three runs. These helpers re-derive the discrete markers — each
// mark as a single range, each block marker as a point — which is what the
// source inspector lists and what the schema validates.
// ---------------------------------------------------------------------------

export type DocMarker =
  | { kind: 'mark'; name: string; value: unknown; start: number; end: number }
  /** A block marker occupies exactly one position, so it has an index, not a range. */
  | { kind: 'block'; index: number; block: BlockValue };

/**
 * Discrete markers for a spans array, ordered by position.
 *
 * Adjacent runs merge into one mark only when the mark's VALUE matches too, so
 * two different links side by side stay two markers — the same rule
 * `markExtentAt` uses in the Sentences editor. The consequence, accepted there
 * and here, is that two abutting marks with an identical value are
 * indistinguishable from one and report as one.
 */
export function markersFromSpans(spans: RichTextSpan[]): DocMarker[] {
  const markers: DocMarker[] = [];
  /** Mark ranges still open at the current offset, keyed by mark name. */
  const open = new Map<string, { value: unknown; start: number }>();
  let index = 0;

  const closeAllExcept = (keep: (name: string, value: unknown) => boolean, at: number) => {
    for (const [name, o] of [...open]) {
      if (keep(name, o.value)) continue;
      markers.push({ kind: 'mark', name, value: o.value, start: o.start, end: at });
      open.delete(name);
    }
  };

  for (const s of spans) {
    if (s.type === 'block') {
      // A block marker carries no marks, so every open range ends before it.
      closeAllExcept(() => false, index);
      const { type, parents, attrs } = s.value as BlockValue;
      markers.push({
        kind: 'block', index,
        block: { type, parents: [...(parents ?? [])], attrs: { ...(attrs ?? {}) } },
      });
      index += 1;
      continue;
    }
    const marks = s.marks ?? {};
    closeAllExcept((name, value) => name in marks && marks[name] === value, index);
    for (const [name, value] of Object.entries(marks)) {
      if (!open.has(name)) open.set(name, { value, start: index });
    }
    index += s.value.length;
  }
  closeAllExcept(() => false, index);

  return markers.sort((a, b) => {
    const aStart = a.kind === 'block' ? a.index : a.start;
    const bStart = b.kind === 'block' ? b.index : b.start;
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = a.kind === 'block' ? a.index : a.end;
    const bEnd = b.kind === 'block' ? b.index : b.end;
    return aEnd - bEnd;
  });
}

/** The flat string as the JSON projection sees it (`￼` per block marker). */
export function flatTextFromSpans(spans: RichTextSpan[]): string {
  let out = '';
  for (const s of spans) out += s.type === 'block' ? BLOCK_MARKER : s.value;
  return out;
}

/**
 * Positions holding a literal `￼` CHARACTER rather than a real block marker.
 *
 * U+FFFC is never legitimate content — it exists in the JSON projection only as
 * the stand-in for a block marker. A literal one is the fingerprint of a
 * flattened Peritext field: something assigned the projection's flat string
 * straight back (`doc.content = text`), replacing the text object and turning
 * every marker into an ordinary character. The damage is invisible in the
 * projection, which looks byte-identical either way, so it has to be detected
 * from the spans.
 */
export function strayBlockMarkers(spans: RichTextSpan[]): number[] {
  const stray: number[] = [];
  let index = 0;
  for (const s of spans) {
    if (s.type === 'block') { index += 1; continue; }
    for (const ch of s.value) {
      if (ch === BLOCK_MARKER) stray.push(index);
      index += 1;
    }
  }
  return stray;
}

/**
 * Ops that turn `oldText` into `newText`, where both are the FLAT text (block
 * markers included as `￼`). A crude single-hunk diff: common prefix and suffix
 * are kept, everything between is deleted and re-inserted.
 *
 * Crude, but non-destructive where it matters — `splice` leaves the marks and
 * block markers outside the hunk alone, which a scalar `doc.field = text`
 * assignment would flatten away entirely. A `￼` inside the hunk is not a
 * character to splice: removing one is `joinBlock`, adding one is `splitBlock`.
 *
 * Deletions are emitted back to front so each op's index still addresses the
 * text the previous ops left behind; insertions then run front to back from the
 * end of the common prefix.
 */
export function flatTextEditOps(oldText: string, newText: string): RichTextOp[] {
  if (oldText === newText) return [];

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) suffix++;

  const removed = oldText.slice(prefix, oldText.length - suffix);
  const inserted = newText.slice(prefix, newText.length - suffix);
  const ops: RichTextOp[] = [];

  // Deletions, back to front.
  let runEnd = prefix + removed.length;
  for (let i = removed.length - 1; i >= 0; i--) {
    if (removed[i] !== BLOCK_MARKER) continue;
    const at = prefix + i;
    if (runEnd > at + 1) ops.push({ op: 'splice', index: at + 1, del: runEnd - (at + 1) });
    ops.push({ op: 'joinBlock', index: at });
    runEnd = at;
  }
  if (runEnd > prefix) ops.push({ op: 'splice', index: prefix, del: runEnd - prefix });

  // Insertions, front to back.
  let at = prefix;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    ops.push({ op: 'splice', index: at, del: 0, text: buf });
    at += buf.length;
    buf = '';
  };
  for (const ch of inserted) {
    if (ch === BLOCK_MARKER) {
      flush();
      ops.push({ op: 'splitBlock', index: at, block: { type: 'paragraph', parents: [], attrs: {} } });
      at += 1;
    } else buf += ch;
  }
  flush();

  return ops;
}

/**
 * Ops that change one marker into another, or delete it when `next` is null.
 *
 * Mark edits pass `expand: 'none'` rather than the engine's `'after'` default:
 * a range typed into an inspector is the range the caller means, and letting it
 * absorb adjacent typing would silently disagree with what was entered.
 */
export function markerEditOps(prev: DocMarker, next: DocMarker | null): RichTextOp[] {
  if (prev.kind === 'block') {
    if (!next) return [{ op: 'joinBlock', index: prev.index }];
    if (next.kind !== 'block') throw new Error('markerEditOps: cannot change a block marker into a mark');
    if (next.index === prev.index) return [{ op: 'updateBlock', index: prev.index, block: next.block }];
    // Moving a marker is a removal and a re-insertion. Removing the old one
    // shifts every later position down by one, so the target index has to be
    // read in the text the joinBlock leaves behind.
    return [
      { op: 'joinBlock', index: prev.index },
      {
        op: 'splitBlock',
        index: next.index > prev.index ? next.index - 1 : next.index,
        block: next.block,
      },
    ];
  }

  const unmark: RichTextOp = {
    op: 'unmark', start: prev.start, end: prev.end, name: prev.name, expand: 'none',
  };
  if (!next) return [unmark];
  if (next.kind !== 'mark') throw new Error('markerEditOps: cannot change a mark into a block marker');

  const ops: RichTextOp[] = [];
  // Re-marking the same name over the same range overwrites the value, so the
  // unmark is only needed when the old range would otherwise survive.
  if (next.name !== prev.name || next.start !== prev.start || next.end !== prev.end) ops.push(unmark);
  ops.push({
    op: 'mark', start: next.start, end: next.end,
    name: next.name, value: next.value as string | number | boolean, expand: 'none',
  });
  return ops;
}

/**
 * StringSyncHook (see sync-to-target.ts) that keeps version-restore from
 * flattening Peritext fields: a plain `d[key] = target[key]` would replace the
 * text object with a scalar string — literal `￼` chars, no marks, no blocks —
 * and mark-only differences would be skipped entirely (equal flat strings).
 * Instead, reconcile via `updateSpans` against the snapshot's real spans.
 * Plain-in-both-docs strings fall through to the default assignment.
 */
export function richTextAwareStringSync(A: any, targetDoc: any) {
  const rich = (spans: any[]): boolean =>
    spans.some(s => s.type === 'block' || (s.type === 'text' && s.marks && Object.keys(s.marks).length > 0));
  return (root: any, path: (string | number)[], _targetValue: string): boolean => {
    let targetSpans: any[];
    try { targetSpans = A.spans(targetDoc, path); } catch { return false; }
    let currentSpans: any[] = [];
    try { currentSpans = A.spans(root, path); } catch { /* not a text field on this side */ }
    if (!rich(targetSpans) && !rich(currentSpans)) return false;
    A.updateSpans(root, path, targetSpans);
    return true;
  };
}
