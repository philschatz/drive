import {
  type ValidationError, type SchemaNode, type DocSchemaPlugin,
  type UTCDateTime, type LocalDateTime, type Duration, type PatchObject,
  type VirtualLocation, type Link, type Participant, type Alert,
  str, num, bool, obj, record, validateNode,
  LOCAL_DATE_TIME_RE, UTC_DATE_TIME_RE, DURATION_RE, HEX_COLOR_RE,
  STATUS_VALUES, FREEBUSY_VALUES, PRIVACY_VALUES, PROGRESS_VALUES,
  boolMap, linkSchema, virtualLocationSchema, recurrenceRuleSchema,
  participantSchema, alertSchema,
  isParseableLocalDateTime, isParseableDuration, isParseableTimeZone,
  isDangerousUri, checkRecurrenceRuleDeps, checkRecurrenceOverrideKeys,
} from '../../../shared/schemas/core';

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

/** Field nodes shared by every Event-shaped item — Calendar events and
 * Calendar+Counters items (src/client/doc-plugins/counters/schema.ts) both spread these. */
export const baseEventFields: Record<string, SchemaNode> = {
  title: str({ optional: true }),
  // `start` is a local date ("YYYY-MM-DD") or local datetime ("YYYY-MM-DDTHH:mm:ss"),
  // never a UTC/offset timestamp — timezone lives in the separate `timeZone` field.
  start: str({ pattern: LOCAL_DATE_TIME_RE, optional: true }),
  duration: str({ pattern: DURATION_RE, optional: true }),
};

/** Time-parse safety net for the base fields: mirror the Temporal parsing the
 * renderers do so crafted values that pass the loose regexes surface as
 * validation errors instead of render crashes. */
export function checkBaseEventTimeDeps(ev: any, p: (string | number)[], errors: ValidationError[]): void {
  if (typeof ev.start === 'string' && ev.start && !isParseableLocalDateTime(ev.start)) {
    errors.push({ path: [...p, 'start'], message: `start "${ev.start}" is not a valid date/time`, kind: 'dependency' });
  }
  if (typeof ev.duration === 'string' && ev.duration && !isParseableDuration(ev.duration)) {
    errors.push({ path: [...p, 'duration'], message: `duration "${ev.duration}" is not a valid ISO 8601 duration`, kind: 'dependency' });
  }
}

const commonEventFields: Record<string, SchemaNode> = {
  ...baseEventFields,
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
  timeZone: str({ optional: true }),
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

/**
 * Flag stored `href`/`uri` values that use a script-executing scheme
 * (javascript:, etc.). Checked on links, attachments, and virtualLocations,
 * which are the only event fields that hold URLs.
 */
function checkEventUris(ev: any, p: (string | number)[], errors: ValidationError[]): void {
  const scan = (map: any, field: string, key: 'href' | 'uri') => {
    if (!map || typeof map !== 'object') return;
    for (const [id, item] of Object.entries(map)) {
      const v = (item as any)?.[key];
      if (typeof v === 'string' && isDangerousUri(v)) {
        errors.push({
          path: [...p, field, id, key],
          message: `${key} "${v}" uses a disallowed URL scheme`,
          kind: 'dependency',
        });
      }
    }
  };
  scan(ev.links, 'links', 'href');
  scan(ev.attachments, 'attachments', 'href');
  scan(ev.virtualLocations, 'virtualLocations', 'uri');
}

export function checkCalendarDependencies(doc: any, errors: ValidationError[]): void {
  // The document-level default time zone drives event rendering, so it must
  // resolve just like a per-event timeZone.
  if (typeof doc.timeZone === 'string' && doc.timeZone && !isParseableTimeZone(doc.timeZone)) {
    errors.push({ path: ['timeZone'], message: `timeZone "${doc.timeZone}" is not a valid time zone`, kind: 'dependency' });
  }

  const events = doc.events;
  if (!events || typeof events !== 'object') return;

  for (const [uid, event] of Object.entries(events)) {
    const ev = event as any;
    const p = ['events', uid];

    if (ev.recurrenceRule) {
      checkRecurrenceRuleDeps(ev.recurrenceRule, [...p, 'recurrenceRule'], errors);
    }

    // recurrenceOverrides keys are occurrence identifiers (local date/date-time).
    if (ev.recurrenceOverrides) {
      checkRecurrenceOverrideKeys(ev.recurrenceOverrides, [...p, 'recurrenceOverrides'], errors);
    }

    checkBaseEventTimeDeps(ev, p, errors);
    if (typeof ev.recurrenceId === 'string' && ev.recurrenceId && !isParseableLocalDateTime(ev.recurrenceId)) {
      errors.push({ path: [...p, 'recurrenceId'], message: `recurrenceId "${ev.recurrenceId}" is not a valid date/time`, kind: 'dependency' });
    }
    if (typeof ev.timeZone === 'string' && ev.timeZone && !isParseableTimeZone(ev.timeZone)) {
      errors.push({ path: [...p, 'timeZone'], message: `timeZone "${ev.timeZone}" is not a valid time zone`, kind: 'dependency' });
    }
    if (typeof ev.recurrenceIdTimeZone === 'string' && ev.recurrenceIdTimeZone && !isParseableTimeZone(ev.recurrenceIdTimeZone)) {
      errors.push({ path: [...p, 'recurrenceIdTimeZone'], message: `recurrenceIdTimeZone "${ev.recurrenceIdTimeZone}" is not a valid time zone`, kind: 'dependency' });
    }

    checkEventUris(ev, p, errors);

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

/** Worker-safe plugin core — registered in src/shared/schemas (validation) and
 * spread into the full calendar plugin (src/client/doc-plugins/calendar/plugin.tsx). */
export const calendarSchemaPlugin: DocSchemaPlugin = {
  type: 'Calendar',
  schema: calendarDocumentSchema,
  checkDeps: checkCalendarDependencies,
};
