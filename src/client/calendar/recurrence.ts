import type { CalendarEvent } from './schema';

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

export function toDateStr(d: any): string {
  if (d instanceof Temporal.PlainDate || d instanceof Temporal.PlainDateTime) return d.toString().substring(0, 10);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function parseDuration(dur: string): { days: number; hours: number; minutes: number } {
  if (!dur) return { days: 0, hours: 1, minutes: 0 };
  const m = dur.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
  if (!m) return { days: 0, hours: 1, minutes: 0 };
  return { days: parseInt(m[1] || '0'), hours: parseInt(m[2] || '0'), minutes: parseInt(m[3] || '0') };
}

export function generateDates(startStr: string, rule: any, rangeStart: string, rangeEnd: string): string[] {
  const dates: string[] = [];
  const interval = rule.interval || 1;
  const maxCount = rule.count || 730;
  const untilStr = rule.until ? rule.until.substring(0, 10) : null;
  const allDay = startStr.length <= 10;
  const timePart = allDay ? '' : startStr.substring(10);
  const startDate = Temporal.PlainDate.from(startStr.substring(0, 10));
  const rangeStartDate = Temporal.PlainDate.from(rangeStart);
  const rangeEndDate = Temporal.PlainDate.from(rangeEnd);
  const untilDate = untilStr ? Temporal.PlainDate.from(untilStr) : null;
  let count = 0;

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
      while (addDate(cur)) cur = cur.add({ days: interval });
      break;

    case 'weekly': {
      const byDay = rule.byDay ? rule.byDay.map((d: any) => DAY_MAP[d.day]) : [startDate.dayOfWeek];
      byDay.sort((a: number, b: number) => a - b);
      let weekStart = Temporal.PlainDate.from(cur);
      let done = false;
      while (!done) {
        for (let i = 0; i < byDay.length; i++) {
          const diff = (byDay[i] - weekStart.dayOfWeek + 7) % 7;
          const dd = weekStart.add({ days: diff });
          if (!addDate(dd)) { done = true; break; }
        }
        weekStart = weekStart.add({ days: 7 * interval });
      }
      break;
    }

    case 'monthly': {
      const dom = rule.byMonthDay ? rule.byMonthDay[0] : startDate.day;
      while (true) {
        const dim = cur.daysInMonth;
        if (dom <= dim) {
          const md = cur.with({ day: dom });
          if (!addDate(md)) break;
        }
        cur = cur.add({ months: interval }).with({ day: 1 });
      }
      break;
    }

    case 'yearly':
      while (addDate(cur)) cur = cur.add({ years: interval });
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
  }

  return expanded;
}
