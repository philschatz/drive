import { effectiveBounds, displayOrder } from './order';
import { dayOf, fromDay } from './fuzzy-date';
import {
  chapterSpans, chapterLayout, cellAtRow, coversBetween, memoriesIn, chaptersAt, placeGaps, hasPlaces, chapterCards,
} from './chapters';
import type { TimelineEvent, TimelinePrompt } from '../schemas/timeline';

const day = (s: string) => dayOf(s)!;
const TODAY = day('2026-11-17');
const ev = (title: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({ '@type': 'Event', title, ...over });
const year = (y: number | string) => ({ earliest: String(y), latest: String(y) });
const chapter = (title: string, kind: TimelineEvent['chapter'], from: number | string, to?: number | string, over: Partial<TimelineEvent> = {}) =>
  ev(title, { chapter: kind, when: year(from), ...(to !== undefined ? { until: year(to) } : {}), ...over });

function setup(events: Record<string, TimelineEvent>, birth = '1986-08-14', prompts: Record<string, TimelinePrompt> = {}) {
  const doc = { birth, events, prompts };
  const bounds = effectiveBounds(doc, TODAY);
  const { ordered } = displayOrder(doc, bounds);
  return { doc, bounds, ordered, layout: chapterLayout(doc, bounds, ordered) };
}
const bar = (s: ReturnType<typeof setup>, uid: string) => s.layout.bars.find(b => b.uid === uid)!;
const at = (s: ReturnType<typeof setup>, uid: string) => s.ordered.indexOf(uid);

describe('chapterSpans', () => {
  it('a chapter without `until` is still going: it ends today', () => {
    const s = setup({ chi: chapter('Chicago', 'place', 2008) });
    const span = chapterSpans(s.doc, s.bounds).get('chi')!;
    expect(span.ongoing).toBe(true);
    expect(span.to).toBe(TODAY);
    expect(fromDay(span.sureFrom).toString()).toBe('2008-12-31');
    expect(span.sureTo).toBe(TODAY);
  });

  it('an ended chapter runs from its best start to its best end; undated chapters have no span', () => {
    const s = setup({ col: chapter('College', 'pursuit', 2004, 2008), u: ev('Someday', { chapter: 'phase' }) });
    const spans = chapterSpans(s.doc, s.bounds);
    expect(fromDay(spans.get('col')!.from).year).toBe(2004);
    expect(fromDay(spans.get('col')!.to).year).toBe(2008);
    expect(spans.get('col')!.ongoing).toBe(false);
    expect(spans.has('u')).toBe(false);
  });
});

describe('chapterLayout', () => {
  const life = () => setup({
    duluth: chapter('Duluth', 'place', 1986, 1995, { when: { earliest: '1986-08-14', latest: '1986-08-14' } }),
    born: ev('Born', { when: { earliest: '1986-08-14', latest: '1986-08-14' } }),
    bike: ev('First bike', { when: year(1991) }),
    stp: chapter('St. Paul', 'place', 1995, 2004),
    chi: chapter('Chicago', 'place', 2008),
    jamie: chapter('Dating Jamie', 'people', 2010, 2014),
    run: chapter('Marathon training', 'phase', 2012, 2013),
    marathon: ev('Ran the marathon', { when: { earliest: '2013-10-13', latest: '2013-10-13' } }),
    dog: ev('Adopted a dog', { when: year(2019) }),
  });

  it('nested chapters step right; consecutive ones reuse the lane', () => {
    const s = life();
    expect(bar(s, 'duluth').lane).toBe(0);
    expect(bar(s, 'stp').lane).toBe(0);
    expect(bar(s, 'chi').lane).toBe(0);
    expect(bar(s, 'jamie').lane).toBe(1);
    expect(bar(s, 'run').lane).toBe(2);
    expect(s.layout.laneCount).toBe(3);
  });

  it('colours go round-robin in start order', () => {
    const s = life();
    expect(['duluth', 'stp', 'chi', 'jamie', 'run'].map(u => bar(s, u).colorIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('a bar runs from its own row to the newest row inside it; a still-going one runs to the top', () => {
    const s = life();
    const d = bar(s, 'duluth');
    expect(d.lo).toBe(at(s, 'duluth'));
    expect(d.hi).toBe(at(s, 'bike'));
    expect(d.toTop).toBe(false);
    const j = bar(s, 'jamie');
    expect(j.hi).toBe(at(s, 'marathon'));
    expect(bar(s, 'chi').toTop).toBe(true);
    expect(cellAtRow(d, d.lo)).toBe('start');
    expect(cellAtRow(d, at(s, 'born'))).toBe('through');
    expect(cellAtRow(d, d.hi)).toBe('end');
    expect(cellAtRow(d, d.hi + 1)).toBeNull();
    expect(cellAtRow(bar(s, 'chi'), at(s, 'dog'))).toBe('through');
    expect(cellAtRow(bar(s, 'stp'), at(s, 'stp'))).toBe('dot');
  });

  it('things drawn between rows are covered only where the bar passes', () => {
    const s = life();
    const d = bar(s, 'duluth');
    expect(coversBetween(d, d.lo)).toBe(true);
    expect(coversBetween(d, d.hi)).toBe(false);
    expect(coversBetween(d, d.lo - 1)).toBe(false);
    const last = s.ordered.length - 1;
    expect(coversBetween(bar(s, 'chi'), last)).toBe(true);
    expect(coversBetween(bar(s, 'jamie'), last)).toBe(false);
  });

  it('memories exclude nested chapters', () => {
    const s = life();
    expect(memoriesIn(bar(s, 'jamie'), s.ordered, s.doc.events)).toBe(1);
    expect(memoriesIn(bar(s, 'chi'), s.ordered, s.doc.events)).toBe(2);
  });

  it('an explicit "during" pulls a row in, and is never a maybe', () => {
    const s = setup({
      lake: chapter('Summers at the lake', 'place', 1990, 1992),
      arm: ev('Broke my arm', { rel: { lake: 'during' } }),
    });
    const b = bar(s, 'lake');
    expect(b.members.has(at(s, 'arm'))).toBe(true);
    expect(b.maybe.has(at(s, 'arm'))).toBe(false);
  });

  it('a row only possibly inside (the chapter\'s fuzzy end) is a maybe', () => {
    const s = setup({
      job: chapter('Acme', 'pursuit', 2008, '2014'),
      party: ev('Leaving party', { when: { earliest: '2014-06', latest: '2014-06' } }),
      early: ev('First week', { when: { earliest: '2008-09', latest: '2008-09' } }),
      mid: ev('Promotion', { when: year(2011) }),
    });
    const b = bar(s, 'job');
    expect(b.maybe.has(at(s, 'party'))).toBe(true);
    expect(b.maybe.has(at(s, 'mid'))).toBe(false);
    expect(b.maybe.has(at(s, 'early'))).toBe(true); // the job may have begun after September 2008
  });

  it('chaptersAt lists what was under way on a day', () => {
    const s = life();
    const spans = chapterSpans(s.doc, s.bounds);
    expect(chaptersAt(spans, day('2012-07-01')).map(c => c.uid)).toEqual(['chi', 'jamie', 'run']);
    expect(chaptersAt(spans, day('2006-01-01'))).toEqual([]);
  });
});

describe('placeGaps', () => {
  it('nothing to ask until there is a place; then the uncovered stretches, recent first', () => {
    expect(placeGaps({ birth: '1986', events: {}, prompts: {} }, effectiveBounds({ birth: '1986', events: {} }, TODAY), TODAY)).toEqual([]);
    expect(hasPlaces({ events: {}, prompts: {} })).toBe(false);
    const s = setup({
      duluth: chapter('Duluth', 'place', 1986, 1995),
      stp: chapter('St. Paul', 'place', 1995, 2004),
      chi: chapter('Chicago', 'place', 2008),
      job: chapter('Acme', 'pursuit', 2004, 2008),
    });
    const gaps = placeGaps(s.doc, s.bounds, TODAY);
    expect(gaps).toHaveLength(1);
    expect(fromDay(gaps[0].lo).year).toBe(2004);
    expect(fromDay(gaps[0].hi).year).toBe(2008);
  });

  it('a place-gap prompt, answered or skipped, covers its stretch', () => {
    const events = { stp: chapter('St. Paul', 'place', 1995, 2004), chi: chapter('Chicago', 'place', 2008) };
    const prompts: Record<string, TimelinePrompt> = {
      g: { source: 'gap', chapter: 'place', when: { earliest: '2004-07' }, until: { latest: '2008-06' }, added: 'x', dismissed: true },
    };
    const s = setup(events, '1995-01-01', prompts);
    expect(placeGaps(s.doc, s.bounds, TODAY)).toEqual([]);
    expect(hasPlaces({ events: {}, prompts })).toBe(true);
  });

  it('starts at birth when it is known, else at the first place', () => {
    const events = { chi: chapter('Chicago', 'place', 2008) };
    expect(placeGaps(setup(events, '').doc, setup(events, '').bounds, TODAY)).toEqual([]);
    const s = setup(events, '1986-08-14');
    const gaps = placeGaps(s.doc, s.bounds, TODAY);
    expect(fromDay(gaps[0].lo).toString()).toBe('1986-08-14');
  });
});

describe('chapterCards', () => {
  it('favours long, recent, empty chapters', () => {
    const s = setup({
      chi: chapter('Chicago', 'place', 2008),
      a: ev('A', { when: year(2010) }), b: ev('B', { when: year(2015) }), c: ev('C', { when: year(2020) }),
      col: chapter('College', 'pursuit', 2004, 2008),
      grade: chapter('Grade school', 'pursuit', 1994, 1996),
    });
    const cards = chapterCards(s.doc, s.bounds, s.ordered, s.layout, TODAY);
    expect(cards.map(c => c.uid)).toEqual(['chi', 'col', 'grade']);
    expect(cards[0].memories).toBe(3);
    expect(cards.map(c => c.uid).indexOf('col')).toBeLessThan(cards.map(c => c.uid).indexOf('grade'));
  });
});
