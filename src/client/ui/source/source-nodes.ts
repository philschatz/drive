/**
 * Pure helpers for the source inspector — no Preact, no DOM.
 *
 * The inspector navigates one level of the document at a time, and the level it
 * shows is whatever the URL says (`#/source/<id>/<path>`). Everything that turns
 * a path into something renderable lives here so it can be tested without
 * mounting anything.
 */

import { BLOCK_MARKER, type BlockValue } from '../../../shared/rich-text-ops';

export type Path = (string | number)[];

export type NodeKind = 'object' | 'array' | 'string' | 'richtext' | 'number' | 'boolean' | 'null' | 'unknown';

/** True for the two kinds that have children to navigate into. */
export function isContainer(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

export function nodeKind(value: unknown, rich = false): NodeKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return rich ? 'richtext' : 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

/**
 * The leading glyph for a row, which is how the value's type is carried.
 *
 * Colour alone did that before, in a hard-coded VS Code palette that ignored the
 * app theme; a glyph reads at a glance on a phone and survives dark mode. These
 * are `material-symbols-outlined` names, except that JSON has no glyph for
 * "object" or "array" — those use `{}` / `[]` as text (see `KIND_TEXT_GLYPH`).
 */
export const KIND_ICON: Record<NodeKind, string> = {
  object: 'data_object',
  array: 'data_array',
  string: 'format_quote',
  richtext: 'format_paragraph',
  number: 'numbers',
  boolean: 'toggle_on',
  null: 'block',
  unknown: 'help',
};

export const KIND_LABEL: Record<NodeKind, string> = {
  object: 'object',
  array: 'array',
  string: 'text',
  richtext: 'rich text',
  number: 'number',
  boolean: 'boolean',
  null: 'null',
  unknown: 'unknown',
};

/** How many children a container has, phrased for the row's supporting text. */
export function containerSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? 'item' : 'items'}`;
  }
  const n = Object.keys(value as object).length;
  return `${n} ${n === 1 ? 'key' : 'keys'}`;
}

/**
 * One line of a value, for a row that has no room for more.
 *
 * Strings are escaped (so a newline or a block marker is visible rather than
 * silently reflowing the row) and then cut at `max`, because a row must never be
 * the reason the page scrolls sideways.
 */
export function valuePreview(value: unknown, max = 80): string {
  if (isContainer(value)) return containerSummary(value);
  if (value === null) return 'null';
  if (typeof value !== 'string') return String(value);
  const escaped = escapeString(value);
  return `"${escaped.length > max ? escaped.slice(0, max) + '…' : escaped}"`;
}

/**
 * A block marker is U+FFFC, which renders as nothing (or as tofu) — invisible in
 * the value AND in the edit field, where it silently survives a round trip. So
 * it escapes to `￼`, which is both visible and typeable: adding one to the
 * string inserts a block marker, deleting one removes it.
 */
export function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    .replace(new RegExp(BLOCK_MARKER, 'g'), '\\uFFFC');
}

export function unescapeString(s: string): string {
  let result = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') { result += '\n'; i++; continue; }
      if (next === 'r') { result += '\r'; i++; continue; }
      if (next === 't') { result += '\t'; i++; continue; }
      if (next === '\\') { result += '\\'; i++; continue; }
      if (s.slice(i + 1, i + 6).toUpperCase() === 'UFFFC') { result += BLOCK_MARKER; i += 5; continue; }
    }
    result += s[i];
  }
  return result;
}

/** Untyped coercion of a typed value: `null`/`true`/`false`/number, else string. */
export function parseValue(raw: string): any {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== '') return num;
  return unescapeString(raw);
}

/**
 * A mark value typed into a field, read back at the type it already had.
 *
 * A string mark value is shown RAW, so a link's `{"href":…}` is editable as the
 * JSON text it is — which is exactly why the edit must not be re-parsed: that
 * would store an object, and an Automerge mark value has to be a scalar.
 * Non-string values (a `strong` of `true`) are shown JSON-encoded, so they are
 * read back the same way, with the raw text as the fallback.
 */
export function reparseMarkValue(previous: unknown, raw: string): unknown {
  if (typeof previous === 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? raw : parsed;
  } catch {
    return raw;
  }
}

/**
 * Compact block-type label for the inline chip: `¶h1`, `¶ul`, `¶p`.
 *
 * List nesting is not a separate field — a block's `parents` chain IS its
 * depth, so a twice-indented item is `parents: ['unordered-list-item',
 * 'unordered-list-item']`. The chip shows that as `·N` rather than dropping it,
 * since two list items at different depths are otherwise identical here.
 */
export function blockChipLabel(b: BlockValue): string {
  const depth = b.parents?.length ?? 0;
  const suffix = depth > 0 ? `·${depth}` : '';
  const level = (b.attrs as any)?.level;
  if (b.type === 'heading') return `h${level ?? '?'}${suffix}`;
  if (b.type === 'unordered-list-item') return `ul${suffix}`;
  if (b.type === 'ordered-list-item') return `ol${suffix}`;
  if (b.type === 'paragraph') return `p${suffix}`;
  return b.type + suffix;
}

export function pathsEqual(a: Path, b: Path): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** True when `prefix` is a strict ancestor of `full`. */
export function isPrefix(prefix: Path, full: Path): boolean {
  if (prefix.length >= full.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== full[i]) return false;
  return true;
}

/** Read a path out of a document, or `undefined` if any segment is missing. */
export function valueAt(doc: any, path: Path): any {
  let current = doc;
  for (const seg of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[seg as any];
  }
  return current;
}

/** Decode a router `rest` remainder into a path, coercing numeric segments. */
export function pathFromRest(rest: string | undefined): Path {
  if (!rest) return [];
  return rest.split('/').filter(Boolean).map((seg) => {
    const decoded = decodeURIComponent(seg);
    const n = Number(decoded);
    return !isNaN(n) && decoded.trim() !== '' ? n : decoded;
  });
}

export interface ResolvedLevel {
  /** The container to list. Always resolvable (worst case, the root). */
  levelPath: Path;
  /** A child of `levelPath` the caller asked for by name — highlight it. */
  selectedKey: string | number | null;
  /** A trailing marker-carrying string: show its field screen, not a level. */
  fieldPath: Path | null;
  /** The requested path could not be walked in full. */
  missing: boolean;
}

/**
 * What to show for a requested path.
 *
 * Three quite different callers hand this a path and none of them can be asked
 * to know the document's shape first: the validation panel deep-links to the
 * *leaf* an error is about, every other editor's "Edit source" links to whatever
 * field was focused, and an operations row carries a raw Automerge patch path —
 * which for a text edit ends in a character offset (`['content', 14]`) that is
 * not a key at all. So resolution is one rule: walk as far as the document
 * allows, list the deepest container reached, and treat one leftover segment as
 * a row to point at.
 *
 * `richPaths` names the string fields that carry rich-text markers; those get a
 * screen of their own rather than being a row in their parent's level, because a
 * field with twenty block markers is not a one-line value.
 */
export function resolveLevel(doc: any, path: Path, richPaths?: Set<string>): ResolvedLevel {
  const empty: ResolvedLevel = { levelPath: [], selectedKey: null, fieldPath: null, missing: false };
  if (!isContainer(doc)) return empty;

  let current = doc;
  const walked: Path = [];
  for (const seg of path) {
    const next = isContainer(current) ? current[seg as any] : undefined;
    if (next === undefined) {
      // A leftover segment names a row in the level we reached. Only one, and
      // only if nothing follows it — a deeper remainder is a stale path.
      const rest = path.slice(walked.length);
      return {
        levelPath: walked,
        selectedKey: rest.length === 1 ? rest[0] : null,
        fieldPath: null,
        missing: true,
      };
    }
    walked.push(seg);
    current = next;
    if (!isContainer(current)) break;
  }

  // Stopped on a primitive: it is either a rich-text field with its own screen,
  // or a row to highlight in its parent's level.
  if (!isContainer(current)) {
    const rich = typeof current === 'string' && richPaths?.has(walked.join('/'));
    if (rich) return { levelPath: walked.slice(0, -1), selectedKey: null, fieldPath: walked, missing: false };
    return {
      levelPath: walked.slice(0, -1),
      selectedKey: walked[walked.length - 1] ?? null,
      // Trailing segments past a primitive (a text offset from a patch path) are
      // not an error worth reporting — the path resolved as far as it means to.
      fieldPath: null,
      missing: false,
    };
  }

  return { levelPath: walked, selectedKey: null, fieldPath: null, missing: false };
}

/**
 * Path keys of every changed leaf and its ancestors, for the change flash.
 * Returns whether anything under `path` changed at all.
 *
 * Ancestors are included on purpose: the inspector shows one level at a time, so
 * an edit three levels down is only visible as a flash on the container row that
 * leads to it.
 *
 * A container is reported only when a descendant genuinely differs, never merely
 * because its identity did. The worker hands out a fresh immutable snapshot on
 * every change, so every object in it is a new reference — marking containers on
 * identity alone would flash every row of every level on every keystroke.
 */
export function collectChangedPaths(prev: any, curr: any, path: Path, out: Set<string>): boolean {
  if (prev === curr) return false;
  const prevIsObj = isContainer(prev);
  const currIsObj = isContainer(curr);
  if (!prevIsObj || !currIsObj) {
    // A changed leaf, or a value that changed shape (object ↔ primitive).
    out.add(path.join('/'));
    return true;
  }
  let changed = false;
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const key of allKeys) {
    if (collectChangedPaths(prev[key], curr[key], [...path, key], out)) changed = true;
  }
  if (changed) out.add(path.join('/'));
  return changed;
}
