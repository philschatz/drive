/**
 * Readable ids for a Timeline's entries (and for prompts written from outside
 * the app): the date, the place, and who was there, then a short suffix —
 *
 *   2014-06-12-galveston-ana-ben-x7k2
 *   2010-portland-moved-to-portland-q3fd   (no people: a few words of the title)
 *   undated-a-dog-called-max-8kd1          (no date yet)
 *
 * so an id in the raw document says what it is. An id is made once, when the
 * entry is created, from what is known then; editing the entry later does not
 * rename it (relations and prompts point at it by id).
 *
 * Self-contained apart from types: changes.ts functions may be rebuilt from
 * source in the worker, but nothing there calls these.
 */
import type { FuzzyDate } from './fuzzy-date';

export interface IdParts {
  when?: FuzzyDate;
  location?: string;
  /** People's names, most important first; their first names are used. */
  people?: string[];
  /** Used when there is neither a place nor people. */
  title?: string;
}

/** An id made by readableId: it starts with a (partial) date or "undated". */
export const READABLE_ID_RE = /^(\d{4}(-\d{2}){0,2}|undated)-[a-z0-9-]*[a-z0-9]$/;

const FOLD: Record<string, string> = { æ: 'ae', ø: 'o', ð: 'd', þ: 'th', ß: 'ss', ł: 'l', đ: 'd', œ: 'oe', ı: 'i' };

/** Lowercase ASCII words joined by '-', at most `maxWords` of them. */
export function slug(s: string | undefined, maxWords = 4): string {
  if (!s) return '';
  const ascii = s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[æøðþßłđœı]/g, c => FOLD[c] ?? '');
  return ascii.split(/[^a-z0-9]+/).filter(Boolean).slice(0, maxWords).join('-');
}

/** The date part: the best guess, else the earliest, else the latest; "undated" without one. */
export function idDate(when: FuzzyDate | undefined): string {
  const d = when?.best ?? when?.earliest ?? when?.latest;
  return d && /^\d{4}(-\d{2}){0,2}$/.test(d) ? d : 'undated';
}

/** `<date>-<place>-<up to 3 first names>-<suffix>`, or the title in place of place and people. */
export function readableId(parts: IdParts, suffix: string): string {
  const place = slug(parts.location?.split(',')[0], 3);
  const people = (parts.people ?? []).map(n => slug(n, 1)).filter(Boolean);
  const who = [...new Set(people)].slice(0, 3).join('-');
  const what = place || who ? [place, who] : [slug(parts.title, 4)];
  const body = [idDate(parts.when), ...what].filter(Boolean).join('-').slice(0, 60).replace(/-+$/, '');
  return `${body}-${slug(suffix, 1) || '0'}`;
}

/** A short base-36 suffix. */
export function randomSuffix(random: () => number = Math.random, length = 4): string {
  let s = '';
  for (let i = 0; i < length; i++) s += Math.floor(random() * 36).toString(36);
  return s;
}

/**
 * A new entry's id: readable, and not one `taken` already. Collisions (same
 * date, place, people and suffix) are rerolled.
 */
export function newEntryId(
  entry: { when?: FuzzyDate; location?: string; title?: string; participants?: Record<string, { name?: string }> },
  taken: (id: string) => boolean,
  random: () => number = Math.random,
): string {
  const parts: IdParts = {
    when: entry.when,
    location: entry.location,
    people: Object.values(entry.participants ?? {}).map(p => p.name ?? '').filter(Boolean),
    title: entry.title,
  };
  for (let i = 0; i < 20; i++) {
    const id = readableId(parts, randomSuffix(random, i < 10 ? 4 : 6));
    if (!taken(id)) return id;
  }
  return readableId(parts, randomSuffix(random, 10));
}
