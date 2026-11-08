/**
 * A stand-in for the Automerge module for engine tests that never read a
 * document's content: the surface the engine's history index needs, driven by
 * a mutable list of `{ change: { time, hash } }` entries (push one to "make a
 * change"). Each change depends on the previous one, so the heads are always
 * the last hash — which is also what makes the engine's per-doc index rebuild.
 */
export interface StubHistoryEntry { change: { time: number; hash: string } }

export function stubAutomerge(history: StubHistoryEntry[]) {
  return {
    getAllChanges: () => history.map((_, i) => i),
    decodeChange: (i: number) => ({
      hash: history[i].change.hash,
      deps: i > 0 ? [history[i - 1].change.hash] : [],
      time: history[i].change.time,
    }),
    getHeads: () => (history.length ? [history[history.length - 1].change.hash] : []),
    view: (doc: any) => doc,
  };
}
