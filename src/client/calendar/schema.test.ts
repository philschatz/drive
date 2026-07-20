import { validateDocument } from '../../shared/schemas';
import { validateCalendarEvent } from './schema';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function hasPath(errors: { path: (string | number)[] }[], expected: (string | number)[]) {
  return errors.some(e =>
    e.path.length === expected.length && e.path.every((v, i) => v === expected[i])
  );
}

// ---------------------------------------------------------------------------
// Calendar document
// ---------------------------------------------------------------------------

describe('Calendar document validation', () => {
  const validCalendar = {
    '@type': 'Calendar',
    name: 'My Calendar',
    events: {},
  };

  it('accepts a minimal valid calendar', () => {
    expect(validateDocument(validCalendar)).toEqual([]);
  });

  it('accepts a calendar with optional fields', () => {
    const doc = { ...validCalendar, description: 'desc', color: '#fff', timeZone: 'America/New_York' };
    expect(validateDocument(doc)).toEqual([]);
  });

  it('rejects missing @type', () => {
    const errors = validateDocument({ name: 'x', events: {} });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown @type', () => {
    const errors = validateDocument({ '@type': 'Foo', name: 'x' });
    expect(errors).toEqual([{ path: ['@type'], message: expect.stringContaining('Unknown') }]);
  });

  it('rejects missing name', () => {
    const errors = validateDocument({ '@type': 'Calendar', events: {} });
    expect(hasPath(errors, ['name'])).toBe(true);
  });

  it('rejects missing events', () => {
    const errors = validateDocument({ '@type': 'Calendar', name: 'x' });
    expect(hasPath(errors, ['events'])).toBe(true);
  });

  it('validates nested events', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: { '@type': 'Event', title: 'Test', start: '2025-01-15T10:00' },
      },
    };
    expect(validateDocument(doc)).toEqual([]);
  });

  it('reports errors inside events with path', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: { '@type': 'Event', priority: 99 },
      },
    };
    const errors = validateDocument(doc);
    expect(hasPath(errors, ['events', 'e1', 'priority'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CalendarEvent
// ---------------------------------------------------------------------------

describe('CalendarEvent validation', () => {
  it('accepts a minimal event', () => {
    expect(validateCalendarEvent({ '@type': 'Event' })).toEqual([]);
  });

  it('rejects wrong @type', () => {
    const errors = validateCalendarEvent({ '@type': 'Task' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('validates start date format', () => {
    expect(validateCalendarEvent({ '@type': 'Event', start: '2025-01-15' })).toEqual([]);
    expect(validateCalendarEvent({ '@type': 'Event', start: '2025-01-15T10:00' })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', start: 'not-a-date' });
    expect(hasPath(errors, ['start'])).toBe(true);
  });

  it('validates duration format', () => {
    expect(validateCalendarEvent({ '@type': 'Event', duration: 'PT1H' })).toEqual([]);
    expect(validateCalendarEvent({ '@type': 'Event', duration: 'P1DT2H30M' })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', duration: '1 hour' });
    expect(hasPath(errors, ['duration'])).toBe(true);
  });

  it('validates status enum', () => {
    expect(validateCalendarEvent({ '@type': 'Event', status: 'confirmed' })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', status: 'maybe' });
    expect(hasPath(errors, ['status'])).toBe(true);
  });

  it('validates recurrence rule', () => {
    const event = {
      '@type': 'Event',
      recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'fr' }] },
    };
    expect(validateCalendarEvent(event)).toEqual([]);
  });

  it('rejects invalid recurrence frequency', () => {
    const errors = validateCalendarEvent({
      '@type': 'Event',
      recurrenceRule: { frequency: 'biweekly' },
    });
    expect(hasPath(errors, ['recurrenceRule', 'frequency'])).toBe(true);
  });

  it('validates priority range', () => {
    expect(validateCalendarEvent({ '@type': 'Event', priority: 5 })).toEqual([]);
    const errors = validateCalendarEvent({ '@type': 'Event', priority: 10 });
    expect(hasPath(errors, ['priority'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Calendar data dependencies
// ---------------------------------------------------------------------------

describe('Calendar data dependencies', () => {
  it('flags mutually exclusive count and until', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          recurrenceRule: { frequency: 'daily', count: 5, until: '2025-12-31' },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('mutually exclusive'))).toBe(true);
  });

  it('flags nthOfPeriod with weekly frequency', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo', nthOfPeriod: 2 }] },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('nthOfPeriod'))).toBe(true);
  });

  it('allows nthOfPeriod with monthly frequency', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 2 }] },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.filter(e => e.message.includes('nthOfPeriod'))).toEqual([]);
  });

  it('flags dangling participant locationId', () => {
    const doc = {
      '@type': 'Calendar',
      name: 'cal',
      events: {
        e1: {
          '@type': 'Event',
          participants: { p1: { locationId: 'loc1' } },
          replyTo: { imip: 'mailto:a@b.com' },
        },
      },
    };
    const errors = validateDocument(doc);
    expect(errors.some(e => e.message.includes('locationId') && e.message.includes('loc1'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Calendar recurrence & render robustness (Group B — DoS / crash hardening)
// ---------------------------------------------------------------------------

describe('Calendar recurrence & render robustness', () => {
  function calWithEvent(ev: any) {
    return { '@type': 'Calendar', name: 'cal', events: { e1: { '@type': 'Event', ...ev } } };
  }

  it('flags byMonthDay of 0', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'monthly', byMonthDay: [0] } }));
    expect(hasPath(errors, ['events', 'e1', 'recurrenceRule', 'byMonthDay', 0])).toBe(true);
  });

  it('flags byMonthDay above 31', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'monthly', byMonthDay: [32] } }));
    expect(errors.some(e => e.path.includes('byMonthDay'))).toBe(true);
  });

  it('flags byMonthDay below -31', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'monthly', byMonthDay: [-40] } }));
    expect(errors.some(e => e.path.includes('byMonthDay'))).toBe(true);
  });

  it('accepts a valid negative byMonthDay', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'monthly', byMonthDay: [-1] } }));
    expect(errors.some(e => e.path.includes('byMonthDay'))).toBe(false);
  });

  it('accepts monthly byMonthDay of 31', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'monthly', byMonthDay: [31] } }));
    expect(errors).toEqual([]);
  });

  it('flags weekly frequency with an empty byDay', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15T10:00:00', recurrenceRule: { frequency: 'weekly', byDay: [] } }));
    expect(errors.some(e => e.path.includes('byDay') && e.kind === 'dependency')).toBe(true);
  });

  it('flags interval of 0', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'daily', interval: 0 } }));
    expect(hasPath(errors, ['events', 'e1', 'recurrenceRule', 'interval'])).toBe(true);
  });

  it('flags count of 0', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'daily', count: 0 } }));
    expect(hasPath(errors, ['events', 'e1', 'recurrenceRule', 'count'])).toBe(true);
  });

  it('flags an unparseable start that passes the regex', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-13-01' }));
    expect(errors.some(e => e.path.includes('start'))).toBe(true);
  });

  it('flags an unparseable duration that passes the regex', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15T10:00:00', duration: 'P' }));
    expect(errors.some(e => e.path.includes('duration'))).toBe(true);
  });

  it('flags an invalid timeZone', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15T10:00:00', timeZone: 'Bogus/Zone' }));
    expect(errors.some(e => e.path.includes('timeZone'))).toBe(true);
  });

  it('flags a non-hex event color', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', color: 'red' }));
    expect(errors.some(e => e.path.includes('color'))).toBe(true);
  });

  it('flags a non-hex document color', () => {
    const errors = validateDocument({ '@type': 'Calendar', name: 'cal', color: 'blue', events: {} });
    expect(hasPath(errors, ['color'])).toBe(true);
  });

  it('accepts a 3-digit hex color (app legitimately uses these)', () => {
    const errors = validateDocument({ '@type': 'Calendar', name: 'cal', color: '#fff', events: {} });
    expect(errors).toEqual([]);
  });

  it('accepts a local-datetime start with seconds', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15T10:00:00' }));
    expect(errors.some(e => e.path.includes('start'))).toBe(false);
  });

  it('produces no errors for a well-formed recurring event (no false positives)', () => {
    const errors = validateDocument(calWithEvent({
      start: '2025-01-15T10:00:00',
      duration: 'PT1H',
      timeZone: 'America/New_York',
      color: '#039be5',
      recurrenceRule: { frequency: 'weekly', interval: 2, byDay: [{ day: 'mo' }, { day: 'we' }], count: 5 },
    }));
    expect(errors).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// Calendar: extended recurrence & field validation (Group E)
// ---------------------------------------------------------------------------

describe('Calendar extended validation', () => {
  function calWithEvent(ev: any) {
    return { '@type': 'Calendar', name: 'cal', events: { e1: { '@type': 'Event', ...ev } } };
  }

  it('flags byYearDay of 0', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'yearly', byYearDay: [0] } }));
    expect(hasPath(errors, ['events', 'e1', 'recurrenceRule', 'byYearDay', 0])).toBe(true);
  });

  it('accepts a valid byYearDay', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'yearly', byYearDay: [100, -1] } }));
    expect(errors.some(e => e.path.includes('byYearDay'))).toBe(false);
  });

  it('flags byWeekNo of 0', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'yearly', byWeekNo: [0] } }));
    expect(hasPath(errors, ['events', 'e1', 'recurrenceRule', 'byWeekNo', 0])).toBe(true);
  });

  it('flags bySetPosition of 0', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'monthly', bySetPosition: [0] } }));
    expect(hasPath(errors, ['events', 'e1', 'recurrenceRule', 'bySetPosition', 0])).toBe(true);
  });

  it('flags an invalid byMonth value', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'yearly', byMonth: ['13x'] } }));
    expect(hasPath(errors, ['events', 'e1', 'recurrenceRule', 'byMonth', 0])).toBe(true);
  });

  it('flags a byMonth of "0"', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'yearly', byMonth: ['0'] } }));
    expect(errors.some(e => e.path.includes('byMonth'))).toBe(true);
  });

  it('accepts valid byMonth values (importer stores "1".."12")', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'yearly', byMonth: ['1', '6', '12'] } }));
    expect(errors.some(e => e.path.includes('byMonth'))).toBe(false);
  });

  it('flags an nthOfPeriod of 0', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'mo', nthOfPeriod: 0 }] } }));
    expect(errors.some(e => e.path.includes('nthOfPeriod'))).toBe(true);
  });

  it('flags an unparseable recurrenceOverrides key', () => {
    const errors = validateDocument(calWithEvent({
      start: '2025-01-15',
      recurrenceRule: { frequency: 'daily' },
      recurrenceOverrides: { 'not-a-date': { excluded: true } },
    }));
    expect(errors.some(e => e.path.includes('recurrenceOverrides') && e.message.includes('not-a-date'))).toBe(true);
  });

  it('accepts a valid recurrenceOverrides key', () => {
    const errors = validateDocument(calWithEvent({
      start: '2025-01-15T10:00:00',
      recurrenceRule: { frequency: 'daily' },
      recurrenceOverrides: { '2025-01-16T10:00:00': { excluded: true } },
    }));
    expect(errors.some(e => e.path.includes('recurrenceOverrides'))).toBe(false);
  });

  it('flags an invalid document-level timeZone', () => {
    const errors = validateDocument({ '@type': 'Calendar', name: 'cal', timeZone: 'Bogus/Zone', events: {} });
    expect(hasPath(errors, ['timeZone'])).toBe(true);
  });

  it('flags an invalid recurrenceIdTimeZone', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceIdTimeZone: 'Bogus/Zone' }));
    expect(errors.some(e => e.path.includes('recurrenceIdTimeZone'))).toBe(true);
  });

  it('flags an unparseable recurrenceId', () => {
    const errors = validateDocument(calWithEvent({ start: '2025-01-15', recurrenceId: '2025-13-01' }));
    expect(errors.some(e => e.path.includes('recurrenceId'))).toBe(true);
  });

  it('flags a javascript: URL in links', () => {
    const errors = validateDocument(calWithEvent({
      start: '2025-01-15',
      links: { l1: { '@type': 'Link', href: 'javascript:alert(1)' } },
    }));
    expect(hasPath(errors, ['events', 'e1', 'links', 'l1', 'href'])).toBe(true);
  });

  it('flags a javascript: URI in virtualLocations (whitespace-obfuscated)', () => {
    const errors = validateDocument(calWithEvent({
      start: '2025-01-15',
      virtualLocations: { v1: { '@type': 'VirtualLocation', uri: '  java\tscript:alert(1)' } },
    }));
    expect(errors.some(e => e.path.includes('virtualLocations') && e.path.includes('uri'))).toBe(true);
  });

  it('accepts safe URLs in links / attachments / virtualLocations', () => {
    const errors = validateDocument(calWithEvent({
      start: '2025-01-15',
      links: { l1: { '@type': 'Link', href: 'https://example.com/x' } },
      attachments: { a1: { '@type': 'Link', href: 'mailto:a@b.com' } },
      virtualLocations: { v1: { '@type': 'VirtualLocation', uri: 'https://zoom.us/j/123' } },
    }));
    expect(errors).toEqual([]);
  });

  it('produces no errors for a fully-populated well-formed event (no false positives)', () => {
    const errors = validateDocument({
      '@type': 'Calendar', name: 'cal', color: '#039be5', timeZone: 'America/New_York',
      events: {
        e1: {
          '@type': 'Event',
          start: '2025-01-15T10:00:00', duration: 'PT1H', timeZone: 'America/New_York',
          recurrenceId: '2025-01-15T10:00:00', recurrenceIdTimeZone: 'America/New_York',
          recurrenceRule: {
            frequency: 'monthly', interval: 2,
            byMonth: ['1', '7'], byMonthDay: [15], byYearDay: [100], byWeekNo: [10], bySetPosition: [1],
            byDay: [{ day: 'mo', nthOfPeriod: 2 }], count: 5,
          },
          recurrenceOverrides: { '2025-03-15T10:00:00': { excluded: true } },
          links: { l1: { '@type': 'Link', href: 'https://example.com' } },
          virtualLocations: { v1: { '@type': 'VirtualLocation', uri: 'https://meet.example/room' } },
        },
      },
    });
    expect(errors).toEqual([]);
  });
});

