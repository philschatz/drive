// Recurrence expansion is the calendar's DoS hot spot: a hostile peer can write
// raw CRDT JSON (or import a crafted .ics) with a recurrence rule that would loop
// forever or throw out of the render path. These tests assert bounded termination
// (independent of Jest's wall-clock timeout) plus no regression on normal rules.
import 'temporal-polyfill/global';
import { generateDates, rebuildExpanded } from './recurrence';
import type { CalendarEvent } from '../../../../shared/schemas/calendar';
import { captureConsole } from '../../../../../tests/support/console';

const RANGE_START = '2026-01-01';
const RANGE_END = '2026-06-30';

describe('generateDates termination (DoS guards)', () => {
  it('terminates with byMonthDay:[32] (a day that never exists)', () => {
    const dates = generateDates('2026-01-15', { frequency: 'monthly', byMonthDay: [32] }, RANGE_START, RANGE_END);
    expect(Array.isArray(dates)).toBe(true);
    expect(dates.length).toBeLessThan(1000);
    expect(dates.length).toBe(0); // no month has a 32nd day
  });

  it('terminates with byMonthDay:[0]', () => {
    const dates = generateDates('2026-01-15', { frequency: 'monthly', byMonthDay: [0] }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(1000);
    expect(dates.length).toBe(0);
  });

  it('terminates with negative byMonthDay and resolves from the month end', () => {
    const dates = generateDates('2026-01-15', { frequency: 'monthly', byMonthDay: [-1] }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(1000);
    expect(dates).toContain('2026-01-31');
    expect(dates).toContain('2026-02-28');
    expect(dates).toContain('2026-06-30');
  });

  it('terminates with an out-of-range negative byMonthDay', () => {
    const dates = generateDates('2026-01-15', { frequency: 'monthly', byMonthDay: [-40] }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(1000);
  });

  it('terminates with an empty byDay (weekly) and falls back to the start weekday', () => {
    const dates = generateDates('2026-01-15', { frequency: 'weekly', byDay: [] }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(1000);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates).toContain('2026-01-15'); // 2026-01-15 is a Thursday
  });

  it('terminates with interval:0 (monthly, never-matching day)', () => {
    const dates = generateDates('2026-01-15', { frequency: 'monthly', interval: 0, byMonthDay: [32] }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(1000);
  });

  it('terminates with interval:0 (weekly, empty byDay)', () => {
    const dates = generateDates('2026-01-15', { frequency: 'weekly', interval: 0, byDay: [] }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(1000);
  });

  it('terminates with interval:0 (daily)', () => {
    const dates = generateDates('2026-01-15', { frequency: 'daily', interval: 0 }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(2000);
  });

  it('terminates with an invalid byDay entry (weekly)', () => {
    const dates = generateDates('2026-01-15', { frequency: 'weekly', byDay: [{ day: 'xx' }] }, RANGE_START, RANGE_END);
    expect(dates.length).toBeLessThan(1000);
  });
});

describe('generateDates correctness (no regression)', () => {
  it('produces correct monthly dates', () => {
    const dates = generateDates('2026-01-15', { frequency: 'monthly' }, '2026-01-01', '2026-04-30');
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('produces correct weekly dates for a single weekday', () => {
    // 2026-01-05 is a Monday
    const dates = generateDates('2026-01-05', { frequency: 'weekly', byDay: [{ day: 'mo' }] }, '2026-01-01', '2026-01-31');
    expect(dates).toEqual(['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
  });

  it('produces correct daily dates with an interval', () => {
    const dates = generateDates('2026-01-01', { frequency: 'daily', interval: 2 }, '2026-01-01', '2026-01-07');
    expect(dates).toEqual(['2026-01-01', '2026-01-03', '2026-01-05', '2026-01-07']);
  });

  it('carries the time part through for timed events', () => {
    const dates = generateDates('2026-01-01T09:30:00', { frequency: 'daily' }, '2026-01-01', '2026-01-03');
    expect(dates).toEqual(['2026-01-01T09:30:00', '2026-01-02T09:30:00', '2026-01-03T09:30:00']);
  });
});

describe('rebuildExpanded robustness', () => {
  it('skips events whose expansion throws and keeps the rest', () => {
    const events: Record<string, CalendarEvent> = {
      good: { '@type': 'Event', title: 'Good', start: '2026-01-10', duration: 'P1D' } as any,
      bad: { '@type': 'Event', title: 'Bad', start: 'not-a-real-date', recurrenceRule: { frequency: 'monthly' } } as any,
    };
    let expanded: ReturnType<typeof rebuildExpanded> = [];
    // The `bad` event's expansion throws and logs an expected warning — swallow it.
    const con = captureConsole(['warn']);
    expect(() => { expanded = rebuildExpanded(events, '2026-01-01', '2026-01-31'); }).not.toThrow();
    con.restore();
    expect(expanded.map(e => e.uid)).toContain('good');
    expect(expanded.map(e => e.uid)).not.toContain('bad');
  });

  it('expands a well-formed recurring event within range', () => {
    const events: Record<string, CalendarEvent> = {
      weekly: {
        '@type': 'Event', title: 'Weekly', start: '2026-01-05', duration: 'PT1H',
        recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo' }] },
      } as any,
    };
    const expanded = rebuildExpanded(events, '2026-01-01', '2026-01-31');
    const dates = expanded.filter(e => e.uid === 'weekly').map(e => e.recurrenceDate).sort();
    expect(dates).toEqual(['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);
  });
});
