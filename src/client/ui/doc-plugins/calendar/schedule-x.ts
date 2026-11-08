import { createCalendar, viewMonthGrid, viewWeek, viewDay } from '@schedule-x/calendar';
import { createEventsServicePlugin } from '@schedule-x/events-service';
import { createCurrentTimePlugin } from '@schedule-x/current-time';
import type { ExpandedEvent } from './recurrence';
import { rebuildExpanded, isAllDay } from './recurrence';
import { isDark } from '../../common/theme';
import type { CalendarDocument } from '../../../../shared/schemas/calendar';
import { createLogger } from '../../../../shared/logger';
import { eventHighlight, type EventHighlight } from './diff-events';

const log = createLogger('calendar');

export interface EventLookupMap {
  /** `ghost`: an occurrence of an event the version on screen removed — drawn, not editable. */
  [id: string]: ExpandedEvent & { ghost?: boolean };
}

export interface CalendarSource extends CalendarDocument {
  docId: string;
}

export interface MultiCalEventLookupMap {
  [id: string]: ExpandedEvent & { calDocId: string };
}

export function mapToSXEvents(
  expanded: ExpandedEvent[], calTZ: string, calColor: string,
  /** History mode: diff classes per uid, and which uids are ghosts. */
  highlight?: Pick<EventHighlight, 'diff' | 'ghosts'>,
): { sxEvents: any[]; eventLookup: EventLookupMap } {
  const eventLookup: EventLookupMap = {};
  const sxEvents: any[] = [];
  for (const item of expanded) {
    // A single event with a crafted start/duration/timeZone must not throw out of
    // refreshCalendar and blank the whole calendar \u2014 skip just that event.
    try {
      const ev = item.ev;
      const id = (item.uid + (item.recurrenceDate ? '--' + item.recurrenceDate : '')).replace(/[^a-zA-Z0-9_-]/g, '_');
      const allDay = isAllDay(ev);
      const startStr = ev.start || '';
      const tz = ev.timeZone || calTZ;
      let sxStart: any, sxEnd: any;
      if (allDay) {
        sxStart = Temporal.PlainDate.from(startStr.substring(0, 10));
        const dur = Temporal.Duration.from(ev.duration || 'P1D');
        sxEnd = sxStart.add(dur).subtract({ days: 1 });
        // Clamp: time-only durations (PT1H) produce end < start on PlainDate
        if (Temporal.PlainDate.compare(sxEnd, sxStart) < 0) sxEnd = sxStart;
      } else {
        const pdt = Temporal.PlainDateTime.from(startStr.substring(0, 19));
        sxStart = pdt.toZonedDateTime(tz);
        const dur = Temporal.Duration.from(ev.duration || 'PT1H');
        sxEnd = sxStart.add(dur);
      }
      const isPast = allDay
        ? Temporal.PlainDate.compare(sxEnd, Temporal.Now.plainDateISO()) < 0
        : Temporal.Instant.compare(sxEnd.toInstant(), Temporal.Now.instant()) < 0;
      const { classes, ghost } = eventHighlight(item.uid, highlight);
      eventLookup[id] = ghost ? { ...item, ghost: true } : item;
      sxEvents.push({
        id,
        title: (ev.title || 'Untitled') + (item.isRecurring ? ' \u21bb' : ''),
        start: sxStart,
        end: sxEnd,
        calendarId: isPast ? 'cal-past' : 'cal',
        // schedule-x puts these on the event element in every view.
        ...(classes ? { _options: { additionalClasses: classes } } : {}),
      });
    } catch (err) {
      log.warn(`Skipping malformed calendar event "${item.uid}":`, err);
    }
  }
  return { sxEvents, eventLookup };
}

/**
 * Move the visible range to `date`. There is no public controls plugin in this
 * build, so this reaches schedule-x's internal `$app` state (private on the
 * type, hence `any`), guarded so a future internal rename degrades to a no-op.
 */
export function goToDate(calendar: any, date: Temporal.PlainDate): void {
  const selected = calendar?.$app?.datePickerState?.selectedDate;
  if (selected && typeof selected === 'object' && 'value' in selected) selected.value = date;
}

export function createSXCalendar(
  el: HTMLElement,
  initialEvents: any[],
  calTZ: string,
  calColor: string,
  callbacks: {
    onEventClick: (event: any) => void;
    onClickDate: (date: any) => void;
    onClickDateTime: (dateTime: any) => void;
    onRangeUpdate: (range: any) => void;
  }
) {
  const eventsPlugin = createEventsServicePlugin();

  const calendar = createCalendar({
    views: [viewMonthGrid, viewWeek, viewDay],
    defaultView: viewWeek.name,
    timezone: calTZ,
    events: initialEvents,
    // schedule-x ships its own `.is-dark` stylesheet rather than reading our
    // MD3 tokens, so the theme has to be handed to it. Later OS flips arrive
    // via calendar.setTheme() — see the onThemeChange hook in Calendar.tsx.
    isDark: isDark(),
    plugins: [eventsPlugin, createCurrentTimePlugin()],
    calendars: {
      cal: {
        colorName: 'cal',
        lightColors: { main: calColor, container: calColor + '30', onContainer: '#1a1a1a' },
        darkColors: { main: calColor, container: calColor + '30', onContainer: '#f0f0f0' },
      },
      'cal-past': {
        colorName: 'cal-past',
        lightColors: { main: calColor + '60', container: calColor + '15', onContainer: '#1a1a1a60' },
        darkColors: { main: calColor + '60', container: calColor + '15', onContainer: '#f0f0f060' },
      },
    },
    callbacks,
  });

  calendar.render(el);
  return { calendar, eventsPlugin };
}

function buildCalendarColors(color: string) {
  return {
    lightColors: { main: color, container: color + '30', onContainer: '#1a1a1a' },
    darkColors: { main: color, container: color + '30', onContainer: '#f0f0f0' },
  };
}

function buildCalendarPastColors(color: string) {
  return {
    lightColors: { main: color + '60', container: color + '15', onContainer: '#1a1a1a60' },
    darkColors: { main: color + '60', container: color + '15', onContainer: '#f0f0f060' },
  };
}

function eventToSX(id: string, item: ExpandedEvent, calTZ: string, calId: string, pastId: string) {
  const ev = item.ev;
  const allDay = isAllDay(ev);
  const startStr = ev.start || '';
  const tz = ev.timeZone || calTZ;
  let sxStart: any, sxEnd: any;
  if (allDay) {
    sxStart = Temporal.PlainDate.from(startStr.substring(0, 10));
    const dur = Temporal.Duration.from(ev.duration || 'P1D');
    sxEnd = sxStart.add(dur).subtract({ days: 1 });
    if (Temporal.PlainDate.compare(sxEnd, sxStart) < 0) sxEnd = sxStart;
  } else {
    const pdt = Temporal.PlainDateTime.from(startStr.substring(0, 19));
    sxStart = pdt.toZonedDateTime(tz);
    const dur = Temporal.Duration.from(ev.duration || 'PT1H');
    sxEnd = sxStart.add(dur);
  }
  const isPast = allDay
    ? Temporal.PlainDate.compare(sxEnd, Temporal.Now.plainDateISO()) < 0
    : Temporal.Instant.compare(sxEnd.toInstant(), Temporal.Now.instant()) < 0;
  return {
    id,
    title: (ev.title || 'Untitled') + (item.isRecurring ? ' \u21bb' : ''),
    start: sxStart,
    end: sxEnd,
    calendarId: isPast ? pastId : calId,
  };
}

const defaultTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function mapMultiCalToSXEvents(
  sources: CalendarSource[],
  rangeStart: string,
  rangeEnd: string,
): { sxEvents: any[]; eventLookup: MultiCalEventLookupMap; sxCalendars: Record<string, any> } {
  const eventLookup: MultiCalEventLookupMap = {};
  const sxEvents: any[] = [];
  const sxCalendars: Record<string, any> = {};

  for (const src of sources) {
    const color = src.color || '#039be5';
    const calId = src.docId;
    const pastId = src.docId + '-past';
    sxCalendars[calId] = { colorName: calId, ...buildCalendarColors(color) };
    sxCalendars[pastId] = { colorName: pastId, ...buildCalendarPastColors(color) };

    const calTZ = src.timeZone || defaultTZ;
    const expanded = rebuildExpanded(src.events || {}, rangeStart, rangeEnd);
    for (const item of expanded) {
      const id = (src.docId + '__' + item.uid + (item.recurrenceDate ? '--' + item.recurrenceDate : '')).replace(/[^a-zA-Z0-9_-]/g, '_');
      // Skip a single malformed event instead of throwing out of the whole map.
      try {
        const sx = eventToSX(id, item, calTZ, calId, pastId);
        eventLookup[id] = { ...item, calDocId: src.docId };
        sxEvents.push(sx);
      } catch (err) {
        log.warn(`Skipping malformed calendar event "${item.uid}":`, err);
      }
    }
  }

  return { sxEvents, eventLookup, sxCalendars };
}

export function createMultiCalSXCalendar(
  el: HTMLElement,
  initialEvents: any[],
  defaultTimezone: string,
  sxCalendars: Record<string, any>,
  callbacks: {
    onEventClick: (event: any) => void;
    onClickDate: (date: any) => void;
    onClickDateTime: (dateTime: any) => void;
    onRangeUpdate: (range: any) => void;
  }
) {
  const eventsPlugin = createEventsServicePlugin();

  const calendar = createCalendar({
    views: [viewMonthGrid, viewWeek, viewDay],
    defaultView: viewWeek.name,
    timezone: defaultTimezone,
    events: initialEvents,
    isDark: isDark(),
    plugins: [eventsPlugin, createCurrentTimePlugin()],
    calendars: sxCalendars,
    callbacks,
  });

  calendar.render(el);
  return { calendar, eventsPlugin };
}
