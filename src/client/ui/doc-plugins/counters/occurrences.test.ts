import 'temporal-polyfill/global';
import {
  expectedOccurrences, metInPeriod, windowEnd, currentStatus, currentStreak, sortedCounters, metMissedByWeek, isArchived,
  createdDate, reanchorDate, parseReward, formatReward, windowEndTime, windowDuration,
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

/** Every 3 days from `created`, i.e. a rule whose grid depends on its anchor. */
const every3 = (extra: Partial<CounterEvent> = {}): CounterEvent => ({
  '@type': 'Event',
  title: 'water plants',
  created: createdOn('2026-07-01'),
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', interval: 3 },
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
    // Next due is 3 days after it was done (the 23rd), not after the 22nd.
    expect(currentStatus(ev, NOW)).toEqual({ status: 'done', occurrence: '2026-07-20' });
  });

  it('without a completion the grid still runs from `created`', () => {
    expect(expectedOccurrences(every3(), '2026-07-01', '2026-07-10')).toEqual(['2026-07-01', '2026-07-04', '2026-07-07', '2026-07-10']);
    expect(currentStatus(every3(), NOW)).toEqual({ status: 'overdue', occurrence: '2026-07-19' });
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
    expect(currentStatus(daily({ start: '2026-07-14' }), NOW)).toEqual({ status: 'overdue', occurrence: '2026-07-21' });
  });

  it('daily with yesterday met and today unmet (window open) → pending', () => {
    const ev = daily({ start: '2026-07-14', completions: { '2026-07-20T09:00:00': '' } });
    expect(currentStatus(ev, NOW)).toEqual({ status: 'pending', occurrence: '2026-07-21' });
  });

  it('daily created today, unmet, window open → pending', () => {
    expect(currentStatus(daily({ start: '2026-07-21' }), NOW)).toEqual({ status: 'pending', occurrence: '2026-07-21' });
  });

  it('daily with today met → done', () => {
    expect(currentStatus(daily({ completions: { '2026-07-21T08:00:00': '' } }), NOW)).toEqual({ status: 'done', occurrence: '2026-07-21' });
  });

  it('weekly Monday, now Tuesday, missed → overdue until the next occurrence', () => {
    const ev = daily({ recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', byDay: [{ '@type': 'NDay', day: 'mo' }] } });
    expect(currentStatus(ev, NOW)).toEqual({ status: 'overdue', occurrence: '2026-07-20' });
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
