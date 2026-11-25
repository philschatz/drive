/**
 * The timeline itself: entries NEWEST FIRST under sticky year headers (birth at
 * the bottom), a gap row wherever whole years are empty, and "Undated" on top —
 * next to the newest end, where ↓ on an undated entry's handle drops it in.
 *
 * `ordered` arrives oldest first (order.displayOrder) and the callbacks speak
 * chronology — (earlier, later) — so only this component knows the list is
 * drawn upside down. Visually "above" is later, "below" is earlier.
 *
 * In arrange mode, an insertion target sits between every two rows (a new
 * entry dropped there is "after the one below, before the one above"), and
 * fuzzy entries carry a drag handle. Dragging — or ↑/↓ on the focused handle —
 * moves an entry among the others; the container turns the spot into order
 * relations (planner.placeBetween), or refuses when the entry's date forbids it.
 * No drag library: pointer events with pointer capture, positions measured once
 * at the start of the drag.
 *
 * Chapters are rows too (at their start), and each draws a vertical bar in the
 * gutter (Rails) up through everything inside it. A year header names the
 * chapters under way at any point that year — the "where was I then" cue that
 * stays on screen as the header sticks. (By date, not by bar: a bar ends at
 * the last row inside it, which can be below the header of a year the
 * chapter still ran through.)
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ListRow } from '../../common/ListRow';
import { PresenceDot } from '../../common/PeerDot';
import type { PeerFieldInfo } from '../../common/presence';
import type { TimelineEvent } from '../../../../shared/schemas/timeline';
import { displayDay, isOngoing, type Bounds } from '../../../../shared/timeline/order';
import { formatFuzzy, formatDayRange, fromDay, parsePartial, dayOf } from '../../../../shared/timeline/fuzzy-date';
import {
  cellAtRow, coversBetween, memoriesIn, chapterSpans, chaptersDuring, type ChapterBar, type ChapterLayout,
} from '../../../../shared/timeline/chapters';
import { Thumb } from './Thumb';
import { Rails, type RailCell } from './Rails';
import { CHAPTER_KIND_META, chapterColor } from './chapter-kinds';

export interface TimelineListProps {
  docId?: string;
  events: Record<string, TimelineEvent>;
  bounds: Bounds;
  ordered: string[];
  undated: string[];
  /** Chapter bars over `ordered` (chapters.chapterLayout). */
  layout: ChapterLayout;
  birth?: string;
  canEdit: boolean;
  arranging: boolean;
  peerEditing: Record<string, PeerFieldInfo>;
  onOpen: (uid: string) => void;
  /** A new entry between two entries in time (either may be null at the ends). */
  onInsert: (earlier: string | null, later: string | null) => void;
  /** Move an entry between two entries in time. */
  onMove: (uid: string, earlier: string | null, later: string | null) => void;
  /** Start an entry in an empty stretch. */
  onGap: (loYear: number, hiYear: number) => void;
}

/** Exact-day and settled entries, and chapters, take their order from their dates: no handle. */
export function isMovable(ev: TimelineEvent): boolean {
  if (ev.settled || ev.chapter) return false;
  const e = ev.when?.earliest && parsePartial(ev.when.earliest);
  return !(e && e.precision === 'day' && ev.when?.earliest === ev.when?.latest);
}

function ageAt(birth: string | undefined, year: number): number | null {
  const b = birth ? parsePartial(birth) : null;
  return b ? year - b.first.year : null;
}

/** "2008 – 2013", "Since 2019", "Undated". */
export function chapterDates(ev: TimelineEvent, birth?: string): string {
  if (!ev.when && !ev.until) return isOngoing(ev) ? 'Still going' : 'Undated';
  const from = formatFuzzy(ev.when, birth);
  if (isOngoing(ev)) return `Since ${from}`;
  return `${from} – ${ev.until && Object.keys(ev.until).length ? formatFuzzy(ev.until, birth) : 'ended'}`;
}

export function TimelineList(p: TimelineListProps) {
  const { events, bounds, ordered, undated, layout, birth, canEdit, arranging } = p;
  const chrono = new Map(ordered.map((u, i) => [u, i]));
  const spans = chapterSpans({ events }, bounds);
  const barOf = new Map(layout.bars.map(b => [b.uid, b]));
  const titleOf = (b: ChapterBar) => events[b.uid]?.title || 'Chapter';
  /** The bar pieces on a row (at chronological index `i`) or between rows (`below`, `below + 1`). */
  const rowCells = (i: number): RailCell[] => layout.bars.flatMap(b => {
    const shape = cellAtRow(b, i);
    return shape ? [{ uid: b.uid, lane: b.lane, color: chapterColor(b.colorIndex), shape, maybe: b.maybe.has(i), title: titleOf(b) }] : [];
  });
  const betweenCells = (below: number): RailCell[] => layout.bars.filter(b => coversBetween(b, below)).map(b => ({
    uid: b.uid, lane: b.lane, color: chapterColor(b.colorIndex), shape: 'between',
    maybe: b.maybe.has(below + 1) || (b.maybe.has(below) && below !== b.lo), title: titleOf(b),
  }));
  const withRails = (cells: RailCell[], child: ComponentChildren, key: string, extra?: Record<string, unknown>) => (
    <div key={key} className="flex items-stretch" {...extra}>
      <Rails lanes={layout.laneCount} cells={cells} onOpen={p.onOpen} />
      <div className="flex-1 min-w-0">{child}</div>
    </div>
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ uid: string; startY: number; dy: number; index: number } | null>(null);
  const dragRef = useRef<{ uid: string; startY: number; mids: { uid: string; mid: number }[] } | null>(null);

  const yearOf = (uid: string) => fromDay(displayDay(events[uid], bounds.entries.get(uid)!)).year;
  /** Screen order: newest first. */
  const shown = [...ordered].reverse();
  const others = (uid: string) => shown.filter(u => u !== uid);
  const dropIndex = (uid: string, y: number) => {
    const mids = dragRef.current?.mids.filter(m => m.uid !== uid) ?? [];
    let i = 0;
    while (i < mids.length && y > mids[i].mid) i++;
    return i;
  };
  /** The [earlier, later] entries around screen slot `index` among the others. */
  const neighbours = (uid: string, index: number): [string | null, string | null] => {
    const rest = others(uid);
    return [rest[index] ?? null, rest[index - 1] ?? null];
  };

  const startDrag = (uid: string, clientY: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-entry-row]') ?? [];
    const mids: { uid: string; mid: number }[] = [];
    rows.forEach(r => {
      const u = r.dataset.uid!;
      if (!ordered.includes(u)) return;
      const rect = r.getBoundingClientRect();
      mids.push({ uid: u, mid: rect.top + rect.height / 2 });
    });
    dragRef.current = { uid, startY: clientY, mids };
    setDrag({ uid, startY: clientY, dy: 0, index: dropIndex(uid, clientY) });
  };
  const moveDrag = (clientY: number) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ uid: d.uid, startY: d.startY, dy: clientY - d.startY, index: dropIndex(d.uid, clientY) });
  };
  const endDrag = (clientY: number) => {
    const d = dragRef.current;
    // The drop position reads the measurements, so take it before clearing them.
    const index = d ? dropIndex(d.uid, clientY) : 0;
    dragRef.current = null;
    setDrag(null);
    if (!d || Math.abs(clientY - d.startY) < 4) return;
    const [earlier, later] = neighbours(d.uid, index);
    const i = ordered.indexOf(d.uid);
    if (i >= 0 && ordered[i - 1] === (earlier ?? undefined) && ordered[i + 1] === (later ?? undefined)) return;
    p.onMove(d.uid, earlier, later);
  };
  const keyMove = (uid: string, key: 'ArrowUp' | 'ArrowDown') => {
    const i = shown.indexOf(uid);
    // An undated entry (shown above the timeline) enters at its top (↓).
    const at = i < 0 ? (key === 'ArrowDown' ? 0 : -1) : key === 'ArrowUp' ? i - 1 : i + 1;
    if (at < 0 || at > others(uid).length) return;
    const [earlier, later] = neighbours(uid, at);
    p.onMove(uid, earlier, later);
  };

  const row = (uid: string) => {
    const ev = events[uid];
    const b = bounds.entries.get(uid)!;
    const i = chrono.get(uid);
    const bar = ev.chapter ? layout.bars.find(x => x.uid === uid) : undefined;
    const cover = Object.keys(ev.links ?? {})[0];
    const peer = p.peerEditing[uid];
    const dragging = drag?.uid === uid;
    const movable = canEdit && arranging && isMovable(ev);
    let supporting: string;
    if (ev.chapter) {
      const n = bar ? memoriesIn(bar, ordered, events) : 0;
      supporting = [chapterDates(ev, birth), bar ? `${n} ${n === 1 ? 'memory' : 'memories'}` : '', ev.location]
        .filter(Boolean).join(' · ');
    } else {
      const date = ev.when || !b.placed ? formatFuzzy(ev.when, birth) : `≈ ${formatDayRange(b.start.lo, b.start.hi)}`;
      const until = ev.until ? ` – ${formatFuzzy(ev.until, birth)}` : '';
      supporting = [date + until, ev.location].filter(Boolean).join(' · ');
    }
    const icon = ev.chapter ? CHAPTER_KIND_META[ev.chapter].icon : ev.until ? 'date_range' : 'event';
    return withRails(i === undefined ? [] : rowCells(i), (
      <ListRow
        data-entry-row=""
        data-uid={uid}
        data-testid={ev.chapter ? 'timeline-chapter-row' : 'timeline-row'}
        data-chapter-kind={ev.chapter}
        onTap={() => p.onOpen(uid)}
        style={{
          opacity: peer ? 0.5 : 1,
          ...(dragging ? { transform: `translateY(${drag!.dy}px)`, zIndex: 5, position: 'relative' } : {}),
        }}
        end={
          <span className="flex items-center gap-1">
            <PresenceDot peer={peer} />
            {b.conflicts.length > 0 && <span className="material-symbols-outlined text-error text-lg" title="Conflicting answers">error</span>}
            {ev.revisit !== undefined && <span className="material-symbols-outlined text-lg" title="Revisit later">flag</span>}
            {movable && (
              <DragHandle
                title={ev.title}
                testId={`drag-${uid}`}
                onStart={y => startDrag(uid, y)}
                onMove={moveDrag}
                onEnd={endDrag}
                onCancel={() => { dragRef.current = null; setDrag(null); }}
                onKey={key => keyMove(uid, key)}
              />
            )}
          </span>
        }
      >
        <span slot="start" className="flex items-center">
          {cover && !ev.chapter
            ? <Thumb docId={p.docId} photoId={cover} />
            : <span aria-hidden="true" className="material-symbols-outlined text-lg"
              style={bar ? { color: chapterColor(bar.colorIndex) } : undefined}>{icon}</span>}
        </span>
        <div slot="headline" className={ev.chapter ? 'font-semibold' : undefined}>{ev.title || 'Untitled'}</div>
        <div slot="supporting-text">{supporting}</div>
      </ListRow>
    ), uid, { role: 'listitem' });
  };

  /** `below`: the chronological index of the row just below (older); -1 at the very bottom. */
  const insertTarget = (earlier: string | null, later: string | null, key: string, below: number) =>
    canEdit && arranging ? withRails(betweenCells(below), (
      <button
        type="button"
        data-testid="timeline-insert"
        className="w-full flex items-center gap-2 px-4 h-8 text-sm text-primary state-layer rounded-full"
        onClick={() => p.onInsert(earlier, later)}
      >
        <span aria-hidden="true" className="material-symbols-outlined text-base">add</span>
        Insert {earlier && later ? 'here' : earlier ? 'later' : 'earlier'}
      </button>
    ), key) : null;

  const gapRow = (lo: number, hi: number, key: string, below: number) => {
    const ageLo = ageAt(birth, lo);
    const ageHi = ageAt(birth, hi);
    const ages = ageLo !== null && ageHi !== null && ageLo >= 0 ? ` (age ${ageLo}–${ageHi})` : '';
    return withRails(betweenCells(below), (
      <button
        type="button"
        data-testid="timeline-gap"
        disabled={!canEdit}
        className="w-full text-left px-4 py-2 my-1 rounded-xl border border-dashed text-sm text-muted-foreground state-layer"
        onClick={() => p.onGap(lo, hi)}
      >
        Nothing from {lo === hi ? lo : `${lo}–${hi}`} yet{ages}{canEdit ? ' — add a memory' : ''}
      </button>
    ), key);
  };

  /** A year's sticky header: the year, your age, and the chapters under way that year. */
  const yearHeader = (year: number, below: number) => {
    const age = ageAt(birth, year);
    const lo = dayOf(String(year))!;
    const bars = chaptersDuring(spans, lo, dayOf(String(year + 1))! - 1).map(c => barOf.get(c.uid)).filter((b): b is ChapterBar => !!b);
    const shownChips = bars.slice(0, 3);
    return (
      <h3 className="sticky top-0 z-10 bg-page flex items-stretch">
        <Rails lanes={layout.laneCount} cells={betweenCells(below)} onOpen={p.onOpen} />
        <span className="flex-1 min-w-0 flex items-center gap-2 pt-3 pb-1 text-xs text-muted-foreground">
          <span className="font-semibold uppercase shrink-0">{year}{age !== null && age >= 0 ? ` · age ${age}` : ''}</span>
          {shownChips.map(b => (
            <span key={b.uid} data-testid="year-chapter" data-chapter={b.uid}
              className="flex items-center gap-1 min-w-0 max-w-[10rem]">
              <span aria-hidden="true" className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: chapterColor(b.colorIndex) }} />
              <span className="truncate">{titleOf(b)}</span>
            </span>
          ))}
          {bars.length > shownChips.length && <span className="shrink-0">+{bars.length - shownChips.length}</span>}
        </span>
      </h3>
    );
  };

  // Rows grouped under years, with gap rows for runs of empty years.
  const out: ComponentChildren[] = [];
  let lastYear: number | null = null;
  let groupTop = -1;
  let group: ComponentChildren[] = [];
  const flush = () => {
    if (lastYear === null) return;
    out.push(
      <section key={`y${lastYear}`} data-testid="timeline-year" data-year={lastYear}>
        {yearHeader(lastYear, groupTop)}
        <div role="list">{group}</div>
      </section>,
    );
    group = [];
  };
  shown.forEach((uid, i) => {
    const y = yearOf(uid);
    const k = chrono.get(uid)!;
    if (lastYear !== null && y !== lastYear) {
      flush();
      if (lastYear - y > 2) out.push(gapRow(y + 1, lastYear - 1, `g${lastYear}`, k));
    }
    if (lastYear === null || y !== lastYear) { lastYear = y; groupTop = k; }
    if (i === 0) group.push(insertTarget(uid, null, 'ins-first', k));
    group.push(row(uid));
    group.push(insertTarget(shown[i + 1] ?? null, uid, `ins-${uid}`, k - 1));
  });
  flush();

  return (
    <div ref={listRef} data-testid="timeline-list">
      {ordered.length === 0 && undated.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">
          Nothing here yet. Add a memory — however vague the date — and the timeline will fill in around it.
        </p>
      )}
      {undated.length > 0 && (
        <section data-testid="timeline-undated">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground pt-3 pb-1">Undated</h3>
          <div role="list">{undated.map(row)}</div>
        </section>
      )}
      {ordered.length === 0 && undated.length > 0 && insertTarget(null, null, 'ins-empty', -1)}
      {out}
      {drag && <div className="sr-only" aria-live="polite">Dropping at position {drag.index + 1}</div>}
    </div>
  );
}

/**
 * The drag handle. Listeners are attached with addEventListener rather than
 * onPointerDown props: Preact maps an `on*` prop to a lowercase event only when
 * the element has that IDL property, which jsdom lacks for pointer events — the
 * prop form would bind `PointerDown` there and never fire in tests. Pointer
 * capture keeps the moves coming while the finger is off the handle.
 */
function DragHandle({ title, testId, onStart, onMove, onEnd, onCancel, onKey }: {
  title: string;
  testId: string;
  onStart: (clientY: number) => void;
  onMove: (clientY: number) => void;
  onEnd: (clientY: number) => void;
  onCancel: () => void;
  onKey: (key: 'ArrowUp' | 'ArrowDown') => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const cb = useRef({ onStart, onMove, onEnd, onCancel, onKey });
  cb.current = { onStart, onMove, onEnd, onCancel, onKey };
  useEffect(() => {
    const el = ref.current!;
    let active = false;
    const down = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture?.(e.pointerId); } catch { /* not capturable (synthetic) */ }
      active = true;
      cb.current.onStart(e.clientY);
    };
    const move = (e: PointerEvent) => { if (active) cb.current.onMove(e.clientY); };
    const up = (e: PointerEvent) => { if (!active) return; active = false; cb.current.onEnd(e.clientY); };
    const cancel = () => { active = false; cb.current.onCancel(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();
      cb.current.onKey(e.key);
    };
    const click = (e: Event) => e.stopPropagation();
    el.addEventListener('pointerdown', down as EventListener);
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up as EventListener);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('keydown', key as EventListener);
    el.addEventListener('click', click);
    return () => {
      el.removeEventListener('pointerdown', down as EventListener);
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up as EventListener);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('keydown', key as EventListener);
      el.removeEventListener('click', click);
    };
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className="material-symbols-outlined h-10 w-10 rounded-full state-layer touch-none cursor-grab"
      aria-label={`Move ${title}`}
      title="Drag, or use ↑ ↓"
      data-testid={testId}
    >drag_indicator</button>
  );
}
