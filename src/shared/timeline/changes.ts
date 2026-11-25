/**
 * Every change to a Timeline document, as a standalone function.
 *
 * The UI sends these to the worker through `updateDoc(docId, fn, ...args)`,
 * which ships `fn.toString()` and rebuilds it with `new Function` — so each
 * function here must be SELF-CONTAINED: no closures, no imports, no calls to
 * each other, no Temporal. Anything computed (calendar fields, placements,
 * stamps) is computed by the caller and passed in as plain data. The CLI
 * feeder calls them in-process the same way. changes.test.ts rebuilds every
 * one of them from its source text and runs it on real Automerge, which the
 * jsdom mock of updateDoc cannot do.
 *
 * Automerge rules that apply inside: never store `undefined` (omit or delete
 * the key), and never assign an object read from the document to another
 * place in it (copy plain data instead).
 */
import type { TimelineEvent, TimelinePrompt, Rel } from '../schemas/timeline';
import type { FuzzyDate } from './fuzzy-date';
import type { RelRef } from './planner';

export interface CalendarFields { start?: string; duration?: string }

/** Add a whole entry in one change (the caller has computed start/duration). */
export function addEntry(d: any, uid: string, entry: TimelineEvent): void {
  const e: any = {};
  for (const k of Object.keys(entry)) if ((entry as any)[k] !== undefined) e[k] = (entry as any)[k];
  d.events[uid] = e;
}

/** Set or clear simple fields: a value of `null` deletes the key. */
export function patchEntry(d: any, uid: string, patch: Record<string, unknown>): void {
  const ev = d.events[uid];
  if (!ev) return;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null || v === undefined) { if (k in ev) delete ev[k]; } else if (ev[k] !== v) ev[k] = v;
  }
}

/** Take one person off an entry (a wrong face match, or nobody worth keeping). */
export function removeParticipant(d: any, uid: string, participantId: string): void {
  const ev = d.events[uid];
  if (!ev || !ev.participants || !(participantId in ev.participants)) return;
  delete ev.participants[participantId];
  if (Object.keys(ev.participants).length === 0) delete ev.participants;
}

/** Replace `when` or `until` wholesale (null clears it) and the calendar fields derived from it. */
export function setWhen(
  d: any, uid: string, field: 'when' | 'until', value: FuzzyDate | null, cal: CalendarFields,
): void {
  const ev = d.events[uid];
  if (!ev) return;
  if (value) {
    const fd: any = {};
    for (const k of ['earliest', 'latest', 'best']) if ((value as any)[k]) fd[k] = (value as any)[k];
    ev[field] = fd;
  } else if (field in ev) {
    delete ev[field];
  }
  for (const k of ['start', 'duration']) {
    const v = (cal as any)[k];
    if (v) { if (ev[k] !== v) ev[k] = v; } else if (k in ev) delete ev[k];
  }
}

/** Record how one entry relates to another (a pin-down answer). */
export function answerRelation(d: any, uid: string, field: 'rel' | 'untilRel', target: string, rel: Rel): void {
  const ev = d.events[uid];
  if (!ev || !d.events[target] || uid === target) return;
  if (!ev[field]) ev[field] = {};
  ev[field][target] = rel;
}

export function removeRelation(d: any, owner: string, field: 'rel' | 'untilRel', target: string): void {
  const m = d.events[owner]?.[field];
  if (m && target in m) delete m[target];
}

/** Make an entry a chapter of the given kind, or (null) a plain entry again. */
export function setChapter(d: any, uid: string, kind: string | null): void {
  const ev = d.events[uid];
  if (!ev) return;
  if (kind) { if (ev.chapter !== kind) ev.chapter = kind; } else if ('chapter' in ev) delete ev.chapter;
}

/**
 * The "During" pane's Save: the chapters this memory happened during. Adds
 * `rel[c] = 'during'` for each of `add`, and removes the relation to each of
 * `remove` only while it still says "during" (not some other answer).
 */
export function setDuring(d: any, uid: string, add: string[], remove: string[]): void {
  const ev = d.events[uid];
  if (!ev) return;
  for (const c of remove) {
    if (ev.rel && ev.rel[c] === 'during') delete ev.rel[c];
  }
  for (const c of add) {
    if (c === uid || !d.events[c]) continue;
    if (!ev.rel) ev.rel = {};
    if (ev.rel[c] !== 'during') ev.rel[c] = 'during';
  }
}

/**
 * A drop or keyboard move: the planner's placement (relations to drop and to
 * add, the new best guess) and the calendar fields that follow from it.
 */
export function applyPlacement(
  d: any, uid: string, remove: RelRef[], add: (RelRef & { rel: Rel })[], when: FuzzyDate, cal: CalendarFields,
): void {
  const ev = d.events[uid];
  if (!ev) return;
  for (const r of remove) {
    const m = d.events[r.owner]?.[r.field];
    if (m && r.target in m) delete m[r.target];
  }
  for (const r of add) {
    const o = d.events[r.owner];
    if (!o || !d.events[r.target]) continue;
    if (!o[r.field]) o[r.field] = {};
    o[r.field][r.target] = r.rel;
  }
  const fd: any = {};
  for (const k of ['earliest', 'latest', 'best']) if ((when as any)[k]) fd[k] = (when as any)[k];
  ev.when = fd;
  for (const k of ['start', 'duration']) {
    const v = (cal as any)[k];
    if (v) { if (ev[k] !== v) ev[k] = v; } else if (k in ev) delete ev[k];
  }
}

/**
 * Delete an entry, the relations pointing at it, and reopen any prompt that
 * had become it (so its photos can be written up again).
 */
export function deleteEntry(d: any, uid: string): void {
  if (!d.events[uid]) return;
  delete d.events[uid];
  for (const other of Object.keys(d.events)) {
    for (const field of ['rel', 'untilRel']) {
      const m = d.events[other][field];
      if (m && uid in m) delete m[uid];
    }
  }
  for (const key of Object.keys(d.prompts ?? {})) {
    if (d.prompts[key].entry === uid) delete d.prompts[key].entry;
  }
}

/** Write a prompt up as an entry: the entry and the prompt's "answered" mark in one change. */
export function answerPrompt(d: any, promptKey: string, uid: string, entry: TimelineEvent): void {
  const p = d.prompts?.[promptKey];
  if (!p || d.events[uid]) return;
  const e: any = {};
  for (const k of Object.keys(entry)) if ((entry as any)[k] !== undefined) e[k] = (entry as any)[k];
  d.events[uid] = e;
  p.entry = uid;
  if (p.dismissed) delete p.dismissed;
}

/**
 * Skip a prompt for good. Its thumbnails go (unless an entry shows them):
 * nothing will display them again, and they are the bulk of its bytes.
 */
export function dismissPrompt(d: any, promptKey: string): void {
  const p = d.prompts?.[promptKey];
  if (!p || p.entry) return;
  p.dismissed = true;
  const keys: string[] = Object.keys(p.links ?? {});
  if (p.cover && keys.indexOf(p.cover) < 0) keys.push(p.cover);
  for (const k of keys) {
    if (!d.thumbs || !(k in d.thumbs)) continue;
    let used = false;
    for (const uid of Object.keys(d.events)) if (d.events[uid].links && k in d.events[uid].links) { used = true; break; }
    if (!used) delete d.thumbs[k];
  }
}

/** Record an in-app gap card's outcome (answered or "nothing comes to mind"). */
export function recordGap(d: any, key: string, prompt: TimelinePrompt): void {
  if (!d.prompts) d.prompts = {};
  if (d.prompts[key]) return;
  const p: any = {};
  for (const k of Object.keys(prompt)) if ((prompt as any)[k] !== undefined) p[k] = (prompt as any)[k];
  d.prompts[key] = p;
}

/** A gap card that became an entry: the entry and its gap record in one change. */
export function answerGap(d: any, key: string, prompt: TimelinePrompt, uid: string, entry: TimelineEvent): void {
  if (!d.prompts) d.prompts = {};
  if (d.prompts[key] || d.events[uid]) return;
  const e: any = {};
  for (const k of Object.keys(entry)) if ((entry as any)[k] !== undefined) e[k] = (entry as any)[k];
  d.events[uid] = e;
  const p: any = {};
  for (const k of Object.keys(prompt)) if ((prompt as any)[k] !== undefined) p[k] = (prompt as any)[k];
  p.entry = uid;
  d.prompts[key] = p;
}

export function setBirth(d: any, birth: string | null): void {
  if (birth) d.birth = birth; else if ('birth' in d) delete d.birth;
}

export function rename(d: any, name: string): void {
  d.name = name;
}

/**
 * The feeder's one change per pass: new prompts and their thumbnails. Never
 * overwrites an existing prompt or thumbnail (another device may have
 * answered it meanwhile), and refuses any document that is not a Timeline.
 * `wrap` turns base64 into an Automerge ImmutableString (see engine changeDoc).
 */
export function addPrompts(
  d: any,
  payload: { prompts: Record<string, TimelinePrompt>; thumbs: Record<string, string> },
  wrap: (s: string) => unknown,
): number {
  if (d['@type'] !== 'Calendar+Timeline') return 0;
  if (!d.prompts) d.prompts = {};
  if (!d.thumbs) d.thumbs = {};
  let added = 0;
  for (const key of Object.keys(payload.prompts)) {
    if (key in d.prompts) continue;
    const src: any = payload.prompts[key];
    const p: any = {};
    for (const k of Object.keys(src)) if (src[k] !== undefined) p[k] = src[k];
    d.prompts[key] = p;
    added++;
  }
  for (const key of Object.keys(payload.thumbs)) {
    if (!(key in d.thumbs)) d.thumbs[key] = wrap(payload.thumbs[key]);
  }
  return added;
}
