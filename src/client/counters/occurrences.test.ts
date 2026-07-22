import 'temporal-polyfill/global';
import {
  expectedOccurrences, metInPeriod, windowEnd, currentStatus, sortedCounters, metMissedByWeek, isArchived,
} from './occurrences';
import type { CounterEvent } from './schema';

const NOW = '2026-07-21T12:00:00'; // a Tuesday

const daily = (extra: Partial<CounterEvent> = {}): CounterEvent => ({
  '@type': 'Event',
  title: 'stretch',
  recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
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
