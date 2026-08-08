import 'temporal-polyfill/global';
import {
  expectedOccurrences, metInPeriod, windowEnd, currentStatus, currentStreak, sortedCounters, metMissedByWeek, isArchived,
  createdDate, createdDateTime, reanchorDate, parseReward, formatReward, windowEndTime, windowDuration,
} from './occurrences';
import type { CounterEvent } from '../../../../shared/schemas/counters';

const NOW = '2026-07-21T12:00:00'; // a Tuesday

const daily = (extra: Partial<CounterEvent> = {}): CounterEvent => ({
  '@type': 'Event',
  title: 'stretch',
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
  ...extra,
});

/** `created` is a UTC instant; build it from a local date so the test reads the
 * same calendar day back whatever zone it runs in. */
const createdOn = (date: string): string =>
  Temporal.PlainDateTime.from(date + 'T09:00:00')
    .toZonedDateTime(Temporal.Now.timeZoneId())
    .toInstant()
    .toString({ smallestUnit: 'second' });

/** The same, when the *time* of creation is what the test is about. */
const createdAtLocal = (dateTime: string): string =>
  Temporal.PlainDateTime.from(dateTime)
    .toZonedDateTime(Temporal.Now.timeZoneId())
    .toInstant()
    .toString({ smallestUnit: 'second' });

/** Every 3 days from `created`, i.e. a rule whose grid depends on its anchor. */
const every3 = (extra: Partial<CounterEvent> = {}): CounterEvent => ({
  '@type': 'Event',
  title: 'water plants',
  created: createdOn('2026-07-01'),
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', interval: 3 },
  ...extra,
});

/** Every 4 months from `created` — the interval that exposed the end-of-day deadline. */
const every4Months = (extra: Partial<CounterEvent> = {}): CounterEvent => ({
  '@type': 'Event',
  title: 'descale the kettle',
  created: createdOn('2026-07-19'),
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'monthly', interval: 4 },
  ...extra,
});

describe('expectedOccurrences', () => {
  it('expands a daily rule with no start date across the range', () => {
    expect(expectedOccurrences(daily(), '2026-07-19', '2026-07-21')).toEqual(['2026-07-19', '2026-07-20', '2026-07-21']);
  });

  it('carries the startTime into each occurrence', () => {
    const ev = daily({ startTime: '08:00:00' });
    expect(expectedOccurrences(ev, '2026-07-20', '2026-07-21')).toEqual(['2026-07-20T08:00:00', '2026-07-21T08:00:00']);
  });

  it('expands weekly byDay rules', () => {
    const ev = daily({
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'mo' }, { '@type': 'NDay', day: 'th' }] },
    });
    expect(expectedOccurrences(ev, '2026-07-13', '2026-07-19')).toEqual(['2026-07-13', '2026-07-16']);
  });

  it('non-recurring: single occurrence at start, only when in range', () => {
    const ev: CounterEvent = { '@type': 'Event', start: '2026-07-20T09:00:00' };
    expect(expectedOccurrences(ev, '2026-07-19', '2026-07-21')).toEqual(['2026-07-20T09:00:00']);
    expect(expectedOccurrences(ev, '2026-07-21', '2026-07-22')).toEqual([]);
  });

  it('no rule and no start: nothing expected', () => {
    expect(expectedOccurrences({ '@type': 'Event' }, '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

describe('the schedule restarts at each completion', () => {
  it('re-anchors to the day it was done, without losing the occurrences before it', () => {
    // Due Jul 19, done a day late on the 20th (still inside its credit period).
    const ev = every3({ completions: { '2026-07-20T09:00:00': '' } });
    expect(expectedOccurrences(ev, '2026-07-01', '2026-07-26')).toEqual([
      // history from `created` survives …
      '2026-07-01', '2026-07-04', '2026-07-07', '2026-07-10', '2026-07-13', '2026-07-16',
      // … and Jul 19 is *replaced* by the completion, not counted missed beside it
      '2026-07-20', '2026-07-23', '2026-07-26',
    ]);
    // Next due is 3 days after it was done (the 23rd), not after the 22nd — and
    // that is what the done row counts down to, since a 3-day habit's window runs
    // until it comes due again.
    expect(currentStatus(ev, NOW)).toEqual({ status: 'done', occurrence: '2026-07-20', dueAt: '2026-07-23T00:00:00' });
  });

  it('without a completion the grid still runs from `created`', () => {
    expect(expectedOccurrences(every3(), '2026-07-01', '2026-07-10')).toEqual(['2026-07-01', '2026-07-04', '2026-07-07', '2026-07-10']);
    // Overdue since the 4th: that is when Jul 1 stopped being creditable, not the
    // morning after it (a 3-day habit is not late one day in).
    expect(currentStatus(every3(), NOW)).toEqual({ status: 'overdue', occurrence: '2026-07-19', dueAt: '2026-07-04T00:00:00' });
  });

  it('a streak counts through the re-anchors', () => {
    const ev = every3({
      completions: { '2026-07-15T09:00:00': '', '2026-07-18T09:00:00': '', '2026-07-21T09:00:00': '' },
    });
    expect(currentStreak(ev, NOW)).toBe(3);
    // …and the missed weeks before the habit got going are still charted, which
    // is what anchoring the grid at `created` (not at the moving `start`) buys.
    expect(metMissedByWeek({ a: ev }, NOW, 4)).toEqual([
      { weekStart: '2026-06-29', met: 0, missed: 2 }, // Jul 1, Jul 4
      { weekStart: '2026-07-06', met: 0, missed: 2 }, // Jul 7, Jul 10
      { weekStart: '2026-07-13', met: 2, missed: 0 }, // done on the 15th and 18th
      { weekStart: '2026-07-20', met: 0, missed: 0 }, // today's period is still open
    ]);
  });

  it('a click before the window opens belongs to the previous day', () => {
    const ev: CounterEvent = { '@type': 'Event', startTime: '08:00:00' };
    expect(reanchorDate(ev, '2026-07-21T07:00:00')).toBe('2026-07-20');
    expect(reanchorDate(ev, '2026-07-21T08:30:00')).toBe('2026-07-21');
    expect(reanchorDate({ '@type': 'Event' }, '2026-07-21T00:30:00')).toBe('2026-07-21');

    // So an early tick doesn't push the habit a day out of phase.
    const early = every3({ startTime: '08:00:00', completions: { '2026-07-21T07:00:00': '' } });
    expect(expectedOccurrences(early, '2026-07-20', '2026-07-26')).toEqual(['2026-07-20T08:00:00', '2026-07-23T08:00:00', '2026-07-26T08:00:00']);
    expect(currentStatus(early, NOW).status).toBe('done'); // credited, not "upcoming"
  });

  it('daily and weekly-byDay grids are anchor-invariant, so completions leave them alone', () => {
    const before = expectedOccurrences(daily({ created: createdOn('2026-07-01') }), '2026-07-19', '2026-07-21');
    const after = expectedOccurrences(daily({ created: createdOn('2026-07-01'), completions: { '2026-07-20T09:00:00': '' } }), '2026-07-19', '2026-07-21');
    expect(after).toEqual(before);
  });

  it('createdDate falls back to `start` for counters written before the field existed', () => {
    expect(createdDate({ '@type': 'Event', created: createdOn('2026-07-04') })).toBe('2026-07-04');
    expect(createdDate({ '@type': 'Event', start: '2026-07-04' })).toBe('2026-07-04');
    expect(createdDate({ '@type': 'Event', created: 'not-an-instant', start: '2026-07-05' })).toBe('2026-07-05');
    expect(createdDate({ '@type': 'Event' })).toBeUndefined();
  });

  it('createdDateTime keeps the time of day, and floors a legacy date to midnight', () => {
    expect(createdDateTime({ '@type': 'Event', created: createdOn('2026-07-04') })).toBe('2026-07-04T09:00:00');
    expect(createdDateTime({ '@type': 'Event', start: '2026-07-04' })).toBe('2026-07-04T00:00:00');
    expect(createdDateTime({ '@type': 'Event', start: '2026-07-04T11:30:00' })).toBe('2026-07-04T11:30:00');
    expect(createdDateTime({ '@type': 'Event', created: 'not-an-instant', start: '2026-07-05' })).toBe('2026-07-05T00:00:00');
    expect(createdDateTime({ '@type': 'Event' })).toBeUndefined();
    // Sub-second precision from an imported document must not leak into a string
    // the engine compares against "YYYY-MM-DDTHH:mm:ss" deadlines.
    expect(createdDateTime({ '@type': 'Event', created: '2026-07-04T00:00:00.123Z' })).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  });
});

describe('a deadline runs until the habit comes due again', () => {
  it('a long interval is not overdue the morning after it was created', () => {
    // The report: created two days ago, never done, repeating every 4 months.
    // The end of the creation day is not the deadline — the next occurrence is.
    expect(currentStatus(every4Months(), NOW)).toEqual({
      status: 'pending',
      occurrence: '2026-07-19',
      dueAt: '2026-11-19T00:00:00',
    });
  });

  it('…and goes overdue when it does come due again', () => {
    expect(currentStatus(every4Months(), '2026-11-20T12:00:00')).toEqual({
      status: 'overdue',
      occurrence: '2026-11-19',
      dueAt: '2026-11-19T00:00:00',
    });
  });

  it('a neglected one measures from the first blown deadline, not the day after an occurrence', () => {
    const ev = every4Months({ created: createdOn('2025-01-01') });
    expect(currentStatus(ev, NOW)).toEqual({
      status: 'overdue',
      occurrence: '2026-05-01',
      // Jan 1 is when the Sep 1 occurrence stopped being creditable — the start
      // of the run of misses inside the expansion window.
      dueAt: '2026-01-01T00:00:00',
    });
  });

  it('an explicit window still wins: it closes when the user said it does', () => {
    const ev = every4Months({
      startTime: '09:00:00',
      duration: 'PT1H',
      created: createdAtLocal('2026-07-19T08:00:00'),
    });
    expect(currentStatus(ev, NOW)).toEqual({
      status: 'overdue',
      occurrence: '2026-07-19T09:00:00',
      dueAt: '2026-07-19T10:00:00',
    });
  });

  it('daily is unchanged, because its next occurrence *is* the end of the day', () => {
    expect(windowEnd(daily(), '2026-07-21', '2026-07-22')).toBe('2026-07-22T00:00:00');
    // No next occurrence (a one-shot, or the far edge of the expansion): end of day.
    expect(windowEnd(daily(), '2026-07-21')).toBe('2026-07-22T00:00:00');
    expect(windowEnd(every4Months(), '2026-07-19', '2026-11-19')).toBe('2026-11-19T00:00:00');
  });
});

describe('a window that shut before the counter existed', () => {
  /** 06:00–07:00 daily, written at 10:00 — after today's hour had already gone. */
  const writtenLate = (at: string) => daily({
    startTime: '06:00:00',
    duration: 'PT1H',
    created: createdAtLocal(at),
  });

  it('is not a miss: a brand-new counter does not open Overdue', () => {
    expect(currentStatus(writtenLate('2026-07-21T10:00:00'), NOW)).toEqual({
      status: 'upcoming',
      occurrence: '2026-07-22T06:00:00',
      dueAt: '2026-07-22T07:00:00',
    });
  });

  it('trims the grid rather than the status, so nothing downstream sees it', () => {
    expect(expectedOccurrences(writtenLate('2026-07-21T10:00:00'), '2026-07-21', '2026-07-23'))
      .toEqual(['2026-07-22T06:00:00', '2026-07-23T06:00:00']);
  });

  it('created mid-window keeps today: it can still be done', () => {
    const ev = writtenLate('2026-07-21T06:30:00');
    expect(currentStatus(ev, '2026-07-21T06:45:00')).toEqual({
      status: 'pending',
      occurrence: '2026-07-21T06:00:00',
      dueAt: '2026-07-21T07:00:00',
    });
    // …and it is genuinely overdue once that window shuts unmet.
    expect(currentStatus(ev, NOW)).toEqual({
      status: 'overdue',
      occurrence: '2026-07-21T06:00:00',
      dueAt: '2026-07-21T07:00:00',
    });
  });

  it('an all-day habit created at 23:00 still has the rest of the day', () => {
    // The trim keys on when the window *shuts*, not when the occurrence starts.
    expect(currentStatus(daily({ created: createdAtLocal('2026-07-21T23:00:00') }), '2026-07-21T23:30:00')).toEqual({
      status: 'pending',
      occurrence: '2026-07-21',
      dueAt: '2026-07-22T00:00:00',
    });
  });

  it('the chart does not book it as a miss either', () => {
    // Only the 22nd — the hour that predates the counter is not charted.
    expect(metMissedByWeek({ a: writtenLate('2026-07-21T10:00:00') }, '2026-07-22T12:00:00', 1))
      .toEqual([{ weekStart: '2026-07-20', met: 0, missed: 1 }]);
  });

  it('leaves legacy counters and one-shots alone', () => {
    // No `created`: `start` is the legacy origin and floors to midnight, so a
    // whole day of history is never trimmed away.
    expect(createdDateTime(daily({ start: '2026-07-14' }))).toBe('2026-07-14T00:00:00');
    expect(currentStatus(daily({ start: '2026-07-14' }), NOW).status).toBe('overdue');
    // A one-shot's `start` is its due date and may legitimately predate its own
    // creation — logging something you already owe.
    const oneShot: CounterEvent = { '@type': 'Event', start: '2026-07-20T09:00:00', created: createdAtLocal('2026-07-21T10:00:00') };
    expect(currentStatus(oneShot, NOW).status).toBe('overdue');
  });
});

describe('rewards', () => {
  it('parses "<goal>: <text>" and leaves plain notes alone', () => {
    expect(parseReward('10: Ice cream')).toEqual({ goal: 10, text: 'Ice cream' });
    expect(parseReward('3: ')).toEqual({ goal: 3, text: '' });
    expect(parseReward('just a note')).toBeNull();
    expect(parseReward('10:no space')).toBeNull();
    expect(parseReward('0: nothing')).toBeNull();
    expect(parseReward(undefined)).toBeNull();
  });

  it('round-trips through formatReward', () => {
    expect(formatReward(10, 'Ice cream')).toBe('10: Ice cream');
    expect(formatReward(null, 'just a note')).toBe('just a note');
    expect(parseReward(formatReward(4, 'Cake'))).toEqual({ goal: 4, text: 'Cake' });
  });

  it('sorts unclaimed rewards first within a status, closest to unlocking at the top', () => {
    const events: Record<string, CounterEvent> = {
      far: daily({ title: 'far', description: '5: cake' }),
      near: daily({ title: 'near', description: '2: tea' }),
      plain: daily({ title: 'plain' }),
    };
    const sorted = sortedCounters(events, NOW);
    expect(sorted.map(e => e.uid)).toEqual(['near', 'far', 'plain']);
    expect(sorted[0].reward).toEqual({ goal: 2, text: 'tea', remaining: 2, unlocked: false });
  });

  it('an overdue habit has broken its chain, so its reward starts over', () => {
    // Done for three days, then the timed window shut unmet today. The raw
    // streak is still salvageable (a late completion would count), but the row
    // shows a broken chain: no flame, and the reward back to its full goal.
    const ev = daily({
      start: '2026-07-14', startTime: '08:00:00', duration: 'PT1H', description: '5: cake',
      completions: { '2026-07-18T08:30:00': '', '2026-07-19T08:30:00': '', '2026-07-20T08:30:00': '' },
    });
    expect(currentStreak(ev, NOW)).toBe(3); // the history still knows
    const [entry] = sortedCounters({ a: ev }, NOW);
    expect(entry.status).toBe('overdue');
    expect(entry.streak).toBe(0);
    expect(entry.reward).toMatchObject({ goal: 5, remaining: 5 });
  });

  it('an unlocked reward drops back into normal order', () => {
    const done = { completions: { '2026-07-21T08:00:00': '' } };
    const events: Record<string, CounterEvent> = {
      zzz: daily({ title: 'zzz', description: '1: prize', ...done }),
      aaa: daily({ title: 'aaa', ...done }),
    };
    const sorted = sortedCounters(events, NOW);
    expect(sorted.map(e => e.uid)).toEqual(['aaa', 'zzz']); // by title, not pinned to the top
    expect(sorted[1].reward).toMatchObject({ remaining: 0, unlocked: true });
  });
});

describe('the daily window as start/end times', () => {
  it('converts an end time to a stored duration', () => {
    expect(windowDuration('08:00', '09:30')).toBe('PT1H30M');
    expect(windowDuration('08:00', '09:00')).toBe('PT1H');
    expect(windowDuration('22:00', '02:00')).toBe('PT4H'); // crosses midnight
    expect(windowDuration('', '01:00')).toBe('PT1H'); // no start time → from midnight
    expect(windowDuration('08:00', '08:00')).toBe(''); // a full day is the default window
    expect(windowDuration('08:00', '')).toBe('');
  });

  it('converts a stored duration back to an end time', () => {
    expect(windowEndTime('08:00', 'PT1H30M')).toBe('09:30');
    expect(windowEndTime('22:00', 'PT4H')).toBe('02:00');
    expect(windowEndTime('', 'PT1H')).toBe('01:00');
    expect(windowEndTime('08:00', '')).toBe('');
    expect(windowEndTime('08:00', 'P1D')).toBe(''); // no clock end to show
  });
});

describe('metInPeriod / windowEnd', () => {
  it('all-day occurrence window is the whole day', () => {
    expect(windowEnd(daily(), '2026-07-20')).toBe('2026-07-21T00:00:00');
  });

  it('duration sets the window length', () => {
    expect(windowEnd(daily({ startTime: '08:00:00', duration: 'PT1H' }), '2026-07-20T08:00:00')).toBe('2026-07-20T09:00:00');
  });

  it('credits a click anywhere in [occurrence, next occurrence)', () => {
    const ev = daily({ completions: { '2026-07-20T23:30:00': '' } });
    expect(metInPeriod(ev, '2026-07-20', '2026-07-21')).toBe(true);
    expect(metInPeriod(ev, '2026-07-19', '2026-07-20')).toBe(false); // click is after this period
    expect(metInPeriod(ev, '2026-07-21', '2026-07-22')).toBe(false);
  });

  it('no completions → not met', () => {
    expect(metInPeriod(daily(), '2026-07-20', '2026-07-21')).toBe(false);
  });
});

describe('currentStatus', () => {
  it('daily created a week ago with no completions → overdue (previous occurrence missed)', () => {
    expect(currentStatus(daily({ start: '2026-07-14' }), NOW)).toEqual({ status: 'overdue', occurrence: '2026-07-21', dueAt: '2026-07-15T00:00:00' });
  });

  it('daily with yesterday met and today unmet (window open) → pending', () => {
    const ev = daily({ start: '2026-07-14', completions: { '2026-07-20T09:00:00': '' } });
    expect(currentStatus(ev, NOW)).toEqual({ status: 'pending', occurrence: '2026-07-21', dueAt: '2026-07-22T00:00:00' });
  });

  it('daily created today, unmet, window open → pending', () => {
    expect(currentStatus(daily({ start: '2026-07-21' }), NOW)).toEqual({ status: 'pending', occurrence: '2026-07-21', dueAt: '2026-07-22T00:00:00' });
  });

  it('daily with today met → done', () => {
    expect(currentStatus(daily({ completions: { '2026-07-21T08:00:00': '' } }), NOW)).toEqual({ status: 'done', occurrence: '2026-07-21', dueAt: '2026-07-22T00:00:00' });
  });

  it('weekly Monday, now Tuesday, missed → still pending: a Tuesday click counts', () => {
    // A weekly habit has a week, not a day. It stays pending until next Monday —
    // exactly when a completion would stop crediting this occurrence.
    const ev = daily({
      created: createdOn('2026-07-20'), // a Monday
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'mo' }] },
    });
    expect(currentStatus(ev, NOW)).toEqual({ status: 'pending', occurrence: '2026-07-20', dueAt: '2026-07-27T00:00:00' });
    // …and a week later it is overdue, dated from the Monday it blew.
    expect(currentStatus(ev, '2026-07-28T12:00:00')).toEqual({ status: 'overdue', occurrence: '2026-07-27', dueAt: '2026-07-27T00:00:00' });
  });

  it('weekly Monday, now Tuesday, done Monday → done', () => {
    const ev = daily({
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'mo' }] },
      completions: { '2026-07-20T10:00:00': '' },
    });
    expect(currentStatus(ev, NOW).status).toBe('done');
  });

  it('one-shot: overdue once the day passes, done after a click, upcoming before', () => {
    const ev: CounterEvent = { '@type': 'Event', start: '2026-07-20' };
    expect(currentStatus(ev, NOW).status).toBe('overdue');
    expect(currentStatus({ ...ev, completions: { '2026-07-20T10:00:00': '' } }, NOW).status).toBe('done');
    expect(currentStatus({ ...ev, start: '2026-08-01' }, NOW).status).toBe('upcoming');
  });

  it('no rule and no start → free tally', () => {
    expect(currentStatus({ '@type': 'Event', title: 'pushups' }, NOW).status).toBe('tally');
  });
});

describe('currentStatus → dueAt (what the row renders as a relative time)', () => {
  it('a still-open window never yields a future dueAt on an overdue row', () => {
    // The trap: this row is overdue because *yesterday* was missed, but today's
    // all-day window runs until 2026-07-22T00:00 — tomorrow. A dueAt built from
    // it would read "in 12 hours" under a red Overdue heading.
    const ev = daily({ start: '2026-07-14' });
    const r = currentStatus(ev, NOW);
    expect(r.dueAt).toBe('2026-07-15T00:00:00'); // the first deadline it blew
    expect(r.dueAt! < NOW).toBe(true);
    expect(r.dueAt).not.toBe(windowEnd(ev, '2026-07-21'));
  });

  it('measures from the start of the current run of misses, so it keeps growing', () => {
    // Neglected since it was created: five days of misses, not "12 hours".
    expect(currentStatus(daily({ start: '2026-07-16' }), NOW).dueAt).toBe('2026-07-17T00:00:00');
  });

  it('the run stops at the last completion', () => {
    const ev = daily({ created: createdOn('2026-07-14'), start: '2026-07-19', completions: { '2026-07-19T09:00:00': '' } });
    expect(currentStatus(ev, NOW).dueAt).toBe('2026-07-21T00:00:00'); // not back to the 15th
  });

  it('a counter with no known origin reports only its most recent blown deadline', () => {
    // No `created`/`start`, so the grid is synthetic (anchored 400 days back).
    // Walking it would claim the habit had been overdue for over a year.
    const ev = daily({ startTime: '08:00:00', duration: 'PT1H' });
    expect(currentStatus(ev, NOW)).toEqual({ status: 'overdue', occurrence: '2026-07-21T08:00:00', dueAt: '2026-07-21T09:00:00' });
  });

  it('a pending row counts down to the moment its window shuts', () => {
    const timed = daily({ start: '2026-07-14', startTime: '11:00:00', duration: 'PT4H', completions: { '2026-07-20T11:00:00': '' } });
    expect(currentStatus(timed, NOW).dueAt).toBe('2026-07-21T15:00:00');
  });

  it('a free tally has no deadline at all', () => {
    expect(currentStatus({ '@type': 'Event', title: 'pushups' }, NOW)).toEqual({ status: 'tally' });
  });

  it('survives the spread into the sorted entry', () => {
    expect(sortedCounters({ a: daily({ start: '2026-07-14' }) }, NOW)[0].dueAt).toBe('2026-07-15T00:00:00');
  });

  // The fence: whatever else changes, an overdue row must never render a future
  // time and a pending row must never render a past one.
  it.each([
    ['all-day, unmet since creation', daily({ start: '2026-07-14' })],
    ['timed, window shut', daily({ start: '2026-07-14', startTime: '10:00:00', duration: 'PT1H', completions: { '2026-07-20T10:30:00': '' } })],
    ['no anchor, timed', daily({ startTime: '08:00:00', duration: 'PT1H' })],
    ['weekly Monday missed', daily({ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'mo' }] } })],
    ['every 3 days, never done', every3()],
    ['every 4 months, brand new', every4Months()],
    ['every 4 months, long neglected', every4Months({ created: createdOn('2025-01-01') })],
    ['timed, created after today\'s window shut', daily({ startTime: '06:00:00', duration: 'PT1H', created: createdAtLocal('2026-07-21T10:00:00') })],
    ['one-shot, day passed', { '@type': 'Event', start: '2026-07-20' } as CounterEvent],
    ['overlapping 30-day windows', daily({ start: '2026-07-14', duration: 'P30D' })],
    ['neglected for months', daily({ created: createdOn('2026-03-01') })],
    ['pending all-day', daily({ start: '2026-07-14', completions: { '2026-07-20T09:00:00': '' } })],
    ['pending timed', daily({ start: '2026-07-14', startTime: '11:00:00', duration: 'PT4H', completions: { '2026-07-20T11:00:00': '' } })],
  ])('%s: overdue is in the past, pending is in the future', (_name, ev) => {
    const r = currentStatus(ev, NOW);
    if (r.status === 'overdue') expect(r.dueAt! <= NOW).toBe(true);
    if (r.status === 'pending') expect(r.dueAt! > NOW).toBe(true);
  });
});

describe('currentStreak', () => {
  it('counts consecutive met days including today', () => {
    const ev = daily({ completions: { '2026-07-19T09:00:00': '', '2026-07-20T09:00:00': '', '2026-07-21T09:00:00': '' } });
    expect(currentStreak(ev, NOW)).toBe(3);
  });

  it('the current unmet-but-open period does not reset the streak', () => {
    const ev = daily({ completions: { '2026-07-19T09:00:00': '', '2026-07-20T09:00:00': '' } });
    expect(currentStreak(ev, NOW)).toBe(2);
  });

  it('resets once a missed occurrence is decided', () => {
    // 18 + 19 met, 20 missed (decided — the 21st has begun), 21 met → streak 1.
    const ev = daily({ completions: { '2026-07-18T09:00:00': '', '2026-07-19T09:00:00': '', '2026-07-21T09:00:00': '' } });
    expect(currentStreak(ev, NOW)).toBe(1);
  });

  it('a closed window today does not reset while a late completion still counts', () => {
    // Timed habit: today's 08–09 window has passed unmet, but the credit period
    // runs until tomorrow's occurrence — yesterday's streak survives.
    const ev = daily({ startTime: '08:00:00', duration: 'PT1H', completions: { '2026-07-20T08:30:00': '' } });
    expect(currentStreak(ev, NOW)).toBe(1);
  });

  it('counts weekly periods', () => {
    const ev = daily({
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'mo' }] },
      completions: { '2026-07-13T09:00:00': '', '2026-07-20T10:00:00': '' },
    });
    expect(currentStreak(ev, NOW)).toBe(2);
  });

  it('non-recurring events have no streak', () => {
    expect(currentStreak({ '@type': 'Event', start: '2026-07-20', completions: { '2026-07-20T10:00:00': '' } }, NOW)).toBe(0);
    expect(currentStreak({ '@type': 'Event', completions: { '2026-07-20T10:00:00': '' } }, NOW)).toBe(0);
  });
});

describe('isArchived', () => {
  it('is true only when the recurrence has an until bound', () => {
    expect(isArchived(daily())).toBe(false);
    expect(isArchived(daily({ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', until: '2026-07-21T09:00:00' } }))).toBe(true);
    expect(isArchived({ '@type': 'Event', title: 'tally' })).toBe(false);
  });

  it('an archived habit generates no occurrences after its until', () => {
    const ev = daily({ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', until: '2026-07-19T00:00:00' } });
    expect(expectedOccurrences(ev, '2026-07-18', '2026-07-25')).toEqual(['2026-07-18', '2026-07-19']);
  });
});

describe('sortedCounters', () => {
  it('orders overdue, pending, done, then schedule-less tallies', () => {
    const events: Record<string, CounterEvent> = {
      t: { '@type': 'Event', title: 'tally' },
      d: daily({ title: 'done', completions: { '2026-07-21T08:00:00': '' } }),
      p: daily({ title: 'pending' }),
      o: daily({ title: 'overdue', recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'mo' }] } }),
    };
    expect(sortedCounters(events, NOW).map(e => e.uid)).toEqual(['o', 'p', 'd', 't']);
  });
});

describe('metMissedByWeek', () => {
  it('counts met and missed decided occurrences per week, excluding the open period', () => {
    const ev = daily({ completions: { '2026-07-13T09:00:00': '', '2026-07-14T09:00:00': '' } });
    const stats = metMissedByWeek({ a: ev }, NOW, 2);
    expect(stats).toHaveLength(2);
    expect(stats[0]).toEqual({ weekStart: '2026-07-13', met: 2, missed: 5 });
    // This week: Mon 20 decided (missed); Tue 21 is the current open period → excluded.
    expect(stats[1]).toEqual({ weekStart: '2026-07-20', met: 0, missed: 1 });
  });

  it('excludes free tallies and future one-shots', () => {
    const events: Record<string, CounterEvent> = {
      t: { '@type': 'Event', completions: { '2026-07-20T09:00:00': '' } },
      f: { '@type': 'Event', start: '2026-08-01' },
    };
    const stats = metMissedByWeek(events, NOW, 4);
    expect(stats.every(s => s.met === 0 && s.missed === 0)).toBe(true);
  });

  it('timed events count met/missed once their period is decided', () => {
    const ev = daily({ startTime: '08:00:00', duration: 'PT1H', completions: { '2026-07-21T08:15:00': '' } });
    const stats = metMissedByWeek({ a: ev }, NOW, 1);
    // Mon 20's window passed unmet; Tue 21's window (08–09) closed met.
    expect(stats[0]).toEqual({ weekStart: '2026-07-20', met: 1, missed: 1 });
  });
});
