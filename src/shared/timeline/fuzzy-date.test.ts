import {
  parsePartial, boundsOf, bestDay, calendarFields, formatFuzzy, formatDayRange,
  draftOf, fromDraft, emptyDraft, ageRange, toDay, fromDay, dayOf, type FuzzyDate, type PresetDraft,
} from './fuzzy-date';

const day = (s: string) => dayOf(s)!;

describe('parsePartial', () => {
  it.each([
    ['2014', '2014-01-01', '2014-12-31', 'year'],
    ['2014-02', '2014-02-01', '2014-02-28', 'month'],
    ['2016-02', '2016-02-01', '2016-02-29', 'month'],
    ['2014-06-12', '2014-06-12', '2014-06-12', 'day'],
  ])('%s covers %s..%s', (s, first, last, precision) => {
    const p = parsePartial(s)!;
    expect([p.first.toString(), p.last.toString(), p.precision]).toEqual([first, last, precision]);
  });

  it.each(['14', '2014-13', '2014-02-30', '2014-6', 'June 2014', '', null])('rejects %p', s => {
    expect(parsePartial(s)).toBeNull();
  });
});

describe('day numbers', () => {
  it('round-trip', () => {
    for (const s of ['1970-01-01', '1899-12-31', '2024-02-29']) expect(fromDay(day(s)).toString()).toBe(s);
    expect(day('1970-01-02')).toBe(1);
  });
});

describe('boundsOf / bestDay', () => {
  it('earliest and latest bound; best never does', () => {
    expect(boundsOf({ earliest: '2014', latest: '2014' })).toEqual({ lo: day('2014-01-01'), hi: day('2014-12-31') });
    expect(boundsOf({ best: '2014' })).toEqual({ lo: undefined, hi: undefined });
    expect(boundsOf({ earliest: '2005' })).toEqual({ lo: day('2005-01-01'), hi: undefined });
    expect(boundsOf(undefined)).toEqual({ lo: undefined, hi: undefined });
  });

  it('best day is the middle of the guess, else of the range, else unknown', () => {
    expect(fromDay(bestDay({ earliest: '2014-06-12', latest: '2014-06-12' })!).toString()).toBe('2014-06-12');
    expect(fromDay(bestDay({ earliest: '2014-06', latest: '2014-06' })!).toString()).toBe('2014-06-15');
    expect(fromDay(bestDay({ earliest: '2000', latest: '2010', best: '2009-03' })!).toString()).toBe('2009-03-16');
    expect(bestDay({ earliest: '2005' })).toBeUndefined();
    expect(bestDay(undefined)).toBeUndefined();
  });
});

describe('calendarFields', () => {
  it('an all-day event on the best day', () => {
    expect(calendarFields({ earliest: '2014-06-12', latest: '2014-06-12' }, undefined))
      .toEqual({ start: '2014-06-12', duration: 'P1D' });
  });
  it('a period spans to its end', () => {
    expect(calendarFields({ earliest: '2014-06-01', latest: '2014-06-01' }, { earliest: '2014-06-10', latest: '2014-06-10' }))
      .toEqual({ start: '2014-06-01', duration: 'P10D' });
  });
  it('nothing for an undated or open-ended entry', () => {
    expect(calendarFields(undefined, undefined)).toEqual({});
    expect(calendarFields({ earliest: '2005' }, undefined)).toEqual({});
  });
});

describe('formatFuzzy', () => {
  it.each<[FuzzyDate | undefined, string]>([
    [undefined, 'Undated'],
    [{}, 'Undated'],
    [{ earliest: '2014-06-12', latest: '2014-06-12' }, '12 Jun 2014'],
    [{ earliest: '2014-06', latest: '2014-06' }, 'Jun 2014'],
    [{ earliest: '2014', latest: '2014' }, '2014'],
    [{ earliest: '2014-06', latest: '2014-08' }, 'summer 2014'],
    [{ earliest: '2013-12', latest: '2014-02' }, 'winter 2013–14'],
    [{ earliest: '1990', latest: '1999' }, '1990s'],
    [{ earliest: '2007', latest: '2011', best: '2009' }, 'around 2009'],
    [{ earliest: '2004', latest: '2014', best: '2009' }, 'around 2009 (±5)'],
    [{ earliest: '2008', latest: '2012' }, '2008–2012'],
    [{ earliest: '2008-03', latest: '2009-06' }, 'Mar 2008 – Jun 2009'],
    [{ earliest: '2005' }, 'after 2005'],
    [{ latest: '1999-04' }, 'before Apr 1999'],
    [{ best: '2014-06' }, 'around Jun 2014'],
  ])('%j → %s', (fd, text) => expect(formatFuzzy(fd)).toBe(text));

  it('says "age N" only when the birth day reproduces the range', () => {
    const birth = '1987-03-04';
    expect(formatFuzzy(ageRange(birth, 12), birth)).toBe('age 12');
    expect(formatFuzzy(ageRange(birth, 12))).toBe('4 Mar 1999 – 3 Mar 2000');
  });
});

describe('formatDayRange', () => {
  it('chooses a precision to suit the width', () => {
    expect(formatDayRange(day('2014-06-12'), day('2014-06-12'))).toBe('12 Jun 2014');
    expect(formatDayRange(day('2014-06-01'), day('2014-07-20'))).toBe('1 Jun 2014 – 20 Jul 2014');
    expect(formatDayRange(day('2014-01-01'), day('2014-09-30'))).toBe('Jan 2014 – Sep 2014');
    expect(formatDayRange(day('2001-01-01'), day('2009-12-31'))).toBe('2001–2009');
  });
});

describe('presets', () => {
  const birth = '1987-03-04';
  const cases: [string, Partial<PresetDraft>, FuzzyDate | undefined][] = [
    ['unknown', { kind: 'unknown' }, undefined],
    ['day', { kind: 'day', day: '2014-06-12' }, { earliest: '2014-06-12', latest: '2014-06-12' }],
    ['month', { kind: 'month', year: '2014', month: '6' }, { earliest: '2014-06', latest: '2014-06' }],
    ['season', { kind: 'season', year: '2014', season: 'summer' }, { earliest: '2014-06', latest: '2014-08' }],
    ['winter', { kind: 'season', year: '2013', season: 'winter' }, { earliest: '2013-12', latest: '2014-02' }],
    ['year', { kind: 'year', year: '2014' }, { earliest: '2014', latest: '2014' }],
    ['around', { kind: 'around', year: '2009', spread: '2' }, { earliest: '2007', latest: '2011', best: '2009' }],
    ['decade', { kind: 'decade', year: '1990' }, { earliest: '1990', latest: '1999' }],
    ['age', { kind: 'age', age: '12' }, { earliest: '1999-03-04', latest: '2000-03-03' }],
    ['between', { kind: 'between', from: '2008-03', to: '2009' }, { earliest: '2008-03', latest: '2009' }],
    ['after', { kind: 'after', from: '2005' }, { earliest: '2005' }],
    ['before', { kind: 'before', to: '1999-04' }, { latest: '1999-04' }],
  ];

  it.each(cases)('%s: draft → FuzzyDate → the same draft', (_name, partial, fd) => {
    const draft = { ...emptyDraft(), ...partial } as PresetDraft;
    expect(fromDraft(draft, birth)).toEqual(fd);
    const back = draftOf(fd, birth);
    expect(back.kind).toBe(draft.kind);
    expect(fromDraft(back, birth)).toEqual(fd);
  });

  it.each<[string, Partial<PresetDraft>]>([
    ['bad day', { kind: 'day', day: '2014-02-30' }],
    ['no year', { kind: 'year', year: '' }],
    ['not a decade', { kind: 'decade', year: '1995' }],
    ['age without birth', { kind: 'age', age: '12' }],
    ['backwards between', { kind: 'between', from: '2010', to: '2009' }],
    ['zero spread', { kind: 'around', year: '2009', spread: '0' }],
  ])('%s is incomplete (null)', (_name, partial) => {
    expect(fromDraft({ ...emptyDraft(), ...partial } as PresetDraft)).toBeNull();
  });
});

it('toDay/fromDay agree with dayOf', () => {
  expect(toDay(fromDay(12345))).toBe(12345);
});
