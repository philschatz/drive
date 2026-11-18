/**
 * Chapters: the stretches of life that frame memories — where I lived, who I
 * was with, what my days went into, a phase. A chapter is an entry with
 * `chapter` set, so the date solver already treats it as a period (order.ts):
 * "during" a chapter narrows a memory, and a chapter's contents narrow it.
 *
 * This module turns chapters into what the list draws — a vertical bar per
 * chapter beside the rows it spans — and into the prompts they make possible.
 *
 * The list is not proportional to time, so a bar is measured in ROWS: from
 * the chapter's own row (its start) up to the newest row inside it. Indices
 * here are into `ordered` (order.displayOrder: OLDEST first); the list draws
 * them newest first. "Up" means newer.
 */
import type { TimelineDocument, TimelineEvent, ChapterKind } from '../schemas/timeline';
import { bestDay, boundsOf, dayOf } from './fuzzy-date';
import { displayDay, isOngoing, type Bounds } from './order';
import { memoryWeight, pinThreshold } from './planner';

export const isChapter = (ev: TimelineEvent | undefined): boolean => !!ev?.chapter;

/** When a chapter ran, as best we know. Days. */
export interface ChapterSpan {
  uid: string;
  kind: ChapterKind;
  /** Best guess of its start / end (end = today while it is still going). */
  from: number;
  to: number;
  /** Where it is CERTAINLY under way: from the latest it can have begun to the earliest it can have ended. May be empty. */
  sureFrom: number;
  sureTo: number;
  ongoing: boolean;
}

/** Every placed chapter's span. Unplaced (undated) chapters have none. */
export function chapterSpans(doc: Pick<TimelineDocument, 'events'>, bounds: Bounds): Map<string, ChapterSpan> {
  const out = new Map<string, ChapterSpan>();
  for (const [uid, ev] of Object.entries(doc.events ?? {})) {
    if (!isChapter(ev)) continue;
    const b = bounds.entries.get(uid);
    if (!b || !b.placed || !b.end) continue;
    const ongoing = isOngoing(ev);
    const from = displayDay(ev, b);
    const guess = ongoing ? bounds.life.hi : bestDay(ev.until);
    const endMid = Math.floor((b.end.lo + b.end.hi) / 2);
    const to = Math.max(from, guess === undefined ? endMid : Math.min(b.end.hi, Math.max(b.end.lo, guess)));
    out.set(uid, { uid, kind: ev.chapter!, from, to, sureFrom: b.start.hi, sureTo: b.end.lo, ongoing });
  }
  return out;
}

/** A chapter's bar, in rows of `ordered`. */
export interface ChapterBar {
  uid: string;
  kind: ChapterKind;
  /** Left to right; outer (earlier, longer) chapters take the low lanes. */
  lane: number;
  /** Position in start order: the list colours chapters round-robin by it. */
  colorIndex: number;
  /** The chapter's own row. */
  lo: number;
  /** The newest row inside it (≥ lo). */
  hi: number;
  /** Still going: the bar runs on past `hi` to the top of the list. */
  toTop: boolean;
  /** Rows inside it, beyond its own row — explicit "during" or dated within it. */
  members: Set<number>;
  /** Rows only POSSIBLY inside (outside its certain stretch, and not stated). */
  maybe: Set<number>;
}

export interface ChapterLayout {
  bars: ChapterBar[];
  laneCount: number;
}

/** Bars for the placed chapters among `ordered` (oldest first). */
export function chapterLayout(
  doc: Pick<TimelineDocument, 'events'>, bounds: Bounds, ordered: string[],
): ChapterLayout {
  const events = doc.events ?? {};
  const spans = chapterSpans(doc, bounds);
  const index = new Map(ordered.map((u, i) => [u, i]));
  const dayAt = ordered.map(u => displayDay(events[u], bounds.entries.get(u)!));

  const raw: Omit<ChapterBar, 'lane' | 'colorIndex'>[] = [];
  for (const span of spans.values()) {
    const lo = index.get(span.uid);
    if (lo === undefined) continue;
    const members = new Set<number>();
    const maybe = new Set<number>();
    for (let i = lo + 1; i < ordered.length; i++) {
      const stated = events[ordered[i]]?.rel?.[span.uid] === 'during';
      // A chapter starting the day this one ends follows it (a move), rather than sitting inside it.
      const inside = isChapter(events[ordered[i]]) ? dayAt[i] < span.to : dayAt[i] <= span.to;
      if (stated || inside) {
        members.add(i);
        if (!stated && (dayAt[i] < span.sureFrom || dayAt[i] > span.sureTo)) maybe.add(i);
      }
    }
    const hi = Math.max(lo, ...members);
    // Rows the bar passes without being members (the order put them there) read as "maybe".
    for (let i = lo + 1; i < hi; i++) if (!members.has(i)) maybe.add(i);
    raw.push({ uid: span.uid, kind: span.kind, lo, hi, toTop: span.ongoing, members, maybe });
  }

  // Start order: oldest first; at the same row the longer (outer) one first.
  const top = (b: { hi: number; toTop: boolean }) => (b.toTop ? ordered.length : b.hi);
  raw.sort((a, b) => a.lo - b.lo || (top(b) - b.lo) - (top(a) - a.lo) || (a.uid < b.uid ? -1 : 1));
  const laneEnds: number[] = [];
  const bars = raw.map((b, colorIndex) => {
    let lane = laneEnds.findIndex(end => end < b.lo);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(top(b)); } else laneEnds[lane] = top(b);
    return { ...b, lane, colorIndex };
  });
  return { bars, laneCount: laneEnds.length };
}

/** How a bar crosses one row: its own row (`start`), its newest row (`end`), a row in between (`through`), or alone (`dot`). */
export type CellShape = 'start' | 'end' | 'through' | 'dot';

export function cellAtRow(bar: ChapterBar, i: number): CellShape | null {
  if (i < bar.lo || i > (bar.toTop ? Infinity : bar.hi)) return null;
  if (i === bar.lo) return bar.hi > bar.lo || bar.toTop ? 'start' : 'dot';
  if (i === bar.hi && !bar.toTop) return 'end';
  return 'through';
}

/**
 * Whether a bar passes something drawn BETWEEN rows `below` (older) and
 * `below + 1` (newer): a year header, a gap row, an insert target. Above the
 * newest row, `below` is the last index; only a still-going bar reaches there.
 */
export function coversBetween(bar: ChapterBar, below: number): boolean {
  return bar.lo <= below && (bar.toTop || bar.hi >= below + 1);
}

/** Memories inside a chapter: its member rows that are not chapters themselves. */
export function memoriesIn(bar: ChapterBar, ordered: string[], events: Record<string, TimelineEvent>): number {
  let n = 0;
  for (const i of bar.members) if (!isChapter(events[ordered[i]])) n++;
  return n;
}

/** The chapters under way on a given day (by best guess), oldest first. */
export function chaptersAt(spans: Map<string, ChapterSpan>, day: number): ChapterSpan[] {
  return [...spans.values()].filter(s => s.from <= day && day <= s.to).sort((a, b) => a.from - b.from);
}

// ── Prompts ──────────────────────────────────────────────────────────────────

export interface ChapterGap { lo: number; hi: number; score: number }

/**
 * Stretches of life no Place chapter covers ("where were you living then?"),
 * most worth asking first. Places tile a life, which no other kind does. A
 * place-gap prompt (answered or skipped) counts as covering its stretch, so
 * nothing is asked twice. Without a birth date the window starts at the
 * earliest place.
 */
export function placeGaps(
  doc: Pick<TimelineDocument, 'birth' | 'events' | 'prompts'>, bounds: Bounds, today: number,
): ChapterGap[] {
  const covered: [number, number][] = [];
  for (const s of chapterSpans(doc, bounds).values()) if (s.kind === 'place') covered.push([s.from, s.to]);
  for (const p of Object.values(doc.prompts ?? {})) {
    if (p.chapter !== 'place') continue;
    const lo = boundsOf(p.when).lo;
    const hi = boundsOf(p.until ?? p.when).hi;
    if (lo !== undefined && hi !== undefined) covered.push([lo, Math.max(lo, hi)]);
  }
  const birth = doc.birth ? dayOf(doc.birth) ?? undefined : undefined;
  if (!covered.length) return [];
  covered.sort((a, b) => a[0] - b[0]);
  const start = birth ?? covered[0][0];
  const gaps: ChapterGap[] = [];
  let at = start;
  const consider = (lo: number, hi: number) => {
    if (hi - lo < Math.max(62, 2 * pinThreshold((lo + hi) / 2, today))) return;
    gaps.push({ lo, hi, score: memoryWeight(lo, hi, today, birth) });
  };
  for (const [lo, hi] of covered) {
    if (lo > at) consider(at, Math.min(lo, today));
    at = Math.max(at, hi + 1);
  }
  if (at < today) consider(at, today);
  return gaps.sort((a, b) => b.score - a.score || a.lo - b.lo);
}

/** Whether the timeline has any Place yet (a chapter, or a place-gap prompt answered or skipped). */
export function hasPlaces(doc: Pick<TimelineDocument, 'events' | 'prompts'>): boolean {
  return Object.values(doc.events ?? {}).some(e => e.chapter === 'place')
    || Object.values(doc.prompts ?? {}).some(p => p.chapter === 'place');
}

export interface ChapterCard { uid: string; memories: number; score: number }

/**
 * Chapters that deserve more memories: how much you are likely to remember
 * from their stretch of life, over the memories already in them.
 */
export function chapterCards(
  doc: Pick<TimelineDocument, 'birth' | 'events'>, bounds: Bounds, ordered: string[], layout: ChapterLayout, today: number,
): ChapterCard[] {
  const spans = chapterSpans(doc, bounds);
  const birth = doc.birth ? dayOf(doc.birth) ?? undefined : undefined;
  const out: ChapterCard[] = [];
  for (const bar of layout.bars) {
    const s = spans.get(bar.uid)!;
    const memories = memoriesIn(bar, ordered, doc.events);
    out.push({ uid: bar.uid, memories, score: memoryWeight(s.from, s.to, today, birth) / (1 + memories) });
  }
  return out.sort((a, b) => b.score - a.score || (a.uid < b.uid ? -1 : 1));
}
