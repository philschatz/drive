/**
 * Regression test for the stale-homepage bug: the Home list's title /
 * "lastUpdated" relative time did not refresh until a full page reload.
 *
 * The Home list subscribes to each doc's summary with { peek: true, meta: true }.
 * Two engine defects starved that subscription:
 *
 *   Fix 1 — pushToSubscriptions dropped the whole query-result whenever the jq
 *   projection was byte-identical (`if (!changed) continue`), even though heads /
 *   lastModified advanced. HOME_SUMMARY_QUERY carries no timestamp, so any edit
 *   that left type/name/counts unchanged never refreshed lastUpdated. The `meta`
 *   flag opts a subscription into receiving those timestamp-only refreshes.
 *
 *   Fix 2 — a doc background-opened by a peek subscription resolves a not-yet-ready
 *   handle, so the drain's pushToSubscriptions early-returns. The handle-ready
 *   backstop only re-ran refreshSeenState, never pushToSubscriptions, so the
 *   initial summary was never delivered until some later change event.
 *
 * Harness mirrors tests/last-viewed.test.ts: in-memory kv + stubbed Automerge +
 * a hand-rolled automerge-repo handle. Query results are captured via the `post`
 * callback passed to subscribeQuery; the jq function is seeded directly into
 * jqCache so no real jq module is imported.
 */

import { DriveEngine } from '../src/shared/drive-engine';

const FILTER = 'HOME_SUMMARY';

/** In-memory KV standing in for the EngineHost. */
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
  // Skip init(): seed only the pieces the query path needs.
  (engine as any).lastViewedHeads = {};
  // Project { name, count } directly — avoids importing the real jq module.
  (engine as any).jqCache.set(FILTER, (d: any) => ({ name: d.name, count: d.count }));
  return { engine, kv };
}

/**
 * Minimal automerge-repo handle: mutable doc/heads, a controllable ready state
 * (whenReady resolves on becomeReady()), and a change trigger.
 */
function makeHandle(opts: { ready: boolean; doc: any; heads: string[] }) {
  const listeners: Record<string, Array<() => void>> = {};
  let ready = opts.ready;
  let doc = opts.doc;
  let heads = [...opts.heads];
  let resolveReady!: () => void;
  const readyPromise = new Promise<void>((r) => { resolveReady = r; });
  const handle = {
    on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb); },
    isReady: () => ready,
    whenReady: async () => { if (!ready) await readyPromise; },
    doc: () => doc,
    heads: () => [...heads],
  };
  return {
    handle,
    setDoc(d: any) { doc = d; },
    setHeads(h: string[]) { heads = [...h]; },
    becomeReady() { ready = true; resolveReady(); },
    fireChange() { for (const cb of listeners['change'] ?? []) cb(); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('home summary refresh', () => {
  it('re-delivers lastModified on a change that leaves the projection unchanged (Fix 1)', async () => {
    const { engine } = makeEngine();
    const history: any[] = [{ change: { time: 1000, hash: 'h1' } }];
    (engine as any).Automerge = { getHistory: () => history };
    const { handle, setDoc, setHeads, fireChange } =
      makeHandle({ ready: true, doc: { name: 'A', count: 1 }, heads: ['h1'] });
    (engine as any).getOrCreateEntry('d1', handle);

    const posts: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => posts.push(m), true, true);
    await tick();

    // Initial delivery carries the current timestamp.
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[posts.length - 1].lastModified).toBe(1000);
    const before = posts.length;

    // A change that advances heads + change.time but NOT the {name,count} projection.
    setDoc({ name: 'A', count: 1, notes: 'edited' });
    history.push({ change: { time: 2000, hash: 'h2' } });
    setHeads(['h2']);
    fireChange();
    await tick();

    // The meta subscription still receives the fresh lastModified (bug: it did not).
    expect(posts.length).toBeGreaterThan(before);
    const last = posts[posts.length - 1];
    expect(last.lastModified).toBe(2000);
    expect(last.result).toEqual({ name: 'A', count: 1 });
  });

  it('delivers the initial summary once a background-opened handle becomes ready (Fix 2)', async () => {
    const { engine } = makeEngine();
    const history: any[] = [{ change: { time: 1000, hash: 'h1' } }];
    (engine as any).Automerge = { getHistory: () => history };
    const { handle, becomeReady } =
      makeHandle({ ready: false, doc: { name: 'A', count: 1 }, heads: ['h1'] });
    // No registry entry yet → subscribeQuery background-opens via repo.find.
    (engine as any).repo = { find: async () => handle };

    const posts: any[] = [];
    await engine.subscribeQuery('d1', 1, FILTER, (m: any) => posts.push(m), true, true);
    await tick(); // getOrLoadHandle().then(getOrCreateEntry) runs; handle not ready yet

    // The drain's push early-returns on the not-ready handle — nothing delivered.
    expect(posts).toHaveLength(0);

    becomeReady();
    await tick();
    await tick();

    // Once ready, the backstop pushes the current summary (bug: only seen-state ran).
    expect(posts.length).toBeGreaterThanOrEqual(1);
    const last = posts[posts.length - 1];
    expect(last.result).toEqual({ name: 'A', count: 1 });
    expect(last.lastModified).toBe(1000);
  });
});
