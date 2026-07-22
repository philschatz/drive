import type { CounterEvent } from './schema';
import { generateDates, parseDuration } from '../calendar/recurrence';

/** All functions take `now` as a local datetime string ("YYYY-MM-DDTHH:mm:ss")
 * so the logic stays pure and testable. */

export type CounterStatus = 'overdue' | 'pending' | 'upcoming' | 'done' | 'tally';

export interface CounterEntry {
  uid: string;
  ev: CounterEvent;
  status: CounterStatus;
  /** The occurrence the status refers to (window start datetime), if any. */
  occurrence?: string;
}

export interface WeekStat {
  weekStart: string; // "YYYY-MM-DD", Monday
  met: number;
  missed: number;
}

const LOOKBACK_DAYS = 400;

/** A habit is archived by ending its recurrence: `recurrenceRule.until` is set
 * to the moment it was archived, so no future occurrences are generated. */
export function isArchived(ev: CounterEvent): boolean {
  return !!ev.recurrenceRule?.until;
}

/** Normalize a local date or datetime string to a full local datetime. */
function toDateTime(s: string): string {
  return s.length <= 10 ? s + 'T00:00:00' : s;
}

function dateOf(s: string): string {
  return s.substring(0, 10);
}

function normTime(t: string): string {
  return t.length === 5 ? t + ':00' : t;
}

// Recurring counters don't carry a start date — occurrences follow the rule
// alone. generateDates needs an anchor to expand from (and caps how far it
// walks), so the query's own range start is used as the anchor; the (optional)
// time-of-day window comes from `startTime` + `duration`, not a start date.
function anchorFor(ev: CounterEvent, rangeStart: string): string {
  const date = ev.start ? dateOf(ev.start) : rangeStart;
  let timePart = ev.start && ev.start.length > 10 ? ev.start.substring(10) : '';
  if (ev.startTime) timePart = 'T' + normTime(ev.startTime);
  return date + timePart;
}

/** End of an occurrence's pending window: window start + duration, or end of
 * its day when no duration is set. */
export function windowEnd(ev: CounterEvent, occ: string): string {
  const start = Temporal.PlainDateTime.from(toDateTime(occ));
  if (ev.duration) {
    const d = parseDuration(ev.duration);
    return start.add({ days: d.days, hours: d.hours, minutes: d.minutes }).toString();
  }
  return Temporal.PlainDate.from(dateOf(occ)).add({ days: 1 }).toString() + 'T00:00:00';
}

/** Occurrence window-start datetimes in [rangeStart, rangeEnd] (inclusive date
 * strings — generateDates range semantics), sorted ascending. */
export function expectedOccurrences(ev: CounterEvent, rangeStart: string, rangeEnd: string): string[] {
  if (!ev.recurrenceRule) {
    if (!ev.start) return [];
    const d = dateOf(ev.start);
    return d >= rangeStart && d <= rangeEnd ? [ev.start] : [];
  }
  return generateDates(anchorFor(ev, rangeStart), ev.recurrenceRule, rangeStart, rangeEnd);
}

/** True when a click was recorded within an occurrence's credit period — from
 * the occurrence's window start until the next occurrence begins (a late
 * completion still counts, up until the habit comes due again). */
export function metInPeriod(ev: CounterEvent, occStart: string, nextStart?: string): boolean {
  const completions = ev.completions;
  if (!completions) return false;
  const lo = toDateTime(occStart);
  const hi = nextStart ? toDateTime(nextStart) : null;
  for (const ts of Object.keys(completions)) {
    const t = toDateTime(ts);
    if (t >= lo && (hi === null || t < hi)) return true;
  }
  return false;
}

/**
 * Status of a counter's current period, used for sectioning/sorting:
 *   'tally'    — no schedule at all: a free-running counter, always clickable
 *   'upcoming' — its first occurrence is still in the future
 *   'done'     — the current period has a recorded completion
 *   'pending'  — the current occurrence's window is still open and the previous
 *                occurrence (if any since the habit's start) was met
 *   'overdue'  — the current window has closed with no completion yet (and the
 *                next occurrence hasn't begun), or the current window is open
 *                but the previous occurrence went unmet
 */
export function currentStatus(ev: CounterEvent, now: string): { status: CounterStatus; occurrence?: string } {
  if (!ev.recurrenceRule && !ev.start) return { status: 'tally' };

  const today = dateOf(now);
  const from = Temporal.PlainDate.from(today).subtract({ days: LOOKBACK_DAYS }).toString();
  const to = Temporal.PlainDate.from(today).add({ days: LOOKBACK_DAYS }).toString();
  const occs = expectedOccurrences(ev, from, to);
  if (occs.length === 0) return { status: 'upcoming' };

  let prev: string | undefined;
  let curr: string | undefined;
  let next: string | undefined;
  for (const o of occs) {
    if (toDateTime(o) <= now) { prev = curr; curr = o; }
    else { next = o; break; }
  }
  if (!curr) return { status: 'upcoming', occurrence: occs[0] };

  if (metInPeriod(ev, curr, next)) return { status: 'done', occurrence: curr };
  if (now >= windowEnd(ev, curr)) return { status: 'overdue', occurrence: curr };
  // Window still open — but a missed previous occurrence keeps it overdue.
  // Without a start anchor the expansion is synthetic (anchored at the query
  // range), so "previous" doesn't imply the habit existed then; skip the check.
  if (ev.start && prev && !metInPeriod(ev, prev, curr)) return { status: 'overdue', occurrence: curr };
  return { status: 'pending', occurrence: curr };
}

/** Overdue first, then pending, upcoming, done, and finally schedule-less
 * tallies — ties broken by occurrence time then title. */
const STATUS_ORDER: Record<CounterStatus, number> = { overdue: 0, pending: 1, upcoming: 2, done: 3, tally: 4 };

export function sortedCounters(events: Record<string, CounterEvent>, now: string): CounterEntry[] {
  const entries: CounterEntry[] = Object.entries(events).map(([uid, ev]) => ({ uid, ev, ...currentStatus(ev, now) }));
  entries.sort((a, b) => {
    if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    const ao = a.occurrence || '';
    const bo = b.occurrence || '';
    if (ao !== bo) return ao < bo ? -1 : 1;
    const at = a.ev.title || '';
    const bt = b.ev.title || '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.uid < b.uid ? -1 : 1;
  });
  return entries;
}

/**
 * Met/missed history aggregated per week (Monday-start), oldest first,
 * covering `weeks` weeks up to `now`. Only occurrences whose credit period has
 * fully elapsed (the next occurrence has already begun) are counted, so the
 * current, still-open period is never shown as missed. Free tallies are excluded.
 */
export function metMissedByWeek(events: Record<string, CounterEvent>, now: string, weeks = 12): WeekStat[] {
  const today = Temporal.PlainDate.from(dateOf(now));
  const thisWeekStart = today.subtract({ days: today.dayOfWeek - 1 });
  const firstWeekStart = thisWeekStart.subtract({ weeks: weeks - 1 });

  const stats: WeekStat[] = [];
  const byWeek = new Map<string, WeekStat>();
  for (let i = 0; i < weeks; i++) {
    const ws = firstWeekStart.add({ weeks: i }).toString();
    const stat = { weekStart: ws, met: 0, missed: 0 };
    stats.push(stat);
    byWeek.set(ws, stat);
  }

  for (const ev of Object.values(events)) {
    if (!ev.recurrenceRule && !ev.start) continue; // free tally
    const occs = expectedOccurrences(ev, firstWeekStart.toString(), dateOf(now));
    for (let i = 0; i < occs.length; i++) {
      const occ = occs[i];
      const next = occs[i + 1];
      // Only decided once the next period has started (or, for a one-shot, once
      // its window has closed).
      const decided = next ? toDateTime(next) <= now : windowEnd(ev, occ) <= now;
      if (!decided) continue;
      const occDate = Temporal.PlainDate.from(dateOf(occ));
      const weekStart = occDate.subtract({ days: occDate.dayOfWeek - 1 }).toString();
      const stat = byWeek.get(weekStart);
      if (!stat) continue;
      if (metInPeriod(ev, occ, next)) stat.met++;
      else stat.missed++;
    }
  }
  return stats;
}
