import type { CalendarEvent } from '../../../../shared/schemas/calendar';

const DAY_MAP: Record<string, number> = { su: 7, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };

export interface ExpandedEvent {
  uid: string;
  recurrenceDate: string | null;
  ev: CalendarEvent;
  isRecurring: boolean;
}

export function isAllDay(ev: CalendarEvent): boolean {
  return !!ev.start && ev.start.length <= 10;
}

/**
 * A recurrence rule as a short human phrase — "every 2 weeks on mo, we at 09:00".
 * Returns '' when there is no rule.
 *
 * Shared by the Counters list rows and by both editors' collapsed "Repeat"
 * property row, which is the only summary of a rule the user sees until they
 * open the pane.
 */
export function describeRecurrence(rule?: { frequency?: string; interval?: number; byDay?: { day: string }[] } | null, startTime?: string): string {
  if (!rule?.frequency) return '';
  const every = rule.interval && rule.interval > 1 ? `every ${rule.interval} ` : '';
  const base = every
    ? { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }
    : { daily: 'daily', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };
  const freq = (base as any)[rule.frequency] || rule.frequency;
  const days = rule.byDay?.length ? ' on ' + rule.byDay.map(d => d.day).join(', ') : '';
  const at = startTime ? ' at ' + startTime.substring(0, 5) : '';
  return every + freq + days + at;
}

export function toDateStr(d: any): string {
  if (d instanceof Temporal.PlainDate || d instanceof Temporal.PlainDateTime) return d.toString().substring(0, 10);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * Weeks fold into days: `DURATION_RE` accepts "P1W", so without the W branch it
 * would match the bare "P" and yield a ZERO-length duration — which reads as a
 * window that shuts the instant it opens, not as one week.
 */
export function parseDuration(dur: string): { days: number; hours: number; minutes: number } {
  if (!dur) return { days: 0, hours: 1, minutes: 0 };
  const m = dur.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  if (!m) return { days: 0, hours: 1, minutes: 0 };
  const days = parseInt(m[1] || '0') * 7 + parseInt(m[2] || '0');
  return { days, hours: parseInt(m[3] || '0'), minutes: parseInt(m[4] || '0') };
}

// Hard backstop against pathological rules (crafted CRDT JSON / malicious .ics).
// Validation is advisory, so the generator itself must never hang: every loop
// advances/checks a counter regardless of whether an occurrence is produced.
const MAX_ITERATIONS = 20000;

export function generateDates(startStr: string, rule: any, rangeStart: string, rangeEnd: string): string[] {
  const dates: string[] = [];
  // Clamp interval/count so interval:0 (never advances) and count:0/negative
  // (never terminates via count) cannot spin forever.
  const rawInterval = rule.interval;
  const interval = typeof rawInterval === 'number' && rawInterval >= 1 ? Math.floor(rawInterval) : 1;
  const maxCount = typeof rule.count === 'number' && rule.count >= 1 ? Math.floor(rule.count) : 730;
  const untilStr = rule.until ? rule.until.substring(0, 10) : null;
  const allDay = startStr.length <= 10;
  const timePart = allDay ? '' : startStr.substring(10);
  const startDate = Temporal.PlainDate.from(startStr.substring(0, 10));
  const rangeStartDate = Temporal.PlainDate.from(rangeStart);
  const rangeEndDate = Temporal.PlainDate.from(rangeEnd);
  const untilDate = untilStr ? Temporal.PlainDate.from(untilStr) : null;
  let count = 0;
  let iterations = 0;

  function addDate(d: Temporal.PlainDate): boolean {
    if (untilDate && Temporal.PlainDate.compare(d, untilDate) > 0) return false;
    if (Temporal.PlainDate.compare(d, rangeEndDate) > 0) return false;
    if (Temporal.PlainDate.compare(d, rangeStartDate) >= 0 && Temporal.PlainDate.compare(d, startDate) >= 0) {
      dates.push(d.toString() + timePart);
    }
    count++;
    return count < maxCount;
  }

  let cur = Temporal.PlainDate.from(startDate);

  switch (rule.frequency) {
    case 'daily':
      while (addDate(cur)) {
        if (++iterations > MAX_ITERATIONS) break;
        cur = cur.add({ days: interval });
      }
      break;

    case 'weekly': {
      // Empty/invalid byDay must not stall the loop (the inner for-loop would
      // never call addDate). Fall back to the start weekday and drop unknown days.
      let byDay: number[] = (rule.byDay && rule.byDay.length)
        ? rule.byDay.map((d: any) => DAY_MAP[d?.day]).filter((n: number) => typeof n === 'number')
        : [startDate.dayOfWeek];
      if (byDay.length === 0) byDay = [startDate.dayOfWeek];
      byDay.sort((a: number, b: number) => a - b);
      let weekStart = Temporal.PlainDate.from(cur);
      let done = false;
      while (!done) {
        // Advance the guard every iteration, even if no occurrence lands in range.
        if (++iterations > MAX_ITERATIONS) break;
        // The 7-day window starts at the start date's weekday, so candidates can
        // land out of chronological order; sort before adding, otherwise a
        // beyond-range later day terminates the loop and drops in-range siblings.
        const candidates = byDay
          .map((day: number) => weekStart.add({ days: (day - weekStart.dayOfWeek + 7) % 7 }))
          .sort(Temporal.PlainDate.compare);
        for (let i = 0; i < candidates.length; i++) {
          if (!addDate(candidates[i])) { done = true; break; }
        }
        weekStart = weekStart.add({ days: 7 * interval });
      }
      break;
    }

    case 'monthly': {
      const rawDom = rule.byMonthDay ? rule.byMonthDay[0] : startDate.day;
      while (true) {
        // Guard first: byMonthDay values that never match (e.g. 32) would
        // otherwise loop forever because addDate is never reached.
        if (++iterations > MAX_ITERATIONS) break;
        // Once past the range end (and any `until`) no future month can contribute.
        if (Temporal.PlainDate.compare(cur, rangeEndDate) > 0) break;
        if (untilDate && Temporal.PlainDate.compare(cur, untilDate) > 0) break;
        const dim = cur.daysInMonth;
        // Resolve the day-of-month: positive is 1..dim; negative counts from the
        // end (-1 = last day). 0, >dim, and out-of-range negatives produce no
        // occurrence this month instead of throwing on cur.with({ day }).
        let dom: number | null = null;
        if (typeof rawDom === 'number' && Number.isInteger(rawDom)) {
          if (rawDom >= 1 && rawDom <= dim) dom = rawDom;
          else if (rawDom < 0 && dim + rawDom + 1 >= 1) dom = dim + rawDom + 1;
        }
        if (dom !== null) {
          const md = cur.with({ day: dom });
          if (!addDate(md)) break;
        }
        cur = cur.add({ months: interval }).with({ day: 1 });
      }
      break;
    }

    case 'yearly':
      while (addDate(cur)) {
        if (++iterations > MAX_ITERATIONS) break;
        cur = cur.add({ years: interval });
      }
      break;
  }
  return dates;
}

export function rebuildExpanded(events: Record<string, CalendarEvent>, rangeStart: string, rangeEnd: string): ExpandedEvent[] {
  const expanded: ExpandedEvent[] = [];

  for (const uid in events) {
    const ev = events[uid];
    if (!ev || !ev.start) continue;
    const isRecurring = !!ev.recurrenceRule;

    if (!isRecurring) {
      const evDay = ev.start.substring(0, 10);
      if (evDay >= rangeStart && evDay <= rangeEnd) {
        expanded.push({ uid, recurrenceDate: null, ev, isRecurring: false });
      }
      continue;
    }

    // Expansion parses untrusted date/rule data via Temporal, which can throw on
    // crafted input. Skip (and log) the offending event rather than letting one
    // bad event blank the whole calendar.
    try {
      const allDates = new Set<string>();
      const dates = generateDates(ev.start, ev.recurrenceRule!, rangeStart, rangeEnd);
      for (const d of dates) allDates.add(d);

      if (ev.recurrenceOverrides) {
        for (const dateKey in ev.recurrenceOverrides) {
          const overrideDay = dateKey.substring(0, 10);
          if (overrideDay >= rangeStart && overrideDay <= rangeEnd) allDates.add(dateKey);
        }
      }

      allDates.forEach(dateStr => {
        const override = ev.recurrenceOverrides && ev.recurrenceOverrides[dateStr];
        if (override && override.excluded) return;
        const effective: any = Object.assign({}, ev);
        if (ev.start!.length <= 10) { effective.start = dateStr.substring(0, 10); }
        else { effective.start = dateStr; }
        if (override) {
          for (const key in override) { if (key !== 'excluded') effective[key] = override[key]; }
        }
        delete effective.recurrenceRule;
        delete effective.recurrenceOverrides;
        expanded.push({ uid, recurrenceDate: dateStr, ev: effective, isRecurring: true });
      });
    } catch (err) {
      console.warn(`Skipping recurrence expansion for event "${uid}":`, err);
    }
  }

  return expanded;
}
