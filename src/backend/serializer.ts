import type { CalendarEvent, RecurrenceRule } from '../shared/schemas';

/**
 * Escape iCalendar special characters
 */
function escapeICS(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Convert JMAP Alert to iCalendar VALARM component
 */
function alertToVALARM(alert: any): string {
  let valarm = 'BEGIN:VALARM\n';

  // ACTION (default to DISPLAY)
  const action = alert.action || 'display';
  valarm += `ACTION:${action.toUpperCase()}\n`;

  // TRIGGER
  if (alert.trigger) {
    if (alert.trigger['@type'] === 'OffsetTrigger') {
      // Offset trigger (relative to start or end)
      const offset = alert.trigger.offset;
      const relativeTo = alert.trigger.relativeTo || 'start';

      if (relativeTo === 'end') {
        valarm += `TRIGGER;RELATED=END:${offset}\n`;
      } else {
        valarm += `TRIGGER:${offset}\n`;
      }
    } else if (alert.trigger['@type'] === 'AbsoluteTrigger') {
      // Absolute trigger (specific date-time)
      const when = alert.trigger.when.replace(/[-:]/g, '').replace(/\.\d+/, '');
      valarm += `TRIGGER;VALUE=DATE-TIME:${when}\n`;
    }
  }

  // DESCRIPTION (for display action)
  if (action === 'display') {
    valarm += 'DESCRIPTION:Reminder\n';
  }

  // ACKNOWLEDGED (if the alarm has been acknowledged)
  if (alert.acknowledged) {
    const ack = alert.acknowledged.replace(/[-:]/g, '').replace(/\.\d+/, '');
    valarm += `ACKNOWLEDGED:${ack}\n`;
  }

  valarm += 'END:VALARM\n';
  return valarm;
}

/**
 * Convert JMAP RecurrenceRule to iCalendar RRULE string
 */
function recurrenceRuleToRRULE(rule: RecurrenceRule): string {
  const parts: string[] = [];

  // FREQ is required
  if (rule.frequency) {
    parts.push(`FREQ=${rule.frequency.toUpperCase()}`);
  }

  // INTERVAL
  if (rule.interval && rule.interval > 1) {
    parts.push(`INTERVAL=${rule.interval}`);
  }

  // COUNT or UNTIL (mutually exclusive)
  if (rule.count) {
    parts.push(`COUNT=${rule.count}`);
  } else if (rule.until) {
    // Convert ISO 8601 to iCalendar format
    const until = rule.until.replace(/[-:]/g, '').replace(/\.\d+/, '');
    parts.push(`UNTIL=${until}`);
  }

  // BYDAY
  if (rule.byDay && rule.byDay.length > 0) {
    const byDayStr = rule.byDay
      .map((nday: any) => {
        const day = nday.day.toUpperCase();
        return nday.nthOfPeriod ? `${nday.nthOfPeriod}${day}` : day;
      })
      .join(',');
    parts.push(`BYDAY=${byDayStr}`);
  }

  // BYMONTHDAY
  if (rule.byMonthDay && rule.byMonthDay.length > 0) {
    parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  }

  // BYMONTH
  if (rule.byMonth && rule.byMonth.length > 0) {
    parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  }

  // BYYEARDAY
  if (rule.byYearDay && rule.byYearDay.length > 0) {
    parts.push(`BYYEARDAY=${rule.byYearDay.join(',')}`);
  }

  // BYWEEKNO
  if (rule.byWeekNo && rule.byWeekNo.length > 0) {
    parts.push(`BYWEEKNO=${rule.byWeekNo.join(',')}`);
  }

  // BYHOUR
  if (rule.byHour && rule.byHour.length > 0) {
    parts.push(`BYHOUR=${rule.byHour.join(',')}`);
  }

  // BYMINUTE
  if (rule.byMinute && rule.byMinute.length > 0) {
    parts.push(`BYMINUTE=${rule.byMinute.join(',')}`);
  }

  // BYSECOND
  if (rule.bySecond && rule.bySecond.length > 0) {
    parts.push(`BYSECOND=${rule.bySecond.join(',')}`);
  }

  // BYSETPOS
  if (rule.bySetPosition && rule.bySetPosition.length > 0) {
    parts.push(`BYSETPOS=${rule.bySetPosition.join(',')}`);
  }

  // WKST (week start day)
  if (rule.firstDayOfWeek) {
    parts.push(`WKST=${rule.firstDayOfWeek.toUpperCase()}`);
  }

  return parts.join(';');
}

/**
 * Render a single VEVENT block. If recurrenceId is provided, emits RECURRENCE-ID.
 */
function veventToICS(uid: string, event: CalendarEvent, recurrenceId?: string): string {
  let ics = 'BEGIN:VEVENT\n';
  ics += `UID:${uid}\n`;

  if (recurrenceId) {
    const recId = recurrenceId.replace(/[-:]/g, '').replace(/\.\d+/, '');
    if (event.timeZone && event.timeZone !== 'Etc/UTC' && event.timeZone !== 'UTC') {
      ics += `RECURRENCE-ID;TZID=${event.timeZone}:${recId}\n`;
    } else {
      ics += `RECURRENCE-ID:${recId}\n`;
    }
  }

  if (event.title) {
    ics += `SUMMARY:${escapeICS(event.title)}\n`;
  }

  if (event.description) {
    ics += `DESCRIPTION:${escapeICS(event.description)}\n`;
  }

  if (event.start) {
    const dtstart = event.start.replace(/[-:]/g, '').replace(/\.\d+/, '');
    if (event.start.length <= 10) {
      ics += `DTSTART;VALUE=DATE:${dtstart}\n`;
    } else if (event.timeZone === 'Etc/UTC' || event.timeZone === 'UTC') {
      ics += `DTSTART;VALUE=DATE-TIME:${dtstart}Z\n`;
    } else if (event.timeZone) {
      ics += `DTSTART;VALUE=DATE-TIME;TZID=${event.timeZone}:${dtstart}\n`;
    } else {
      ics += `DTSTART;VALUE=DATE-TIME:${dtstart}\n`;
    }
  }

  if (event.duration) {
    ics += `DURATION:${event.duration}\n`;
  }

  if (event.status) {
    ics += `STATUS:${event.status.toUpperCase()}\n`;
  }

  if (event.privacy) {
    ics += `CLASS:${event.privacy.toUpperCase()}\n`;
  }

  if (event.freeBusyStatus) {
    ics += `TRANSP:${event.freeBusyStatus === 'free' ? 'TRANSPARENT' : 'OPAQUE'}\n`;
  }

  if (event.location) {
    ics += `LOCATION:${escapeICS(event.location)}\n`;
  }

  // Add categories
  if (event.categories) {
    const categories = Object.entries(event.categories)
      .filter(([_, enabled]) => enabled)
      .map(([category]) => escapeICS(category))
      .join(',');
    if (categories) {
      ics += `CATEGORIES:${categories}\n`;
    }
  }

  // Add recurrence rule (only for parent, not exceptions)
  if (!recurrenceId && event.recurrenceRule) {
    const rrule = recurrenceRuleToRRULE(event.recurrenceRule);
    if (rrule) {
      ics += `RRULE:${rrule}\n`;
    }
  }

  // Add EXDATE (only for parent, not exceptions)
  if (!recurrenceId && event.recurrenceOverrides) {
    for (const [dateTime, override] of Object.entries(event.recurrenceOverrides)) {
      if (override === null || (override as any).excluded === true) {
        const exdate = dateTime.replace(/[-:]/g, '').replace(/\.\d+/, '');
        if (event.timeZone === 'Etc/UTC' || event.timeZone === 'UTC') {
          ics += `EXDATE:${exdate}Z\n`;
        } else if (event.timeZone) {
          ics += `EXDATE;TZID=${event.timeZone}:${exdate}\n`;
        } else {
          ics += `EXDATE:${exdate}\n`;
        }
      }
    }
  }

  // Add alerts (VALARM components)
  if (event.alerts) {
    for (const alert of Object.values(event.alerts)) {
      ics += alertToVALARM(alert);
    }
  }

  // Add attachments
  if (event.attachments) {
    for (const attachment of Object.values(event.attachments)) {
      let attachLine = 'ATTACH';
      const params: string[] = [];

      if (attachment.contentType) {
        params.push(`FMTTYPE=${attachment.contentType}`);
      }

      if (attachment.size) {
        params.push(`SIZE=${attachment.size}`);
      }

      if (attachment.title) {
        params.push(`FILENAME=${escapeICS(attachment.title)}`);
      }

      if (params.length > 0) {
        attachLine += `;${params.join(';')}`;
      }

      attachLine += `:${attachment.href}\n`;
      ics += attachLine;
    }
  }

  ics += 'END:VEVENT\n';
  return ics;
}

/**
 * Convert single Event to iCalendar format
 */
export function eventToICS(uid: string, event: CalendarEvent): string {
  let ics = 'BEGIN:VCALENDAR\n';
  ics += 'VERSION:2.0\n';
  ics += 'PRODID:-//Automerge Calendar//EN\n';

  // Parent VEVENT
  ics += veventToICS(uid, event);

  // Exception VEVENTs from recurrenceOverrides
  if (event.recurrenceOverrides) {
    for (const [dateTime, override] of Object.entries(event.recurrenceOverrides)) {
      if (override === null || (override as any).excluded === true) continue;
      if (Object.keys(override).length === 0) continue;

      // Merge parent properties with override patch
      const exceptionEvent: CalendarEvent = {
        ...event,
        ...override as Partial<CalendarEvent>,
        // Use override start if provided, otherwise use the recurrence date
        start: (override as any).start || dateTime,
      };
      // Don't include parent's recurrence rule/overrides in exception
      delete exceptionEvent.recurrenceRule;
      delete exceptionEvent.recurrenceOverrides;

      ics += veventToICS(uid, exceptionEvent, dateTime);
    }
  }

  ics += 'END:VCALENDAR\n';
  return ics;
}

/**
 * Convert Calendar to iCalendar format
 */
export function calendarToIcs(events: {uid: string, event: CalendarEvent}[], calendarName: string): string {
  let ics = 'BEGIN:VCALENDAR\n';
  ics += 'VERSION:2.0\n';
  ics += 'PRODID:-//Automerge Calendar//EN\n';
  ics += `X-WR-CALNAME:${escapeICS(calendarName)}\n`;

  for (const {uid, event} of events) {
    // Parent VEVENT
    ics += veventToICS(uid, event);

    // Exception VEVENTs from recurrenceOverrides
    if (event.recurrenceOverrides) {
      for (const [dateTime, override] of Object.entries(event.recurrenceOverrides)) {
        if (override === null || (override as any).excluded === true) continue;
        if (Object.keys(override).length === 0) continue;

        const exceptionEvent: CalendarEvent = {
          ...event,
          ...override as Partial<CalendarEvent>,
          start: (override as any).start || dateTime,
        };
        delete exceptionEvent.recurrenceRule;
        delete exceptionEvent.recurrenceOverrides;

        ics += veventToICS(uid, exceptionEvent, dateTime);
      }
    }
  }

  ics += 'END:VCALENDAR\n';
  return ics;
}

/**
 * Generate ETag for an event
 */
export function generateEtag(event: CalendarEvent): string {
  const data = JSON.stringify(event);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}
