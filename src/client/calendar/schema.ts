import {
  type ValidationError, type SchemaNode,
  type UTCDateTime, type LocalDateTime, type Duration, type PatchObject,
  type VirtualLocation, type Link, type Participant, type Alert,
  str, num, bool, obj, record, validateNode,
  LOCAL_DATE_TIME_RE, UTC_DATE_TIME_RE, DURATION_RE,
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
  color: str({ optional: true }),
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
  start: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
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
  color: str({ optional: true }),
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
