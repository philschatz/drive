/**
 * Presence liveness: which peers count as "fresh".
 *
 * The engine tracks liveness itself (a lastSeen map bumped on heartbeat /
 * update / snapshot events) because the library's own pruning is broken for
 * idle peers — its heartbeat handler bumps `lastUpdateAt` while `prune()`
 * filters on `lastActiveAt`, so a peer that heartbeats but doesn't edit gets
 * pruned. `freshPresencePeerIds` is the pure membership rule: a peer is fresh
 * iff it was seen within PRESENCE_STALE_MS.
 */

import { freshPresencePeerIds, PRESENCE_STALE_MS } from '../src/shared/drive-engine';

describe('freshPresencePeerIds', () => {
  const NOW = 1_000_000_000;

  it('returns an empty set for an empty map', () => {
    expect(freshPresencePeerIds(new Map(), NOW).size).toBe(0);
  });

  it('includes a peer seen just now', () => {
    const seen = new Map([['peer-a', NOW]]);
    expect(freshPresencePeerIds(seen, NOW)).toEqual(new Set(['peer-a']));
  });

  it('includes a peer seen just inside the stale window', () => {
    const seen = new Map([['peer-a', NOW - PRESENCE_STALE_MS + 1]]);
    expect(freshPresencePeerIds(seen, NOW)).toEqual(new Set(['peer-a']));
  });

  it('excludes a peer seen exactly PRESENCE_STALE_MS ago', () => {
    const seen = new Map([['peer-a', NOW - PRESENCE_STALE_MS]]);
    expect(freshPresencePeerIds(seen, NOW).size).toBe(0);
  });

  it('separates fresh and stale peers', () => {
    const seen = new Map([
      ['fresh-1', NOW - 1000],
      ['stale-1', NOW - PRESENCE_STALE_MS - 1],
      ['fresh-2', NOW],
      ['stale-2', NOW - PRESENCE_STALE_MS * 10],
    ]);
    expect(freshPresencePeerIds(seen, NOW)).toEqual(new Set(['fresh-1', 'fresh-2']));
  });

  it('honours a custom staleMs', () => {
    const seen = new Map([['peer-a', NOW - 5000]]);
    expect(freshPresencePeerIds(seen, NOW, 4000).size).toBe(0);
    expect(freshPresencePeerIds(seen, NOW, 6000)).toEqual(new Set(['peer-a']));
  });
});
