/**
 * `get-version-changes` through the engine, against real Automerge — and the
 * heads fix underneath it: a version's heads are "changes 0..i applied", so a
 * concurrent branch's sibling is no longer reported as reverted (the bug the old
 * `[history[i].change.hash]` had). Harness as in all-rich-text-subscription.
 */
import * as A from '@automerge/automerge';
import { DriveEngine } from '../src/shared/drive-engine';

const FILTER = 'IDENTITY';

function makeEngine() {
  const kv = new Map<string, any>();
  const emitted: any[] = [];
  const engine = new DriveEngine({
    emit: (e: any) => emitted.push(e),
    kv: {
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: any) => { kv.set(k, structuredClone(v)); },
      del: async (k: string) => { kv.delete(k); },
      delPrefix: async () => {},
    },
  } as any);
  (engine as any).lastViewedHeads = {};
  (engine as any).jqCache.set(FILTER, (d: any) => JSON.parse(JSON.stringify(d)));
  (engine as any).Automerge = A;
  let nextId = 1;
  const ask = async (msg: Record<string, any>) => {
    const id = nextId++;
    await engine.handleMessage({ ...msg, id } as any);
    const r = emitted.find(x => x.type === 'result' && x.id === id);
    if (!r) throw new Error('no result for ' + msg.type);
    if (r.error) throw new Error(r.error);
    return r.result;
  };
  return { engine, emitted, ask };
}

function makeHandle(initial: any) {
  let doc = initial;
  return {
    handle: {
      on() {},
      isReady: () => true,
      whenReady: async () => {},
      doc: () => doc,
      heads: () => A.getHeads(doc),
      change(fn: (d: any) => void) { doc = A.change(doc, fn); },
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('get-version-changes', () => {
  it('describes a version with the old values', async () => {
    const { engine, ask } = makeEngine();
    let doc = A.from<any>({ '@type': 'TaskList', tasks: { a: { title: 'A' }, b: { title: 'B' } } });
    doc = A.change(doc, (d: any) => { d.tasks.a.title = 'A2'; delete d.tasks.b; });
    (engine as any).getOrCreateEntry('d1', makeHandle(doc).handle);

    const changes = await ask({ type: 'get-version-changes', docId: 'd1', version: 1 });
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ['tasks', 'a', 'title'], kind: 'changed', before: 'A', after: 'A2' }),
      expect.objectContaining({ path: ['tasks', 'b'], kind: 'removed', before: { title: 'B' } }),
    ]));
    // Version 0 is diffed against the empty document: everything is an addition.
    const first = await ask({ type: 'get-version-changes', docId: 'd1', version: 0 });
    expect(first.every((c: any) => c.kind === 'added')).toBe(true);
  });

  it('a concurrent branch is not reported as reverted', async () => {
    const { engine, ask } = makeEngine();
    let a = A.from<any>({ x: 0, y: 0 }, { actor: 'aaaa' });
    let b = A.clone(a, { actor: 'bbbb' });
    a = A.change(a, (d: any) => { d.x = 1; });
    b = A.change(b, (d: any) => { d.y = 1; });
    (engine as any).getOrCreateEntry('d1', makeHandle(A.merge(a, b)).handle);

    const changes = await ask({ type: 'get-version-changes', docId: 'd1', version: 2 });
    expect(changes.map((c: any) => c.path)).toEqual([[expect.any(String)]]);
    expect(changes[0]).toMatchObject({ kind: 'changed', before: 0, after: 1 });
    // The raw patches the source viewer lists come through the same heads.
    const patches = await ask({ type: 'debug-get-version-patches', docId: 'd1', version: 2 });
    expect(patches).toHaveLength(1);
  });

  it('get-doc-history lists every version with its time', async () => {
    const { engine, ask } = makeEngine();
    let doc = A.from<any>({ n: 0 });
    doc = A.change(doc, { time: 1_700_000_000 }, (d: any) => { d.n = 1; });
    (engine as any).getOrCreateEntry('d1', makeHandle(doc).handle);
    const history = await ask({ type: 'get-doc-history', docId: 'd1' });
    expect(history).toHaveLength(2);
    expect(history[1]).toEqual({ version: 1, time: 1_700_000_000 });
  });

  it('a pinned subscription delivers that version, and unpinning the live one', async () => {
    const { engine } = makeEngine();
    let doc = A.from<any>({ n: 0 });
    doc = A.change(doc, (d: any) => { d.n = 1; });
    doc = A.change(doc, (d: any) => { d.n = 2; });
    (engine as any).getOrCreateEntry('d1', makeHandle(doc).handle);

    const got: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => got.push(m));
    await tick();
    expect(got.at(-1).result.n).toBe(2);

    await engine.handleMessage({ type: 'set-doc-version', docId: 'd1', version: 1 } as any);
    await tick();
    expect(got.at(-1).result.n).toBe(1);

    await engine.handleMessage({ type: 'set-doc-version', docId: 'd1', version: null } as any);
    await tick();
    expect(got.at(-1).result.n).toBe(2);
  });
});
