/**
 * Relative-date markup for the bundled example documents (`examples/`).
 *
 * The examples ship with tokens instead of literal dates so they read as current
 * whenever they are created, rather than being frozen to the day they were
 * authored. Expansion happens once, at document-creation time (see
 * `createDocsFromJson` in src/client/home/Home.tsx).
 *
 *   {{ <anchor> [±N<unit>] [@HH:mm[:ss]] [Z] }}
 *   {{ dayOfMonth: <anchor> [±N<unit>] }}   → a JSON number
 *   {{ month:      <anchor> [±N<unit>] }}   → a "1".."12" string
 *
 * anchor  `today`, or a weekday `mo|tu|we|th|fr|sa|su`. A weekday anchor resolves
 *         to that weekday **within the current ISO week** (Monday-start), so it
 *         moves in whole weeks and never lands on a different weekday. That is
 *         what keeps a weekly recurrence's `start` aligned with its `byDay`, and
 *         `recurrenceOverrides` / `completions` keys on real occurrences.
 * unit    `d` days, `w` weeks, `m` months, `y` years (weekday anchors: `w` only).
 * time    absent → `YYYY-MM-DD`; present → `YYYY-MM-DDTHH:mm:ss`; trailing `Z` →
 *         `YYYY-MM-DDTHH:mm:ssZ`, for the UTC-typed fields (`created`,
 *         `progressUpdated`, `acknowledged`, `scheduleUpdated`).
 *
 *   "{{tu@16:30}}"             → 2026-07-21T16:30:00   (today = Sun 2026-07-26)
 *   "{{tu+2w@16:30}}"          → 2026-08-04T16:30:00
 *   "{{today+29d}}"            → 2026-08-24
 *   "{{today-26d@14:05Z}}"     → 2026-06-30T14:05:00Z
 *   "{{dayOfMonth:today+24d}}" → 19
 *
 * Anything between `{{ }}` that does not match the grammar is left verbatim, so
 * ordinary user documents containing braces are never rewritten.
 */
import { Temporal } from 'temporal-polyfill';
import { DAY_VALUES } from './schemas/core';

/** `mo` → 1 … `su` → 7, matching Temporal's `dayOfWeek`. */
const WEEKDAY: Record<string, number> = Object.fromEntries(
  DAY_VALUES.map((d, i) => [d, i + 1]),
);

const UNITS: Record<string, 'days' | 'weeks' | 'months' | 'years'> = {
  d: 'days', w: 'weeks', m: 'months', y: 'years',
};

/** `{{ … }}` with the inside captured; the inside is parsed separately. */
const TOKEN_RE = /\{\{([^{}]*)\}\}/g;

/**
 * `[fn:] anchor [±N unit] [@time] [Z]`
 *   1 fn      `dayOfMonth` | `month`
 *   2 anchor  `today` | weekday
 *   3 sign    `+` | `-`
 *   4 amount
 *   5 unit
 *   6 time    `HH:mm` or `HH:mm:ss`
 *   7 zulu
 */
const INNER_RE = new RegExp(
  '^\\s*(?:(dayOfMonth|month)\\s*:\\s*)?'
  + `(today|${DAY_VALUES.join('|')})`
  + '\\s*(?:([+-])\\s*(\\d+)\\s*([dwmy]))?'
  + '\\s*(?:@\\s*(\\d{2}:\\d{2}(?::\\d{2})?))?'
  + '\\s*(Z)?\\s*$',
);

interface Parsed {
  fn?: 'dayOfMonth' | 'month';
  date: Temporal.PlainDate;
  time?: string;
  zulu: boolean;
}

function parse(inner: string, today: Temporal.PlainDate): Parsed | null {
  const m = INNER_RE.exec(inner);
  if (!m) return null;
  const [, fn, anchor, sign, amount, unit, time, zulu] = m;

  // A weekday anchor starts from that weekday in the current ISO week; `today`
  // starts from today. Weekday anchors only make sense in whole weeks.
  let date: Temporal.PlainDate;
  if (anchor === 'today') {
    date = today;
  } else {
    const monday = today.subtract({ days: today.dayOfWeek - 1 });
    date = monday.add({ days: WEEKDAY[anchor] - 1 });
    if (unit && unit !== 'w') return null;
  }

  if (sign && amount && unit) {
    const delta = { [UNITS[unit]]: Number(amount) } as Temporal.DurationLike;
    date = sign === '-' ? date.subtract(delta) : date.add(delta);
  }

  return {
    fn: fn as Parsed['fn'],
    date,
    time: time ? (time.length === 5 ? `${time}:00` : time) : undefined,
    zulu: !!zulu,
  };
}

function render(p: Parsed): string {
  if (p.fn === 'dayOfMonth') return String(p.date.day);
  if (p.fn === 'month') return String(p.date.month);
  const day = p.date.toString(); // YYYY-MM-DD
  if (!p.time) return day;
  return `${day}T${p.time}${p.zulu ? 'Z' : ''}`;
}

/**
 * Expand every recognised token in a string. Substitution is per-substring, so
 * `"{{today-29d}} to {{today}}"` works.
 */
function expandString(s: string, today: Temporal.PlainDate): string {
  if (!s.includes('{{')) return s;
  return s.replace(TOKEN_RE, (whole, inner: string) => {
    const p = parse(inner, today);
    return p ? render(p) : whole;
  });
}

/** True when the whole string is a single `dayOfMonth:` token, which must
 *  become a JSON number (`byMonthDay` is an array of numbers). */
function isWholeDayOfMonthToken(s: string, today: Temporal.PlainDate): boolean {
  const m = /^\{\{([^{}]*)\}\}$/.exec(s);
  if (!m) return false;
  const p = parse(m[1], today);
  return p?.fn === 'dayOfMonth';
}

/**
 * Recursively expand date tokens in a parsed JSON value, rewriting object **keys**
 * as well as string values — `recurrenceOverrides` and `completions` are keyed by
 * occurrence timestamp.
 *
 * Returns a new structure and never mutates its input: the examples arrive as
 * `import.meta.glob` module exports, which are shared across calls.
 */
export function expandRelativeDates<T>(value: T, today?: Temporal.PlainDate): T {
  const ref = today ?? Temporal.Now.plainDateISO();
  return walk(value, ref) as T;
}

function walk(value: unknown, today: Temporal.PlainDate): unknown {
  if (typeof value === 'string') {
    if (isWholeDayOfMonthToken(value, today)) return Number(expandString(value, today));
    return expandString(value, today);
  }
  if (Array.isArray(value)) return value.map(v => walk(v, today));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[expandString(k, today)] = walk(v, today);
    }
    return out;
  }
  return value;
}
