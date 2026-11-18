/**
 * What the Timeline knows about when each entry happened, once every order
 * relation ("this was before that") is taken into account.
 *
 * Each entry has a START; a period (an entry with `until`, or any chapter)
 * also has an END. Each is a variable whose value is a day, bounded by
 * [lo, hi]: initially the entry's own `when` / `until`, an unknown side
 * defaulting to birth (or 1900-01-01) and today. A chapter with no `until` is
 * still going: its end is today. Every relation is a difference constraint
 * `x ≤ y + c` (c ≥ 0) between two such variables:
 *
 *   X before B   X ≤ start(B)
 *   X after B    end(B) ≤ X
 *   X during B   start(B) ≤ X ≤ end(B)
 *   X near B     |X − start(B)| ≤ NEAR_DAYS
 *   period       start ≤ end
 *
 * Constraints are relaxed in both directions (`hi(x) ← hi(y)+c`,
 * `lo(y) ← lo(x)−c`) until nothing changes, so the contents of a period can
 * narrow the period too. Every step is sound: if the true days satisfy the
 * constraint and lie in both ranges, they lie in the narrowed ones. Fuzzy
 * anchors stay sound because only their bounds are used, never their guess.
 *
 * A relation that would leave some range empty contradicts what else is known.
 * It is not applied: it is reported as a conflict on both entries and the
 * whole propagation is rerun without it, so nothing it implied survives.
 * Because every c ≥ 0, cycles of relations are never contradictions by
 * themselves ("A before B before A" means the same day).
 */
import type { TimelineDocument, TimelineEvent, Rel } from '../schemas/timeline';
import { boundsOf, bestDay, dayOf } from './fuzzy-date';

/** "About the same time": within a season either side. */
export const NEAR_DAYS = 92;
export const DEFAULT_LIFE_START = '1900-01-01';

/** How a bound was tightened, from the narrowed entry's point of view. */
export interface Because {
  /** The other entry. */
  uid: string;
  /** This entry relative to it. `includes`: the other entry happened during this period. */
  rel: Rel | 'includes';
}
export interface Range { lo: number; hi: number; loBy?: Because; hiBy?: Because }

export interface Conflict {
  /** The entry holding the relation, the field it is in, and its target. */
  owner: string;
  field: 'rel' | 'untilRel';
  target: string;
  rel: Rel;
  reason: 'contradicts-dates' | 'contradicts-answer';
}

export interface EntryBounds {
  start: Range;
  /** Present for periods. */
  end?: Range;
  /** The entry's own `when` states something. */
  ownDate: boolean;
  /** False when nothing at all (own date or relation) says when it happened. */
  placed: boolean;
  conflicts: Conflict[];
}

export interface Bounds {
  life: { lo: number; hi: number };
  entries: Map<string, EntryBounds>;
}

type Node = string; // `${uid}:s` | `${uid}:e`
interface Edge {
  /** x ≤ y + c */
  x: Node; y: Node; c: number;
  id: string;
  /** The relation it comes from (absent for a period's own start ≤ end). */
  src?: { owner: string; field: 'rel' | 'untilRel'; target: string; rel: Rel };
}

/** Has an END: an entry with `until`, or any chapter (one with no `until` is still going). */
export const isPeriod = (ev: TimelineEvent | undefined) => !!ev?.until || !!ev?.chapter;
/** A chapter that has not ended: its end is today. */
export const isOngoing = (ev: TimelineEvent | undefined) => !!ev?.chapter && !ev.until;
const startOf = (uid: string): Node => `${uid}:s`;
const endOf = (uid: string, ev: TimelineEvent): Node => isPeriod(ev) ? `${uid}:e` : `${uid}:s`;
const uidOf = (n: Node) => n.slice(0, -2);

const INVERSE: Record<Rel, Rel | 'includes'> = {
  before: 'after', after: 'before', near: 'near', during: 'includes', unsure: 'unsure',
};

export function lifeSpan(doc: Pick<TimelineDocument, 'birth'>, today: number): { lo: number; hi: number } {
  const b = doc.birth ? dayOf(doc.birth) : null;
  return { lo: b ?? dayOf(DEFAULT_LIFE_START)!, hi: today };
}

/** The edges one relation stands for. */
function edgesFor(owner: string, field: 'rel' | 'untilRel', target: string, rel: Rel,
  events: Record<string, TimelineEvent>): Edge[] {
  const o = events[owner];
  const t = events[target];
  if (!o || !t || owner === target) return [];
  const x = field === 'untilRel' && isPeriod(o) ? `${owner}:e` : startOf(owner);
  const src = { owner, field, target, rel };
  const id = `${owner}|${field}|${target}`;
  switch (rel) {
    case 'before': return [{ x, y: startOf(target), c: 0, id, src }];
    case 'after': return [{ x: endOf(target, t), y: x, c: 0, id, src }];
    case 'during': return [
      { x: startOf(target), y: x, c: 0, id: id + '#1', src },
      { x, y: endOf(target, t), c: 0, id: id + '#2', src },
    ];
    case 'near': return [
      { x, y: startOf(target), c: NEAR_DAYS, id: id + '#1', src },
      { x: startOf(target), y: x, c: NEAR_DAYS, id: id + '#2', src },
    ];
    default: return [];
  }
}

const relKey = (s: Edge['src'] & {}) => `${s.owner}|${s.field}|${s.target}`;

export function effectiveBounds(doc: Pick<TimelineDocument, 'birth' | 'events'>, today: number): Bounds {
  const events = doc.events ?? {};
  const life = lifeSpan(doc, today);
  const uids = Object.keys(events).sort();

  // Own bounds.
  const init = new Map<Node, { lo: number; hi: number }>();
  const result = new Map<string, EntryBounds>();
  const ownConflicts = new Map<string, Conflict[]>();
  for (const uid of uids) {
    const ev = events[uid];
    const w = boundsOf(ev.when);
    init.set(startOf(uid), clampPair(w.lo ?? life.lo, w.hi ?? life.hi));
    if (isOngoing(ev)) {
      init.set(`${uid}:e`, { lo: life.hi, hi: life.hi });
    } else if (isPeriod(ev)) {
      const u = boundsOf(ev.until);
      init.set(`${uid}:e`, clampPair(u.lo ?? life.lo, u.hi ?? life.hi));
    }
    ownConflicts.set(uid, []);
  }

  // Edges, in a canonical order so the result never depends on key order.
  const edges: Edge[] = [];
  for (const uid of uids) {
    if (isPeriod(events[uid])) edges.push({ x: startOf(uid), y: `${uid}:e`, c: 0, id: `${uid}|span` });
    for (const field of ['rel', 'untilRel'] as const) {
      const rels = events[uid][field];
      if (!rels) continue;
      for (const target of Object.keys(rels).sort()) edges.push(...edgesFor(uid, field, target, rels[target], events));
    }
  }

  // Two answers that cannot both hold ("A before B" and "B before A") are
  // contradictory answers, not a same-day hint: report both, apply neither.
  const dead = new Set<string>();
  const conflicts: Conflict[] = [];
  for (const uid of uids) {
    const rels = events[uid].rel;
    if (!rels) continue;
    for (const [target, rel] of Object.entries(rels)) {
      if (uid >= target || (rel !== 'before' && rel !== 'after')) continue;
      if (events[target]?.rel?.[uid] === rel) {
        for (const [o, t] of [[uid, target], [target, uid]]) {
          dead.add(`${o}|rel|${t}`);
          conflicts.push({ owner: o, field: 'rel', target: t, rel, reason: 'contradicts-answer' });
        }
      }
    }
  }

  // Propagate; on a contradiction, kill that relation and start over.
  let state = propagate(init, edges, dead);
  while (state.killed) {
    const s = state.killed;
    dead.add(relKey(s));
    conflicts.push({ ...s, reason: 'contradicts-dates' });
    state = propagate(init, edges, dead);
  }

  for (const c of conflicts) {
    ownConflicts.get(c.owner)?.push(c);
    if (c.target !== c.owner) ownConflicts.get(c.target)?.push(c);
  }
  for (const uid of uids) {
    const ev = events[uid];
    const start = state.ranges.get(startOf(uid))!;
    const end = isPeriod(ev) ? state.ranges.get(`${uid}:e`) : undefined;
    const ownDate = !!(ev.when && (ev.when.earliest || ev.when.latest || ev.when.best));
    const placed = ownDate || !!(start.loBy || start.hiBy) || start.lo > life.lo || start.hi < life.hi;
    result.set(uid, { start, end, ownDate, placed, conflicts: ownConflicts.get(uid)! });
  }
  return { life, entries: result };
}

function clampPair(lo: number, hi: number) {
  return lo <= hi ? { lo, hi } : { lo: hi, hi: lo };
}

function propagate(
  init: Map<Node, { lo: number; hi: number }>, edges: Edge[], dead: Set<string>,
): { ranges: Map<Node, Range>; killed?: Edge['src'] & {} } {
  const ranges = new Map<Node, Range>();
  for (const [n, b] of init) ranges.set(n, { ...b });
  const live = edges.filter(e => !e.src || !dead.has(relKey(e.src)));
  const touching = new Map<Node, Edge[]>();
  for (const e of live) {
    for (const n of [e.x, e.y]) {
      if (!touching.has(n)) touching.set(n, []);
      touching.get(n)!.push(e);
    }
  }
  const queue: Edge[] = [...live];
  const queued = new Set<Edge>(live);
  // Bounds only move inward and are integers, so this terminates; the cap is
  // the Bellman–Ford bound, there to make a bug a stop rather than a hang.
  let budget = (live.length + 1) * (ranges.size + 1) * 2;
  while (queue.length && budget-- > 0) {
    const e = queue.shift()!;
    queued.delete(e);
    const rx = ranges.get(e.x)!;
    const ry = ranges.get(e.y)!;
    const newHiX = ry.hi + e.c;
    const newLoY = rx.lo - e.c;
    if (newHiX < rx.lo || newLoY > ry.hi) {
      if (e.src) return { ranges, killed: e.src };
      continue; // a period's own start/end contradiction: reported by validation
    }
    const changed: Node[] = [];
    if (newHiX < rx.hi) { rx.hi = newHiX; rx.hiBy = because(e, e.x); changed.push(e.x); }
    if (newLoY > ry.lo) { ry.lo = newLoY; ry.loBy = because(e, e.y); changed.push(e.y); }
    for (const n of changed) {
      for (const other of touching.get(n) ?? []) {
        if (!queued.has(other)) { queued.add(other); queue.push(other); }
      }
    }
  }
  return { ranges };
}

function because(e: Edge, narrowed: Node): Because | undefined {
  if (!e.src) return undefined;
  const { owner, target, rel } = e.src;
  return uidOf(narrowed) === owner ? { uid: target, rel } : { uid: owner, rel: INVERSE[rel] };
}

// ── Display order ─────────────────────────────────────────────────────────────

/** The day an entry is shown at: its own best guess, kept inside what is known; else the middle of that. */
export function displayDay(ev: TimelineEvent, b: EntryBounds): number {
  const guess = bestDay(ev.when);
  return guess !== undefined ? Math.min(b.start.hi, Math.max(b.start.lo, guess)) : Math.floor((b.start.lo + b.start.hi) / 2);
}

/**
 * Entries in the order the list shows them: by the middle of what is known
 * (or the entry's own best guess, when it has one), then adjusted so every
 * live relation reads correctly — two entries with identical ranges still
 * appear in the order you said. Unplaced entries come back separately.
 */
export function displayOrder(
  doc: Pick<TimelineDocument, 'birth' | 'events'>, bounds: Bounds,
): { ordered: string[]; undated: string[] } {
  const events = doc.events ?? {};
  const keyOf = new Map<string, number>();
  const placed: string[] = [];
  const undated: string[] = [];
  for (const [uid, b] of bounds.entries) {
    if (!b.placed) { undated.push(uid); continue; }
    placed.push(uid);
    keyOf.set(uid, displayDay(events[uid], b));
  }
  const title = (u: string) => events[u]?.title ?? '';
  // On the same day a chapter comes first, so what happened that day is inside
  // it; and of two chapters the one ending later, so the outer one holds the inner.
  const chapterFirst = (u: string) => (events[u]?.chapter ? 0 : 1);
  const endOf = (u: string) => {
    const e = events[u]?.chapter ? bounds.entries.get(u)?.end : undefined;
    return e ? (e.lo + e.hi) / 2 : 0;
  };
  const cmp = (a: string, b: string) =>
    keyOf.get(a)! - keyOf.get(b)! || chapterFirst(a) - chapterFirst(b) || endOf(b) - endOf(a)
    || title(a).localeCompare(title(b)) || (a < b ? -1 : a > b ? 1 : 0);

  // "a precedes b" edges from live relations.
  const deadRels = new Set<string>();
  for (const b of bounds.entries.values()) for (const c of b.conflicts) deadRels.add(`${c.owner}|${c.field}|${c.target}`);
  const succ = new Map<string, Set<string>>();
  const indeg = new Map<string, number>(placed.map(u => [u, 0]));
  const precede = (a: string, b: string) => {
    if (a === b || !indeg.has(a) || !indeg.has(b)) return;
    if (!succ.has(a)) succ.set(a, new Set());
    if (succ.get(a)!.has(b)) return;
    succ.get(a)!.add(b);
    indeg.set(b, indeg.get(b)! + 1);
  };
  for (const uid of placed) {
    const rels = events[uid].rel ?? {};
    for (const [target, rel] of Object.entries(rels)) {
      if (deadRels.has(`${uid}|rel|${target}`)) continue;
      if (rel === 'before') precede(uid, target);
      else if (rel === 'after' || rel === 'during') precede(target, uid);
    }
  }

  // Kahn's algorithm, always taking the earliest ready entry; a cycle (only
  // possible through "same day" answers) is broken at its earliest member.
  const ordered: string[] = [];
  const done = new Set<string>();
  const remaining = new Set(placed);
  while (remaining.size) {
    let next: string | undefined;
    for (const u of remaining) if (indeg.get(u) === 0 && (next === undefined || cmp(u, next) < 0)) next = u;
    if (next === undefined) for (const u of remaining) if (next === undefined || cmp(u, next) < 0) next = u;
    remaining.delete(next!);
    done.add(next!);
    ordered.push(next!);
    for (const s of succ.get(next!) ?? []) if (!done.has(s)) indeg.set(s, indeg.get(s)! - 1);
  }
  undated.sort((a, b) => title(a).localeCompare(title(b)) || (a < b ? -1 : 1));
  return { ordered, undated };
}

/**
 * Whether the stated orderings ("before", "after", "during") go round in a
 * circle. The solver accepts a circle (everything on one day), but for the
 * list it means the answers no longer say which comes first.
 */
export function hasOrderCycle(events: Record<string, TimelineEvent>): boolean {
  const succ = new Map<string, string[]>();
  const edge = (a: string, b: string) => {
    if (a === b || !events[a] || !events[b]) return;
    if (!succ.has(a)) succ.set(a, []);
    succ.get(a)!.push(b);
  };
  for (const [uid, ev] of Object.entries(events)) {
    for (const [target, rel] of Object.entries(ev.rel ?? {})) {
      if (rel === 'before') edge(uid, target);
      else if (rel === 'after' || rel === 'during') edge(target, uid);
    }
  }
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = done
  const visit = (u: string): boolean => {
    state.set(u, 1);
    for (const v of succ.get(u) ?? []) {
      const s = state.get(v);
      if (s === 1 || (s === undefined && visit(v))) return true;
    }
    state.set(u, 2);
    return false;
  };
  for (const u of succ.keys()) if (!state.has(u) && visit(u)) return true;
  return false;
}
