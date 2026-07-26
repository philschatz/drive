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
