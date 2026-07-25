/**
 * "New changes since last viewed" seen-state machine.
 *
 * A doc is being VIEWED while it has ≥1 live non-peek query subscription; while
 * viewed, every change re-records its last-viewed heads (mirrored in
 * this.lastViewedHeads and persisted to device-local IDB), so remote edits
 * arriving mid-view count as seen. Docs with only peek subscriptions (home
 * summary, source inspector, HyperFormula bridge) flip the
 * `unseen-changes-updated` flag on instead. Missing record = never viewed.
 *
 * These tests exercise the machine's observable behaviour — the in-memory
 * lastViewedHeads working copy and the unseen-changes emissions. Persistence
 * (host.kv.set on KEYS.lastViewedHeads) runs against the in-memory Map kv here.
 */

import { DriveEngine, headsEqual } from '../src/shared/drive-engine';

/** In-memory KV + emit recorder standing in for the EngineHost. */
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
  // Skip init(): seed the pieces the seen-state machine needs directly.
  (engine as any).lastViewedHeads = {};
  (engine as any).Automerge = { getHistory: () => [] };
  const unseenEvents = () => emitted.filter((e) => e.type === 'unseen-changes-updated');
  const viewedHeads = () => (engine as any).lastViewedHeads;
  return { engine, kv, emitted, unseenEvents, viewedHeads };
}

/** Minimal automerge-repo handle: mutable heads + a change trigger. */
function makeHandle(initialHeads: string[]) {
  const listeners: Record<string, Array<() => void>> = {};
  const handle = {
    heads: [...initialHeads],
    on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); },
    isReady: () => true,
    whenReady: async () => {},
    doc: () => ({ '@type': 'TaskList' }),
  };
  return {
    handle: {
      on: handle.on.bind(handle),
      isReady: handle.isReady,
      whenReady: handle.whenReady,
      doc: handle.doc,
      heads: () => [...handle.heads],
    },
    setHeads(h: string[]) { handle.heads = [...h]; },
    fireChange() { for (const cb of listeners['change'] ?? []) cb(); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('headsEqual', () => {
  it('is order-insensitive', () => {
    expect(headsEqual(['b', 'a'], ['a', 'b'])).toBe(true);
  });
  it('a missing record never equals', () => {
    expect(headsEqual(undefined, [])).toBe(false);
    expect(headsEqual(undefined, ['a'])).toBe(false);
  });
  it('rejects length and content mismatches', () => {
    expect(headsEqual(['a'], ['a', 'b'])).toBe(false);
    expect(headsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('seen-state machine', () => {
  it('records heads (sorted) and emits seen on a non-peek subscribe of a ready doc', async () => {
    const { engine, unseenEvents, viewedHeads } = makeEngine();
    const { handle } = makeHandle(['h2', 'h1']);
    (engine as any).getOrCreateEntry('d1', handle);
    await engine.subscribeQuery('d1', 1, '.', () => {});
    await tick();

    expect(viewedHeads()).toEqual({ d1: ['h1', 'h2'] });
    const events = unseenEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].unseen).toEqual({ d1: false });
  });

  it('keeps last-viewed current on changes while a non-peek sub is live (stays seen)', async () => {
    const { engine, unseenEvents, viewedHeads } = makeEngine();
    const { handle, setHeads, fireChange } = makeHandle(['h1']);
    (engine as any).getOrCreateEntry('d1', handle);
    await engine.subscribeQuery('d1', 1, '.', () => {});
    await tick();

    setHeads(['h2']);
    fireChange();
    await tick();

    expect(viewedHeads()).toEqual({ d1: ['h2'] });
    // The doc ends (and stays) seen; earlier events may include the transient
    // unknown→true flip while the subscription was still attaching.
    const events = unseenEvents();
    expect(events[events.length - 1].unseen).toEqual({ d1: false });
  });

  it('flips unseen on a change seen only through a peek sub, emitting once (transition-only)', async () => {
    const { engine, unseenEvents, viewedHeads } = makeEngine();
    const { handle, setHeads, fireChange } = makeHandle(['h1']);
    (engine as any).lastViewedHeads = { d1: ['h1'] }; // previously viewed at h1
    (engine as any).getOrCreateEntry('d1', handle);
    await engine.subscribeQuery('d1', 1, '.', () => {}, true); // peek
    await tick();
    // Heads match the record → the doc resolves from unknown to known-seen.
    expect(unseenEvents()).toEqual([{ type: 'unseen-changes-updated', unseen: { d1: false } }]);

    setHeads(['h2']);
    fireChange();
    await tick();
    setHeads(['h3']);
    fireChange();
    await tick();

    const events = unseenEvents();
    expect(events).toHaveLength(2); // two changes, one transition
    expect(events[1].unseen).toEqual({ d1: true });
    expect(viewedHeads()).toEqual({ d1: ['h1'] }); // peek never re-records
  });

  it('marks a never-viewed doc unseen once its entry loads', async () => {
    const { engine, unseenEvents } = makeEngine();
    const { handle } = makeHandle(['h1']);
    (engine as any).getOrCreateEntry('d1', handle); // no subs at all
    await tick();

    const events = unseenEvents();
    expect(events).toHaveLength(1);
    expect(events[0].unseen).toEqual({ d1: true });
  });

  it('one-shot query marks viewed unless peek', async () => {
    const { engine, emitted, viewedHeads } = makeEngine();
    const { handle } = makeHandle(['h1']);
    (engine as any).getOrCreateEntry('d1', handle);
    await tick();

    await engine.handleMessage({ type: 'query', id: 1, docId: 'd1', filter: '.', peek: true } as any);
    expect(viewedHeads()).toEqual({}); // peek never records

    await engine.handleMessage({ type: 'query', id: 2, docId: 'd1', filter: '.' } as any);
    expect(viewedHeads()).toEqual({ d1: ['h1'] });
    // Both queries still answered normally.
    expect(emitted.filter((e) => e.type === 'result' && !e.error)).toHaveLength(2);
  });

  it('pruneSeenState drops the record and re-emits without the doc', async () => {
    const { engine, unseenEvents, viewedHeads } = makeEngine();
    const { handle } = makeHandle(['h1']);
    (engine as any).getOrCreateEntry('d1', handle);
    await engine.subscribeQuery('d1', 1, '.', () => {});
    await tick();
    expect(viewedHeads()).toEqual({ d1: ['h1'] });

    (engine as any).pruneSeenState('d1');
    expect(viewedHeads()).toEqual({});
    const events = unseenEvents();
    expect(events[events.length - 1].unseen).toEqual({});
  });
});
