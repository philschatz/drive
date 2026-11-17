/**
 * What to ask next, and where a dropped or inserted entry goes.
 *
 * Two kinds of fuzzy bisection:
 *   - Pin down (`nextDateQuestion`): the entry whose date is vaguest is asked
 *     "before or after <anchor>?", the anchor being whichever other entry
 *     splits its range most evenly; with no useful anchor, a calendar or age
 *     pivot near the middle. Honest answers shrink the range by ≥ 30% each.
 *   - Fill gaps (`largestGaps`): the stretches of life with nothing in them,
 *     ranked by how much you are likely to remember from them.
 *
 * Both lean towards recent years: memory density rises with recency (and is
 * low in early childhood), and a date counts as pinned down once its range is
 * small for how long ago it was — a month for last year, a year for twenty
 * years ago.
 */
import type { TimelineDocument, TimelineEvent, Rel } from '../schemas/timeline';
import {
  type FuzzyDate, type Precision, boundsOf, bestDay, dayOf, fromDay, parsePartial, partialOf,
  precisionForWidth, formatFuzzy,
} from './fuzzy-date';
import { effectiveBounds, displayOrder, hasOrderCycle, lifeSpan, type Bounds, type Range } from './order';

export type Endpoint = 'start' | 'end';

const YEAR = 365.25;
/** Recency scale of the memory-density curve, in days. */
export const RECENCY_DAYS = 5 * YEAR;
/** Early-childhood memories (before this age) are rare. */
export const CHILDHOOD_YEARS = 4;
export const CHILDHOOD_FACTOR = 0.2;
/** A question is only worth asking if every answer shrinks the range to this share of it. */
export const MAX_SHRINK = 0.7;

/** Expected memories per day, relative: 1 today, falling with distance, low in early childhood. */
export function density(day: number, today: number, birth?: number): number {
  const d = 1 / (1 + Math.max(0, today - day) / RECENCY_DAYS);
  return birth !== undefined && day >= birth && day < birth + CHILDHOOD_YEARS * YEAR ? d * CHILDHOOD_FACTOR : d;
}

/** ∫ density over [a, b], in closed form. */
export function memoryWeight(a: number, b: number, today: number, birth?: number): number {
  const lo = Math.min(a, b, today);
  const hi = Math.min(Math.max(a, b), today);
  const raw = (x: number, y: number) =>
    y <= x ? 0 : RECENCY_DAYS * Math.log((1 + (today - x) / RECENCY_DAYS) / (1 + (today - y) / RECENCY_DAYS));
  let w = raw(lo, hi);
  if (birth !== undefined) {
    const cLo = Math.max(lo, birth);
    const cHi = Math.min(hi, birth + CHILDHOOD_YEARS * YEAR);
    w -= (1 - CHILDHOOD_FACTOR) * raw(cLo, cHi);
  }
  return w;
}

/** The range width at which a date counts as pinned down: ≥ 31 days, and 5% of how long ago it was. */
export function pinThreshold(mid: number, today: number): number {
  return Math.max(31, 0.05 * Math.max(0, today - mid));
}

const width = (r: { lo: number; hi: number }) => r.hi - r.lo;
const midOf = (r: { lo: number; hi: number }) => Math.floor((r.lo + r.hi) / 2);

// ── Pin down ─────────────────────────────────────────────────────────────────

export interface Target { uid: string; end: Endpoint }
export type Question =
  | { kind: 'anchor'; uid: string; end: Endpoint; range: Range; anchor: string; options: Rel[] }
  | { kind: 'pivot'; uid: string; end: Endpoint; range: Range; pivot: number; label: string };

export const targetKey = (t: Target) => `${t.uid}:${t.end}`;

function related(a: TimelineEvent, aUid: string, b: TimelineEvent, bUid: string): boolean {
  return !!(a.rel?.[bUid] || a.untilRel?.[bUid] || b.rel?.[aUid] || b.untilRel?.[aUid]);
}

/** Entries' endpoints whose date is not yet pinned down, most in need first. */
export function pinTargets(
  doc: Pick<TimelineDocument, 'birth' | 'events'>, today: number, bounds = effectiveBounds(doc, today),
): (Target & { range: Range; score: number })[] {
  const out: (Target & { range: Range; score: number })[] = [];
  for (const [uid, b] of bounds.entries) {
    if (doc.events[uid].settled) continue;
    for (const [end, range] of [['start', b.start], ['end', b.end]] as const) {
      if (!range) continue;
      const t = pinThreshold(midOf(range), today);
      if (width(range) > t) out.push({ uid, end, range, score: width(range) / t });
    }
  }
  return out.sort((a, b) => b.score - a.score || (a.uid < b.uid ? -1 : 1) || (a.end < b.end ? -1 : 1));
}

/**
 * The next before/after question, or null when every date is pinned down
 * enough. `skip` holds targetKeys the user said "not sure" to in this session;
 * `target` forces the question onto one entry (the editor's "Pin down" action).
 */
export function nextDateQuestion(
  doc: Pick<TimelineDocument, 'birth' | 'events'>, today: number,
  opts: { skip?: Set<string>; target?: Target } = {},
): Question | null {
  const bounds = effectiveBounds(doc, today);
  let targets = pinTargets(doc, today, bounds);
  if (opts.target) {
    const b = bounds.entries.get(opts.target.uid);
    const range = opts.target.end === 'end' ? b?.end : b?.start;
    if (!range || width(range) < 1) return null;
    targets = [{ ...opts.target, range, score: 0 }];
  } else if (opts.skip) {
    targets = targets.filter(t => !opts.skip!.has(targetKey(t)));
  }
  for (const t of targets) {
    const q = anchorQuestion(doc, bounds, t) ?? pivotQuestion(doc, t, today);
    if (q) return q;
  }
  return null;
}

function anchorQuestion(
  doc: Pick<TimelineDocument, 'events'>, bounds: Bounds, t: Target & { range: Range },
): Question | null {
  const { lo, hi } = t.range;
  const W = hi - lo;
  const me = doc.events[t.uid];
  let best: { anchor: string; worst: number; aw: number; options: Rel[] } | null = null;
  for (const [uid, b] of bounds.entries) {
    if (uid === t.uid || !b.placed) continue;
    const other = doc.events[uid];
    if (related(me, t.uid, other, uid)) continue;
    const s = b.start;
    const e = b.end ?? b.start;
    const before = Math.min(hi, s.hi) - lo;
    const after = hi - Math.max(lo, e.lo);
    if (before < 0 || after < 0) continue; // the order already follows
    const regions = [before, after];
    const options: Rel[] = ['before', 'after'];
    if (b.end) {
      regions.push(Math.max(-1, Math.min(hi, e.hi) - Math.max(lo, s.lo)));
      options.push('during');
    }
    const worst = Math.max(...regions);
    if (worst > MAX_SHRINK * W) continue;
    const near = Math.min(hi, s.hi + 92) - Math.max(lo, s.lo - 92);
    if (!b.end && near <= MAX_SHRINK * W) options.push('near');
    const aw = width(s);
    if (!best || worst < best.worst || (worst === best.worst && (aw < best.aw || (aw === best.aw && uid < best.anchor)))) {
      best = { anchor: uid, worst, aw, options: [...options, 'unsure'] };
    }
  }
  return best ? { kind: 'anchor', uid: t.uid, end: t.end, range: t.range, anchor: best.anchor, options: best.options } : null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A round date near the middle of the range: a birthday, a new year, a new month, or a day. */
function pivotQuestion(doc: Pick<TimelineDocument, 'birth'>, t: Target & { range: Range }, _today: number): Question | null {
  const { lo, hi } = t.range;
  const W = hi - lo;
  if (W < 2) return null;
  const wLo = lo + Math.ceil(0.4 * W);
  const wHi = lo + Math.floor(0.6 * W);
  const mid = midOf(t.range);
  const closest = (cands: number[]) => cands.filter(c => c >= wLo && c <= wHi && c > lo)
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  const q = (pivot: number, label: string): Question => ({ kind: 'pivot', uid: t.uid, end: t.end, range: t.range, pivot, label });

  const birth = doc.birth ? parsePartial(doc.birth) : null;
  if (birth?.precision === 'day' && W >= 3 * 365) {
    const ages: number[] = [];
    for (let age = 1; age < 130; age++) {
      const d = dayOf(birth.first.add({ years: age }).toString())!;
      if (d > wHi) break;
      ages.push(d);
    }
    const p = closest(ages);
    if (p !== undefined) return q(p, `you turned ${fromDay(p).year - birth.first.year}`);
  }
  const lo0 = fromDay(lo);
  const hi0 = fromDay(hi);
  const years: number[] = [];
  for (let y = lo0.year; y <= hi0.year; y++) years.push(dayOf(String(y))!);
  const py = closest(years);
  if (py !== undefined) return q(py, `the start of ${fromDay(py).year}`);
  const months: number[] = [];
  for (let m = lo0.with({ day: 1 }); dayOf(m.toString())! <= hi; m = m.add({ months: 1 })) months.push(dayOf(m.toString())!);
  const pm = closest(months);
  if (pm !== undefined) { const d = fromDay(pm); return q(pm, `the start of ${MONTHS[d.month - 1]} ${d.year}`); }
  const p = Math.max(lo + 1, mid);
  return q(p, formatFuzzy({ earliest: fromDay(p).toString(), latest: fromDay(p).toString() }));
}

/** A day bound written as the coarsest partial date that states it exactly. */
function exactPartial(day: number, side: 'first' | 'last'): string {
  const d = fromDay(day);
  if (side === 'first') {
    if (d.month === 1 && d.day === 1) return partialOf(day, 'year');
    if (d.day === 1) return partialOf(day, 'month');
  } else {
    if (d.month === 12 && d.day === 31) return partialOf(day, 'year');
    if (d.add({ days: 1 }).day === 1) return partialOf(day, 'month');
  }
  return partialOf(day, 'day');
}

/** The FuzzyDate after answering a pivot question ("before"/"after" the pivot day). */
export function applyPivotAnswer(fd: FuzzyDate | undefined, pivot: number, answer: 'before' | 'after'): FuzzyDate {
  const next: FuzzyDate = { ...(fd ?? {}) };
  const { lo, hi } = boundsOf(fd);
  if (answer === 'before') {
    if (hi === undefined || pivot - 1 < hi) next.latest = exactPartial(pivot - 1, 'last');
  } else if (lo === undefined || pivot > lo) {
    next.earliest = exactPartial(pivot, 'first');
  }
  const b = next.best ? parsePartial(next.best) : null;
  const nb = boundsOf(next);
  if (b && ((nb.lo !== undefined && dayOf(b.last.toString())! < nb.lo) || (nb.hi !== undefined && dayOf(b.first.toString())! > nb.hi))) {
    delete next.best;
  }
  return next;
}

// ── Gaps ─────────────────────────────────────────────────────────────────────

export interface Gap { lo: number; hi: number; score: number }

/** Every day the timeline already says something about: entries, and every prompt ever offered. */
export function coveredDays(doc: Pick<TimelineDocument, 'birth' | 'events' | 'prompts'>, today: number,
  bounds = effectiveBounds(doc, today)): number[] {
  const days: number[] = [];
  const { ordered } = displayOrder(doc, bounds);
  for (const uid of ordered) {
    const b = bounds.entries.get(uid)!;
    days.push(clampTo(bestDay(doc.events[uid].when), b.start));
    if (b.end) days.push(clampTo(bestDay(doc.events[uid].until), b.end));
  }
  for (const p of Object.values(doc.prompts ?? {})) {
    const d = bestDay(p.when);
    if (d !== undefined) days.push(d);
  }
  return days;
}

function clampTo(guess: number | undefined, r: { lo: number; hi: number }): number {
  return guess === undefined ? midOf(r) : Math.min(r.hi, Math.max(r.lo, guess));
}

/**
 * The empty stretches of life, most worth asking about first: ranked by the
 * memories you are likely to have from them (recent beats old, early
 * childhood counts little), ignoring stretches too short to matter for how
 * long ago they were. Asking about the middle of the top gap, and recording
 * the answer (an entry, or a "gap" prompt), splits it — coverage goes from
 * coarse to fine.
 */
export function largestGaps(
  doc: Pick<TimelineDocument, 'birth' | 'events' | 'prompts'>, today: number,
  extraDays: number[] = [],
): Gap[] {
  const birth = doc.birth ? dayOf(doc.birth) ?? undefined : undefined;
  const days = [...coveredDays(doc, today), ...extraDays].filter(d => d <= today).sort((a, b) => a - b);
  const start = birth ?? (days.length ? Math.min(days[0], today - 20 * 365) : today - 20 * 365);
  const points = [start, ...days.filter(d => d > start), today];
  const gaps: Gap[] = [];
  for (let i = 1; i < points.length; i++) {
    const lo = points[i - 1];
    const hi = points[i];
    const mid = (lo + hi) / 2;
    if (hi - lo < Math.max(62, 2 * pinThreshold(mid, today))) continue;
    gaps.push({ lo, hi, score: memoryWeight(lo, hi, today, birth) });
  }
  return gaps.sort((a, b) => b.score - a.score || a.lo - b.lo);
}

// ── Placement by position (insert between, drag to reorder) ──────────────────

export interface RelRef { owner: string; field: 'rel' | 'untilRel'; target: string }
export type Placement =
  | { ok: true; remove: RelRef[]; add: (RelRef & { rel: Rel })[]; when: FuzzyDate }
  | { ok: false; reason: string };

function withRels(events: Record<string, TimelineEvent>, remove: RelRef[], add: (RelRef & { rel: Rel })[]) {
  const next: Record<string, TimelineEvent> = { ...events };
  const touch = (uid: string) => {
    next[uid] = { ...next[uid], rel: { ...(next[uid].rel ?? {}) }, untilRel: { ...(next[uid].untilRel ?? {}) } };
  };
  for (const r of remove) { if (!next[r.owner]) continue; touch(r.owner); delete next[r.owner][r.field]![r.target]; }
  for (const r of add) { touch(r.owner); next[r.owner][r.field]![r.target] = r.rel; }
  return next;
}

/**
 * Where an entry lands when dropped (or inserted) between `above` and `below`
 * in the list (either may be null at the ends). The entry's existing ordering
 * relations to anything are dropped, "after above" / "before below" added,
 * then each old relation is kept again if it still fits. Its best guess moves
 * to the middle of what is now possible. Refused when its own date (or a
 * neighbour's) forbids the spot.
 *
 * `draft` stands for an entry not yet in the document (insert-between).
 */
export function placeBetween(
  doc: Pick<TimelineDocument, 'birth' | 'events'>, uid: string,
  above: string | null, below: string | null, today: number, draft?: TimelineEvent,
): Placement {
  const events = { ...doc.events, ...(draft ? { [uid]: draft } : {}) };
  const me = events[uid];
  if (!me) return { ok: false, reason: 'That entry no longer exists.' };

  const old: (RelRef & { rel: Rel })[] = [];
  for (const [owner, ev] of Object.entries(events)) {
    for (const field of ['rel', 'untilRel'] as const) {
      for (const [target, rel] of Object.entries(ev[field] ?? {})) {
        if (rel === 'unsure') continue;
        if ((owner === uid && events[target]) || (target === uid && owner !== uid)) old.push({ owner, field, target, rel });
      }
    }
  }
  const add: (RelRef & { rel: Rel })[] = [];
  if (above && above !== uid) add.push({ owner: uid, field: 'rel', target: above, rel: 'after' });
  if (below && below !== uid) add.push({ owner: uid, field: 'rel', target: below, rel: 'before' });

  const conflicted = (evs: Record<string, TimelineEvent>) =>
    (effectiveBounds({ birth: doc.birth, events: evs }, today).entries.get(uid)?.conflicts.length ?? 0) > 0;

  let remove: RelRef[] = old.map(({ owner, field, target }) => ({ owner, field, target }));
  let trial = withRels(events, remove, add);
  if (conflicted(trial)) {
    const names = [above, below].filter(Boolean).map(u => `“${events[u!].title}”`).join(' and ');
    return {
      ok: false,
      reason: `Its date (${formatFuzzy(me.when, doc.birth)}) doesn't fit ${above && below ? 'between' : above ? 'after' : 'before'} ${names}.`,
    };
  }
  // Keep each old relation that still agrees with the dates AND with the new
  // order (one that would make the stated order circular contradicts the drop
  // as surely as one contradicting the dates), in canonical order.
  const sorted = [...old].sort((a, b) => `${a.owner}|${a.field}|${a.target}`.localeCompare(`${b.owner}|${b.field}|${b.target}`));
  for (const r of sorted) {
    if (add.some(a => a.owner === r.owner && a.field === r.field && a.target === r.target)) continue;
    if ((r.owner === above || r.owner === below) && r.target === uid) continue; // superseded by the new order
    const without = remove.filter(x => !(x.owner === r.owner && x.field === r.field && x.target === r.target));
    const t = withRels(events, without, add);
    if (!conflicted(t) && !hasOrderCycle(t)) { remove = without; trial = t; }
  }
  // Drop no-op removals (relations that were not there to begin with) and re-adds of what exists.
  remove = remove.filter(r => !add.some(a => a.owner === r.owner && a.field === r.field && a.target === r.target && events[r.owner]?.[r.field]?.[r.target] === a.rel));
  const addNeeded = add.filter(a => events[a.owner]?.[a.field]?.[a.target] !== a.rel);

  const range = effectiveBounds({ birth: doc.birth, events: trial }, today).entries.get(uid)!.start;
  const precision: Precision = precisionForWidth(width(range));
  const when: FuzzyDate = { ...(me.when ?? {}), best: partialOf(midOf(range), precision) };
  return { ok: true, remove, add: addNeeded, when };
}

export { lifeSpan };
