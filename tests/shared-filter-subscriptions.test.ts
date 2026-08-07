/**
 * Two subscriptions on the SAME (docId, filter) must each receive every update.
 *
 * The query cache is keyed by `queryCacheKey(docId, filter)`, not by subId, so
 * `runCachedQuery` reports `changed` for the *cache*, not for the subscriber asking.
 * The first sub in the push loop wrote the cache entry; every later sub with the same
 * filter was then told "unchanged" and skipped by `if (!changed) continue` — so it
 * received the initial result and then went permanently silent.
 *
 * One tab rarely hits this (its subscriptions use different filters), but two tabs
 * viewing the same document is exactly two subs with one filter — the case the
 * cross-tab router creates. `changed` is now decided per subscriber via
 * `SubInfo.lastJson`.
 *
 * Harness mirrors tests/home-summary-refresh.test.ts: in-memory kv, stubbed
 * Automerge, hand-rolled handle, jq seeded straight into jqCache.
 */

import { DriveEngine } from '../src/shared/drive-engine';

const FILTER = 'NAME_ONLY';

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
  (engine as any).jqCache.set(FILTER, (d: any) => ({ name: d.name }));
  return { engine, kv };
}

function makeHandle(opts: { doc: any; heads: string[] }) {
  const listeners: Record<string, Array<() => void>> = {};
  let doc = opts.doc;
  let heads = [...opts.heads];
  return {
    handle: {
      on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); },
      isReady: () => true,
      whenReady: async () => {},
      doc: () => doc,
      heads: () => [...heads],
    },
    setDoc(d: any) { doc = d; },
    setHeads(h: string[]) { heads = [...h]; },
    fireChange() { for (const cb of listeners['change'] ?? []) cb(); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('subscriptions sharing one filter', () => {
  it('delivers a change to every subscriber, not just the first', async () => {
    const { engine } = makeEngine();
    const history: any[] = [{ change: { time: 1000, hash: 'h1' } }];
    (engine as any).Automerge = { getHistory: () => history };
    const { handle, setDoc, setHeads, fireChange } = makeHandle({ doc: { name: 'A' }, heads: ['h1'] });
    (engine as any).getOrCreateEntry('d1', handle);

    // Two tabs, same doc, same filter — subIds are namespaced by the router.
    const tabA: any[] = [];
    const tabB: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => tabA.push(m));
    await engine.subscribeQuery('d1', 2, FILTER, (m: any) => tabB.push(m));
    await tick();

    const names = (posts: any[]) => posts.filter((p) => !p.error).map((p) => p.result?.name);
    expect(names(tabA)).toContain('A');
    expect(names(tabB)).toContain('A');

    setDoc({ name: 'B' });
    history.push({ change: { time: 2000, hash: 'h2' } });
    setHeads(['h2']);
    fireChange();
    await tick();

    // The second subscriber used to be starved here: the first one's push wrote the
    // shared cache entry, so this one was told the projection had not changed.
    expect(names(tabA)).toContain('B');
    expect(names(tabB)).toContain('B');
  });

  it('does not re-deliver an unchanged projection to either subscriber', async () => {
    const { engine } = makeEngine();
    const history: any[] = [{ change: { time: 1000, hash: 'h1' } }];
    (engine as any).Automerge = { getHistory: () => history };
    const { handle, setDoc, setHeads, fireChange } = makeHandle({ doc: { name: 'A' }, heads: ['h1'] });
    (engine as any).getOrCreateEntry('d1', handle);

    const tabA: any[] = [];
    const tabB: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => tabA.push(m));
    await engine.subscribeQuery('d1', 2, FILTER, (m: any) => tabB.push(m));
    await tick();
    const beforeA = tabA.length;
    const beforeB = tabB.length;

    // A change that leaves `{ name }` byte-identical. Neither sub is a meta sub, so
    // the per-subscriber comparison must still suppress both pushes.
    setDoc({ name: 'A', notes: 'edited' });
    history.push({ change: { time: 2000, hash: 'h2' } });
    setHeads(['h2']);
    fireChange();
    await tick();

    expect(tabA).toHaveLength(beforeA);
    expect(tabB).toHaveLength(beforeB);
  });

  it('seeds a late subscriber from the cache without duplicating it', async () => {
    const { engine } = makeEngine();
    const history: any[] = [{ change: { time: 1000, hash: 'h1' } }];
    (engine as any).Automerge = { getHistory: () => history };
    const { handle } = makeHandle({ doc: { name: 'A' }, heads: ['h1'] });
    (engine as any).getOrCreateEntry('d1', handle);

    await engine.subscribeQuery('d1', 1, FILTER, () => {});
    await tick();

    // Joining second, this one is replayed from the warm cache; the push that runs
    // straight after must not send the same result again.
    const late: any[] = [];
    await engine.subscribeQuery('d1', 2, FILTER, (m: any) => late.push(m));
    await tick();

    expect(late).toHaveLength(1);
    expect(late[0].result).toEqual({ name: 'A' });
  });
});
