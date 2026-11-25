/**
 * How an entry felt: any number of emotions, from broad to nuanced, stored as
 * `TimelineEvent.emotions` — a map of emotion key → true (a map, not an array,
 * so concurrent edits merge).
 *
 * A key is a lowercase path, its segments separated by ':' (a segment's own
 * words by '-'), so it splits with `key.split(':')`:
 *
 *   sad                               a generic emotion
 *   self-evaluative:imposter          a nuanced one, under its category
 *   temporal:nostalgic:for-college    your own, more specific still
 *
 * Any key of that shape is valid (up to three segments), so a list can grow
 * past the vocabulary below without a schema change; the vocabulary is what
 * the editor offers.
 */

export interface EmotionGroup {
  /** The key's first segment. */
  key: string;
  label: string;
  emotions: readonly string[];
}

/** Broad emotions, keyed by name alone. */
export const GENERIC_EMOTIONS: readonly string[] = ['happy', 'sad', 'angry', 'scared', 'surprised', 'disgusted', 'loved', 'calm'];

/** Nuanced emotions, keyed `<group>:<emotion>`. */
export const EMOTION_GROUPS: readonly EmotionGroup[] = [
  { key: 'anticipatory', label: 'Anticipatory', emotions: ['apprehensive', 'giddy', 'resigned', 'hopeful', 'dread'] },
  { key: 'relational', label: 'Relational', emotions: ['seen', 'dismissed', 'wistful', 'protective', 'excluded', 'cherished'] },
  { key: 'self-evaluative', label: 'Self-evaluative', emotions: ['pride', 'shame', 'imposter', 'deflated', 'competent', 'foolish'] },
  { key: 'agency', label: 'Agency & control', emotions: ['powerless', 'empowered', 'trapped', 'liberated', 'responsibility'] },
  { key: 'temporal', label: 'Temporal', emotions: ['nostalgic', 'disoriented', 'urgent', 'stagnant', 'transformed'] },
  { key: 'moral', label: 'Moral & justice', emotions: ['indignant', 'guilty', 'vindicated', 'betrayed', 'grateful'] },
  { key: 'existential', label: 'Existential', emotions: ['hollow', 'aligned', 'small', 'connected', 'lost'] },
];

/** One to three segments of lowercase words joined by '-', separated by ':'. */
export const EMOTION_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*){0,2}$/;

/** Every key the vocabulary offers, in display order. */
export const VOCABULARY_KEYS: readonly string[] = [
  ...GENERIC_EMOTIONS,
  ...EMOTION_GROUPS.flatMap(g => g.emotions.map(e => `${g.key}:${e}`)),
];

const segment = (s: string) => s.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean).join('-');

/**
 * Typed text as a key: "Relational: Left out" → "relational:left-out",
 * "Proud" → "proud". Null when nothing usable is left or it has more than
 * three segments.
 */
export function normalizeEmotion(input: string): string | null {
  const parts = input.split(':').map(segment);
  if (parts.some(p => !p)) return null;
  const key = parts.join(':');
  return EMOTION_KEY_RE.test(key) ? key : null;
}

/** The parts of a key, and the vocabulary group it falls under, if any. */
export function parseEmotion(key: string): { path: string[]; group?: EmotionGroup } {
  const path = key.split(':');
  return { path, group: path.length > 1 ? EMOTION_GROUPS.find(g => g.key === path[0]) : undefined };
}

const words = (s: string) => s.replace(/-/g, ' ');
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * A key for people: its emotion, with any nuance after it — "Hopeful",
 * "Nostalgic — for college". A two-segment key outside the vocabulary's groups
 * reads as an emotion and its nuance ("sad:homesick" → "Sad — homesick").
 */
export function emotionLabel(key: string): string {
  const { path, group } = parseEmotion(key);
  if (path.length === 1) return cap(words(path[0]));
  const [head, ...rest] = group ? path.slice(1) : path;
  return rest.length ? `${cap(words(head))} — ${rest.map(words).join(' — ')}` : cap(words(head));
}

/** Keys in vocabulary order, then the rest alphabetically. */
export function sortEmotions(keys: string[]): string[] {
  const rank = (k: string) => { const i = VOCABULARY_KEYS.indexOf(k); return i < 0 ? VOCABULARY_KEYS.length : i; };
  return [...keys].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}
