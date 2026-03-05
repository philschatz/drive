import { icsToEvent } from '../src/backend/parser';
import type { CalendarEvent } from '../src/shared/schemas';

describe('ICS to JMAP Parser', () => {
  describe('Basic Event Parsing', () => {
    it('should parse a simple event', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-event-123
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
DTEND:20240115T150000Z
SUMMARY:Test Meeting
DESCRIPTION:This is a test event
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events).toHaveLength(1);
      expect(events[0].uid).toBe('test-event-123');
      expect(events[0].event.title).toBe('Test Meeting');
      expect(events[0].event.description).toBe('This is a test event');
    });

    it('should parse event with location', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:test-event-456
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Meeting with Location
LOCATION:Conference Room A
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.location).toBe('Conference Room A');
    });

    it('should parse all-day event', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:all-day-event
DTSTAMP:20240101T120000Z
DTSTART;VALUE=DATE:20240115
SUMMARY:All Day Event
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.start).toBe('2024-01-15');
    });
  });

  describe('Status and Classification', () => {
    it('should parse event status', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:status-test
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Status Test
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.status).toBe('confirmed');
    });

    it('should parse transparency', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:transp-test
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Transparency Test
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.freeBusyStatus).toBe('free');
    });

    it('should parse classification', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:class-test
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Private Event
CLASS:PRIVATE
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.privacy).toBe('private');
    });
  });

  describe('Participants', () => {
    it('should parse organizer', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:organizer-test
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Meeting with Organizer
ORGANIZER;CN=John Doe:mailto:john@example.com
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.participants).toBeDefined();
      const organizer = Object.values(events[0].event.participants || {})[0];
      expect(organizer.name).toBe('John Doe');
      expect(organizer.email).toBe('john@example.com');
      expect(organizer.roles?.owner).toBe(true);
    });

    it('should parse attendees', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:attendee-test
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Meeting with Attendees
ORGANIZER;CN=John Doe:mailto:john@example.com
ATTENDEE;CN=Jane Smith;PARTSTAT=ACCEPTED:mailto:jane@example.com
ATTENDEE;CN=Bob Johnson;PARTSTAT=TENTATIVE:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.participants).toBeDefined();
      const participants = Object.values(events[0].event.participants || {});
      expect(participants).toHaveLength(3); // 1 organizer + 2 attendees
    });
  });

  describe('Recurrence', () => {
    it('should parse daily recurrence', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recurring-daily
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Daily Meeting
RRULE:FREQ=DAILY;COUNT=10
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.recurrenceRule).toBeDefined();
      expect(events[0].event.recurrenceRule?.frequency).toBe('daily');
      expect(events[0].event.recurrenceRule?.count).toBe(10);
    });

    it('should parse weekly recurrence with BYDAY', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recurring-weekly
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Weekly Meeting
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.recurrenceRule).toBeDefined();
      expect(events[0].event.recurrenceRule?.frequency).toBe('weekly');
      expect(events[0].event.recurrenceRule?.byDay).toBeDefined();
      expect(events[0].event.recurrenceRule?.byDay?.length).toBe(3);
    });

    it('should parse EXDATE', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recurring-with-exdate
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Recurring with Exception
RRULE:FREQ=DAILY;COUNT=10
EXDATE:20240117T140000Z
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.recurrenceOverrides).toBeDefined();
      expect(Object.keys(events[0].event.recurrenceOverrides || {}).length).toBeGreaterThan(0);
    });
  });

  describe('Alarms', () => {
    it('should parse alarm with offset trigger', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-with-alarm
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Event with Alarm
BEGIN:VALARM
TRIGGER:-PT15M
ACTION:DISPLAY
DESCRIPTION:Reminder
END:VALARM
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.alerts).toBeDefined();
      const alert = Object.values(events[0].event.alerts || {})[0];
      expect(alert.trigger['@type']).toBe('OffsetTrigger');
      expect(alert.action).toBe('display');
    });
  });

  describe('Virtual Locations', () => {
    it('should detect Zoom links as virtual locations', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:zoom-meeting
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Zoom Meeting
URL:https://zoom.us/j/123456789
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.virtualLocations).toBeDefined();
      expect(events[0].event.virtualLocations?.['virtual-1'].uri).toContain('zoom');
    });

    it('should detect Google Meet links as virtual locations', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:meet-meeting
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Google Meet
URL:https://meet.google.com/abc-defg-hij
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.virtualLocations).toBeDefined();
      expect(events[0].event.virtualLocations?.['virtual-1'].uri).toContain('meet');
    });
  });

  describe('Multiple Events', () => {
    it('should parse multiple events', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-1
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Event 1
END:VEVENT
BEGIN:VEVENT
UID:event-2
DTSTAMP:20240101T120000Z
DTSTART:20240116T140000Z
SUMMARY:Event 2
END:VEVENT
BEGIN:VEVENT
UID:event-3
DTSTAMP:20240101T120000Z
DTSTART:20240117T140000Z
SUMMARY:Event 3
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events).toHaveLength(3);
      expect(events[0].event.title).toBe('Event 1');
      expect(events[1].event.title).toBe('Event 2');
      expect(events[2].event.title).toBe('Event 3');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty calendar', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events).toHaveLength(0);
    });
  });

  describe('Categories and Keywords', () => {
    it('should parse categories', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:categories-test
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Event with Categories
CATEGORIES:MEETING,WORK,IMPORTANT
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.categories).toBeDefined();
      expect(Object.keys(events[0].event.categories || {}).length).toBeGreaterThan(0);
    });
  });

  describe('Attachments', () => {
    it('should parse attachments', () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:attachment-test
DTSTAMP:20240101T120000Z
DTSTART:20240115T140000Z
SUMMARY:Event with Attachment
ATTACH;FMTTYPE=application/pdf:https://example.com/document.pdf
END:VEVENT
END:VCALENDAR`;

      const events = icsToEvent(ics);

      expect(events[0].event.attachments).toBeDefined();
      const attachment = Object.values(events[0].event.attachments || {})[0];
      expect(attachment.href).toContain('example.com');
      expect(attachment.contentType).toBe('application/pdf');
    });
  });
});
