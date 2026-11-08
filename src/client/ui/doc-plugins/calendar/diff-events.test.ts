import { eventHighlight, firstHighlightedDate } from './diff-events';

const ev = (start: string) => ({ '@type': 'Event', title: 't', start }) as any;

describe('calendar history highlights', () => {
  it('maps an event to its diff class and ghost flag', () => {
    const h = { diff: new Map([['a', 'added' as const], ['g', 'removed' as const]]), ghosts: new Set(['g']) };
    expect(eventHighlight('a', h)).toEqual({ classes: ['diff-added'], ghost: false });
    expect(eventHighlight('g', h)).toEqual({ classes: ['diff-removed'], ghost: true });
    expect(eventHighlight('x', h)).toEqual({ classes: null, ghost: false });
    expect(eventHighlight('a', undefined)).toEqual({ classes: null, ghost: false });
  });

  it('moves the view to the earliest highlighted event, ignoring ones without a start', () => {
    const events = { a: ev('2026-03-10T09:00:00'), b: ev('2026-02-01'), c: { '@type': 'Event', title: 'no start' } as any };
    const diff = new Map([['a', 'changed' as const], ['b', 'added' as const], ['c', 'changed' as const]]);
    expect(firstHighlightedDate(events, diff)).toBe('2026-02-01');
    expect(firstHighlightedDate(events, new Map([['c', 'changed' as const]]))).toBeNull();
    expect(firstHighlightedDate(events, new Map())).toBeNull();
  });
});
