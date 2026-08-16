import { reanchorDate, type CounterEvent } from '../../../../shared/schemas/counters';
import { generateDates, parseDuration } from '../calendar/recurrence';

// Re-exported so the plugin has one import for its date logic; it lives in the
// schema module because the document validator enforces the same rule.
export { reanchorDate, lastCompletionAnchor } from '../../../../shared/schemas/counters';

/** All functions take `now` as a local datetime string ("YYYY-MM-DDTHH:mm:ss")
 * so the logic stays pure and testable. */

export type CounterStatus = 'overdue' | 'due' | 'todo' | 'done' | 'anytime';

/**
 * What a counter IS, structurally — as opposed to where it is in its window,
 * which is {@link currentStatus}. Kind is a property of the document alone;
 * status is a property of the document *and* the clock.
 *
 *   'recurring' — a habit on a schedule. Its `start` is the anchor of that
 *                 schedule (the last completion), never a due date.
 *   'checklist' — a to-do you tick off. `start` is the day it is wanted, and its
 *                 presence is what *arms* it; ticking clears it, so the item
 *                 settles back to 'anytime' and can be armed again. A counter
 *                 that is never armed is just a checklist item you only ever
 *                 tally — there is no third kind.
 */
export type CounterKind = 'recurring' | 'checklist';

export const counterKind = (ev: CounterEvent): CounterKind =>
  ev.recurrenceRule ? 'recurring' : 'checklist';

/** Nothing is owed: a checklist item with no due date. The `anytime` status and
 * this condition are the same thing — see {@link currentStatus}. */
const isSettled = (ev: CounterEvent): boolean => !ev.recurrenceRule && !ev.start;

export interface CounterEntry {
  uid: string;
  ev: CounterEvent;
  status: CounterStatus;
  /** The occurrence the status refers to (window start datetime), if any. */
  occurrence?: string;
  /**
   * The deadline this row's status is about, as a local datetime — what the row
   * renders as a relative time.
   *   due — its deadline (in the future): the explicit window's end, else the
   *         end of the occurrence's day (see dueBy)
   *   done — when the habit comes due again (in the future)
   *   todo — when the item comes due (in the future): its first occurrence, or —
   *          recurring, past halfway through a met period — the next one
   *   overdue — when the habit *became* overdue: the earliest blown deadline in
   *             the current unbroken run of misses, so the number keeps growing
   *             while the habit is left undone. Guaranteed <= now, so an
   *             overdue row can never read "in 12 hours".
   * Absent for 'anytime' and for a counter with no occurrences at all.
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

/** Local midnight after the day of the given date or datetime. */
function endOfDay(s: string): string {
  return Temporal.PlainDate.from(dateOf(s)).add({ days: 1 }).toString() + 'T00:00:00';
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
 * When an occurrence stops being *creditable*. An explicit `duration` is the
 * window the user set. Otherwise it runs until the habit comes due again — the
 * same period {@link metInPeriod} credits a completion in. End of day only as a
 * last resort, where there is no next occurrence: a one-shot, or the far edge
 * of the expansion.
 *
 * This is the credit window, not the deadline — those parted ways when due rows
 * stopped claiming an interval of slack ("6 days left" on a weekly item due
 * today). Status and badge deadlines come from {@link dueBy}; this remains what
 * a done row counts down to (when it comes due again) and what the
 * {@link sinceCreation} trim keys on (could it still have been done at birth).
 */
export function windowEnd(ev: CounterEvent, occ: string, next?: string): string {
  if (ev.duration) {
    const d = parseDuration(ev.duration);
    return Temporal.PlainDateTime.from(toDateTime(occ))
      .add({ days: d.days, hours: d.hours, minutes: d.minutes })
      .toString();
  }
  if (next) return toDateTime(next);
  return endOfDay(occ);
}

/**
 * The midpoint between `from` and the next occurrence, floored at the end of
 * `from`'s day — the boundary both halves of the status ladder escalate at:
 *
 *   met:   'done' → upcoming 'todo' at halfwayTo(crediting completion, next).
 *          Measured from the completion rather than the occurrence so that
 *          ticking an upcoming row visibly returns it to done even under an
 *          anchor-invariant rule, where the tick cannot move the grid.
 *   unmet, never-started habit: 'due' → 'overdue' at halfwayTo(occ, next) —
 *          see {@link dueBy}.
 *
 * The floor keeps anything daily-grained on its own day: a completed daily
 * habit stays done until midnight rather than resurfacing the same afternoon.
 */
function halfwayTo(from: string, next: string): string {
  const f = Temporal.PlainDateTime.from(from);
  const gap = f.until(Temporal.PlainDateTime.from(toDateTime(next)), { largestUnit: 'hours' });
  const mid = f.add({ seconds: Math.round(gap.total('seconds') / 2) }).toString({ smallestUnit: 'second' });
  const eod = endOfDay(from);
  return mid > eod ? mid : eod;
}

/**
 * The deadline an unmet occurrence is judged by — what a due row counts down to
 * and the moment it turns overdue. Deliberately NOT the credit window
 * ({@link metInPeriod}, which runs until the next occurrence): a completion
 * after this deadline still credits the occurrence and un-reds the row.
 *
 *   - an explicit `duration` is the window the user set
 *   - a started habit (any completion ever) is due by the end of the
 *     occurrence's day: weekly-on-Monday means Monday, not "some time before
 *     next Monday" — a due row must never claim an interval of slack
 *   - a never-started habit escalates at the midpoint to the next occurrence
 *     instead, so a brand-new 4-monthly one is not red the morning after it
 *     was created
 */
function dueBy(ev: CounterEvent, occ: string, next?: string): string {
  if (ev.duration) return windowEnd(ev, occ);
  const started = Object.keys(ev.completions ?? {}).length > 0;
  if (!started && next) return halfwayTo(toDateTime(occ), next);
  return endOfDay(occ);
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
    // Not trimmed at creation: a one-off's `start` is its *due date*, and may
    // legitimately predate its own creation — logging something already owed.
    if (!ev.start) return [];
    // Its one occurrence opens at the time of day the window opens, exactly as a
    // recurring one does — so `startTime` + `duration` decide when it is overdue.
    const occ = anchorFor(ev, ev.start);
    // Only the future edge gates. There is a single occurrence and no cost to
    // keeping it, and a to-do armed longer ago than the lookback window is still
    // owed — dropping it here would report the stale item as 'todo'.
    return dateOf(occ) <= rangeEnd ? [occ] : [];
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

/** The latest click recorded within an occurrence's credit period — from the
 * occurrence's window start until the next occurrence begins (a late
 * completion still counts, up until the habit comes due again). */
function latestInPeriod(ev: CounterEvent, occStart: string, nextStart?: string): string | undefined {
  const completions = ev.completions;
  if (!completions) return undefined;
  const lo = toDateTime(occStart);
  const hi = nextStart ? toDateTime(nextStart) : null;
  let latest: string | undefined;
  for (const ts of Object.keys(completions)) {
    const t = toDateTime(ts);
    if (t >= lo && (hi === null || t < hi) && (latest === undefined || t > latest)) latest = t;
  }
  return latest;
}

/** True when a click was recorded within an occurrence's credit period. */
export function metInPeriod(ev: CounterEvent, occStart: string, nextStart?: string): boolean {
  return latestInPeriod(ev, occStart, nextStart) !== undefined;
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
 * Always <= `now`: occurrences whose deadline is still ahead are skipped, so
 * the result can never render as a future time on an overdue row.
 *
 * `anchored` must be false when the counter has no `created`/`start`, because
 * then the grid is synthetic — anchored at the query range 400 days back (see
 * expandOccurrences) — and every occurrence before today would be counted as a
 * miss the habit never actually had.
 */
function overdueSince(ev: CounterEvent, occs: string[], from: number, now: string, anchored: boolean): string | undefined {
  let since: string | undefined;
  for (let i = from; i >= 0; i--) {
    const end = dueBy(ev, occs[i], occs[i + 1]);
    if (end > now) continue; // deadline still ahead — nothing owed for it yet
    if (metInPeriod(ev, occs[i], occs[i + 1])) break; // the run ends at the last one done
    since = end;
    if (!anchored) break; // synthetic grid: trust only the most recent deadline
  }
  return since;
}

/**
 * Status of a counter's current period, used for sectioning/sorting:
 *   'anytime'  — nothing owed: an unarmed checklist item, always tappable. It is
 *                exactly {@link isSettled}, so the row shows a *ticked* box.
 *   'todo'     — not owed yet, but coming: its first occurrence is still in the
 *                future, or the current period is met and past halfway to the
 *                next occurrence (see {@link halfwayTo})
 *   'done'     — the current period has a recorded completion, and its next
 *                occurrence is still more than half the gap away
 *   'due'      — the current occurrence has begun and its deadline
 *                ({@link dueBy}) is still ahead, with the previous occurrence
 *                (if any since the habit's start) met
 *   'overdue'  — the deadline passed with no completion yet, or the previous
 *                occurrence went unmet
 *
 * 'anytime' and 'done' are the two in which nothing is owed; the other three are
 * the escalation ladder. That split is what the row's ticked/empty box encodes.
 * The halfway rule is what keeps Done a shelf of recent wins — a 4-monthly habit
 * spends 2 months there and then resurfaces in To do ahead of its deadline,
 * instead of parking in Done for a third of a year and teleporting into To do
 * the instant it comes due.
 *
 * The deadline is not the credit window: a completion recorded any time before
 * the next occurrence still credits the current one ({@link metInPeriod}), so a
 * late click un-reds an overdue row rather than counting toward the next period.
 */
export function currentStatus(ev: CounterEvent, now: string): StatusResult {
  if (isSettled(ev)) return { status: 'anytime' };

  const today = dateOf(now);
  const from = Temporal.PlainDate.from(today).subtract({ days: LOOKBACK_DAYS }).toString();
  const to = Temporal.PlainDate.from(today).add({ days: LOOKBACK_DAYS }).toString();
  const occs = expectedOccurrences(ev, from, to);
  if (occs.length === 0) return { status: 'todo' };

  // Indexed so the overdue walk below can start at `curr` (or the one before it)
  // without re-deriving them. Equivalent to the prev/curr/next scan it replaces.
  let ci = -1;
  for (let i = 0; i < occs.length; i++) {
    if (toDateTime(occs[i]) <= now) ci = i;
    else break;
  }
  if (ci < 0) return { status: 'todo', occurrence: occs[0], dueAt: toDateTime(occs[0]) };
  const curr = occs[ci];
  const prev = occs[ci - 1];
  const next = occs[ci + 1];

  const met = latestInPeriod(ev, curr, next);
  if (met) {
    // Done only until halfway to the next occurrence, then back on the list as
    // an upcoming 'todo'. With no next occurrence there is nothing to come up
    // again for, so a met one-shot (or an exhausted rule) stays done.
    if (next && now >= halfwayTo(met, next)) {
      return { status: 'todo', occurrence: next, dueAt: toDateTime(next) };
    }
    return { status: 'done', occurrence: curr, dueAt: windowEnd(ev, curr, next) };
  }

  // Both the retroactive-miss rule and the walk need this, and it parses an
  // Instant, so resolve it once.
  const anchored = !!createdDate(ev);

  if (now >= dueBy(ev, curr, next)) {
    return {
      status: 'overdue',
      occurrence: curr,
      dueAt: overdueSince(ev, occs, ci, now, anchored) ?? dueBy(ev, curr, next),
    };
  }
  // Deadline still ahead — but a missed previous occurrence keeps it overdue.
  // Without a creation anchor the expansion is synthetic (anchored at the query
  // range), so "previous" doesn't imply the habit existed then; skip the check.
  if (anchored && prev && !metInPeriod(ev, prev, curr)) {
    return {
      status: 'overdue',
      occurrence: curr,
      // Never dueBy(curr): that deadline is still ahead, i.e. in the future,
      // and would render as "in 12 hours" on a row filed under Overdue. Walk
      // back from `prev`; `curr` itself (<= now by construction) is the floor.
      dueAt: overdueSince(ev, occs, ci - 1, now, anchored) ?? toDateTime(curr),
    };
  }
  return { status: 'due', occurrence: curr, dueAt: dueBy(ev, curr, next) };
}

/**
 * Overdue first, then everything owed, then done, then the settled pile — ties
 * broken by an unclaimed reward, then the deadline, then title.
 *
 * `due` and `todo` deliberately share a rank. They are one section, and ranking
 * them apart would sort every open-window item above every future one no matter
 * how far off its deadline — putting "due in 4 months" above "due tomorrow",
 * which is the ordering the deadline comparison exists to fix.
 */
const STATUS_ORDER: Record<CounterStatus, number> = { overdue: 0, due: 1, todo: 1, done: 2, anytime: 3 };

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
    // By the deadline the row actually RENDERS, not by when its window opened.
    // Sorting on `occurrence` ordered the list by a number the user cannot see:
    // two due habits of different intervals share a similar window start while
    // their deadlines are months apart, so "4 months left" sat above "1 month
    // left". Ascending covers every section — soonest first in Due/To do,
    // longest-overdue first in Overdue, next-due-soonest first in Done.
    // The sentinel sorts a row with no deadline last rather than first.
    const ad = a.dueAt ?? '￿';
    const bd = b.dueAt ?? '￿';
    if (ad !== bd) return ad < bd ? -1 : 1;
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
    if (isSettled(ev)) continue; // nothing owed, nothing to miss
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
