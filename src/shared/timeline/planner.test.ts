import {
  nextDateQuestion, applyPivotAnswer, largestGaps, placeBetween, pinTargets, pinThreshold,
  memoryWeight, density, MAX_SHRINK, type Question,
} from './planner';
import { effectiveBounds, displayOrder } from './order';
import { dayOf, fromDay, type FuzzyDate } from './fuzzy-date';
import type { TimelineEvent, TimelineDocument, Rel } from '../schemas/timeline';

const day = (s: string) => dayOf(s)!;
const TODAY = day('2026-11-17');
const ev = (title: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({ '@type': 'Event', title, ...over });
const year = (y: number) => ({ earliest: String(y), latest: String(y) });

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stated range that contains `truth`: an exact day, its month, its year, or a few years around it. */
function statedRange(truth: number, r: () => number): FuzzyDate {
  const d = fromDay(truth);
  const k = r();
  if (k < 0.25) return { earliest: d.toString(), latest: d.toString() };
  if (k < 0.5) { const m = d.toString().substring(0, 7); return { earliest: m, latest: m }; }
  if (k < 0.75) return year(d.year);
  const a = Math.floor(r() * 4);
  const b = Math.floor(r() * 4);
  return { earliest: String(d.year - a), latest: String(Math.min(fromDay(TODAY).year, d.year + b)) };
}

interface World { doc: Pick<TimelineDocument, 'birth' | 'events'>; truth: Map<string, { s: number; e?: number }> }

function makeWorld(seed: number): World {
  const r = rng(seed);
  const birthDay = day('1980-05-17');
  const truth = new Map<string, { s: number; e?: number }>();
  const events: Record<string, TimelineEvent> = {};
  const n = 4 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const s = birthDay + Math.floor(r() * (TODAY - birthDay));
    const uid = `a${i}`;
    if (r() < 0.25) {
      const e = Math.min(TODAY, s + Math.floor(r() * 2000));
      truth.set(uid, { s, e });
      events[uid] = ev(`Period ${i}`, { when: statedRange(s, r), until: statedRange(e, r) });
      // keep stated ranges consistent with each other
      if ((dayOf(events[uid].until!.latest!.length === 4 ? events[uid].until!.latest! + '-12-31' : events[uid].until!.latest!) ?? 0) < (dayOf(events[uid].when!.earliest!) ?? 0)) {
        events[uid].until = { latest: fromDay(e).toString() };
      }
    } else {
      truth.set(uid, { s });
      events[uid] = ev(`Anchor ${i}`, { when: statedRange(s, r) });
    }
  }
  const t = birthDay + Math.floor(r() * (TODAY - birthDay));
  truth.set('target', { s: t });
  events.target = ev('Target', r() < 0.5 ? {} : { when: { earliest: String(fromDay(t).year - Math.floor(r() * 15)) } });
  return { doc: { birth: '1980-05-17', events }, truth };
}

/** The honest answer to a question about the target. */
function oracle(q: Question, w: World): Rel | 'before' | 'after' {
  const t = w.truth.get(q.uid)!.s;
  if (q.kind === 'pivot') return t < q.pivot ? 'before' : 'after';
  const a = w.truth.get(q.anchor)!;
  if (t < a.s) return 'before';
  if (a.e !== undefined && t <= a.e && q.options.includes('during')) return 'during';
  if (t >= (a.e ?? a.s)) return 'after';
  return 'before';
}

function answer(w: World, q: Question, a: string): World {
  const events = { ...w.doc.events };
  const me = { ...events[q.uid] };
  if (q.kind === 'pivot') me.when = applyPivotAnswer(me.when, q.pivot, a as 'before' | 'after');
  else me.rel = { ...(me.rel ?? {}), [q.anchor]: a as Rel };
  events[q.uid] = me;
  return { ...w, doc: { ...w.doc, events } };
}

describe('nextDateQuestion: an honest oracle', () => {
  it.each(Array.from({ length: 200 }, (_, i) => i + 1))('world %i: truth stays in range and the range converges', seed => {
    let w = makeWorld(seed);
    const range0 = effectiveBounds(w.doc, TODAY).entries.get('target')!.start;
    const W0 = range0.hi - range0.lo;
    let prev = W0;
    let steps = 0;
    for (;;) {
      const b = effectiveBounds(w.doc, TODAY);
      for (const [uid, eb] of b.entries) {
        expect(eb.conflicts).toEqual([]);
        const tr = w.truth.get(uid)!;
        expect(tr.s).toBeGreaterThanOrEqual(eb.start.lo);
        expect(tr.s).toBeLessThanOrEqual(eb.start.hi);
      }
      const r = b.entries.get('target')!.start;
      expect(r.hi - r.lo).toBeLessThanOrEqual(prev);
      prev = r.hi - r.lo;
      if (r.hi - r.lo <= pinThreshold(Math.floor((r.lo + r.hi) / 2), TODAY)) break;
      const q = nextDateQuestion(w.doc, TODAY, { target: { uid: 'target', end: 'start' } });
      expect(q).not.toBeNull();
      w = answer(w, q!, oracle(q!, w));
      steps++;
    }
    const bound = Math.ceil(Math.log(W0 / 31) / Math.log(1 / MAX_SHRINK)) + 3;
    expect(steps).toBeLessThanOrEqual(Math.max(bound, 0));
  });

  it('a forgetful oracle ("not sure" 30% of the time) still converges', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed * 7);
      let w = makeWorld(seed);
      let unsure = 0;
      for (let steps = 0; ; steps++) {
        const range = effectiveBounds(w.doc, TODAY).entries.get('target')!.start;
        if (range.hi - range.lo <= pinThreshold(Math.floor((range.lo + range.hi) / 2), TODAY)) break;
        const q = nextDateQuestion(w.doc, TODAY, { target: { uid: 'target', end: 'start' } })!;
        const a = q.kind === 'anchor' && r() < 0.3 ? 'unsure' : oracle(q, w);
        if (a === 'unsure') unsure++;
        w = answer(w, q, a);
        expect(steps).toBeLessThan(40 + unsure);
      }
    }
  });

  it('a lie never empties a range or hangs', () => {
    for (let seed = 1; seed <= 50; seed++) {
      let w = makeWorld(seed);
      const lieAt = seed % 4;
      for (let steps = 0; steps < 40; steps++) {
        const b = effectiveBounds(w.doc, TODAY);
        for (const eb of b.entries.values()) expect(eb.start.lo).toBeLessThanOrEqual(eb.start.hi);
        const range = b.entries.get('target')!.start;
        if (range.hi - range.lo <= pinThreshold(Math.floor((range.lo + range.hi) / 2), TODAY)) break;
        const q = nextDateQuestion(w.doc, TODAY, { target: { uid: 'target', end: 'start' } });
        if (!q) break;
        let a = oracle(q, w);
        if (steps === lieAt) a = a === 'before' ? 'after' : 'before';
        w = answer(w, q, a);
      }
    }
  });
});

describe('questions', () => {
  it('prefers an anchor entry that splits the range; offers "during" for a period', () => {
    const events = {
      x: ev('X', { when: { earliest: '2000', latest: '2010' } }),
      school: ev('School', { when: year(2003), until: year(2006) }),
    };
    const q = nextDateQuestion({ events }, TODAY)!;
    expect(q).toMatchObject({ kind: 'anchor', uid: 'x', anchor: 'school' });
    expect((q as any).options).toEqual(['before', 'after', 'during', 'unsure']);
  });

  it('never asks about an anchor whose order already follows, or one already answered', () => {
    const events = {
      x: ev('X', { when: { earliest: '2000', latest: '2010' }, rel: { b: 'unsure' } }),
      b: ev('B', { when: year(2005) }),
      old: ev('Old', { when: year(1990) }),
    };
    const q = nextDateQuestion({ events }, TODAY, { target: { uid: 'x', end: 'start' } })!;
    expect(q.kind).toBe('pivot');
  });

  it('pivots on a birthday for wide ranges when the birth day is known', () => {
    const events = { x: ev('X') };
    const q = nextDateQuestion({ birth: '1987-03-04', events }, TODAY)!;
    expect(q.kind).toBe('pivot');
    expect((q as any).label).toMatch(/^you turned \d+$/);
    expect(fromDay((q as any).pivot).toString().substring(4)).toBe('-03-04');
  });

  it('pivots on a new year otherwise', () => {
    const q = nextDateQuestion({ events: { x: ev('X', { when: { earliest: '2000', latest: '2010' } }) } }, TODAY)!;
    expect(q).toMatchObject({ kind: 'pivot', label: 'the start of 2005' });
  });

  it('applyPivotAnswer writes the coarsest exact bound and drops a best guess it rules out', () => {
    expect(applyPivotAnswer({ earliest: '2000', latest: '2010', best: '2008' }, day('2005-01-01'), 'before'))
      .toEqual({ earliest: '2000', latest: '2004' });
    expect(applyPivotAnswer(undefined, day('2005-06-01'), 'after')).toEqual({ earliest: '2005-06' });
    expect(applyPivotAnswer(undefined, day('2005-06-12'), 'before')).toEqual({ latest: '2005-06-11' });
  });

  it('is done once dates are pinned down enough, and skips settled entries', () => {
    const events = { a: ev('A', { when: { earliest: '2026-03', latest: '2026-03' } }), b: ev('B', { settled: true }) };
    expect(nextDateQuestion({ events }, TODAY)).toBeNull();
  });
});

describe('recency', () => {
  it('memory density falls with distance and is low in early childhood', () => {
    const birth = day('1987-03-04');
    expect(density(TODAY, TODAY)).toBe(1);
    expect(density(day('2000-01-01'), TODAY)).toBeLessThan(density(day('2020-01-01'), TODAY));
    expect(density(day('1989-01-01'), TODAY, birth)).toBeLessThan(density(day('1993-01-01'), TODAY, birth));
  });

  it('a recent gap outranks an equal old one; a long childhood blank still outranks a short recent one', () => {
    const birth = day('1987-03-04');
    expect(memoryWeight(day('2019-01-01'), day('2021-01-01'), TODAY, birth))
      .toBeGreaterThan(memoryWeight(day('1994-01-01'), day('1996-01-01'), TODAY, birth));
    expect(memoryWeight(birth, day('1997-03-04'), TODAY, birth))
      .toBeGreaterThan(memoryWeight(day('2026-08-17'), TODAY, TODAY, birth));
  });

  it('a date counts as pinned down at a precision that suits how long ago it was', () => {
    expect(pinThreshold(day('2026-01-01'), TODAY)).toBe(31);
    expect(pinThreshold(day('2016-11-17'), TODAY)).toBeCloseTo(182.6, 0);
    expect(pinThreshold(day('2006-11-17'), TODAY)).toBeCloseTo(365.2, 0);
  });

  it('asks about a recent vague entry before an equally vague old one', () => {
    const events = {
      old: ev('Old', { when: { earliest: '1995', latest: '1999' } }),
      recent: ev('Recent', { when: { earliest: '2018', latest: '2022' } }),
    };
    expect(pinTargets({ events }, TODAY)[0].uid).toBe('recent');
  });
});

describe('largestGaps', () => {
  const doc = (over: Partial<TimelineDocument> = {}): Pick<TimelineDocument, 'birth' | 'events' | 'prompts'> => ({
    birth: '1987-03-04',
    events: { a: ev('A', { when: year(2000) }), b: ev('B', { when: year(2020) }) },
    prompts: {},
    ...over,
  });

  it('ranks empty stretches by expected memories: six recent years outrank thirteen of childhood', () => {
    const gaps = largestGaps(doc(), TODAY);
    expect(gaps.map(g => [fromDay(g.lo).year, fromDay(g.hi).year])).toEqual([[2000, 2020], [2020, 2026], [1987, 2000]]);
  });

  it('every prompt ever offered covers its day, so answering the middle splits the gap', () => {
    const before = largestGaps(doc(), TODAY)[0];
    const after = largestGaps(doc({
      prompts: { g: { source: 'gap', when: year(2010), added: '2026-11-17T00:00:00.000Z', dismissed: true } },
    }), TODAY);
    expect(after[0].hi - after[0].lo).toBeLessThan(before.hi - before.lo);
  });
});

describe('placeBetween', () => {
  const fuzzy = { earliest: '2010', latest: '2010' };
  const events = (): Record<string, TimelineEvent> => ({
    a: ev('A', { when: fuzzy }),
    b: ev('B', { when: fuzzy, rel: { a: 'after' } }),
    c: ev('C', { when: fuzzy, rel: { b: 'after' } }),
  });
  const order = (evs: Record<string, TimelineEvent>) => displayOrder({ events: evs }, effectiveBounds({ events: evs }, TODAY)).ordered;
  function apply(evs: Record<string, TimelineEvent>, uid: string, p: ReturnType<typeof placeBetween>) {
    if (!p.ok) throw new Error(p.reason);
    const next = structuredClone(evs);
    for (const r of p.remove) delete next[r.owner][r.field]![r.target];
    for (const r of p.add) next[r.owner] = { ...next[r.owner], [r.field]: { ...(next[r.owner][r.field] ?? {}), [r.target]: r.rel } };
    next[uid].when = p.when;
    return next;
  }

  it('moves an entry between two others', () => {
    const evs = events();
    expect(order(evs)).toEqual(['a', 'b', 'c']);
    const p = placeBetween({ events: evs }, 'c', 'a', 'b', TODAY);
    expect(p.ok).toBe(true);
    const next = apply(evs, 'c', p);
    expect(order(next)).toEqual(['a', 'c', 'b']);
    // and back again
    const back = apply(next, 'c', placeBetween({ events: next }, 'c', 'b', null, TODAY));
    expect(order(back)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a spot its own date forbids, saying why', () => {
    const evs = { ...events(), x: ev('X', { when: year(2004) }) };
    const p = placeBetween({ events: evs }, 'x', 'a', 'b', TODAY);
    expect(p).toEqual({ ok: false, reason: 'Its date (2004) doesn\'t fit between “A” and “B”.' });
  });

  it('drops an old relation the new spot contradicts, and keeps the rest', () => {
    const evs: Record<string, TimelineEvent> = {
      a: ev('A', { when: year(2005) }),
      b: ev('B', { when: year(2010) }),
      w: ev('W', { when: year(2012) }),
      far: ev('Far', { when: year(2020) }),
      x: ev('X', { rel: { a: 'before', far: 'before' } }),
    };
    const p = placeBetween({ birth: '1987', events: evs }, 'x', 'b', 'w', TODAY);
    if (!p.ok) throw new Error(p.reason);
    expect(p.remove).toEqual([{ owner: 'x', field: 'rel', target: 'a' }]);
    expect(p.add).toEqual([
      { owner: 'x', field: 'rel', target: 'b', rel: 'after' },
      { owner: 'x', field: 'rel', target: 'w', rel: 'before' },
    ]);
    expect(p.when.best).toMatch(/^201[0-2]/);
  });

  it('places a draft entry that is not in the document yet (insert between)', () => {
    const p = placeBetween({ events: events() }, 'new', 'a', 'b', TODAY, ev('New'));
    expect(p).toMatchObject({ ok: true, remove: [], add: [{ owner: 'new', target: 'a', rel: 'after' }, { owner: 'new', target: 'b', rel: 'before' }] });
  });
});
