/**
 * Fuzzy dates for the Timeline document type: "sometime in 2009", "summer
 * 2014", "between 2008 and 2012", "around 2009", "when I was 12".
 *
 * Stored form (`FuzzyDate`): readable ISO partial dates.
 *   - `earliest` / `latest` BOUND the date: the first day of `earliest` and the
 *     last day of `latest`. "2014" as both means "sometime in 2014". A missing
 *     side is unknown.
 *   - `best` is only a guess ("most likely"). It never bounds anything; it
 *     places the entry on a calendar and in the list.
 *
 * Computation uses Temporal (`PlainDate`); the constraint solver in order.ts
 * works on integer day numbers (`toDay` / `fromDay`) because it does nothing
 * but compare and add them.
 */
import { Temporal } from 'temporal-polyfill';

export type PartialDate = string;
export interface FuzzyDate { earliest?: PartialDate; latest?: PartialDate; best?: PartialDate }
export type Precision = 'year' | 'month' | 'day';

/** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'. Shape only — `parsePartial` checks the calendar. */
export const PARTIAL_DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const YEAR_RE = /^\d{4}$/;

export interface PartialRange { first: Temporal.PlainDate; last: Temporal.PlainDate; precision: Precision }

/** The days a partial date covers, or null when it is not a real date. */
export function parsePartial(s: unknown): PartialRange | null {
  if (typeof s !== 'string' || !PARTIAL_DATE_RE.test(s)) return null;
  try {
    const [y, m, d] = s.split('-').map(Number);
    if (d !== undefined) {
      const day = Temporal.PlainDate.from({ year: y, month: m, day: d }, { overflow: 'reject' });
      return { first: day, last: day, precision: 'day' };
    }
    if (m !== undefined) {
      const first = Temporal.PlainDate.from({ year: y, month: m, day: 1 }, { overflow: 'reject' });
      return { first, last: first.add({ months: 1 }).subtract({ days: 1 }), precision: 'month' };
    }
    const first = Temporal.PlainDate.from({ year: y, month: 1, day: 1 });
    return { first, last: Temporal.PlainDate.from({ year: y, month: 12, day: 31 }), precision: 'year' };
  } catch {
    return null;
  }
}

// ── Day numbers ───────────────────────────────────────────────────────────────

const EPOCH = Temporal.PlainDate.from('1970-01-01');

/** Days since 1970-01-01 (negative before). */
export function toDay(d: Temporal.PlainDate): number {
  return d.since(EPOCH, { largestUnit: 'days' }).days;
}
export function fromDay(n: number): Temporal.PlainDate {
  return EPOCH.add({ days: n });
}
/** Today, as a day number, in the local time zone. */
export function todayDay(): number {
  return toDay(Temporal.Now.plainDateISO());
}

export function dayOf(s: string): number | null {
  const p = parsePartial(s);
  return p ? toDay(p.first) : null;
}

/** A partial date at the given precision for day `n`. */
export function partialOf(n: number, precision: Precision): PartialDate {
  const s = fromDay(n).toString();
  return precision === 'day' ? s : precision === 'month' ? s.substring(0, 7) : s.substring(0, 4);
}

/** The partial date that best states a range of `width` days: a day, a month, or a year. */
export function precisionForWidth(width: number): Precision {
  return width <= 62 ? 'day' : width <= 730 ? 'month' : 'year';
}

// ── Bounds ───────────────────────────────────────────────────────────────────

export interface DayBounds { lo?: number; hi?: number }

/** The day range a FuzzyDate states; a missing side is undefined (unknown). */
export function boundsOf(fd: FuzzyDate | undefined): DayBounds {
  const e = fd?.earliest ? parsePartial(fd.earliest) : null;
  const l = fd?.latest ? parsePartial(fd.latest) : null;
  return { lo: e ? toDay(e.first) : undefined, hi: l ? toDay(l.last) : undefined };
}

/** True when the FuzzyDate says anything at all about when. */
export function isDated(fd: FuzzyDate | undefined): boolean {
  return !!(fd && (fd.earliest || fd.latest || fd.best));
}

/**
 * The single day a calendar should show: the middle of `best` when there is a
 * guess, else the middle of the stated range. Undefined when the date is
 * unknown or open-ended with no guess.
 */
export function bestDay(fd: FuzzyDate | undefined): number | undefined {
  const b = fd?.best ? parsePartial(fd.best) : null;
  if (b) return Math.floor((toDay(b.first) + toDay(b.last)) / 2);
  const { lo, hi } = boundsOf(fd);
  if (lo !== undefined && hi !== undefined) return Math.floor((lo + hi) / 2);
  return undefined;
}

/**
 * The JSCalendar `start` / `duration` that let a calendar viewer place an entry:
 * an all-day event on its best day, or spanning to the period's best end.
 * The extension fields `when` / `until` stay the source of truth.
 */
export function calendarFields(
  when: FuzzyDate | undefined, until: FuzzyDate | undefined,
): { start?: string; duration?: string } {
  const s = bestDay(when);
  if (s === undefined) return {};
  const e = until ? bestDay(until) : undefined;
  const days = e !== undefined && e > s ? e - s + 1 : 1;
  return { start: fromDay(s).toString(), duration: `P${days}D` };
}

// ── Formatting ───────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
/** Northern-hemisphere meteorological seasons; winter spans the new year. */
const SEASON_START: Record<Season, number> = { spring: 3, summer: 6, autumn: 9, winter: 12 };

export function formatPartial(s: PartialDate): string {
  const p = parsePartial(s);
  if (!p) return s;
  const y = String(p.first.year);
  if (p.precision === 'year') return y;
  if (p.precision === 'month') return `${MONTHS[p.first.month - 1]} ${y}`;
  return `${p.first.day} ${MONTHS[p.first.month - 1]} ${y}`;
}

function seasonOf(fd: FuzzyDate): { season: Season; year: number } | null {
  const e = fd.earliest && parsePartial(fd.earliest);
  const l = fd.latest && parsePartial(fd.latest);
  if (!e || !l || e.precision !== 'month' || l.precision !== 'month') return null;
  for (const [season, m] of Object.entries(SEASON_START) as [Season, number][]) {
    if (e.first.month !== m) continue;
    const end = e.first.add({ months: 2 });
    if (end.year === l.first.year && end.month === l.first.month) return { season, year: e.first.year };
  }
  return null;
}

/** "at age N" range from a birth date: the year after the Nth birthday. */
export function ageRange(birth: PartialDate, age: number): FuzzyDate | undefined {
  const b = parsePartial(birth);
  if (!b) return undefined;
  if (b.precision !== 'day') {
    const y = String(b.first.year + age);
    return { earliest: y, latest: y };
  }
  const from = b.first.add({ years: age });
  return { earliest: from.toString(), latest: from.add({ years: 1 }).subtract({ days: 1 }).toString() };
}

function ageOf(fd: FuzzyDate, birth?: PartialDate): number | null {
  if (!birth || !fd.earliest || !fd.latest || fd.best) return null;
  const b = parsePartial(birth);
  // Year-only birth makes "age N" indistinguishable from "the year N"; say the year.
  if (!b || b.precision !== 'day') return null;
  const e = parsePartial(fd.earliest);
  if (!e) return null;
  const age = e.first.year - b.first.year;
  const r = ageRange(birth, age);
  return r && r.earliest === fd.earliest && r.latest === fd.latest && age >= 0 ? age : null;
}

/** A FuzzyDate in words: "12 Jun 2014", "summer 2014", "around 2009", "2008–2012", "Undated". */
export function formatFuzzy(fd: FuzzyDate | undefined, birth?: PartialDate): string {
  if (!fd || !isDated(fd)) return 'Undated';
  const { earliest: e, latest: l, best } = fd;
  if (e && l && e === l && !best) return formatPartial(e);
  const season = seasonOf(fd);
  if (season && !best) {
    return season.season === 'winter'
      ? `winter ${season.year}–${String((season.year + 1) % 100).padStart(2, '0')}`
      : `${season.season} ${season.year}`;
  }
  const age = ageOf(fd, birth);
  if (age !== null) return `age ${age}`;
  if (e && l && !best && /^\d{3}0$/.test(e) && l === e.substring(0, 3) + '9') return `${e}s`;
  if (e && l && best && [e, l, best].every(s => YEAR_RE.test(s))) {
    const k = Number(best) - Number(e);
    if (k > 0 && Number(l) - Number(best) === k) return k <= 2 ? `around ${best}` : `around ${best} (±${k})`;
  }
  if (e && l) {
    const range = e.length === 4 && l.length === 4 ? `${e}–${l}` : `${formatPartial(e)} – ${formatPartial(l)}`;
    return best ? `${range}, likely ${formatPartial(best)}` : range;
  }
  if (e) return `after ${formatPartial(e)}` + (best ? `, likely ${formatPartial(best)}` : '');
  if (l) return `before ${formatPartial(l)}` + (best ? `, likely ${formatPartial(best)}` : '');
  return `around ${formatPartial(best!)}`;
}

/** A day range in words, at a precision that suits its width: for effective ranges. */
export function formatDayRange(lo: number, hi: number): string {
  const precision = precisionForWidth(hi - lo);
  const a = partialOf(lo, precision);
  const b = partialOf(hi, precision);
  if (a === b) return formatPartial(a);
  return precision === 'year' ? `${a}–${b}` : `${formatPartial(a)} – ${formatPartial(b)}`;
}

// ── Presets (what the date pane edits) ────────────────────────────────────────

export type PresetKind =
  | 'unknown' | 'day' | 'month' | 'season' | 'year' | 'around' | 'decade' | 'age' | 'between' | 'after' | 'before';

/** The pane's draft: every field any preset uses, so switching presets keeps what was typed. */
export interface PresetDraft {
  kind: PresetKind;
  day: string;        // 'YYYY-MM-DD'
  year: string;       // 'YYYY' (month, season, year, around, decade)
  month: string;      // '1'..'12'
  season: Season;
  spread: string;     // ±years for 'around'
  age: string;
  from: string;       // partial date (between, after)
  to: string;         // partial date (between, before)
}

export const PRESET_LABELS: Record<PresetKind, string> = {
  unknown: 'Unknown',
  day: 'An exact day',
  month: 'A month',
  season: 'A season',
  year: 'A year',
  around: 'Around a year',
  decade: 'A decade',
  age: 'At an age',
  between: 'Between two dates',
  after: 'After a date',
  before: 'Before a date',
};

export function emptyDraft(kind: PresetKind = 'unknown'): PresetDraft {
  return { kind, day: '', year: '', month: '1', season: 'summer', spread: '2', age: '', from: '', to: '' };
}

/** Read a FuzzyDate into the pane's draft, choosing the preset that reproduces it. */
export function draftOf(fd: FuzzyDate | undefined, birth?: PartialDate): PresetDraft {
  const d = emptyDraft();
  if (!fd || !isDated(fd)) return d;
  const { earliest: e, latest: l, best } = fd;
  const ep = e ? parsePartial(e) : null;
  if (e && l && e === l && !best && ep) {
    if (ep.precision === 'day') return { ...d, kind: 'day', day: e };
    if (ep.precision === 'month') return { ...d, kind: 'month', year: String(ep.first.year), month: String(ep.first.month) };
    return { ...d, kind: 'year', year: e };
  }
  const season = seasonOf(fd);
  if (season && !best) return { ...d, kind: 'season', season: season.season, year: String(season.year) };
  const age = ageOf(fd, birth);
  if (age !== null) return { ...d, kind: 'age', age: String(age) };
  if (e && l && !best && /^\d{3}0$/.test(e) && l === e.substring(0, 3) + '9') return { ...d, kind: 'decade', year: e };
  if (e && l && best && e.length === 4 && l.length === 4 && best.length === 4
    && Number(best) - Number(e) === Number(l) - Number(best)) {
    return { ...d, kind: 'around', year: best, spread: String(Number(best) - Number(e)) };
  }
  if (e && l) return { ...d, kind: 'between', from: e, to: l };
  if (e) return { ...d, kind: 'after', from: e };
  if (l) return { ...d, kind: 'before', to: l };
  return { ...d, kind: 'year', year: best!.substring(0, 4) };
}


/**
 * The FuzzyDate a draft means, `undefined` for "unknown", or `null` when the
 * draft is incomplete or invalid (the pane disables Save).
 */
export function fromDraft(d: PresetDraft, birth?: PartialDate): FuzzyDate | undefined | null {
  const y = d.year.trim();
  switch (d.kind) {
    case 'unknown': return undefined;
    case 'day': return parsePartial(d.day)?.precision === 'day' ? { earliest: d.day, latest: d.day } : null;
    case 'month': {
      const m = Number(d.month);
      if (!YEAR_RE.test(y) || !(m >= 1 && m <= 12)) return null;
      const s = `${y}-${String(m).padStart(2, '0')}`;
      return { earliest: s, latest: s };
    }
    case 'season': {
      if (!YEAR_RE.test(y)) return null;
      const first = Temporal.PlainDate.from({ year: Number(y), month: SEASON_START[d.season], day: 1 });
      const last = first.add({ months: 2 });
      return { earliest: first.toString().substring(0, 7), latest: last.toString().substring(0, 7) };
    }
    case 'year': return YEAR_RE.test(y) ? { earliest: y, latest: y } : null;
    case 'around': {
      const k = Number(d.spread);
      if (!YEAR_RE.test(y) || !(Number.isInteger(k) && k >= 1 && k <= 50)) return null;
      return { earliest: String(Number(y) - k), latest: String(Number(y) + k), best: y };
    }
    case 'decade': return /^\d{3}0$/.test(y) ? { earliest: y, latest: y.substring(0, 3) + '9' } : null;
    case 'age': {
      const n = Number(d.age);
      if (!birth || d.age.trim() === '' || !(Number.isInteger(n) && n >= 0 && n <= 130)) return null;
      return ageRange(birth, n) ?? null;
    }
    case 'between': {
      const a = parsePartial(d.from.trim());
      const b = parsePartial(d.to.trim());
      if (!a || !b || Temporal.PlainDate.compare(a.first, b.last) > 0) return null;
      return { earliest: d.from.trim(), latest: d.to.trim() };
    }
    case 'after': return parsePartial(d.from.trim()) ? { earliest: d.from.trim() } : null;
    case 'before': return parsePartial(d.to.trim()) ? { latest: d.to.trim() } : null;
  }
}
