/**
 * What a version changed, against real Automerge: the patches `diff` emits,
 * walked over a plain mirror of the document before the version. Each case also
 * checks the mirror, patched forward, equals the document after — the proof the
 * hand-applied cases (map deletes, block markers, block properties) are right.
 */
import * as A from '@automerge/automerge';
import { buildHistoryIndex } from '../src/shared/history-index';
import {
  describeVersionChanges, itemChanges, removedItems, withGhosts, textRanges, summarizeChanges, valueAt,
  type VersionChange,
} from '../src/shared/version-changes';

/** The latest version of `doc`, described against the version before it. */
function latestChanges(doc: any): VersionChange[] {
  const idx = buildHistoryIndex(A as any, doc);
  const n = idx.heads.length;
  const before = n > 1 ? idx.heads[n - 2] : [];
  const patches = A.diff(doc, before, idx.heads[n - 1]);
  const mirror = before.length ? A.toJS(A.view(doc, before)) : {};
  const changes = describeVersionChanges(patches as any, mirror, (m, p) => A.applyPatch(m, p));
  expect(mirror).toEqual(A.toJS(doc));
  return changes;
}

const at = (changes: VersionChange[], path: (string | number)[]) =>
  changes.find(c => JSON.stringify(c.path) === JSON.stringify(path));

describe('describeVersionChanges', () => {
  it('a record: added, changed (with the old value) and removed (with the old item)', () => {
    let doc = A.from<any>({ '@type': 'TaskList', tasks: { a: { title: 'A' }, b: { title: 'B' } } });
    doc = A.change(doc, (d: any) => {
      d.tasks.c = { title: 'C' };
      d.tasks.a.title = 'A2';
      delete d.tasks.b;
    });
    const changes = latestChanges(doc);

    expect(at(changes, ['tasks', 'c'])?.kind).toBe('added');
    // A string assignment is one change, not a `put ''` plus a splice.
    expect(at(changes, ['tasks', 'c', 'title'])).toMatchObject({ kind: 'added', after: 'C' });
    expect(changes.filter(c => c.path[0] === 'tasks' && c.path[1] === 'c' && c.path[2] === 'title')).toHaveLength(1);
    expect(at(changes, ['tasks', 'a', 'title'])).toMatchObject({ kind: 'changed', before: 'A', after: 'A2' });
    expect(at(changes, ['tasks', 'b'])).toMatchObject({ kind: 'removed', before: { title: 'B' } });

    expect(itemChanges(changes, ['tasks'])).toEqual(new Map([['c', 'added'], ['a', 'changed'], ['b', 'removed']]));
    expect(removedItems(changes, ['tasks'])).toEqual([{ id: 'b', before: { title: 'B' } }]);
  });

  it('the first version adds everything', () => {
    const doc = A.from<any>({ '@type': 'Counter', n: 1 });
    const changes = latestChanges(doc);
    expect(changes.every(c => c.kind === 'added')).toBe(true);
    expect(at(changes, ['@type'])?.after).toBe('Counter');
  });

  it('a counter increment carries both values', () => {
    let doc = A.from<any>({ n: new A.Counter(1) });
    doc = A.change(doc, (d: any) => { d.n.increment(2); });
    expect(at(latestChanges(doc), ['n'])).toMatchObject({ kind: 'changed', action: 'inc', before: 1, after: 3 });
  });

  it('a list delete carries the removed slice', () => {
    let doc = A.from<any>({ tags: ['a', 'b', 'c'] });
    doc = A.change(doc, (d: any) => { d.tags.deleteAt(0, 2); });
    expect(at(latestChanges(doc), ['tags', 0])).toMatchObject({ kind: 'removed', before: ['a', 'b'], length: 2 });
  });
});

/** A Sentences-shaped doc: one paragraph marker, then text. */
function richDoc() {
  let doc = A.from<any>({ '@type': 'Sentences', content: '' });
  doc = A.change(doc, (d: any) => {
    A.splitBlock(d, ['content'], 0, { type: 'paragraph', parents: [], attrs: {} });
    A.splice(d, ['content'], 1, 0, 'Hello brave world');
  });
  return doc;
}

describe('text ranges', () => {
  it('a replacement is an added range plus a deletion point carrying the old text', () => {
    // Marker at 0, "Hello " 1–6, "brave" 7–11.
    const doc = A.change(richDoc(), (d: any) => { A.splice(d, ['content'], 7, 5, 'new'); });
    const changes = latestChanges(doc);
    expect(at(changes, ['content', 10])).toMatchObject({ kind: 'removed', before: 'brave' });
    expect(textRanges(changes, ['content'])).toEqual([
      { from: 7, to: 10, kind: 'added' },
      { from: 10, to: 10, kind: 'removed', before: 'brave' },
    ]);
  });

  it('a mark is a changed range', () => {
    const doc = A.change(richDoc(), (d: any) => {
      A.mark(d, ['content'], { start: 1, end: 6, expand: 'none' }, 'strong', true);
    });
    expect(textRanges(latestChanges(doc), ['content'])).toEqual([{ from: 1, to: 6, kind: 'changed' }]);
  });

  it('a new block is a block-level added range, its properties block-level changes', () => {
    const doc = A.change(richDoc(), (d: any) => {
      A.splitBlock(d, ['content'], 7, { type: 'paragraph', parents: [], attrs: {} });
    });
    const ranges = textRanges(latestChanges(doc), ['content']);
    expect(ranges[0]).toEqual({ from: 7, to: 8, kind: 'added', block: true });
    expect(ranges.slice(1).every(r => r.block && r.kind === 'changed' && r.from === 7)).toBe(true);
  });

  it('later edits shift and clip earlier ranges', () => {
    const typed = (i: number, text: string): VersionChange =>
      ({ path: ['content', i], kind: 'added', action: 'splice', after: text, length: text.length });
    const cut = (i: number, before: string): VersionChange =>
      ({ path: ['content', i], kind: 'removed', action: 'del', before, length: before.length });
    // Typing inside an added run grows it; typing before one shifts it.
    expect(textRanges([typed(5, 'abc'), typed(6, 'XY'), typed(0, '!')], ['content'])).toEqual([
      { from: 6, to: 11, kind: 'added' },
      { from: 7, to: 9, kind: 'added' },
      { from: 0, to: 1, kind: 'added' },
    ]);
    // Deleting the tail of an added run clips it.
    expect(textRanges([typed(0, 'abcde'), cut(3, 'de')], ['content'])).toEqual([
      { from: 0, to: 3, kind: 'added' },
      { from: 3, to: 3, kind: 'removed', before: 'de' },
    ]);
  });
});

describe('folds for the editors', () => {
  it('withGhosts puts removed items back for display only, skipping ones still present', () => {
    const { record, ghosts } = withGhosts({ a: 1 }, [{ id: 'b', before: 2 }, { id: 'a', before: 0 }]);
    expect(record).toEqual({ a: 1, b: 2 });
    expect([...ghosts]).toEqual(['b']);
    const untouched = { a: 1 };
    expect(withGhosts(untouched, []).record).toBe(untouched);
  });

  it('summarizeChanges counts items, not patches, and sees through DataGrid nesting', () => {
    const changes: VersionChange[] = [
      { path: ['name'], kind: 'changed', action: 'put' },
      { path: ['tasks', 'a', 'title'], kind: 'changed', action: 'put' },
      { path: ['tasks', 'a', 'due'], kind: 'added', action: 'put' },
      { path: ['tasks', 'b'], kind: 'removed', action: 'del' },
      { path: ['sheets', 's1', 'cells', 'r1:c1', 'value'], kind: 'changed', action: 'put' },
      { path: ['sheets', 's1', 'cells', 'r2:c1'], kind: 'added', action: 'put' },
    ];
    expect(summarizeChanges(changes)).toEqual({ added: 1, removed: 1, changed: 3 });
  });

  it('valueAt reads a path or gives undefined', () => {
    expect(valueAt({ a: { b: [1, 2] } }, ['a', 'b', 1])).toBe(2);
    expect(valueAt({ a: 1 }, ['a', 'b'])).toBeUndefined();
  });
});
