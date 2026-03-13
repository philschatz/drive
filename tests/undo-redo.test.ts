import * as Automerge from '@automerge/automerge';
import { toPlain, syncToTarget } from '../src/shared/sync-to-target';

// Helper: perform a full undo/redo restore cycle using Automerge.view + syncToTarget
// (mirrors what the hook does via handle.view().doc() + handle.change())
function restoreToHeads<T>(doc: Automerge.Doc<T>, targetHeads: Automerge.Heads): Automerge.Doc<T> {
  const target = Automerge.view(doc, targetHeads);
  return Automerge.change(doc, (d: any) => syncToTarget(d, target));
}

// ── toPlain ──────────────────────────────────────────────────────────────────

describe('toPlain', () => {
  it('passes through primitives', () => {
    expect(toPlain(42)).toBe(42);
    expect(toPlain('hello')).toBe('hello');
    expect(toPlain(true)).toBe(true);
    expect(toPlain(null)).toBe(null);
    expect(toPlain(undefined)).toBe(undefined);
  });

  it('deep-copies plain objects', () => {
    const obj = { a: 1, b: { c: 'x' } };
    const result = toPlain(obj);
    expect(result).toEqual(obj);
    expect(result).not.toBe(obj);
    expect(result.b).not.toBe(obj.b);
  });

  it('deep-copies arrays', () => {
    const arr = [1, { x: 2 }, [3]];
    const result = toPlain(arr);
    expect(result).toEqual(arr);
    expect(result).not.toBe(arr);
  });

  it('copies Date instances', () => {
    const d = new Date('2025-01-01');
    const result = toPlain(d);
    expect(result).toEqual(d);
    expect(result).not.toBe(d);
  });

  it('copies Uint8Array instances', () => {
    const buf = new Uint8Array([1, 2, 3]);
    const result = toPlain(buf);
    expect(result).toEqual(buf);
    expect(result).not.toBe(buf);
  });

  it('converts Automerge doc values to plain JS', () => {
    const doc = Automerge.from({ items: { a: { value: 'hello' } } });
    const plain = toPlain(doc.items);
    expect(plain).toEqual({ a: { value: 'hello' } });
    // Should be a plain object, not an Automerge proxy
    expect(JSON.stringify(plain)).toBe('{"a":{"value":"hello"}}');
  });
});

// ── syncToTarget ─────────────────────────────────────────────────────────────

describe('syncToTarget', () => {
  it('adds new scalar properties', () => {
    let doc = Automerge.from({ x: 1 } as any);
    doc = Automerge.change(doc, (d: any) => {
      const target = { x: 1, y: 2 };
      syncToTarget(d, target);
    });
    expect(Automerge.toJS(doc)).toEqual({ x: 1, y: 2 });
  });

  it('removes deleted properties', () => {
    let doc = Automerge.from({ x: 1, y: 2 } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { x: 1 });
    });
    expect(Automerge.toJS(doc)).toEqual({ x: 1 });
  });

  it('updates changed scalars', () => {
    let doc = Automerge.from({ x: 1 } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { x: 99 });
    });
    expect(Automerge.toJS(doc)).toEqual({ x: 99 });
  });

  it('skips unchanged scalars (no-op)', () => {
    let doc = Automerge.from({ x: 1 } as any);
    const heads1 = Automerge.getHeads(doc);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { x: 1 });
    });
    // Automerge should detect no actual changes
    expect(Automerge.getHeads(doc)).toEqual(heads1);
  });

  it('recurses into nested objects', () => {
    let doc = Automerge.from({ nested: { a: 1, b: 2 } } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { nested: { a: 1, b: 99 } });
    });
    expect(Automerge.toJS(doc)).toEqual({ nested: { a: 1, b: 99 } });
  });

  it('creates nested objects that did not exist', () => {
    let doc = Automerge.from({ cells: {} } as any);
    doc = Automerge.change(doc, (d: any) => {
      const target = { cells: { 'r1:c1': { value: 'hello' } } };
      syncToTarget(d, target);
    });
    expect(Automerge.toJS(doc)).toEqual({ cells: { 'r1:c1': { value: 'hello' } } });
  });

  it('deletes nested objects', () => {
    let doc = Automerge.from({ cells: { a: { value: 'x' }, b: { value: 'y' } } } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { cells: { b: { value: 'y' } } });
    });
    expect(Automerge.toJS(doc)).toEqual({ cells: { b: { value: 'y' } } });
  });

  it('handles null values', () => {
    let doc = Automerge.from({ x: 'hello' } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { x: null });
    });
    expect(Automerge.toJS(doc)).toEqual({ x: null });
  });

  it('replaces object with scalar', () => {
    let doc = Automerge.from({ x: { nested: 1 } } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { x: 42 });
    });
    expect(Automerge.toJS(doc)).toEqual({ x: 42 });
  });

  it('replaces scalar with object', () => {
    let doc = Automerge.from({ x: 42 } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { x: { nested: 1 } });
    });
    expect(Automerge.toJS(doc)).toEqual({ x: { nested: 1 } });
  });

  it('replaces arrays', () => {
    let doc = Automerge.from({ items: [1, 2, 3] } as any);
    doc = Automerge.change(doc, (d: any) => {
      syncToTarget(d, { items: [4, 5] });
    });
    expect(Automerge.toJS(doc)).toEqual({ items: [4, 5] });
  });
});

// ── Full undo/redo cycle ─────────────────────────────────────────────────────

describe('undo/redo cycle', () => {
  it('undoes and redoes a single cell edit', () => {
    let doc = Automerge.from({ cells: {} } as any);
    const H0 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => {
      d.cells['a'] = {}; d.cells['a'].value = 'hello';
    });
    const H1 = Automerge.getHeads(doc);

    // Undo
    doc = restoreToHeads(doc, H0);
    expect(Automerge.toJS(doc)).toEqual({ cells: {} });

    // Redo
    doc = restoreToHeads(doc, H1);
    expect(Automerge.toJS(doc)).toEqual({ cells: { a: { value: 'hello' } } });
  });

  it('undoes and redoes editing an existing value', () => {
    let doc = Automerge.from({ cells: { a: { value: 'old' } } } as any);
    const H0 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { d.cells['a'].value = 'new'; });
    const H1 = Automerge.getHeads(doc);

    doc = restoreToHeads(doc, H0);
    expect((Automerge.toJS(doc) as any).cells.a.value).toBe('old');

    doc = restoreToHeads(doc, H1);
    expect((Automerge.toJS(doc) as any).cells.a.value).toBe('new');
  });

  it('undoes and redoes cell deletion', () => {
    let doc = Automerge.from({ cells: { a: { value: 'X' }, b: { value: 'Y' } } } as any);
    const H0 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { delete d.cells['a']; });
    const H1 = Automerge.getHeads(doc);

    // Undo deletion
    doc = restoreToHeads(doc, H0);
    expect(Automerge.toJS(doc)).toEqual({ cells: { a: { value: 'X' }, b: { value: 'Y' } } });

    // Redo deletion
    doc = restoreToHeads(doc, H1);
    expect(Automerge.toJS(doc)).toEqual({ cells: { b: { value: 'Y' } } });
  });

  it('handles multiple sequential undos and redos', () => {
    let doc = Automerge.from({ cells: {} } as any);
    const H0 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { d.cells['a'] = {}; d.cells['a'].value = 'A'; });
    const H1 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { d.cells['b'] = {}; d.cells['b'].value = 'B'; });
    const H2 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { d.cells['c'] = {}; d.cells['c'].value = 'C'; });
    const H3 = Automerge.getHeads(doc);

    // Undo all three
    doc = restoreToHeads(doc, H2);
    expect(Object.keys((Automerge.toJS(doc) as any).cells)).toEqual(['a', 'b']);

    doc = restoreToHeads(doc, H1);
    expect(Object.keys((Automerge.toJS(doc) as any).cells)).toEqual(['a']);

    doc = restoreToHeads(doc, H0);
    expect((Automerge.toJS(doc) as any).cells).toEqual({});

    // Redo all three
    doc = restoreToHeads(doc, H1);
    expect(Object.keys((Automerge.toJS(doc) as any).cells)).toEqual(['a']);

    doc = restoreToHeads(doc, H2);
    expect(Object.keys((Automerge.toJS(doc) as any).cells)).toEqual(['a', 'b']);

    doc = restoreToHeads(doc, H3);
    expect(Object.keys((Automerge.toJS(doc) as any).cells)).toEqual(['a', 'b', 'c']);
  });

  it('restores complex nested structures', () => {
    let doc = Automerge.from({
      columns: { c1: { index: 0, name: 'Col A' } },
      rows: { r1: { index: 0 } },
      cells: { 'r1:c1': { value: '42' } },
    } as any);
    const H0 = Automerge.getHeads(doc);

    // Add a column, row, and cell
    doc = Automerge.change(doc, (d: any) => {
      d.columns['c2'] = { index: 1, name: 'Col B' };
      d.rows['r2'] = { index: 1 };
      d.cells['r2:c2'] = { value: '99' };
    });
    const H1 = Automerge.getHeads(doc);

    // Undo
    doc = restoreToHeads(doc, H0);
    const js0 = Automerge.toJS(doc) as any;
    expect(Object.keys(js0.columns)).toEqual(['c1']);
    expect(Object.keys(js0.rows)).toEqual(['r1']);
    expect(Object.keys(js0.cells)).toEqual(['r1:c1']);

    // Redo
    doc = restoreToHeads(doc, H1);
    const js1 = Automerge.toJS(doc) as any;
    expect(js1.columns['c2']).toEqual({ index: 1, name: 'Col B' });
    expect(js1.rows['r2']).toEqual({ index: 1 });
    expect(js1.cells['r2:c2']).toEqual({ value: '99' });
  });

  it('handles undo after redo (re-undo)', () => {
    let doc = Automerge.from({ x: 'initial' } as any);
    const H0 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { d.x = 'changed'; });
    const H1 = Automerge.getHeads(doc);

    // Undo
    doc = restoreToHeads(doc, H0);
    expect((Automerge.toJS(doc) as any).x).toBe('initial');

    // Redo
    doc = restoreToHeads(doc, H1);
    expect((Automerge.toJS(doc) as any).x).toBe('changed');

    // Undo again
    doc = restoreToHeads(doc, H0);
    expect((Automerge.toJS(doc) as any).x).toBe('initial');
  });

  it('preserves unrelated data during restore', () => {
    let doc = Automerge.from({ cells: { a: { value: 'keep' } }, name: 'My Grid' } as any);
    const H0 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { d.cells['b'] = { value: 'new' }; });

    doc = restoreToHeads(doc, H0);
    const js = Automerge.toJS(doc) as any;
    expect(js.name).toBe('My Grid');
    expect(js.cells.a.value).toBe('keep');
    expect(js.cells.b).toBeUndefined();
  });

  it('works with array values', () => {
    let doc = Automerge.from({ tags: ['a', 'b'] } as any);
    const H0 = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (d: any) => { d.tags = ['x', 'y', 'z']; });
    const H1 = Automerge.getHeads(doc);

    doc = restoreToHeads(doc, H0);
    expect((Automerge.toJS(doc) as any).tags).toEqual(['a', 'b']);

    doc = restoreToHeads(doc, H1);
    expect((Automerge.toJS(doc) as any).tags).toEqual(['x', 'y', 'z']);
  });
});
