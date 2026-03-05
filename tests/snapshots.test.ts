import { icsToEvent } from '../src/backend/parser';
import { eventToICS, calendarToIcs } from '../src/backend/serializer';
import type { CalendarEvent } from '../src/shared/schemas';

const allDayIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Automerge Calendar//EN
BEGIN:VEVENT
UID:allday-1
SUMMARY:Company Holiday
DESCRIPTION:Office closed for holiday
DTSTART;VALUE=DATE:20240320
DURATION:P1D
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

const recurringIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Automerge Calendar//EN
BEGIN:VEVENT
UID:recurring-1
DTSTAMP:20240101T120000Z
DTSTART;TZID=America/New_York:20240115T090000
DURATION:PT1H
SUMMARY:Weekly Standup
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10
END:VEVENT
END:VCALENDAR`;

const recurringWithOverrideIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Automerge Calendar//EN
BEGIN:VEVENT
UID:recurring-override-1
DTSTAMP:20240101T120000Z
DTSTART;TZID=Europe/London:20240115T100000
DURATION:PT30M
SUMMARY:Daily Check-in
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT
BEGIN:VEVENT
UID:recurring-override-1
DTSTAMP:20240101T120000Z
RECURRENCE-ID;TZID=Europe/London:20240117T100000
DTSTART;TZID=Europe/London:20240117T140000
DURATION:PT30M
SUMMARY:Daily Check-in (moved)
END:VEVENT
END:VCALENDAR`;

const recurringWithDeletedIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Automerge Calendar//EN
BEGIN:VEVENT
UID:recurring-deleted-1
DTSTAMP:20240101T120000Z
DTSTART;TZID=US/Eastern:20240101T180000
DURATION:PT2H
SUMMARY:Book Club
RRULE:FREQ=MONTHLY;BYDAY=1FR
EXDATE;TZID=US/Eastern:20240202T180000
EXDATE;TZID=US/Eastern:20240405T180000
END:VEVENT
END:VCALENDAR`;

const noTimezoneIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Automerge Calendar//EN
BEGIN:VEVENT
UID:floating-1
DTSTAMP:20240101T120000Z
DTSTART:20240215T120000
DURATION:PT45M
SUMMARY:Lunch Break
END:VEVENT
END:VCALENDAR`;

const endTimeIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Automerge Calendar//EN
BEGIN:VEVENT
UID:endtime-1
DTSTAMP:20240101T120000Z
DTSTART:20240310T080000Z
DTEND:20240310T173000Z
SUMMARY:Conference Day
DESCRIPTION:All-day conference session
LOCATION:Convention Center
END:VEVENT
END:VCALENDAR`;

describe('Parser snapshots', () => {
  it('all-day event', () => {
    expect(icsToEvent(allDayIcs)).toMatchSnapshot();
  });

  it('recurring event', () => {
    expect(icsToEvent(recurringIcs)).toMatchSnapshot();
  });

  it('recurring event with overridden entry', () => {
    expect(icsToEvent(recurringWithOverrideIcs)).toMatchSnapshot();
  });

  it('recurring event with deleted occurrences', () => {
    expect(icsToEvent(recurringWithDeletedIcs)).toMatchSnapshot();
  });

  it('event with no timezone', () => {
    expect(icsToEvent(noTimezoneIcs)).toMatchSnapshot();
  });

  it('event with end time instead of duration', () => {
    expect(icsToEvent(endTimeIcs)).toMatchSnapshot();
  });
});

describe('Serializer snapshots', () => {
  it('all-day event', () => {
    const event: CalendarEvent = {
      '@type': 'Event',
      title: 'Company Holiday',
      description: 'Office closed for holiday',
      start: '2024-03-20',
      timeZone: null,
      duration: 'P1D',
      status: 'confirmed',
    };
    expect(eventToICS('allday-1', event)).toMatchSnapshot();
  });

  it('recurring event', () => {
    const event: CalendarEvent = {
      '@type': 'Event',
      title: 'Weekly Standup',
      start: '2024-01-15T09:00:00',
      timeZone: 'America/New_York',
      duration: 'PT1H',
      recurrenceRule: {
        '@type': 'RecurrenceRule',
        frequency: 'weekly',
        byDay: [{ '@type': 'NDay', day: 'mo' }],
        count: 10,
      },
    };
    expect(eventToICS('recurring-1', event)).toMatchSnapshot();
  });

  it('recurring event with overridden entry', () => {
    const event: CalendarEvent = {
      '@type': 'Event',
      title: 'Daily Check-in',
      start: '2024-01-15T10:00:00',
      timeZone: 'Europe/London',
      duration: 'PT30M',
      recurrenceRule: {
        '@type': 'RecurrenceRule',
        frequency: 'daily',
        count: 5,
      },
      recurrenceOverrides: {
        '2024-01-17T10:00:00': {
          title: 'Daily Check-in (moved)',
          start: '2024-01-17T14:00:00',
        },
      },
    };
    expect(eventToICS('recurring-override-1', event)).toMatchSnapshot();
  });

  it('recurring event with deleted occurrences', () => {
    const event: CalendarEvent = {
      '@type': 'Event',
      title: 'Book Club',
      start: '2024-01-01T18:00:00',
      timeZone: 'US/Eastern',
      duration: 'PT2H',
      recurrenceRule: {
        '@type': 'RecurrenceRule',
        frequency: 'monthly',
        byDay: [{ '@type': 'NDay', day: 'fr', nthOfPeriod: 1 }],
      },
      recurrenceOverrides: {
        '2024-02-02T18:00:00': { excluded: true } as any,
        '2024-04-05T18:00:00': { excluded: true } as any,
      },
    };
    expect(eventToICS('recurring-deleted-1', event)).toMatchSnapshot();
  });

  it('event with no timezone', () => {
    const event: CalendarEvent = {
      '@type': 'Event',
      title: 'Lunch Break',
      start: '2024-02-15T12:00:00',
      timeZone: null,
      duration: 'PT45M',
    };
    expect(eventToICS('floating-1', event)).toMatchSnapshot();
  });

  it('event with end time (serialized as duration)', () => {
    const event: CalendarEvent = {
      '@type': 'Event',
      title: 'Conference Day',
      description: 'All-day conference session',
      start: '2024-03-10T08:00:00',
      timeZone: 'Etc/UTC',
      duration: 'PT9H30M',
      location: 'Convention Center',
    };
    expect(eventToICS('endtime-1', event)).toMatchSnapshot();
  });
});

describe('Round-trip snapshots', () => {
  function roundtripHelper(ics: string) {
    const parsed = icsToEvent(ics);
    const reserialized = eventToICS(parsed[0].uid, parsed[0].event);
    expect(reserialized.trim()).toEqual(ics);
  }

  it('all-day event round-trips', () => {
    roundtripHelper(allDayIcs);
  });

  it('recurring event round-trips', () => {
    const parsed = icsToEvent(recurringIcs);
    const reserialized = eventToICS(parsed[0].uid, parsed[0].event);
    expect(reserialized).toMatchSnapshot();
  });

  it('recurring with override round-trips', () => {
    const parsed = icsToEvent(recurringWithOverrideIcs);
    const reserialized = eventToICS(parsed[0].uid, parsed[0].event);
    expect(reserialized).toMatchSnapshot();
  });

  it('recurring with deleted occurrences round-trips', () => {
    const parsed = icsToEvent(recurringWithDeletedIcs);
    const reserialized = eventToICS(parsed[0].uid, parsed[0].event);
    expect(reserialized).toMatchSnapshot();
  });

  it('calendarToIcs with mixed events', () => {
    const events = [
      ...icsToEvent(allDayIcs),
      ...icsToEvent(recurringIcs),
      ...icsToEvent(noTimezoneIcs),
    ];
    const calendar = calendarToIcs(events, 'Test Calendar');
    expect(calendar).toMatchSnapshot();
  });
});
