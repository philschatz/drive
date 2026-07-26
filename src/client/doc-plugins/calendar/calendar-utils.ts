import type { CalendarEvent } from './schema';
import { toDateStr } from './recurrence';

export interface EditorState {
  uid: string;
  event: CalendarEvent;
  masterEvent: CalendarEvent | null;
  recurrenceDate: string | null;
  isNew: boolean;
  calDocId?: string;
}

export const PATH_PROP_TO_FIELDS: Record<string, string[]> = {
  title: ['ed-title'],
  start: ['ed-date', 'ed-time', 'ed-allday'],
  duration: ['ed-duration'],
  recurrenceRule: ['ed-freq'],
  location: ['ed-location'],
  description: ['ed-desc'],
};

export function generateUid() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9) + '_automerge';
}

/** Compute the initial 3-month date range for calendar queries. */
export function getInitialDateRange(): { start: string; end: string } {
  const now = new Date();
  const initStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const initEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  return { start: toDateStr(initStart), end: toDateStr(initEnd) };
}

/** Snap a datetime value to the nearest 30-minute slot and return an ISO string. */
export function snapDateTime(dateTime: any): string {
  const dt = new Date(dateTime.toString().substring(0, 19));
  dt.setMinutes(Math.round(dt.getMinutes() / 30) * 30, 0, 0);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
    + 'T' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') + ':00';
}

/** Common event lookup item shape (works for both single and multi-calendar). */
export interface EventLookupItem {
  uid: string;
  ev: CalendarEvent;
  recurrenceDate: string | null;
  calDocId?: string;
}

/**
 * Build the schedule-x calendar callback handlers.
 * Shared between Calendar (single-doc) and AllCalendars (multi-doc).
 */
export function makeSXCallbacks(opts: {
  eventLookupRef: { current: Record<string, EventLookupItem> };
  openEditor: (uid: string | null, ev: CalendarEvent | null, defaultDate: string | null, recurrenceDate: string | null, calDocId?: string) => void;
  getDefaultCalDocId?: () => string | undefined;
  currentRangeRef: { current: { start: string; end: string } };
  queryRangeRef: { current: { start: string; end: string } };
  resubscribe: (start: string, end: string) => void;
  refreshCalendar: () => void;
}) {
  let lastRangeKey = '';
  return {
    onEventClick: (event: any) => {
      const item = opts.eventLookupRef.current[event.id];
      if (item) opts.openEditor(item.uid, item.ev, null, item.recurrenceDate, item.calDocId);
    },
    onClickDate: (date: any) => {
      const calDocId = opts.getDefaultCalDocId?.();
      if (opts.getDefaultCalDocId && !calDocId) return;
      opts.openEditor(null, null, date.toString(), null, calDocId);
    },
    onClickDateTime: (dateTime: any) => {
      const calDocId = opts.getDefaultCalDocId?.();
      if (opts.getDefaultCalDocId && !calDocId) return;
      opts.openEditor(null, null, snapDateTime(dateTime), null, calDocId);
    },
    onRangeUpdate: (range: any) => {
      const start = range.start.toString().substring(0, 10);
      const end = range.end.toString().substring(0, 10);
      const key = start + ':' + end;
      if (key === lastRangeKey) return;
      lastRangeKey = key;
      opts.currentRangeRef.current = { start, end };
      if (start < opts.queryRangeRef.current.start || end > opts.queryRangeRef.current.end) {
        opts.resubscribe(start, end);
      }
      opts.refreshCalendar();
    },
  };
}
