/**
 * History mode for the calendar, the pure part: which occurrences get which
 * diff class, which are ghosts of removed events, and where to move the view.
 * Kept apart from schedule-x.ts so it is testable without the schedule-x
 * bundle (ESM, untransformed under Jest).
 */
import type { CalendarEvent } from '../../../../shared/schemas/calendar';
import type { ChangeKind } from '../../../../shared/version-changes';

export interface EventHighlight {
  /** Per uid, what the version on screen did to the event. */
  diff: Map<string, ChangeKind>;
  /** The events it removed, with their old value — rendered as ghosts. */
  removed: Array<{ id: string; before: CalendarEvent }>;
  ghosts: ReadonlySet<string>;
}

/** schedule-x `additionalClasses` and the ghost flag for one occurrence of `uid`. */
export function eventHighlight(
  uid: string,
  h: Pick<EventHighlight, 'diff' | 'ghosts'> | undefined,
): { classes: string[] | null; ghost: boolean } {
  if (!h) return { classes: null, ghost: false };
  const kind = h.diff.get(uid);
  return { classes: kind ? [`diff-${kind}`] : null, ghost: h.ghosts.has(uid) };
}

/** The day (YYYY-MM-DD) of the earliest-starting highlighted event, or null. */
export function firstHighlightedDate(events: Record<string, CalendarEvent>, diff: Map<string, ChangeKind>): string | null {
  let best: string | null = null;
  for (const uid of diff.keys()) {
    const start = events[uid]?.start;
    if (!start) continue;
    const day = start.substring(0, 10);
    if (best === null || day < best) best = day;
  }
  return best;
}
