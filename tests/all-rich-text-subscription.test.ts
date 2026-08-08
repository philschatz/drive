/**
 * The `allRichText` subscription option, against REAL Automerge.
 *
 * The source inspector's markers exist nowhere in the jq projection, so this
 * one delivery is the only thing that puts them on screen. The jsdom test for
 * the inspector runs against the worker-api mock, whose spansStore already IS
 * the set of rich-text fields — so it cannot catch the engine failing to FIND
 * them. That is what this covers: the whole-document walk, the per-field
 * `spans()` call, and the change detection that has to fire for an edit the
 * projection cannot see.
 *
 * Harness mirrors tests/shared-filter-subscriptions.test.ts, but with the real
 * Automerge module rather than a stub — the walk calls `toJS` and `spans`.
 */

import * as A from '@automerge/automerge';
import { DriveEngine } from '../src/shared/drive-engine';

const FILTER = 'IDENTITY';

function makeEngine() {
  const kv = new Map<string, any>();
  const engine = new DriveEngine({
    emit: () => {},
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
  return engine;
}

function makeHandle(initial: any) {
  const listeners: Record<string, Array<() => void>> = {};
  let doc = initial;
  return {
    handle: {
      on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); },
      isReady: () => true,
      whenReady: async () => {},
      doc: () => doc,
      heads: () => A.getHeads(doc),
    },
    change(fn: (d: any) => void) { doc = A.change(doc, fn); },
    fireChange() { for (const cb of listeners['change'] ?? []) cb(); },
  };
}

/** A Sentences-shaped doc: a heading marker, a bold run, then plain text. */
function richDoc() {
  let doc = A.from({ '@type': 'Sentences', name: 'Notes', content: '' });
  doc = A.change(doc, (d: any) => {
    A.splitBlock(d, ['content'], 0, { type: 'heading', parents: [], attrs: { level: 1 } });
    A.splice(d, ['content'], 1, 0, 'Hello world');
    A.mark(d, ['content'], { start: 1, end: 6, expand: 'after' }, 'strong', true);
  });
  return doc;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const posts = (all: any[]) => all.filter(p => !p.error);

describe('allRichText subscriptions', () => {
  it('delivers every marker-bearing field, and only those', async () => {
    const engine = makeEngine();
    const { handle } = makeHandle(richDoc());
    (engine as any).getOrCreateEntry('d1', handle);

    const got: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => got.push(m), true, false, undefined, true);
    await tick();

    const last = posts(got).at(-1);
    expect(last).toBeDefined();
    // `content` carries a block marker and a mark; `name` and `@type` are plain
    // strings and must not be reported, or every field of every doc would be.
    expect(last.richTextFields.map((f: any) => f.path)).toEqual([['content']]);
    expect(last.richTextFields[0].spans).toEqual([
      { type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { type: 'text', value: 'Hello', marks: { strong: true } },
      { type: 'text', value: ' world' },
    ]);
  });

  it('reports nothing for a document with no markers', async () => {
    const engine = makeEngine();
    const { handle } = makeHandle(A.from({ '@type': 'TaskList', name: 'Plain', tasks: {} }));
    (engine as any).getOrCreateEntry('d1', handle);

    const got: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => got.push(m), true, false, undefined, true);
    await tick();

    expect(posts(got).at(-1).richTextFields).toEqual([]);
  });

  it('pushes a mark-only edit, which the jq projection cannot see', async () => {
    const engine = makeEngine();
    const { handle, change, fireChange } = makeHandle(richDoc());
    (engine as any).getOrCreateEntry('d1', handle);

    const got: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => got.push(m), true, false, undefined, true);
    await tick();
    const before = posts(got).length;

    // Bolding more text changes no character, so `changed` stays false and only
    // the marker comparison can trigger the push.
    change((d: any) => A.mark(d, ['content'], { start: 6, end: 12, expand: 'none' }, 'strong', true));
    fireChange();
    await tick();

    expect(posts(got).length).toBeGreaterThan(before);
    expect(posts(got).at(-1).richTextFields[0].spans).toEqual([
      { type: 'block', value: { type: 'heading', parents: [], attrs: { level: 1 } } },
      { type: 'text', value: 'Hello world', marks: { strong: true } },
    ]);
  });

  it('does not send richTextFields to a subscription that did not ask', async () => {
    const engine = makeEngine();
    const { handle } = makeHandle(richDoc());
    (engine as any).getOrCreateEntry('d1', handle);

    const got: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => got.push(m), true);
    await tick();

    expect(posts(got).at(-1)).not.toHaveProperty('richTextFields');
  });
});
