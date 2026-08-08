import { reanchorDate, type CounterEvent } from '../../../../shared/schemas/counters';
import { generateDates, parseDuration } from '../calendar/recurrence';

// Re-exported so the plugin has one import for its date logic; it lives in the
// schema module because the document validator enforces the same rule.
export { reanchorDate, lastCompletionAnchor } from '../../../../shared/schemas/counters';

/** All functions take `now` as a local datetime string ("YYYY-MM-DDTHH:mm:ss")
 * so the logic stays pure and testable. */

export type CounterStatus = 'overdue' | 'pending' | 'upcoming' | 'done' | 'tally';

export interface CounterEntry {
  uid: string;
  ev: CounterEvent;
  status: CounterStatus;
  /** The occurrence the status refers to (window start datetime), if any. */
  occurrence?: string;
  /**
   * The deadline this row's status is about, as a local datetime — what the row
   * renders as a relative time.
   *   pending / upcoming / done — when the window shuts (in the future)
   *   overdue — when the habit *became* overdue: the close of the earliest
   *             occurrence in the current unbroken run of misses, so the number
   *             keeps growing while the habit is left undone. Guaranteed <= now,
   *             so an overdue row can never read "in 12 hours".
   * Absent for 'tally' and for a counter with no occurrences at all.
   */
  dueAt?: string;
  /** Consecutive met occurrences; 0 for non-recurring counters. */
  streak: number;
  /** Reward goal and how far off it is, when the description encodes one. */
  reward?: RewardProgress;
}

/** What `currentStatus` returns. Kept as a slice of the entry so the two cannot
 * drift — `sortedCounters` spreads one into the other. */
export type StatusResult = Pick<CounterEntry, 'status' | 'occurrence' | 'dueAt'>;

/** A reward unlocked by a streak, encoded in the item's description as
 * "<goal>: <text>" — e.g. "10: Ice cream". */
export interface Reward {
  goal: number;
  text: string;
}

export interface RewardProgress extends Reward {
  /** Completions still needed; 0 once the streak has reached the goal. */
  remaining: number;
  unlocked: boolean;
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

/** An anchor date turned into an occurrence datetime: the time-of-day window
 * comes from `startTime` when set, else from the anchor's own time part. */
function anchorFor(ev: CounterEvent, anchor: string): string {
  const date = dateOf(anchor);
  let timePart = anchor.length > 10 ? anchor.substring(10) : '';
  if (ev.startTime) timePart = 'T' + normTime(ev.startTime);
  return date + timePart;
}

/**
 * The local datetime the counter was created. `created` is a UTC timestamp
 * (JSCalendar); counters written before that field existed fall back to `start`,
 * which used to hold the creation anchor — and as a bare date it floors to
 * midnight, so no legacy history is trimmed away. A recurring counter with
 * neither has no known origin (see expandOccurrences).
 *
 * `smallestUnit` is pinned because these strings are compared against deadlines
 * as strings: an imported instant carrying milliseconds must not render as
 * "…T09:00:00.123".
 */
export function createdDateTime(ev: CounterEvent): string | undefined {
  if (ev.created) {
    try {
      return Temporal.Instant.from(ev.created)
        .toZonedDateTimeISO(Temporal.Now.timeZoneId())
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' });
    } catch {
      // Not a real instant — fall through to the legacy anchor.
    }
  }
  return ev.start ? toDateTime(ev.start) : undefined;
}

/** The date part of {@link createdDateTime} — the base of the occurrence grid. */
export function createdDate(ev: CounterEvent): string | undefined {
  return createdDateTime(ev)?.substring(0, 10);
}

/**
 * A `created` stamp for a counter that has none — either brand new, or written
 * before the field existed. It is local midnight of the oldest thing known
 * about the habit (its legacy `start` anchor, or its first completion), because
 * stamping "now" would cut the occurrence grid off there and take the streak
 * and the met/missed chart with it.
 */
export function createdStampFor(ev: CounterEvent): string {
  const known: string[] = [];
  if (ev.start) known.push(dateOf(ev.start));
  for (const ts of Object.keys(ev.completions ?? {})) known.push(dateOf(ts));
  known.sort();
  try {
    if (known.length) {
      return Temporal.PlainDateTime.from(known[0] + 'T00:00:00')
        .toZonedDateTime(Temporal.Now.timeZoneId())
        .toInstant()
        .toString({ smallestUnit: 'second' });
    }
  } catch {
    // Unparseable legacy anchor — fall back to now.
  }
  return Temporal.Now.instant().toString({ smallestUnit: 'second' });
}

/**
 * True for a rule whose grid is the same whatever it is anchored at: every day,
 * or named weekdays every week. Those need no segmented walk at all — which is
 * what keeps the common case (a daily habit with hundreds of completions) at a
 * single expansion.
 */
function anchorInvariant(rule: any): boolean {
  const interval = typeof rule.interval === 'number' && rule.interval > 1 ? rule.interval : 1;
  if (interval > 1) return false;
  if (rule.frequency === 'daily') return true;
  return rule.frequency === 'weekly' && !!rule.byDay?.length;
}

/** Grid anchors oldest-first: the creation date, then each completion (the
 * schedule restarts at every one). */
function scheduleAnchors(ev: CounterEvent, base: string | undefined, rangeEnd: string): string[] {
  const seen = new Set<string>();
  if (base) seen.add(base);
  for (const ts of Object.keys(ev.completions ?? {})) {
    const d = reanchorDate(ev, ts);
    if (base && d < base) continue; // predates the habit — imported or clock-skewed
    if (d > rangeEnd) continue;
    seen.add(d);
  }
  return [...seen].sort();
}

/**
 * When an occurrence stops being doable. An explicit `duration` is the window the
 * user set. Otherwise it runs until the habit comes due again — the same period
 * {@link metInPeriod} credits a completion in, so a counter can never be overdue
 * while a click would still count for it. End of day only as a last resort, where
 * there is no next occurrence: a one-shot, or the far edge of the expansion.
 *
 * The end of the day is *not* a safe default on its own — for anything longer than
 * a daily habit it makes the counter overdue the morning after it was created.
 */
export function windowEnd(ev: CounterEvent, occ: string, next?: string): string {
  if (ev.duration) {
    const d = parseDuration(ev.duration);
    return Temporal.PlainDateTime.from(toDateTime(occ))
      .add({ days: d.days, hours: d.hours, minutes: d.minutes })
      .toString();
  }
  if (next) return toDateTime(next);
  return Temporal.PlainDate.from(dateOf(occ)).add({ days: 1 }).toString() + 'T00:00:00';
}

/**
 * Occurrence window-start datetimes in [rangeStart, rangeEnd] (inclusive date
 * strings — generateDates range semantics), sorted ascending.
 *
 * A recurring counter's schedule **restarts at every completion**, so the grid
 * is a chain of segments: one per anchor, each expanded from its own anchor and
 * ending where the next begins. The last occurrence of a closed segment is
 * dropped, because that is the occurrence the completion credits — it is
 * replaced by the completion's own date. Without that, a habit done a day late
 * would score one missed *and* one met for the same period.
 *
 * The grid starts at `created`, not at the moving `start`, so past occurrences
 * (and with them the streak and the met/missed chart) survive the re-anchoring.
 */
export function expectedOccurrences(ev: CounterEvent, rangeStart: string, rangeEnd: string): string[] {
  const cached = cacheGet(ev, rangeStart, rangeEnd);
  if (cached) return cached;
  return cacheSet(ev, rangeStart, rangeEnd, expandOccurrences(ev, rangeStart, rangeEnd));
}

/**
 * Occurrences whose window shut before the counter existed are not misses: a
 * 06:00–07:00 habit written at 10:00 must not open Overdue for an hour that
 * predates the document. Keyed on when the window *shuts*, so writing it at 06:30
 * keeps today — it can still be done.
 *
 * Dates ascend and the window length is fixed, so what survives is a suffix: walk
 * and slice, which in the overwhelmingly common case costs one `windowEnd` call
 * and returns the very same array.
 */
function sinceCreation(ev: CounterEvent, dates: string[]): string[] {
  const born = createdDateTime(ev);
  if (!born) return dates; // no known origin: the grid is synthetic, leave it be
  let i = 0;
  while (i < dates.length && windowEnd(ev, dates[i], dates[i + 1]) <= born) i++;
  return i === 0 ? dates : dates.slice(i);
}

function expandOccurrences(ev: CounterEvent, rangeStart: string, rangeEnd: string): string[] {
  if (!ev.recurrenceRule) {
    // Not trimmed at creation: a one-shot's `start` is its *due date*, and may
    // legitimately predate its own creation — logging something already owed.
    if (!ev.start) return [];
    const d = dateOf(ev.start);
    return d >= rangeStart && d <= rangeEnd ? [ev.start] : [];
  }
  const rule = ev.recurrenceRule;
  const base = createdDate(ev);

  // No origin and no reset to apply: expand from the query range, as before.
  if (anchorInvariant(rule)) return sinceCreation(ev, generateDates(anchorFor(ev, base ?? rangeStart), rule, rangeStart, rangeEnd));

  const anchors = scheduleAnchors(ev, base, rangeEnd);
  if (anchors.length === 0) return sinceCreation(ev, generateDates(anchorFor(ev, rangeStart), rule, rangeStart, rangeEnd));

  const out: string[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const nextAnchor = anchors[i + 1];
    const segEnd = nextAnchor ?? rangeEnd;
    if (anchors[i] > segEnd) continue;
    const dates = generateDates(anchorFor(ev, anchors[i]), rule, anchors[i], segEnd);
    if (nextAnchor) dates.pop(); // credited by the completion that opens the next segment
    for (const d of dates) if (dateOf(d) >= rangeStart) out.push(d);
  }
  return sinceCreation(ev, out);
}

// Every counter is expanded three times per render (status, streak, chart), and
// the segmented walk is one generateDates call per completion. Automerge hands
// out a fresh snapshot object per change, so keying on the event identity gives
// a per-render cache that invalidates itself.
const expansionCache = new WeakMap<CounterEvent, Map<string, string[]>>();

function cacheGet(ev: CounterEvent, rangeStart: string, rangeEnd: string): string[] | undefined {
  return expansionCache.get(ev)?.get(rangeStart + '|' + rangeEnd);
}

function cacheSet(ev: CounterEvent, rangeStart: string, rangeEnd: string, dates: string[]): string[] {
  let byRange = expansionCache.get(ev);
  if (!byRange) expansionCache.set(ev, (byRange = new Map()));
  byRange.set(rangeStart + '|' + rangeEnd, dates);
  return dates;
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
 * Consecutive met occurrences ending at `now`, for the row's streak badge.
 * An unmet occurrence only breaks the streak once it is decided (its credit
 * period elapsed — same rule as metMissedByWeek), so the current still-open
 * period never resets it. Capped by the LOOKBACK_DAYS expansion window.
 * Non-recurring events have no streak (0).
 */
export function currentStreak(ev: CounterEvent, now: string): number {
  if (!ev.recurrenceRule) return 0;
  const today = dateOf(now);
  const from = Temporal.PlainDate.from(today).subtract({ days: LOOKBACK_DAYS }).toString();
  // Expand past `now` too, so the current occurrence's `next` (and with it the
  // end of its credit period) is known.
  const to = Temporal.PlainDate.from(today).add({ days: LOOKBACK_DAYS }).toString();
  const occs = expectedOccurrences(ev, from, to);
  let streak = 0;
  for (let i = 0; i < occs.length; i++) {
    const occ = occs[i];
    if (toDateTime(occ) > now) break;
    const next = occs[i + 1];
    if (metInPeriod(ev, occ, next)) {
      streak++;
      continue;
    }
    const decided = next ? toDateTime(next) <= now : windowEnd(ev, occ) <= now;
    if (decided) streak = 0;
  }
  return streak;
}

/**
 * When the current run of misses started: the close of the earliest consecutive
 * unmet occurrence at or before `from`. This is what "overdue since" means — a
 * habit last done nine days ago is nine days overdue, not twelve hours overdue
 * every night as each fresh window shuts.
 *
 * Always <= `now`: occurrences whose window is still open are skipped, so the
 * result can never render as a future time on an overdue row.
 *
 * `anchored` must be false when the counter has no `created`/`start`, because
 * then the grid is synthetic — anchored at the query range 400 days back (see
 * expandOccurrences) — and every occurrence before today would be counted as a
 * miss the habit never actually had.
 */
function overdueSince(ev: CounterEvent, occs: string[], from: number, now: string, anchored: boolean): string | undefined {
  let since: string | undefined;
  for (let i = from; i >= 0; i--) {
    const end = windowEnd(ev, occs[i], occs[i + 1]);
    if (end > now) continue; // window still open — nothing owed for it yet
    if (metInPeriod(ev, occs[i], occs[i + 1])) break; // the run ends at the last one done
    since = end;
    if (!anchored) break; // synthetic grid: trust only the most recent deadline
  }
  return since;
}

/**
 * Status of a counter's current period, used for sectioning/sorting:
 *   'tally'    — no schedule at all: a free-running counter, always clickable
 *   'upcoming' — its first occurrence is still in the future
 *   'done'     — the current period has a recorded completion
 *   'pending'  — the current occurrence's window is still open and the previous
 *                occurrence (if any since the habit's start) was met
 *   'overdue'  — the current window has closed with no completion yet, or the
 *                current window is open but the previous occurrence went unmet
 *
 * Absent an explicit `duration`, a window closes when the habit comes due again
 * (see {@link windowEnd}) — so a habit repeating every 4 months is not overdue the
 * day after it was made, and "overdue" always means a completion would no longer
 * have counted.
 */
export function currentStatus(ev: CounterEvent, now: string): StatusResult {
  if (!ev.recurrenceRule && !ev.start) return { status: 'tally' };

  const today = dateOf(now);
  const from = Temporal.PlainDate.from(today).subtract({ days: LOOKBACK_DAYS }).toString();
  const to = Temporal.PlainDate.from(today).add({ days: LOOKBACK_DAYS }).toString();
  const occs = expectedOccurrences(ev, from, to);
  if (occs.length === 0) return { status: 'upcoming' };

  // Indexed so the overdue walk below can start at `curr` (or the one before it)
  // without re-deriving them. Equivalent to the prev/curr/next scan it replaces.
  let ci = -1;
  for (let i = 0; i < occs.length; i++) {
    if (toDateTime(occs[i]) <= now) ci = i;
    else break;
  }
  if (ci < 0) return { status: 'upcoming', occurrence: occs[0], dueAt: windowEnd(ev, occs[0], occs[1]) };
  const curr = occs[ci];
  const prev = occs[ci - 1];
  const next = occs[ci + 1];

  if (metInPeriod(ev, curr, next)) return { status: 'done', occurrence: curr, dueAt: windowEnd(ev, curr, next) };

  // Both the retroactive-miss rule and the walk need this, and it parses an
  // Instant, so resolve it once.
  const anchored = !!createdDate(ev);

  if (now >= windowEnd(ev, curr, next)) {
    return {
      status: 'overdue',
      occurrence: curr,
      dueAt: overdueSince(ev, occs, ci, now, anchored) ?? windowEnd(ev, curr, next),
    };
  }
  // Window still open — but a missed previous occurrence keeps it overdue.
  // Without a creation anchor the expansion is synthetic (anchored at the query
  // range), so "previous" doesn't imply the habit existed then; skip the check.
  if (anchored && prev && !metInPeriod(ev, prev, curr)) {
    return {
      status: 'overdue',
      occurrence: curr,
      // Never windowEnd(curr): that window is still open, i.e. in the future,
      // and would render as "in 12 hours" on a row filed under Overdue. Walk
      // back from `prev`; `curr` itself (<= now by construction) is the floor.
      dueAt: overdueSince(ev, occs, ci - 1, now, anchored) ?? toDateTime(curr),
    };
  }
  return { status: 'pending', occurrence: curr, dueAt: windowEnd(ev, curr, next) };
}

/** Overdue first, then pending, upcoming, done, and finally schedule-less
 * tallies — ties broken by an unclaimed reward, then occurrence time, then title. */
const STATUS_ORDER: Record<CounterStatus, number> = { overdue: 0, pending: 1, upcoming: 2, done: 3, tally: 4 };

export function sortedCounters(events: Record<string, CounterEvent>, now: string): CounterEntry[] {
  const entries: CounterEntry[] = Object.entries(events).map(([uid, ev]) => {
    const status = currentStatus(ev, now);
    // An overdue habit's chain is broken: no flame badge, and its reward starts
    // over. `currentStreak` itself still reports the salvageable streak (a late
    // completion inside the credit period does restore it, and the chart counts
    // that occurrence as met) — this is the row's view, not the history's.
    const streak = status.status === 'overdue' ? 0 : currentStreak(ev, now);
    return { uid, ev, streak, reward: rewardProgress(ev, streak) ?? undefined, ...status };
  });
  entries.sort((a, b) => {
    if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    // Habits working towards a reward rise within their section, closest first.
    // An unlocked one drops back into normal order rather than pinning forever.
    const ar = a.reward && !a.reward.unlocked ? 0 : 1;
    const br = b.reward && !b.reward.unlocked ? 0 : 1;
    if (ar !== br) return ar - br;
    if (ar === 0 && a.reward!.remaining !== b.reward!.remaining) return a.reward!.remaining - b.reward!.remaining;
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

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

/** "10: Ice cream" → a reward unlocked at a streak of 10. Anything without the
 * leading "<digits>: " is an ordinary note and yields null. */
export function parseReward(description?: string): Reward | null {
  if (!description) return null;
  const m = description.match(/^(\d+):\s([\s\S]*)$/);
  if (!m) return null;
  const goal = parseInt(m[1], 10);
  if (!goal || goal < 1) return null;
  return { goal, text: m[2] };
}

/** The inverse of {@link parseReward}. Without a goal the text is stored as-is,
 * so the description doubles as a plain note. */
export function formatReward(goal: number | null, text: string): string {
  const t = text.trim();
  if (!goal || goal < 1) return t;
  return goal + ': ' + t;
}

export function rewardProgress(ev: CounterEvent, streak: number): RewardProgress | null {
  const reward = parseReward(ev.description);
  if (!reward) return null;
  const remaining = Math.max(0, reward.goal - streak);
  return { ...reward, remaining, unlocked: remaining === 0 };
}

// ---------------------------------------------------------------------------
// The daily window, as start/end clock times
// ---------------------------------------------------------------------------

/**
 * "HH:mm" the window closes, from its start time and stored ISO duration —
 * the editor edits an end time but the document stores a duration, per the
 * calendar spec. Wraps past midnight. A whole-day duration (P1D) has no clock
 * end and yields '', since the field cannot express it.
 */
export function windowEndTime(startTime: string, duration: string): string {
  if (!duration) return '';
  const d = parseDuration(duration);
  if (!d.hours && !d.minutes) return '';
  return Temporal.PlainTime.from(normTime(startTime || '00:00'))
    .add({ hours: d.hours, minutes: d.minutes })
    .toString()
    .substring(0, 5);
}

/**
 * The ISO duration for a window running from `startTime` to `endTime`. An end
 * at or before the start crosses midnight; a full day (or a blank end) is '',
 * which leaves the default "you have until the end of the day" window.
 */
export function windowDuration(startTime: string, endTime: string): string {
  if (!endTime) return '';
  const from = Temporal.PlainTime.from(normTime(startTime || '00:00'));
  const to = Temporal.PlainTime.from(normTime(endTime));
  let minutes = Math.round(to.since(from).total({ unit: 'minutes' }));
  if (minutes <= 0) minutes += 24 * 60;
  if (minutes >= 24 * 60) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return 'PT' + (h ? h + 'H' : '') + (m ? m + 'M' : '');
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
