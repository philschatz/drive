/**
 * Tests for document discovery filtering logic.
 *
 * The key invariant: dismissed docs must never be re-added to the doc list,
 * even when they appear in the pendingDecrypt buffer (stale encrypted messages).
 */

import { isDiscoverable } from './doc-discovery';

describe('isDiscoverable', () => {
  it('returns true for a genuinely new doc', () => {
    const known = new Set<string>();
    const dismissed = new Set<string>();
    expect(isDiscoverable('doc-new', known, dismissed)).toBe(true);
  });

  it('returns false for an already-known doc', () => {
    const known = new Set(['doc-1']);
    const dismissed = new Set<string>();
    expect(isDiscoverable('doc-1', known, dismissed)).toBe(false);
  });

  it('returns false for a dismissed doc', () => {
    const known = new Set<string>();
    const dismissed = new Set(['doc-deleted']);
    expect(isDiscoverable('doc-deleted', known, dismissed)).toBe(false);
  });

  it('returns false for a doc that is both known and dismissed', () => {
    const known = new Set(['doc-1']);
    const dismissed = new Set(['doc-1']);
    expect(isDiscoverable('doc-1', known, dismissed)).toBe(false);
  });

  it('does not mutate the dismissed set (no un-dismiss)', () => {
    const dismissed = new Set(['doc-deleted']);
    isDiscoverable('doc-deleted', new Set(), dismissed);
    expect(dismissed.has('doc-deleted')).toBe(true);
  });
});
