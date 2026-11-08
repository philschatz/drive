/**
 * What one version of a document changed, in terms an editor can show.
 *
 * Automerge's `diff` yields patches: an action and a path, with the new value
 * but never the old one. History mode wants to highlight what a version added,
 * removed or replaced — and to show removed content, which only the old value
 * can supply. `describeVersionChanges` walks the patches against a plain-object
 * mirror of the document as it stood BEFORE the version, recording each old
 * value before applying the patch, so later indices still resolve (patch
 * indices are sequential: each refers to the state after the ones before it).
 *
 * The rest of this module folds those changes into the shapes the editors use:
 * a kind per item of a record (`itemChanges`), the removed items with their old
 * value for ghost rows (`removedItems`, `withGhosts`), and character ranges in
 * a Peritext field (`textRanges`). Portable: no Automerge import — the engine
 * passes `applyPatch` in.
 */

import { BLOCK_MARKER } from './rich-text-ops';

export type Prop = string | number;
export type ChangeKind = 'added' | 'removed' | 'changed';

export interface VersionChange {
  /** The patch path; for text and list ops the last segment is the index. */
  path: Prop[];
  kind: ChangeKind;
  /** The raw patch action (put / del / insert / splice / mark / unmark / inc). */
  action: string;
  /** What was there: a map value, a list slice, or a text slice (del, put, inc). */
  before?: unknown;
  /** What is there now (put, insert, splice; the whole string for a string assignment). */
  after?: unknown;
  /** Span length of a text/list del or splice. */
  length?: number;
  marks?: Array<{ name: string; value: unknown; start: number; end: number }>;
}

/** The subset of an Automerge `Patch` this module reads. */
export interface PatchLike {
  action: string;
  path: Prop[];
  value?: unknown;
  values?: unknown[];
  length?: number;
  marks?: any;
  name?: string;
  start?: number;
  end?: number;
}

/** Read a path out of a plain document, or `undefined` if any segment is missing. */
export function valueAt(doc: any, path: Prop[]): any {
  let current = doc;
  for (const seg of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[seg as any];
  }
  return current;
}

const pathKey = (path: Prop[]) => JSON.stringify(path);

/** A counter's number: `toJS` keeps counters as `Counter { value }` objects. */
function counterValue(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof (v as any).value === 'number') return (v as any).value;
  return undefined;
}

/**
 * Depth at which `path` indexes INTO a string and keeps going — a block marker's
 * own properties (`['content', 3, 'type']`), which the mirror cannot hold since it
 * keeps the field as one string. -1 when the path never does.
 */
function textEntryDepth(mirror: any, path: Prop[]): number {
  let current = mirror;
  for (let i = 0; i < path.length; i++) {
    if (typeof current === 'string') return i < path.length - 1 ? i : -1;
    if (current === null || typeof current !== 'object') return -1;
    current = current[path[i] as any];
  }
  return -1;
}

/**
 * The cases `applyPatch` cannot apply to a `toJS` mirror — a map-key delete, a
 * block-marker insert into text, a counter increment — done by hand; everything
 * else is delegated.
 */
function applyMirrorPatch(mirror: any, p: PatchLike, applyPatch: (m: any, p: any) => void): void {
  const parentPath = p.path.slice(0, -1);
  const key = p.path[p.path.length - 1];
  const parent = valueAt(mirror, parentPath);
  if (p.action === 'del' && typeof key === 'string') {
    if (parent && typeof parent === 'object') delete parent[key];
    return;
  }
  if (p.action === 'insert' && typeof parent === 'string' && typeof key === 'number') {
    // Block markers: Automerge inserts a map into the text, which `toJS` shows
    // as the marker character.
    const grand = valueAt(mirror, parentPath.slice(0, -1));
    const field = parentPath[parentPath.length - 1];
    if (grand && typeof grand === 'object') {
      grand[field as any] = parent.slice(0, key) + BLOCK_MARKER.repeat((p.values ?? []).length) + parent.slice(key);
    }
    return;
  }
  if (p.action === 'inc') {
    if (parent && typeof parent === 'object' && typeof p.value === 'number') {
      const cur = parent[key as any];
      if (cur && typeof cur === 'object' && typeof cur.value === 'number') cur.value += p.value;
      else parent[key as any] = (counterValue(cur) ?? 0) + p.value;
    }
    return;
  }
  if (p.action === 'mark' || p.action === 'unmark' || p.action === 'conflict') return;
  applyPatch(mirror, p);
}

/**
 * Describe `patches` (one version's `diff`, in order) against `mirror`, the plain
 * document BEFORE the version. The mirror is mutated as the walk goes.
 *
 * Automerge reports a string assignment as `put ''` followed — not necessarily
 * next — by a `splice` of the text at index 0 of the same path; the pair is
 * folded into one change whose `after` is the whole string.
 */
export function describeVersionChanges(
  patches: PatchLike[],
  mirror: any,
  applyPatch: (m: any, p: any) => void,
): VersionChange[] {
  const out: VersionChange[] = [];
  const pendingPuts = new Map<string, VersionChange>();

  for (const p of patches) {
    const parentPath = p.path.slice(0, -1);
    const key = p.path[p.path.length - 1];
    const entry = textEntryDepth(mirror, p.path);
    if (entry >= 0) {
      // A block marker's properties: the block at that index changed.
      out.push({ path: p.path, kind: 'changed', action: p.action });
      continue;
    }
    const parent = valueAt(mirror, parentPath);

    switch (p.action) {
      case 'put': {
        const before = parent && typeof parent === 'object' ? parent[key as any] : undefined;
        const change: VersionChange = {
          path: p.path, kind: before === undefined ? 'added' : 'changed', action: 'put', before, after: p.value,
        };
        out.push(change);
        if (p.value === '') pendingPuts.set(pathKey(p.path), change);
        break;
      }
      case 'splice': {
        const text = String(p.value ?? '');
        const pending = key === 0 ? pendingPuts.get(pathKey(parentPath)) : undefined;
        if (pending) {
          pending.after = text;
          pendingPuts.delete(pathKey(parentPath));
        } else {
          out.push({ path: p.path, kind: 'added', action: 'splice', after: text, length: text.length });
        }
        break;
      }
      case 'insert': {
        const values = p.values ?? [];
        out.push({ path: p.path, kind: 'added', action: 'insert', after: values, length: values.length });
        break;
      }
      case 'del': {
        const length = p.length ?? 1;
        const before = typeof key === 'number' && (typeof parent === 'string' || Array.isArray(parent))
          ? parent.slice(key, key + length)
          : parent && typeof parent === 'object' ? parent[key as any] : undefined;
        out.push({ path: p.path, kind: 'removed', action: 'del', before, length });
        break;
      }
      case 'inc': {
        const before = parent && typeof parent === 'object' ? counterValue(parent[key as any]) : undefined;
        const delta = typeof p.value === 'number' ? p.value : 0;
        out.push({
          path: p.path, kind: 'changed', action: 'inc', before,
          after: before === undefined ? undefined : before + delta,
        });
        break;
      }
      case 'mark':
        out.push({ path: p.path, kind: 'changed', action: 'mark', marks: p.marks ?? [] });
        break;
      case 'unmark':
        out.push({
          path: p.path, kind: 'changed', action: 'unmark',
          marks: [{ name: p.name ?? '', value: null, start: p.start ?? 0, end: p.end ?? 0 }],
        });
        break;
      default:
        break; // conflict and anything new: nothing to show
    }
    applyMirrorPatch(mirror, p, applyPatch);
  }
  return out;
}

const RANK: Record<ChangeKind, number> = { changed: 0, added: 1, removed: 2 };

function underPrefix(path: Prop[], prefix: Prop[]): boolean {
  if (path.length <= prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (path[i] !== prefix[i]) return false;
  return true;
}

/**
 * A kind per item of the record at `prefix` (`['tasks']`, `['events']`,
 * `['sheets', sid, 'cells']`): a change at the item's own path keeps its kind, a
 * deeper one means the item changed. Per item, removed beats added beats changed.
 */
export function itemChanges(changes: VersionChange[], prefix: Prop[]): Map<string, ChangeKind> {
  const out = new Map<string, ChangeKind>();
  for (const c of changes) {
    if (!underPrefix(c.path, prefix)) continue;
    const id = String(c.path[prefix.length]);
    const kind = c.path.length === prefix.length + 1 ? c.kind : 'changed';
    const prev = out.get(id);
    if (!prev || RANK[kind] > RANK[prev]) out.set(id, kind);
  }
  return out;
}

/** The items removed from the record at `prefix`, with their old value. */
export function removedItems<T = unknown>(changes: VersionChange[], prefix: Prop[]): Array<{ id: string; before: T }> {
  const out: Array<{ id: string; before: T }> = [];
  for (const c of changes) {
    if (c.kind !== 'removed' || c.path.length !== prefix.length + 1 || !underPrefix(c.path, prefix)) continue;
    if (c.before === undefined) continue;
    out.push({ id: String(c.path[prefix.length]), before: c.before as T });
  }
  return out;
}

/**
 * Display-only merge: the removed items put back into `record` so a list can
 * render them as ghosts. Ids already present are left alone (the diff can land
 * before the pinned snapshot does).
 */
export function withGhosts<T>(
  record: Record<string, T>,
  removed: Array<{ id: string; before: T }>,
): { record: Record<string, T>; ghosts: Set<string> } {
  const ghosts = new Set<string>();
  let merged = record;
  for (const r of removed) {
    if (r.id in record) continue;
    if (merged === record) merged = { ...record };
    merged[r.id] = r.before;
    ghosts.add(r.id);
  }
  return { record: merged, ghosts };
}

export interface TextRange {
  from: number;
  to: number;
  kind: ChangeKind;
  /** The deleted text, for a zero-length `removed` range. */
  before?: string;
  /** The range stands for the whole block containing `from` (a new or restyled block). */
  block?: true;
}

/**
 * Character ranges a version touched in the Peritext field at `path`, in the
 * coordinates of the document AFTER the version. Each change is replayed in
 * order and the ranges found so far are shifted (and clipped) by every later
 * insertion or deletion, so they land where the text now is.
 */
export function textRanges(changes: VersionChange[], path: Prop[]): TextRange[] {
  const out: TextRange[] = [];
  const insertAt = (at: number, len: number) => {
    for (const r of out) {
      if (r.from >= at) { r.from += len; r.to += len; }
      else if (r.to > at) r.to += len;
    }
  };
  const deleteAt = (at: number, len: number) => {
    const end = at + len;
    for (const r of out) {
      if (r.to <= at) continue;
      const from = r.from <= at ? r.from : Math.max(at, r.from - len);
      const to = r.to <= end ? Math.min(r.to, at) : r.to - len;
      r.from = from;
      r.to = Math.max(from, to);
    }
  };
  const onField = (c: VersionChange) => c.path.length === path.length && underPrefix([...c.path, 0], path);
  const inField = (c: VersionChange) => c.path.length > path.length && underPrefix(c.path, path);

  for (const c of changes) {
    if (onField(c)) {
      // The whole field reassigned.
      const len = typeof c.after === 'string' ? c.after.length : 0;
      out.length = 0;
      if (c.action === 'mark' || c.action === 'unmark') {
        for (const m of c.marks ?? []) out.push({ from: m.start, to: m.end, kind: 'changed' });
      } else if (c.action === 'put') {
        out.push({ from: 0, to: len, kind: c.kind === 'added' ? 'added' : 'changed' });
      }
      continue;
    }
    if (!inField(c)) continue;
    const at = Number(c.path[path.length]);
    if (c.path.length > path.length + 1) {
      // A block marker's properties.
      out.push({ from: at, to: at, kind: 'changed', block: true });
      continue;
    }
    switch (c.action) {
      case 'splice': {
        const len = c.length ?? 0;
        insertAt(at, len);
        out.push({ from: at, to: at + len, kind: 'added' });
        break;
      }
      case 'insert': {
        const len = c.length ?? 0;
        insertAt(at, len);
        out.push({ from: at, to: at + len, kind: 'added', block: true });
        break;
      }
      case 'del': {
        deleteAt(at, c.length ?? 1);
        out.push({ from: at, to: at, kind: 'removed', before: typeof c.before === 'string' ? c.before : undefined });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Counts for the legend: distinct items touched, by kind. An item is a top-level
 * field, or an entry of a top-level record (`tasks/<uid>`); DataGrid nests its
 * items two levels deeper (`sheets/<sid>/cells/<key>`), the one exception.
 */
export function summarizeChanges(changes: VersionChange[]): Record<ChangeKind, number> {
  const items = new Map<string, ChangeKind>();
  for (const c of changes) {
    const depth = c.path[0] === 'sheets' && c.path.length >= 4 ? 4 : Math.min(2, c.path.length);
    const key = pathKey(c.path.slice(0, depth));
    const kind = c.path.length === depth ? c.kind : 'changed';
    const prev = items.get(key);
    if (!prev || RANK[kind] > RANK[prev]) items.set(key, kind);
  }
  const out: Record<ChangeKind, number> = { added: 0, removed: 0, changed: 0 };
  for (const kind of items.values()) out[kind]++;
  return out;
}
