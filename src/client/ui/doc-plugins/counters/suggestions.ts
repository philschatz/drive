import { counterKind, currentStatus, isArchived, type CounterKind, type CounterStatus } from './occurrences';
import type { CounterEvent } from '../../../../shared/schemas/counters';

/** A match for the New-Counter title being typed — see {@link matchCounters}. */
export interface CounterMatch {
  uid: string;
  /** Stored title, original casing. */
  title: string;
  kind: CounterKind;
  archived: boolean;
  /** Live status; absent for archived items, which have no meaningful one. */
  status?: CounterStatus;
  /** status 'done' only: when the habit comes due again ("Done — back in …"). */
  dueAt?: string;
  /** Same title as the query (trimmed, case-insensitive) — the dedupe target. */
  exact: boolean;
}

export const SUGGESTION_CAP = 5;

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Ranked case-insensitive matches of `query` against the items' titles: the
 * suggestion list under the New-Counter title field, and — via `exact` — the
 * duplicate a save is redirected to instead of creating a twin.
 *
 * Rank tiers: exact match, then prefix, then substring; within a tier active
 * items beat archived ones, then shorter titles, then title, then uid. The
 * exact tier ranking first is a load-bearing invariant — it means an exact
 * match always survives the cap, which the save interception relies on — and
 * active-beats-archived means an archived twin is never unarchived while an
 * active item of the same name exists.
 */
export function matchCounters(
  events: Record<string, CounterEvent>,
  query: string,
  now: string,
  excludeUid?: string,
  limit = SUGGESTION_CAP,
): CounterMatch[] {
  const q = norm(query);
  if (!q) return [];

  const ranked: { uid: string; ev: CounterEvent; title: string; archived: boolean; tier: number }[] = [];
  for (const [uid, ev] of Object.entries(events)) {
    if (uid === excludeUid) continue;
    const title = ev.title || '';
    const t = norm(title);
    if (!t) continue;
    const tier = t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : -1;
    if (tier < 0) continue;
    ranked.push({ uid, ev, title, archived: isArchived(ev), tier });
  }

  ranked.sort((a, b) =>
    a.tier - b.tier
    || Number(a.archived) - Number(b.archived)
    || a.title.length - b.title.length
    || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
    || (a.uid < b.uid ? -1 : 1));

  // Cap first, compute status after: the status is the expensive part (an
  // occurrence expansion per item) and only surviving rows render one.
  return ranked.slice(0, limit).map(({ uid, ev, title, archived, tier }) => {
    const st = archived ? undefined : currentStatus(ev, now);
    return {
      uid,
      title,
      kind: counterKind(ev),
      archived,
      status: st?.status,
      dueAt: st?.status === 'done' ? st.dueAt : undefined,
      exact: tier === 0,
    };
  });
}
