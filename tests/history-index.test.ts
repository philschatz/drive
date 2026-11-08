import * as A from '@automerge/automerge';
import { buildHistoryIndex, headsKeyOf } from '../src/shared/history-index';

/** Each version's heads must name the same state `getHistory(...).snapshot` holds. */
function expectMatchesHistory(doc: any) {
  const idx = buildHistoryIndex(A as any, doc);
  const history = A.getHistory(doc);
  expect(idx.heads.length).toBe(history.length);
  history.forEach((h, i) => {
    expect(idx.heads[i]).toEqual([...A.getHeads(h.snapshot)].sort());
    expect(idx.times[i]).toBe(h.change.time);
  });
  expect(idx.headsKey).toBe(headsKeyOf(A.getHeads(doc)));
  expect(idx.heads[idx.heads.length - 1].join(',')).toBe(idx.headsKey);
}

describe('buildHistoryIndex', () => {
  it('a linear history: one head per version', () => {
    let doc = A.from<any>({ n: 0 });
    for (let i = 1; i <= 4; i++) doc = A.change(doc, (d: any) => { d.n = i; });
    expectMatchesHistory(doc);
    expect(buildHistoryIndex(A as any, doc).heads.every(h => h.length === 1)).toBe(true);
  });

  it('concurrent branches: the merge version has two heads, and neither branch loses its sibling', () => {
    let a = A.from<any>({ x: 0, y: 0 }, { actor: 'aaaa' });
    let b = A.clone(a, { actor: 'bbbb' });
    a = A.change(a, (d: any) => { d.x = 1; });
    b = A.change(b, (d: any) => { d.y = 1; });
    const merged = A.merge(a, b);
    expectMatchesHistory(merged);
    const idx = buildHistoryIndex(A as any, merged);
    expect(idx.heads[2].length).toBe(2);
    // Diffing between the versions' real heads reports only what the version did.
    const patches = A.diff(merged, idx.heads[1], idx.heads[2]);
    expect(patches.map(p => p.path[0])).toHaveLength(1);
  });

  it('an empty document has no versions', () => {
    const idx = buildHistoryIndex(A as any, A.init());
    expect(idx.heads).toEqual([]);
    expect(idx.times).toEqual([]);
  });
});
