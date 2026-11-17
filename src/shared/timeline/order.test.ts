import { effectiveBounds, displayOrder, NEAR_DAYS } from './order';
import { dayOf, fromDay } from './fuzzy-date';
import type { TimelineEvent, Rel } from '../schemas/timeline';

const day = (s: string) => dayOf(s)!;
const TODAY = day('2026-11-17');
const ev = (title: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({ '@type': 'Event', title, ...over });
const year = (y: number) => ({ earliest: String(y), latest: String(y) });
const range = (b: { lo: number; hi: number }) => [fromDay(b.lo).toString(), fromDay(b.hi).toString()];

describe('effectiveBounds', () => {
  it('own dates, defaulting to birth..today', () => {
    const b = effectiveBounds({ birth: '1987-03-04', events: { a: ev('A', { when: year(2010) }), u: ev('U') } }, TODAY);
    expect(range(b.entries.get('a')!.start)).toEqual(['2010-01-01', '2010-12-31']);
    expect(range(b.entries.get('u')!.start)).toEqual(['1987-03-04', '2026-11-17']);
    expect(b.entries.get('u')!.placed).toBe(false);
    expect(b.entries.get('a')!.placed).toBe(true);
  });

  it.each<[Rel, string[]]>([
    ['before', ['2000-01-01', '2010-12-31']],
    ['after', ['2010-01-01', '2020-12-31']],
    ['near', [fromDay(day('2010-01-01') - NEAR_DAYS).toString(), fromDay(day('2010-12-31') + NEAR_DAYS).toString()]],
    ['unsure', ['2000-01-01', '2020-12-31']],
  ])('X %s B narrows X', (rel, expected) => {
    const events = { x: ev('X', { when: { earliest: '2000', latest: '2020' }, rel: { b: rel } }), b: ev('B', { when: year(2010) }) };
    const b = effectiveBounds({ events }, TODAY);
    expect(range(b.entries.get('x')!.start)).toEqual(expected);
    expect(b.entries.get('x')!.conflicts).toEqual([]);
  });

  it('narrows in both directions: the anchor tightens too', () => {
    // X (known: 2005) before B (unknown) ⇒ B is no earlier than 2005.
    const events = { x: ev('X', { when: year(2005), rel: { b: 'before' } }), b: ev('B') };
    const b = effectiveBounds({ birth: '1987', events }, TODAY);
    expect(range(b.entries.get('b')!.start)).toEqual(['2005-01-01', '2026-11-17']);
    expect(b.entries.get('b')!.start.loBy).toEqual({ uid: 'x', rel: 'after' });
    expect(b.entries.get('b')!.placed).toBe(true);
  });

  it('periods: after uses the end, during clamps to the period, and contents narrow the period', () => {
    const events = {
      school: ev('School', { when: { earliest: '1999', latest: '2002' }, until: { earliest: '2005', latest: '2008' } }),
      prom: ev('Prom', { when: year(2004), rel: { school: 'during' } }),
      job: ev('First job', { when: { earliest: '2000', latest: '2015' }, rel: { school: 'after' } }),
    };
    const b = effectiveBounds({ events }, TODAY);
    expect(range(b.entries.get('job')!.start)).toEqual(['2005-01-01', '2015-12-31']);
    expect(range(b.entries.get('prom')!.start)).toEqual(['2004-01-01', '2004-12-31']);
    // Prom during school ⇒ school ends no earlier than 2004 (already) and starts no later than end of 2004.
    expect(b.entries.get('school')!.start.hi).toBe(day('2002-12-31'));
    expect(b.entries.get('school')!.end!.lo).toBe(day('2005-01-01'));
  });

  it('untilRel constrains the end of a period', () => {
    const events = {
      p: ev('Living in Berlin', { when: year(2010), until: { earliest: '2011', latest: '2020' }, untilRel: { b: 'before' } }),
      b: ev('Brother married', { when: year(2014) }),
    };
    expect(range(effectiveBounds({ events }, TODAY).entries.get('p')!.end!)).toEqual(['2011-01-01', '2014-12-31']);
  });

  it('a relation contradicting the dates is a conflict on both entries, and is not applied', () => {
    const events = {
      x: ev('X', { when: year(2015), rel: { b: 'before' } }),
      b: ev('B', { when: year(2010) }),
    };
    const b = effectiveBounds({ events }, TODAY);
    expect(range(b.entries.get('x')!.start)).toEqual(['2015-01-01', '2015-12-31']);
    expect(b.entries.get('x')!.conflicts).toEqual([{ owner: 'x', field: 'rel', target: 'b', rel: 'before', reason: 'contradicts-dates' }]);
    expect(b.entries.get('b')!.conflicts).toHaveLength(1);
  });

  it('a conflict leaves nothing behind: what the dead relation implied is undone', () => {
    // u before x would push u's hi to 2015-12-31 via x; then x before b is
    // dead — u must not keep a bound derived through a dead edge.
    const events = {
      x: ev('X', { when: { earliest: '2005', latest: '2015' }, rel: { b: 'before' } }),
      b: ev('B', { when: year(2001) }),
      u: ev('U', { rel: { x: 'after' } }),
    };
    const b = effectiveBounds({ birth: '1987', events }, TODAY);
    expect(b.entries.get('x')!.conflicts).toHaveLength(1);
    expect(range(b.entries.get('u')!.start)).toEqual(['2005-01-01', '2026-11-17']);
  });

  it('two contradictory answers are both conflicts and neither applies', () => {
    const events = {
      a: ev('A', { rel: { b: 'before' } }),
      b: ev('B', { rel: { a: 'before' } }),
    };
    const b = effectiveBounds({ birth: '1987', events }, TODAY);
    expect(b.entries.get('a')!.conflicts.map(c => c.reason)).toEqual(['contradicts-answer', 'contradicts-answer']);
  });

  it('ignores relations to deleted entries', () => {
    const b = effectiveBounds({ events: { a: ev('A', { when: year(2010), rel: { gone: 'after' } }) } }, TODAY);
    expect(b.entries.get('a')!.conflicts).toEqual([]);
  });

  it('does not depend on key order', () => {
    const make = (keys: string[]) => {
      const all: Record<string, TimelineEvent> = {
        a: ev('A', { when: year(2015), rel: { b: 'before', c: 'after' } }),
        b: ev('B', { when: year(2010) }),
        c: ev('C', { when: { earliest: '2000', latest: '2020' }, rel: { a: 'after' } }),
      };
      return Object.fromEntries(keys.map(k => [k, all[k]]));
    };
    const one = effectiveBounds({ events: make(['a', 'b', 'c']) }, TODAY);
    const two = effectiveBounds({ events: make(['c', 'b', 'a']) }, TODAY);
    for (const k of ['a', 'b', 'c']) expect(two.entries.get(k)).toEqual(one.entries.get(k));
  });
});

describe('displayOrder', () => {
  it('sorts by date and puts undated entries aside', () => {
    const events = { a: ev('A', { when: year(2010) }), b: ev('B', { when: year(2001) }), z: ev('Zed'), y: ev('Yak') };
    const o = displayOrder({ events }, effectiveBounds({ events }, TODAY));
    expect(o).toEqual({ ordered: ['b', 'a'], undated: ['y', 'z'] });
  });

  it('respects every relation even when the ranges are identical', () => {
    const events = {
      first: ev('Zebra first', { when: year(2010), rel: {} }),
      second: ev('Aardvark second', { when: year(2010), rel: { first: 'after' } }),
      third: ev('Middle third', { when: year(2010), rel: { second: 'after' } }),
    };
    const o = displayOrder({ events }, effectiveBounds({ events }, TODAY));
    expect(o.ordered).toEqual(['first', 'second', 'third']);
  });

  it('an entry known only by a relation is placed', () => {
    const events = { a: ev('A', { when: year(2010) }), b: ev('B', { rel: { a: 'before' } }) };
    const o = displayOrder({ birth: '1990', events }, effectiveBounds({ birth: '1990', events }, TODAY));
    expect(o.ordered).toEqual(['b', 'a']);
  });
});
