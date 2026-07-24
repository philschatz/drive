/**
 * Core schema DSL, validator, shared sub-schemas, and types.
 */

import { Temporal } from 'temporal-polyfill';

// ---------------------------------------------------------------------------
// JMAP building-block types (RFC 8984)
// ---------------------------------------------------------------------------

/** A date-time string in ISO 8601 format */
export type UTCDateTime = string;

/** A local date-time string (no timezone) */
export type LocalDateTime = string;

/** A duration in ISO 8601 format (e.g., "PT1H" for 1 hour) */
export type Duration = string;

/** Patch object for overrides */
export type PatchObject = { [key: string]: any } | null;

export type RelationType = "first" | "next" | "child" | "parent" | string;

export interface Relation {
  "@type"?: "Relation";
  relation?: { [key: string]: RelationType };
}

export interface Link {
  "@type": "Link";
  href: string;
  cid?: string;
  contentType?: string;
  size?: number;
  rel?: string;
  display?: "badge" | "graphic" | "fullsize" | "thumbnail";
  title?: string;
}

export interface VirtualLocation {
  "@type": "VirtualLocation";
  name?: string;
  description?: string;
  uri: string;
  features?: { [key: string]: boolean };
}

export interface Location {
  "@type": "Location";
  name?: string;
  description?: string;
  locationTypes?: { [key: string]: boolean };
  relativeTo?: "start" | "end";
  timeZone?: string;
  coordinates?: string;
  links?: { [key: string]: Link };
}

export interface Participant {
  "@type": "Participant";
  name?: string;
  email?: string;
  description?: string;
  sendTo?: { [method: string]: string };
  kind?: "individual" | "group" | "resource" | "room" | "unknown";
  roles?: { [key: string]: boolean };
  language?: string;
  locationId?: string;
  participationStatus?: "needs-action" | "accepted" | "declined" | "tentative" | "delegated";
  participationComment?: string;
  expectReply?: boolean;
  scheduleAgent?: "server" | "client" | "none";
  scheduleForceSend?: boolean;
  scheduleSequence?: number;
  scheduleUpdated?: UTCDateTime;
  invitedBy?: string;
  delegatedTo?: { [key: string]: boolean };
  delegatedFrom?: { [key: string]: boolean };
  memberOf?: { [key: string]: boolean };
  links?: { [key: string]: Link };
  progress?: string;
  progressUpdated?: UTCDateTime;
  percentComplete?: number;
}

export interface OffsetTrigger {
  "@type": "OffsetTrigger";
  offset: Duration;
  relativeTo?: "start" | "end";
}

export interface AbsoluteTrigger {
  "@type": "AbsoluteTrigger";
  when: UTCDateTime;
}

export interface Alert {
  "@type": "Alert";
  trigger: OffsetTrigger | AbsoluteTrigger;
  acknowledged?: UTCDateTime;
  relatedTo?: { [key: string]: Relation };
  action?: "display" | "email";
}

export interface TimeZone {
  "@type": "TimeZone";
  tzId: string;
  updated?: UTCDateTime;
  url?: string;
  validUntil?: UTCDateTime;
  aliases?: { [key: string]: boolean };
  standard?: TimeZoneRule[];
  daylight?: TimeZoneRule[];
}

export interface TimeZoneRule {
  "@type": "TimeZoneRule";
  start: LocalDateTime;
  offsetFrom: string;
  offsetTo: string;
  recurrenceRules?: any[];
  recurrenceOverrides?: { [key: string]: PatchObject };
  names?: { [key: string]: string };
  comments?: string[];
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export interface ValidationError {
  /** JSON-pointer-style path, e.g. ["events","abc123","start"] */
  path: (string | number)[];
  message: string;
  /** 'schema' for structural/type violations, 'dependency' for cross-field issues, 'warning' for non-critical issues like unknown keys. Defaults to 'schema'. */
  kind?: 'schema' | 'dependency' | 'warning';
}

// ---------------------------------------------------------------------------
// Schema DSL
// ---------------------------------------------------------------------------

export type SchemaNode =
  | { type: 'string'; enum?: readonly string[]; pattern?: RegExp; optional?: boolean }
  | { type: 'number'; min?: number; max?: number; integer?: boolean; optional?: boolean }
  | { type: 'boolean'; literal?: boolean; optional?: boolean }
  | { type: 'object'; properties?: Record<string, SchemaNode>; optional?: boolean }
  | { type: 'record'; valueSchema: SchemaNode; keyPattern?: RegExp; optional?: boolean }
  | { type: 'union'; schemas: SchemaNode[]; optional?: boolean }
  | { type: 'array'; items: SchemaNode; optional?: boolean };

/**
 * The worker-safe half of a document-type plugin: the `@type` it validates plus
 * its schema and cross-field dependency checks. Runs inside the automerge worker
 * after every document change (local edits and synced remote edits alike), so
 * implementations must never import UI code. The client-side `DocTypePlugin`
 * (src/client/doc-plugins/types.ts) extends this with rendering concerns.
 */
export interface DocSchemaPlugin {
  /** The document `@type` this plugin validates, e.g. 'Calendar'. */
  type: string;
  schema: SchemaNode;
  checkDeps: (doc: any, errors: ValidationError[]) => void;
}

export function str(opts?: { enum?: readonly string[]; pattern?: RegExp; optional?: boolean }): SchemaNode {
  return { type: 'string', ...opts };
}
export function num(opts?: { min?: number; max?: number; integer?: boolean; optional?: boolean }): SchemaNode {
  return { type: 'number', ...opts };
}
export function bool(opts?: { literal?: boolean; optional?: boolean }): SchemaNode {
  return { type: 'boolean', ...opts };
}
export function obj(properties: Record<string, SchemaNode>, opts?: { optional?: boolean }): SchemaNode {
  return { type: 'object', properties, ...opts };
}
export function record(valueSchema: SchemaNode, opts?: { optional?: boolean; keyPattern?: RegExp }): SchemaNode {
  return { type: 'record', valueSchema, ...opts };
}
export function union(schemas: SchemaNode[], opts?: { optional?: boolean }): SchemaNode {
  return { type: 'union', schemas, ...opts };
}
export function arr(items: SchemaNode, opts?: { optional?: boolean }): SchemaNode {
  return { type: 'array', items, ...opts };
}

// ---------------------------------------------------------------------------
// Schema walker
// ---------------------------------------------------------------------------

export function validateNode(value: unknown, schema: SchemaNode, path: (string | number)[], errors: ValidationError[]): void {
  if (value === undefined || value === null) {
    if (!schema.optional) {
      errors.push({ path, message: `Required value is missing` });
    }
    return;
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push({ path, message: `Expected string, got ${typeof value}` });
        return;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push({ path, message: `Invalid value "${value}", expected one of: ${schema.enum.join(', ')}` });
      }
      if (schema.pattern && !schema.pattern.test(value)) {
        errors.push({ path, message: `String "${value}" does not match expected format` });
      }
      break;
    }
    case 'number': {
      if (typeof value !== 'number' || isNaN(value)) {
        errors.push({ path, message: `Expected number, got ${typeof value}` });
        return;
      }
      if (schema.integer && !Number.isInteger(value)) {
        errors.push({ path, message: `Expected integer, got ${value}` });
      }
      if (schema.min !== undefined && value < schema.min) {
        errors.push({ path, message: `Value ${value} is below minimum ${schema.min}` });
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push({ path, message: `Value ${value} exceeds maximum ${schema.max}` });
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push({ path, message: `Expected boolean, got ${typeof value}` });
      } else if (schema.literal !== undefined && value !== schema.literal) {
        errors.push({ path, message: `Expected ${schema.literal}, got ${value}` });
      }
      break;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ path, message: `Expected object, got ${Array.isArray(value) ? 'array' : typeof value}` });
        return;
      }
      if (schema.properties) {
        for (const [key, childSchema] of Object.entries(schema.properties)) {
          validateNode((value as any)[key], childSchema, [...path, key], errors);
        }
        for (const key of Object.keys(value as object)) {
          if (!(key in schema.properties)) {
            errors.push({ path: [...path, key], message: `Unknown property "${key}"`, kind: 'warning' });
          }
        }
      }
      break;
    }
    case 'record': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ path, message: `Expected object (record), got ${Array.isArray(value) ? 'array' : typeof value}` });
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (schema.keyPattern && !schema.keyPattern.test(key)) {
          errors.push({ path: [...path, key], message: `Invalid key "${key}" (does not match expected id format)` });
        }
        validateNode(child, schema.valueSchema, [...path, key], errors);
      }
      break;
    }
    case 'union': {
      const subErrors: ValidationError[][] = [];
      for (const sub of schema.schemas) {
        const errs: ValidationError[] = [];
        validateNode(value, sub, path, errs);
        if (errs.length === 0) return;
        subErrors.push(errs);
      }
      const best = subErrors.reduce((a, b) => a.length <= b.length ? a : b);
      errors.push(...best);
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ path, message: `Expected array, got ${typeof value}` });
        return;
      }
      for (let i = 0; i < value.length; i++) {
        validateNode(value[i], schema.items, [...path, i], errors);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared constants & patterns
// ---------------------------------------------------------------------------

export const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
export const UTC_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
export const DURATION_RE = /^-?P(\d+W|\d+D)?(T(\d+H)?(\d+M)?(\d+S)?)?$/;
/**
 * Hex color: `#rgb`, `#rrggbb`, or `#rrggbbaa`. Accepts the 3-digit shorthand and
 * the 8-digit (with-alpha) form the app can legitimately produce, and rejects any
 * non-hex string that would land unescaped in a CSS custom property / schedule-x
 * color config. Shared so other document types (Group E) reuse the same rule.
 */
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
/**
 * A `byMonth` value (RFC 8984): a month number 1..13 (13 allows leap months in
 * non-Gregorian rscale calendars) optionally suffixed with "L" for a leap month.
 * The ICS importer stores these as `String(monthNumber)` (see backend/parser.ts),
 * so no leading zeros are expected, but we tolerate one to stay lenient.
 */
export const MONTH_VALUE_RE = /^(0?[1-9]|1[0-3])L?$/;
export const DAY_VALUES = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;
export const FREQ_VALUES = ['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly'] as const;
export const PROGRESS_VALUES = ['needs-action', 'in-process', 'completed', 'failed', 'cancelled'] as const;
export const STATUS_VALUES = ['confirmed', 'cancelled', 'tentative'] as const;
export const FREEBUSY_VALUES = ['free', 'busy', 'busy-tentative', 'busy-unavailable'] as const;
export const PRIVACY_VALUES = ['public', 'private', 'confidential'] as const;

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

export const boolMap = record(bool(), { optional: true });

export const linkSchema = obj({
  '@type': str({ enum: ['Link'] }),
  href: str(),
  cid: str({ optional: true }),
  contentType: str({ optional: true }),
  size: num({ min: 0, integer: true, optional: true }),
  rel: str({ optional: true }),
  display: str({ enum: ['badge', 'graphic', 'fullsize', 'thumbnail'], optional: true }),
  title: str({ optional: true }),
});

export const virtualLocationSchema = obj({
  '@type': str({ enum: ['VirtualLocation'] }),
  name: str({ optional: true }),
  description: str({ optional: true }),
  uri: str(),
  features: boolMap,
});

export const nDaySchema = obj({
  '@type': str({ enum: ['NDay'], optional: true }),
  day: str({ enum: DAY_VALUES }),
  nthOfPeriod: num({ integer: true, optional: true }),
});

export const recurrenceRuleSchema = obj({
  '@type': str({ enum: ['RecurrenceRule'], optional: true }),
  frequency: str({ enum: FREQ_VALUES }),
  interval: num({ min: 1, integer: true, optional: true }),
  rscale: str({ optional: true }),
  skip: str({ enum: ['omit', 'backward', 'forward'], optional: true }),
  firstDayOfWeek: str({ enum: DAY_VALUES, optional: true }),
  byDay: arr(nDaySchema, { optional: true }),
  byMonthDay: arr(num({ min: -31, max: 31, integer: true }), { optional: true }),
  byMonth: arr(str(), { optional: true }),
  byYearDay: arr(num({ min: -366, max: 366, integer: true }), { optional: true }),
  byWeekNo: arr(num({ min: -53, max: 53, integer: true }), { optional: true }),
  byHour: arr(num({ min: 0, max: 23, integer: true }), { optional: true }),
  byMinute: arr(num({ min: 0, max: 59, integer: true }), { optional: true }),
  bySecond: arr(num({ min: 0, max: 60, integer: true }), { optional: true }),
  bySetPosition: arr(num({ min: -366, max: 366, integer: true }), { optional: true }),
  count: num({ min: 1, integer: true, optional: true }),
  until: str({ pattern: LOCAL_DATE_TIME_RE, optional: true }),
}, { optional: true });

export const participantSchema = obj({
  '@type': str({ enum: ['Participant'], optional: true }),
  name: str({ optional: true }),
  email: str({ optional: true }),
  description: str({ optional: true }),
  sendTo: record(str(), { optional: true }),
  kind: str({ enum: ['individual', 'group', 'resource', 'room', 'unknown'], optional: true }),
  roles: boolMap,
  language: str({ optional: true }),
  locationId: str({ optional: true }),
  participationStatus: str({ enum: ['needs-action', 'accepted', 'declined', 'tentative', 'delegated'], optional: true }),
  participationComment: str({ optional: true }),
  expectReply: bool({ optional: true }),
  scheduleAgent: str({ enum: ['server', 'client', 'none'], optional: true }),
  scheduleForceSend: bool({ optional: true }),
  scheduleSequence: num({ min: 0, integer: true, optional: true }),
  scheduleUpdated: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
  invitedBy: str({ optional: true }),
  delegatedTo: boolMap,
  delegatedFrom: boolMap,
  memberOf: boolMap,
  links: record(linkSchema, { optional: true }),
  progress: str({ optional: true }),
  progressUpdated: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
  percentComplete: num({ min: 0, max: 100, integer: true, optional: true }),
});

export const offsetTriggerSchema = obj({
  '@type': str({ enum: ['OffsetTrigger'] }),
  offset: str({ pattern: DURATION_RE }),
  relativeTo: str({ enum: ['start', 'end'], optional: true }),
});

export const absoluteTriggerSchema = obj({
  '@type': str({ enum: ['AbsoluteTrigger'] }),
  when: str({ pattern: UTC_DATE_TIME_RE }),
});

export const alertSchema = obj({
  '@type': str({ enum: ['Alert'], optional: true }),
  trigger: union([offsetTriggerSchema, absoluteTriggerSchema]),
  acknowledged: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
  action: str({ enum: ['display', 'email'], optional: true }),
});

// ---------------------------------------------------------------------------
// Shared dependency-check helpers
//
// These mirror the parsing the renderers do at runtime (Temporal for
// dates/durations/zones) so crafted values that slip past the loose regexes but
// crash a renderer surface as validation errors instead. They are pure so both
// the Calendar and TaskList checkers can share them without duplicating logic.
// ---------------------------------------------------------------------------

/**
 * True if `s` parses as a JSCalendar local date ("YYYY-MM-DD") or local
 * date-time ("YYYY-MM-DDTHH:mm[:ss]"). Values ≤10 chars are treated as all-day
 * dates, matching how the recurrence engine interprets `start`.
 */
export function isParseableLocalDateTime(s: string): boolean {
  try {
    if (s.length <= 10) Temporal.PlainDate.from(s.substring(0, 10));
    else Temporal.PlainDateTime.from(s.substring(0, 19));
    return true;
  } catch {
    return false;
  }
}

/** True if `s` parses as an ISO 8601 duration (e.g. "PT1H", "P1DT2H30M"). */
export function isParseableDuration(s: string): boolean {
  try {
    Temporal.Duration.from(s);
    return true;
  } catch {
    return false;
  }
}

/** True if `tz` is a time zone Temporal can resolve (IANA id or fixed offset). */
export function isParseableTimeZone(tz: string): boolean {
  try {
    Temporal.PlainDateTime.from('2020-01-01T00:00:00').toZonedDateTime(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * True if a stored `href`/`uri` uses a scheme that can execute script when
 * rendered into an anchor or iframe. The app only ever stores http(s)/mailto/
 * tel-style URLs (from ICS import, conference/url properties) and opaque
 * attachment payloads, so a `javascript:`/`vbscript:`/`data:text/html` value is
 * always malformed and worth flagging as defense-in-depth. Whitespace and
 * control characters are stripped first because browsers ignore them when
 * resolving the scheme.
 */
export function isDangerousUri(value: string): boolean {
  const stripped = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return (
    stripped.startsWith('javascript:') ||
    stripped.startsWith('vbscript:') ||
    stripped.startsWith('data:text/html')
  );
}

/**
 * Cross-field validation for a JSCalendar RecurrenceRule, shared by Calendar and
 * TaskList. `rulePath` is the path to the rule object (e.g. ['events', uid,
 * 'recurrenceRule']) so error paths land on the offending sub-field.
 *
 * Covers correctness rules the schema's per-field bounds cannot express:
 * mutually-exclusive count/until, `by*` index values of 0 (nonsensical and, for
 * byMonthDay, a source of infinite expansion loops), out-of-range byMonth
 * strings, an empty byDay on a byDay-driven frequency, and nthOfPeriod misuse.
 */
export function checkRecurrenceRuleDeps(
  rule: any,
  rulePath: (string | number)[],
  errors: ValidationError[],
): void {
  if (!rule || typeof rule !== 'object') return;

  if (rule.count != null && rule.until != null) {
    errors.push({ path: rulePath, message: 'count and until are mutually exclusive', kind: 'dependency' });
  }

  // byMonthDay must be 1..31 or -31..-1. The schema bounds the range, but 0 is
  // not expressible there and drives the monthly expansion into an infinite loop.
  if (Array.isArray(rule.byMonthDay)) {
    rule.byMonthDay.forEach((v: any, i: number) => {
      if (v === 0) {
        errors.push({
          path: [...rulePath, 'byMonthDay', i],
          message: 'byMonthDay must be 1..31 or -31..-1 (0 is not allowed)',
          kind: 'dependency',
        });
      }
    });
  }

  // byYearDay / byWeekNo / bySetPosition are signed indices; 0 is meaningless
  // ("the 0th day/week/occurrence") and never produced legitimately.
  for (const field of ['byYearDay', 'byWeekNo', 'bySetPosition'] as const) {
    if (Array.isArray(rule[field])) {
      rule[field].forEach((v: any, i: number) => {
        if (v === 0) {
          errors.push({
            path: [...rulePath, field, i],
            message: `${field} must not be 0`,
            kind: 'dependency',
          });
        }
      });
    }
  }

  // byMonth values are month strings "1".."13" (optionally "L"-suffixed for
  // leap months). Anything else is malformed.
  if (Array.isArray(rule.byMonth)) {
    rule.byMonth.forEach((v: any, i: number) => {
      if (typeof v !== 'string' || !MONTH_VALUE_RE.test(v)) {
        errors.push({
          path: [...rulePath, 'byMonth', i],
          message: `byMonth value "${v}" is not a valid month (expected "1".."13", optionally suffixed with "L")`,
          kind: 'dependency',
        });
      }
    });
  }

  const freq = rule.frequency;

  // A byDay-driven frequency (weekly and finer) with an empty byDay produces no
  // occurrences and previously looped forever during expansion.
  if (freq && Array.isArray(rule.byDay) && rule.byDay.length === 0) {
    if (freq !== 'yearly' && freq !== 'monthly') {
      errors.push({
        path: [...rulePath, 'byDay'],
        message: `${freq} frequency with an empty byDay produces no occurrences`,
        kind: 'dependency',
      });
    }
  }

  if (Array.isArray(rule.byDay)) {
    for (let i = 0; i < rule.byDay.length; i++) {
      const nth = rule.byDay[i]?.nthOfPeriod;
      if (nth == null) continue;
      if (nth === 0) {
        errors.push({
          path: [...rulePath, 'byDay', i, 'nthOfPeriod'],
          message: 'nthOfPeriod must not be 0',
          kind: 'dependency',
        });
      } else if (freq && freq !== 'yearly' && freq !== 'monthly') {
        errors.push({
          path: [...rulePath, 'byDay', i, 'nthOfPeriod'],
          message: `nthOfPeriod is only valid with yearly or monthly frequency, got "${freq}"`,
          kind: 'dependency',
        });
      }
    }
  }
}

/**
 * Validate that every key of a `recurrenceOverrides` map is a parseable local
 * date / date-time (the keys are occurrence identifiers). `basePath` is the path
 * to the recurrenceOverrides object.
 */
export function checkRecurrenceOverrideKeys(
  overrides: any,
  basePath: (string | number)[],
  errors: ValidationError[],
): void {
  if (!overrides || typeof overrides !== 'object') return;
  for (const key of Object.keys(overrides)) {
    if (!isParseableLocalDateTime(key)) {
      errors.push({
        path: [...basePath, key],
        message: `recurrenceOverrides key "${key}" is not a valid date/time`,
        kind: 'dependency',
      });
    }
  }
}
