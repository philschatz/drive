import {
  type ValidationError, type DocSchemaPlugin,
  type LocalDateTime, type Duration,
  str, obj, record, validateNode,
  recurrenceRuleSchema,
  isParseableLocalDateTime, isParseableDuration,
  checkRecurrenceRuleDeps,
} from './core';
import { baseEventFields, checkBaseEventTimeDeps, type RecurrenceRule } from './calendar';

/** "HH:mm" or "HH:mm:ss" — the local time-of-day a recurring counter's window opens. */
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export interface CounterEvent {
  '@type': 'Event';
  title?: string;
  recurrenceRule?: RecurrenceRule;
  /** Optional anchor date for one-shot counters; recurring counters omit it. */
  start?: LocalDateTime;
  /** Optional time-of-day the recurring window opens (no date). */
  startTime?: string;
  duration?: Duration;
  /** Click log: key = local timestamp of the click, value = how long the
   * occurrence took (ISO 8601 duration) or '' when not recorded. */
  completions?: { [clickTimestamp: string]: Duration | '' };
}

export interface CounterDocument {
  '@type': 'Calendar+Counters';
  name: string;
  description?: string;
  events: Record<string, CounterEvent>;
}

export const counterEventSchema = obj({
  '@type': str({ enum: ['Event'] }),
  ...baseEventFields,
  startTime: str({ pattern: TIME_OF_DAY_RE, optional: true }),
  recurrenceRule: recurrenceRuleSchema,
  // Keys are click timestamps and values optional durations — both shapes are
  // checked in checkCounterDependencies (the DSL validates values, not keys).
  completions: record(str(), { optional: true }),
});

export const counterDocumentSchema = obj({
  '@type': str({ enum: ['Calendar+Counters'] }),
  name: str(),
  description: str({ optional: true }),
  events: record(counterEventSchema),
});

export function checkCounterDependencies(doc: any, errors: ValidationError[]): void {
  const events = doc.events;
  if (!events || typeof events !== 'object') return;

  for (const [uid, event] of Object.entries(events)) {
    const ev = event as any;
    const p = ['events', uid];

    if (ev.recurrenceRule) {
      checkRecurrenceRuleDeps(ev.recurrenceRule, [...p, 'recurrenceRule'], errors);
    }

    checkBaseEventTimeDeps(ev, p, errors);

    if (ev.completions && typeof ev.completions === 'object') {
      for (const [ts, dur] of Object.entries(ev.completions)) {
        if (!isParseableLocalDateTime(ts)) {
          errors.push({ path: [...p, 'completions', ts], message: `completion key "${ts}" is not a valid date/time`, kind: 'dependency' });
        }
        if (typeof dur === 'string' && dur && !isParseableDuration(dur)) {
          errors.push({ path: [...p, 'completions', ts], message: `completion duration "${dur}" is not a valid ISO 8601 duration`, kind: 'dependency' });
        }
      }
    }
  }
}

export function validateCounterEvent(event: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(event, counterEventSchema, [], errors);
  return errors;
}

/** Worker-safe plugin core — registered in src/shared/schemas (validation) and
 * spread into the full counters plugin (src/client/doc-plugins/counters/plugin.tsx). */
export const countersSchemaPlugin: DocSchemaPlugin = {
  type: 'Calendar+Counters',
  schema: counterDocumentSchema,
  checkDeps: checkCounterDependencies,
};
