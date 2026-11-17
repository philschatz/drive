/**
 * The heads of every version of a document, computed once per set of live heads.
 *
 * `Automerge.getHistory` hands back lazy entries: reading `.snapshot` replays the
 * document from its first change, and `.change` decodes again on every access.
 * Everything history mode needs — a version's timestamp, and the heads that
 * identify "changes 0..i applied" so `view`/`diff` can address it without a
 * replay — comes from one pass over the changes: a change stops its deps being
 * heads and becomes one itself.
 *
 * Note `[history[i].change.hash]` is NOT those heads when history has concurrent
 * branches (it names change i and its ancestors only); diffing between single
 * hashes reports a branch's siblings as reverts.
 */

export interface HistoryIndex {
  /** Sorted, comma-joined live heads the index was built for. */
  headsKey: string;
  /** Change timestamps (epoch seconds), one per version. */
  times: number[];
  /** Heads of each version: the state with changes 0..i applied. */
  heads: string[][];
}

interface ChangeMeta { hash: string; deps: string[]; time: number }

export interface HistoryAutomerge {
  getAllChanges(doc: any): Uint8Array[];
  decodeChange(change: Uint8Array): ChangeMeta;
  getHeads(doc: any): string[];
  /**
   * Change metadata without the ops, in the same order as `getAllChanges`.
   * Optional because the Automerge test stub lacks it. Prefer it: `decodeChange`
   * materialises every op, so a document holding long text (a diary's stories,
   * a timeline's thumbnails) spent seconds per change rebuilding this index —
   * 4.6 s against 22 ms for 1,000 entries of ~1,200 characters.
   */
  getChangesMetaSince?(doc: any, since: string[]): ChangeMeta[];
}

export const headsKeyOf = (heads: string[]): string => [...heads].sort().join(',');

export function buildHistoryIndex(A: HistoryAutomerge, doc: any): HistoryIndex {
  const times: number[] = [];
  const heads: string[][] = [];
  const current = new Set<string>();
  const metas: Iterable<ChangeMeta> = A.getChangesMetaSince
    ? A.getChangesMetaSince(doc, [])
    : A.getAllChanges(doc).map(bytes => A.decodeChange(bytes));
  for (const c of metas) {
    for (const d of c.deps) current.delete(d);
    current.add(c.hash);
    heads.push([...current].sort());
    times.push(c.time);
  }
  return { headsKey: headsKeyOf(A.getHeads(doc)), times, heads };
}
