import {
  type ValidationError, type DocSchemaPlugin,
  type LocalDateTime, type UTCDateTime, type Duration,
  str, obj, record, validateNode,
  recurrenceRuleSchema, UTC_DATE_TIME_RE,
  isParseableLocalDateTime, isParseableDuration,
  checkRecurrenceRuleDeps,
} from './core';
import { Temporal } from 'temporal-polyfill';
import { baseEventFields, checkBaseEventTimeDeps, type RecurrenceRule } from './calendar';

/** "HH:mm" or "HH:mm:ss" — the local time-of-day a recurring counter's window opens. */
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export interface CounterEvent {
  '@type': 'Event';
  /** When the counter was created. Written once and never edited: it is the base
   * anchor of the occurrence grid, so the habit's history survives `start`
   * moving with each completion. */
  created?: UTCDateTime;
  title?: string;
  recurrenceRule?: RecurrenceRule;
  /**
   * Two meanings, picked by whether `recurrenceRule` is set — see `counterKind`
   * in doc-plugins/counters/occurrences.ts.
   *
   * Recurring: the *schedule anchor* — the day of the most recent completion, so
   * the recurrence restarts from when the habit was actually done. Absent until
   * the first completion (the grid then runs from `created`).
   *
   * Non-recurring: the day this is **wanted** — a one-off to-do. Its presence is
   * what puts the counter on the to-do list; recording a completion clears it,
   * settling the item back into Anytime so the same event can be armed again
   * the next time. Absent means nothing is owed.
   */
  start?: LocalDateTime;
  /** Optional time-of-day the window opens (no date), for either kind. */
  startTime?: string;
  /** How long the window stays open. With `startTime`, this is what decides when
   * an occurrence — or an armed one-off — goes overdue. */
  duration?: Duration;
  /**
   * Free text. A leading "<n>: " encodes a reward unlocked by a streak of n
   * completions ("10: Ice cream"); anything else is a plain note. Parsed by
   * `parseReward` in doc-plugins/counters/occurrences.ts.
   */
  description?: string;
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

/**
 * The date a completion recorded at `ts` anchors the schedule to. A click before
 * the day's window opens belongs to the previous day's occurrence — so ticking an
 * 08:00 habit at 07:00 must not push today's occurrence into the future.
 *
 * Lives here rather than beside the occurrence engine because both the engine and
 * the validator below need it, and `src/shared` cannot import from `src/client`.
 */
export function reanchorDate(ev: CounterEvent, ts: string): string {
  const date = ts.substring(0, 10);
  const time = ts.length > 10 ? ts.substring(11, 19) : '00:00:00';
  const opens = ev.startTime && ev.startTime.length === 5 ? ev.startTime + ':00' : ev.startTime;
  if (opens && time < opens) {
    try {
      return Temporal.PlainDate.from(date).subtract({ days: 1 }).toString();
    } catch {
      return date; // unparseable key — the validator reports it separately
    }
  }
  return date;
}

/**
 * Where a recurring counter's schedule currently restarts: the anchor date of its
 * most recent completion. This is exactly what `start` must hold — see
 * {@link checkCounterDependencies}.
 */
export function lastCompletionAnchor(ev: CounterEvent): string | undefined {
  let latest: string | undefined;
  let anchor: string | undefined;
  for (const ts of Object.keys(ev.completions ?? {})) {
    if (latest !== undefined && ts <= latest) continue; // keys sort chronologically
    latest = ts;
    anchor = reanchorDate(ev, ts);
  }
  return anchor;
}

export const counterEventSchema = obj({
  '@type': str({ enum: ['Event'] }),
  created: str({ pattern: UTC_DATE_TIME_RE, optional: true }),
  ...baseEventFields,
  startTime: str({ pattern: TIME_OF_DAY_RE, optional: true }),
  description: str({ optional: true }),
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

    // The regex accepts any 4-2-2 shape, so "2026-13-45T00:00:00Z" would pass it.
    // Check the date/time portion the same way `start` is checked (the trailing
    // Z / offset is validated by the pattern).
    if (typeof ev.created === 'string' && ev.created && !isParseableLocalDateTime(ev.created.substring(0, 19))) {
      errors.push({ path: [...p, 'created'], message: `created "${ev.created}" is not a valid date/time`, kind: 'dependency' });
    }

    // A recurring counter's `start` is its schedule anchor: recording a
    // completion moves it to the day the habit was actually done, so it must
    // agree with the most recent entry in the click log. (No completions yet
    // means no anchor to check — `start` is then either absent or a creation
    // anchor left by a counter written before `created` existed.)
    if (ev.recurrenceRule) {
      const expected = lastCompletionAnchor(ev);
      if (expected && ev.start !== expected) {
        errors.push({
          path: [...p, 'start'],
          message: `start "${ev.start ?? ''}" should be the most recent completion's date ("${expected}")`,
          kind: 'dependency',
        });
      }
    }

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
