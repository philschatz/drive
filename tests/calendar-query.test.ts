import { expandRange, calendarQuery } from '../src/client/calendar/calendar-query';
import { one } from '../src/shared/jq';

describe('expandRange', () => {
  it('expands a range by ±1 month', () => {
    const result = expandRange('2026-03-01', '2026-03-31');
    expect(result.start).toBe('2026-02-01');
    expect(result.end).toBe('2026-05-01');
  });

  it('handles year boundary going backward', () => {
    const result = expandRange('2026-01-15', '2026-02-15');
    expect(result.start).toBe('2025-12-15');
    expect(result.end).toBe('2026-03-15');
  });

  it('handles year boundary going forward', () => {
    const result = expandRange('2025-12-01', '2025-12-31');
    expect(result.start).toBe('2025-11-01');
    expect(result.end).toBe('2026-01-31');
  });
});

describe('calendarQuery', () => {
  const doc = {
    '@type': 'Calendar',
    name: 'Test Cal',
    description: 'A test',
    color: '#ff0000',
    timeZone: 'America/New_York',
    events: {
      'ev-in-range': {
        '@type': 'Event',
        title: 'In Range',
        start: '2026-03-15',
        duration: 'P1D',
        timeZone: null,
      },
      'ev-before-range': {
        '@type': 'Event',
        title: 'Before Range',
        start: '2025-01-01',
        duration: 'P1D',
        timeZone: null,
      },
      'ev-after-range': {
        '@type': 'Event',
        title: 'After Range',
        start: '2027-06-01',
        duration: 'P1D',
        timeZone: null,
      },
      'ev-recurring': {
        '@type': 'Event',
        title: 'Weekly Meeting',
        start: '2024-01-01',
        duration: 'PT1H',
        timeZone: null,
        recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo' }] },
      },
      'ev-recurring-ended': {
        '@type': 'Event',
        title: 'Old Series',
        start: '2020-01-01',
        duration: 'PT1H',
        timeZone: null,
        recurrenceRule: { frequency: 'daily', until: '2021-12-31' },
      },
      'ev-recurring-future': {
        '@type': 'Event',
        title: 'Future Series',
        start: '2028-01-01',
        duration: 'PT1H',
        timeZone: null,
        recurrenceRule: { frequency: 'weekly' },
      },
    },
  };

  it('includes events within the date range', async () => {
    const query = calendarQuery('2026-02-01', '2026-04-30');
    const result = await one(query, doc);
    expect(result.events['ev-in-range']).toBeDefined();
    expect(result.events['ev-in-range'].title).toBe('In Range');
  });

  it('excludes events outside the date range', async () => {
    const query = calendarQuery('2026-02-01', '2026-04-30');
    const result = await one(query, doc);
    expect(result.events['ev-before-range']).toBeUndefined();
    expect(result.events['ev-after-range']).toBeUndefined();
  });

  it('always includes recurring events regardless of start date', async () => {
    const query = calendarQuery('2026-02-01', '2026-04-30');
    const result = await one(query, doc);
    expect(result.events['ev-recurring']).toBeDefined();
    expect(result.events['ev-recurring'].title).toBe('Weekly Meeting');
  });

  it('still returns calendar metadata', async () => {
    const query = calendarQuery('2026-02-01', '2026-04-30');
    const result = await one(query, doc);
    expect(result.name).toBe('Test Cal');
    expect(result.description).toBe('A test');
    expect(result.color).toBe('#ff0000');
    expect(result.timeZone).toBe('America/New_York');
  });

  it('returns defaults for missing metadata', async () => {
    const query = calendarQuery('2026-01-01', '2026-12-31');
    const result = await one(query, { events: {} });
    expect(result.name).toBe('Calendar');
    expect(result.description).toBe('');
    expect(result.color).toBe('#039be5');
    expect(result.events).toEqual({});
  });

  it('handles events at range boundaries', async () => {
    const query = calendarQuery('2026-03-15', '2026-03-15');
    const result = await one(query, doc);
    expect(result.events['ev-in-range']).toBeDefined();
    expect(result.events['ev-before-range']).toBeUndefined();
    expect(result.events['ev-after-range']).toBeUndefined();
  });

  it('excludes recurring events whose until date is before the range', async () => {
    const query = calendarQuery('2026-02-01', '2026-04-30');
    const result = await one(query, doc);
    expect(result.events['ev-recurring-ended']).toBeUndefined();
  });

  it('excludes recurring events that start after the range', async () => {
    const query = calendarQuery('2026-02-01', '2026-04-30');
    const result = await one(query, doc);
    expect(result.events['ev-recurring-future']).toBeUndefined();
  });

  it('includes recurring events with until date within the range', async () => {
    const query = calendarQuery('2021-06-01', '2022-06-01');
    const result = await one(query, doc);
    expect(result.events['ev-recurring-ended']).toBeDefined();
  });
});
