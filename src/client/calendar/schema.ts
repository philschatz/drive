import { Temporal } from 'temporal-polyfill';
import {
  type ValidationError, type SchemaNode,
  type UTCDateTime, type LocalDateTime, type Duration, type PatchObject,
  type VirtualLocation, type Link, type Participant, type Alert,
  str, num, bool, obj, record, validateNode,
  LOCAL_DATE_TIME_RE, UTC_DATE_TIME_RE, DURATION_RE, HEX_COLOR_RE,
  STATUS_VALUES, FREEBUSY_VALUES, PRIVACY_VALUES, PROGRESS_VALUES,
  boolMap, linkSchema, virtualLocationSchema, recurrenceRuleSchema,
  participantSchema, alertSchema,
} from '../../shared/schemas/core';

export interface NDay {
  "@type": "NDay";
  day: "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";
  nthOfPeriod?: number;
}

export interface RecurrenceRule {
  "@type": "RecurrenceRule";
  frequency: "yearly" | "monthly" | "weekly" | "daily" | "hourly" | "minutely" | "secondly";
  interval?: number;
  rscale?: string;
  skip?: "omit" | "backward" | "forward";
  firstDayOfWeek?: "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";
  byDay?: NDay[];
  byMonthDay?: number[];
  byMonth?: string[];
  byYearDay?: number[];
  byWeekNo?: number[];
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  bySetPosition?: number[];
  count?: number;
  until?: LocalDateTime;
}

export interface CalendarEvent {
  "@type": "Event";
  created?: UTCDateTime;
  title?: string;
  description?: string;
  location?: string;
  virtualLocations?: { [key: string]: VirtualLocation };
  links?: { [key: string]: Link };
  locale?: string;
  keywords?: { [key: string]: boolean };
  categories?: { [key: string]: boolean };
  color?: string;
  recurrenceRule?: RecurrenceRule;
  recurrenceOverrides?: { [key: string]: PatchObject };
  excluded?: boolean;
  recurrenceId?: LocalDateTime;
  recurrenceIdTimeZone?: string | null;
  status?: "confirmed" | "cancelled" | "tentative";
  freeBusyStatus?: "free" | "busy" | "busy-tentative" | "busy-unavailable";
  privacy?: "public" | "private" | "confidential";
  replyTo?: { [method: string]: string };
  participants?: { [key: string]: Participant };
  useDefaultAlerts?: boolean;
  alerts?: { [key: string]: Alert };
  priority?: number;
  progress?: "needs-action" | "in-process" | "completed" | "failed" | "cancelled";
  progressUpdated?: UTCDateTime;
  percentComplete?: number;
  start?: LocalDateTime;
  timeZone?: string | null;
  duration?: Duration;
  attachments?: { [key: string]: Link };
}

export interface CalendarDocument {
  '@type': 'Calendar';
  name: string;
  description?: string;
  color?: string;
  timeZone?: string;
  events: Record<string, CalendarEvent>;
}

const commonEventFields: Record<string, SchemaNode> = {
  title: str({ optional: true }),
  description: str({ optional: true }),
  location: str({ optional: true }),
  virtualLocations: record(virtualLocationSchema, { optional: true }),
  links: record(linkSchema, { optional: true }),
  locale: str({ optional: true }),
  keywords: boolMap,
  categories: boolMap,
  color: str({ pattern: HEX_COLOR_RE, optional: true }),
  status: str({ enum: STATUS_VALUES, optional: true }),
  freeBusyStatus: str({ enum: FREEBUSY_VALUES, optional: true }),
  privacy: str({ enum: PRIVACY_VALUES, optional: true }),
  replyTo: record(str(), { optional: true }),
  participants: record(participantSchema, { optional: true }),
  useDefaultAlerts: bool({ optional: true }),
  alerts: record(alertSchema, { optional: true }),
  priority: num({ min: 0, max: 9, integer: true, optional: true }),
  progress: str({ enum: PROGRESS_VALUES, optional: true }),
  progressUpdated: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
  percentComplete: num({ min: 0, max: 100, integer: true, optional: true }),
  // `start` is a local date ("YYYY-MM-DD") or local datetime ("YYYY-MM-DDTHH:mm:ss"),
  // never a UTC/offset timestamp — timezone lives in the separate `timeZone` field.
  start: str({ pattern: LOCAL_DATE_TIME_RE, optional: true }),
  timeZone: str({ optional: true }),
  duration: str({ pattern: DURATION_RE, optional: true }),
  attachments: record(linkSchema, { optional: true }),
};

const recurrenceOverrideSchema = obj({
  excluded: bool({ literal: true, optional: true }),
  ...commonEventFields,
});

export const calendarEventSchema = obj({
  '@type': str({ enum: ['Event'] }),
  created: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
  ...commonEventFields,
  recurrenceRule: recurrenceRuleSchema,
  recurrenceOverrides: record(recurrenceOverrideSchema, { optional: true }),
  recurrenceId: str({ pattern: LOCAL_DATE_TIME_RE, optional: true }),
  recurrenceIdTimeZone: str({ optional: true }),
});

export const calendarDocumentSchema = obj({
  '@type': str({ enum: ['Calendar'] }),
  name: str(),
  description: str({ optional: true }),
  color: str({ pattern: HEX_COLOR_RE, optional: true }),
  timeZone: str({ optional: true }),
  events: record(calendarEventSchema),
});

export function checkCalendarDependencies(doc: any, errors: ValidationError[]): void {
  const events = doc.events;
  if (!events || typeof events !== 'object') return;

  for (const [uid, event] of Object.entries(events)) {
    const ev = event as any;
    const p = ['events', uid];

    if (ev.recurrenceRule?.count != null && ev.recurrenceRule?.until != null) {
      errors.push({ path: [...p, 'recurrenceRule'], message: 'count and until are mutually exclusive', kind: 'dependency' });
    }

    // byMonthDay must be 1..31 or -31..-1. The schema bounds the range, but 0 is
    // not expressible there and drives the monthly expansion into an infinite loop.
    if (Array.isArray(ev.recurrenceRule?.byMonthDay)) {
      ev.recurrenceRule.byMonthDay.forEach((v: any, i: number) => {
        if (v === 0) {
          errors.push({
            path: [...p, 'recurrenceRule', 'byMonthDay', i],
            message: 'byMonthDay must be 1..31 or -31..-1 (0 is not allowed)',
            kind: 'dependency',
          });
        }
      });
    }

    // A byDay-driven frequency (weekly) with an empty byDay produces no
    // occurrences and previously looped forever during expansion.
    if (ev.recurrenceRule?.frequency && Array.isArray(ev.recurrenceRule.byDay) && ev.recurrenceRule.byDay.length === 0) {
      const freq = ev.recurrenceRule.frequency;
      if (freq !== 'yearly' && freq !== 'monthly') {
        errors.push({
          path: [...p, 'recurrenceRule', 'byDay'],
          message: `${freq} frequency with an empty byDay produces no occurrences`,
          kind: 'dependency',
        });
      }
    }

    // Time-parse safety net: mirror the Temporal parsing schedule-x does at render
    // time so crafted values that pass the loose regexes but crash the renderer
    // surface as validation errors instead.
    if (typeof ev.start === 'string' && ev.start) {
      const allDay = ev.start.length <= 10;
      try {
        if (allDay) Temporal.PlainDate.from(ev.start.substring(0, 10));
        else Temporal.PlainDateTime.from(ev.start.substring(0, 19));
      } catch {
        errors.push({ path: [...p, 'start'], message: `start "${ev.start}" is not a valid date/time`, kind: 'dependency' });
      }
    }
    if (typeof ev.duration === 'string' && ev.duration) {
      try {
        Temporal.Duration.from(ev.duration);
      } catch {
        errors.push({ path: [...p, 'duration'], message: `duration "${ev.duration}" is not a valid ISO 8601 duration`, kind: 'dependency' });
      }
    }
    if (typeof ev.timeZone === 'string' && ev.timeZone) {
      try {
        Temporal.PlainDateTime.from('2020-01-01T00:00:00').toZonedDateTime(ev.timeZone);
      } catch {
        errors.push({ path: [...p, 'timeZone'], message: `timeZone "${ev.timeZone}" is not a valid time zone`, kind: 'dependency' });
      }
    }

    if (ev.recurrenceRule?.byDay && ev.recurrenceRule.frequency) {
      const freq = ev.recurrenceRule.frequency;
      if (freq !== 'yearly' && freq !== 'monthly') {
        for (let i = 0; i < ev.recurrenceRule.byDay.length; i++) {
          if (ev.recurrenceRule.byDay[i]?.nthOfPeriod != null) {
            errors.push({
              path: [...p, 'recurrenceRule', 'byDay', i, 'nthOfPeriod'],
              message: `nthOfPeriod is only valid with yearly or monthly frequency, got "${freq}"`,
              kind: 'dependency',
            });
          }
        }
      }
    }

    if (ev.participants) {
      for (const [pid, part] of Object.entries(ev.participants)) {
        const pt = part as any;
        if (pt.locationId && (!ev.virtualLocations || !(pt.locationId in ev.virtualLocations))) {
          errors.push({
            path: [...p, 'participants', pid, 'locationId'],
            message: `locationId "${pt.locationId}" does not reference a known virtualLocation`,
            kind: 'dependency',
          });
        }
      }
    }

    if (ev.alerts) {
      const alertKeys = new Set(Object.keys(ev.alerts));
      for (const [aid, alert] of Object.entries(ev.alerts)) {
        const al = alert as any;
        if (al.relatedTo) {
          for (const relKey of Object.keys(al.relatedTo)) {
            if (!alertKeys.has(relKey)) {
              errors.push({
                path: [...p, 'alerts', aid, 'relatedTo', relKey],
                message: `relatedTo key "${relKey}" does not reference a sibling alert`,
                kind: 'dependency',
              });
            }
          }
        }
      }
    }
  }
}

export function validateCalendarEvent(event: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(event, calendarEventSchema, [], errors);
  return errors;
}
