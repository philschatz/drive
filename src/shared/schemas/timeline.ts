/**
 * Timeline: a life diary built retroactively. Entries are JSCalendar Events —
 * a calendar viewer can render a Timeline — extended with fuzzy dates, order
 * relations ("this happened before that") and a revisit note. Prompts (from
 * a photo library or from the app's own gap cards) are deliberately NOT Events, so
 * calendar viewers never see them.
 *
 * Validation reuses the Calendar's: entries are checked by the Calendar's own
 * field nodes (`calendarEventFields`) and its dependency checker, and only the
 * extensions are checked here.
 */
import {
  type ValidationError, type DocSchemaPlugin, type Link, type Duration, type LocalDateTime, type Participant,
  str, num, bool, obj, record, union, linkSchema, participantSchema,
} from './core';
import { calendarEventFields, checkCalendarDependencies } from './calendar';
import {
  type FuzzyDate, type PartialDate, PARTIAL_DATE_RE, parsePartial, boundsOf, dayOf,
} from '../timeline/fuzzy-date';
import { EMOTION_KEY_RE } from '../timeline/emotions';

export type { FuzzyDate, PartialDate } from '../timeline/fuzzy-date';

export const TIMELINE_TYPE = 'Calendar+Timeline';

/** How THIS entry relates to another. "near" = about the same time. */
export type Rel = 'before' | 'after' | 'during' | 'near' | 'unsure';
export const REL_VALUES: readonly Rel[] = ['before', 'after', 'during', 'near', 'unsure'];

/**
 * What kind of stretch of life a chapter is. Place: where I lived. People: who
 * I was with. Pursuit: what my days went into (a school, a job, a team).
 * Phase: a stage or circumstance (new parent, the pandemic).
 */
export type ChapterKind = 'place' | 'people' | 'pursuit' | 'phase' | 'other';
export const CHAPTER_KINDS: readonly ChapterKind[] = ['place', 'people', 'pursuit', 'phase', 'other'];

export interface TimelineEvent {
  '@type': 'Event';
  title: string;
  /** The story. */
  description?: string;
  /** DERIVED from `when` (calendarFields): an all-day date for calendar viewers. */
  start?: LocalDateTime;
  /** DERIVED from `when`/`until`. */
  duration?: Duration;
  /** Place name. */
  location?: string;
  /** Photos: key = the photo's id in its library; display 'thumbnail'. Thumbnail bytes live in doc.thumbs. */
  links?: Record<string, Link>;
  /** Who was there (JSCalendar), e.g. carried over from a photo prompt. */
  participants?: Record<string, Participant>;
  // ── extensions ──
  /** When it happened or began. The source of truth for `start`. */
  when?: FuzzyDate;
  /**
   * Present ⇒ a period, ending at `until`. For a chapter, ABSENT means it is
   * still going (it ends today) and `{}` means it ended, date unknown.
   */
  until?: FuzzyDate;
  /**
   * Present ⇒ this entry is a chapter: a stretch of life that frames memories
   * (where I lived, who I was with). Always a period. Its colour is not stored:
   * chapters take the palette in turn, in start order.
   */
  chapter?: ChapterKind;
  /** RFC 8984 Location coordinates form: 'geo:<lat>,<lng>'. */
  coordinates?: string;
  recall?: 'vivid' | 'hazy';
  /**
   * How it felt: emotion key → true, any number of them. A key is a lowercase
   * ':'-separated path — `sad`, `self-evaluative:imposter`,
   * `temporal:nostalgic:for-college` (timeline/emotions.ts).
   */
  emotions?: Record<string, true>;
  /**
   * Present = come back to this entry; the value says what for ("ask Mom who
   * was there"), '' when there is nothing more to say. One field so the flag
   * and its note can never disagree.
   */
  revisit?: string;
  /** The date is as good as it will get: leave the pin-down queue. */
  settled?: true;
  /** This entry's START relative to entry <key>. */
  rel?: Record<string, Rel>;
  /** This period's END relative to entry <key>. */
  untilRel?: Record<string, Rel>;
}

export interface TimelinePrompt {
  /** 'photos': a moment from the photo library; 'gap': an in-app gap card that was answered or dismissed. */
  source: 'photos' | 'gap';
  when?: FuzzyDate;
  until?: FuzzyDate;
  location?: string;
  coordinates?: string;
  links?: Record<string, Link>;
  /** Key into links/thumbs of the photo to show. */
  cover?: string;
  /** Photos in the moment, including ones not linked. */
  count?: number;
  /**
   * Who is in the moment's photos (JSCalendar participants, keyed by the photo
   * library's id for the person). Writing the prompt up copies them to the entry.
   */
  participants?: Record<string, Participant>;
  /** UTC stamp of the feeder pass (or the in-app answer) that wrote it. */
  added: string;
  /** Answered: the entry it became. */
  entry?: string;
  dismissed?: true;
  /** A chapter-gap card ("where were you living then?"): the kind it asked about. */
  chapter?: ChapterKind;
}

export interface TimelineDocument {
  '@type': typeof TIMELINE_TYPE;
  name: string;
  /** Your birth date — anchors ages, gaps, and "before or after you turned 12?". */
  birth?: PartialDate;
  events: Record<string, TimelineEvent>;
  prompts: Record<string, TimelinePrompt>;
  /** key = the photo's id in its library; base64 JPEG, stored as an Automerge ImmutableString
   * (which reads back as `{ val }` once cloned across a thread). */
  thumbs: Record<string, string | { val: string }>;
}

/** A thumbnail's byte cap, in base64 characters (~16 KB of JPEG). */
export const MAX_THUMB_CHARS = 22_000;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const GEO_RE = /^geo:-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

const partial = (optional = true) => str({ pattern: PARTIAL_DATE_RE, optional });
export const fuzzyDateSchema = obj({ earliest: partial(), latest: partial(), best: partial() }, { optional: true });
const relMap = record(str({ enum: REL_VALUES }), { optional: true });

export const timelineEventSchema = obj({
  ...calendarEventFields,
  title: str(),
  when: fuzzyDateSchema,
  until: fuzzyDateSchema,
  coordinates: str({ pattern: GEO_RE, optional: true }),
  recall: str({ enum: ['vivid', 'hazy'], optional: true }),
  emotions: record(bool({ literal: true }), { optional: true }),
  revisit: str({ optional: true }),
  settled: bool({ literal: true, optional: true }),
  rel: relMap,
  untilRel: relMap,
  chapter: str({ enum: CHAPTER_KINDS, optional: true }),
});

export const timelinePromptSchema = obj({
  source: str({ enum: ['photos', 'gap'] }),
  when: fuzzyDateSchema,
  until: fuzzyDateSchema,
  location: str({ optional: true }),
  coordinates: str({ pattern: GEO_RE, optional: true }),
  links: record(linkSchema, { optional: true }),
  cover: str({ optional: true }),
  count: num({ min: 0, integer: true, optional: true }),
  participants: record(participantSchema, { optional: true }),
  added: str(),
  entry: str({ optional: true }),
  dismissed: bool({ literal: true, optional: true }),
  chapter: str({ enum: CHAPTER_KINDS, optional: true }),
});

export const timelineDocumentSchema = obj({
  '@type': str({ enum: [TIMELINE_TYPE] }),
  name: str(),
  birth: partial(),
  events: record(timelineEventSchema),
  prompts: record(timelinePromptSchema),
  thumbs: record(union([str(), obj({ val: str() })])),
});

/** A thumbnail's base64, whichever form it arrived in. */
export function thumbBase64(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as any).val === 'string') return (v as any).val;
  return null;
}

function checkFuzzy(fd: any, p: (string | number)[], errors: ValidationError[]): void {
  if (!fd || typeof fd !== 'object') return;
  for (const k of ['earliest', 'latest', 'best'] as const) {
    if (typeof fd[k] === 'string' && PARTIAL_DATE_RE.test(fd[k]) && !parsePartial(fd[k])) {
      errors.push({ path: [...p, k], message: `"${fd[k]}" is not a real date`, kind: 'dependency' });
    }
  }
  const { lo, hi } = boundsOf(fd);
  if (lo !== undefined && hi !== undefined && lo > hi) {
    errors.push({ path: p, message: 'earliest is after latest', kind: 'dependency' });
  }
  const b = typeof fd.best === 'string' ? parsePartial(fd.best) : null;
  if (b) {
    const bLo = dayOf(fd.best)!;
    const bHi = bLo + b.last.since(b.first, { largestUnit: 'days' }).days;
    if ((lo !== undefined && bHi < lo) || (hi !== undefined && bLo > hi)) {
      errors.push({ path: [...p, 'best'], message: 'best guess lies outside earliest..latest', kind: 'dependency' });
    }
  }
}

function checkPromptLinks(links: any, p: (string | number)[], errors: ValidationError[]): void {
  if (!links || typeof links !== 'object') return;
  for (const [id, l] of Object.entries(links)) {
    const href = (l as any)?.href;
    if (typeof href === 'string' && !/^https?:\/\//i.test(href)) {
      errors.push({ path: [...p, id, 'href'], message: 'a photo link must be http(s)', kind: 'dependency' });
    }
  }
}

/**
 * The Timeline's own rules, on top of the Calendar's. Dangling references (a
 * relation, prompt or cover naming something since deleted) are deliberately
 * NOT errors: concurrent deletes produce them routinely, and every reader
 * ignores them.
 */
export function checkTimelineDependencies(doc: any, errors: ValidationError[]): void {
  checkFuzzy(doc.birth ? { earliest: doc.birth, latest: doc.birth } : null, ['birth'], errors);
  const events = doc.events && typeof doc.events === 'object' ? doc.events : {};
  for (const [uid, ev] of Object.entries<any>(events)) {
    const p = ['events', uid];
    if (!ev || typeof ev !== 'object') continue;
    if (ev.title === '') errors.push({ path: [...p, 'title'], message: 'title must not be empty', kind: 'dependency' });
    checkFuzzy(ev.when, [...p, 'when'], errors);
    checkFuzzy(ev.until, [...p, 'until'], errors);
    const w = boundsOf(ev.when);
    const u = boundsOf(ev.until);
    if (w.lo !== undefined && u.hi !== undefined && u.hi < w.lo) {
      errors.push({ path: [...p, 'until'], message: 'the period ends before it begins', kind: 'dependency' });
    }
    if (typeof ev.start === 'string') {
      const s = dayOf(ev.start.substring(0, 10));
      if (s !== null && ((w.lo !== undefined && s < w.lo) || (w.hi !== undefined && s > w.hi))) {
        errors.push({ path: [...p, 'start'], message: 'start lies outside the entry\'s date range (when)', kind: 'dependency' });
      }
    }
    if (ev.emotions && typeof ev.emotions === 'object') {
      for (const key of Object.keys(ev.emotions)) {
        if (!EMOTION_KEY_RE.test(key)) {
          errors.push({ path: [...p, 'emotions', key], message: 'an emotion is lowercase words joined by "-", in up to three ":"-separated parts', kind: 'dependency' });
        }
      }
    }
    for (const field of ['rel', 'untilRel'] as const) {
      if (ev[field] && typeof ev[field] === 'object' && uid in ev[field]) {
        errors.push({ path: [...p, field, uid], message: 'an entry cannot be related to itself', kind: 'dependency' });
      }
    }
  }

  const prompts = doc.prompts && typeof doc.prompts === 'object' ? doc.prompts : {};
  for (const [key, pr] of Object.entries<any>(prompts)) {
    if (!pr || typeof pr !== 'object') continue;
    checkFuzzy(pr.when, ['prompts', key, 'when'], errors);
    checkFuzzy(pr.until, ['prompts', key, 'until'], errors);
    checkPromptLinks(pr.links, ['prompts', key, 'links'], errors);
  }

  const thumbs = doc.thumbs && typeof doc.thumbs === 'object' ? doc.thumbs : {};
  for (const [key, v] of Object.entries(thumbs)) {
    const b64 = thumbBase64(v);
    if (b64 === null) continue; // the schema reports the type
    if (b64.length > MAX_THUMB_CHARS) {
      errors.push({ path: ['thumbs', key], message: `thumbnail is larger than ${MAX_THUMB_CHARS} base64 characters`, kind: 'dependency' });
    } else if (!BASE64_RE.test(b64)) {
      errors.push({ path: ['thumbs', key], message: 'thumbnail is not base64', kind: 'dependency' });
    }
  }
}

/** Worker-safe plugin core — registered in src/shared/schemas (validation) and
 * spread into the full plugin (src/client/ui/doc-plugins/timeline/plugin.tsx). */
export const timelineSchemaPlugin: DocSchemaPlugin = {
  type: TIMELINE_TYPE,
  schema: timelineDocumentSchema,
  checkDeps: (doc, errors) => {
    checkCalendarDependencies(doc, errors);
    checkTimelineDependencies(doc, errors);
  },
};

export function createTimelineDoc(name: string): TimelineDocument {
  return { '@type': TIMELINE_TYPE, name, events: {}, prompts: {}, thumbs: {} };
}
