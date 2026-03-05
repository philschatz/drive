/**
 * Core schema DSL, validator, shared sub-schemas, and types.
 */

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
  | { type: 'record'; valueSchema: SchemaNode; optional?: boolean }
  | { type: 'union'; schemas: SchemaNode[]; optional?: boolean }
  | { type: 'array'; items: SchemaNode; optional?: boolean };

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
export function record(valueSchema: SchemaNode, opts?: { optional?: boolean }): SchemaNode {
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
