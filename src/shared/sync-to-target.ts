/** Convert an Automerge proxy value to a plain JS value safe for assignment. */
export function toPlain(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v);
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(toPlain);
  const result: Record<string, any> = {};
  for (const key of Object.keys(v)) result[key] = toPlain(v[key]);
  return result;
}

/**
 * Handles a string field during syncToTarget. Return true when the field was
 * reconciled (skips the default assignment). Invoked even when the flat
 * strings are EQUAL: rich-text (Peritext) fields can differ only in marks or
 * block attributes, which the plain string never shows — plain assignment
 * would both miss those and destroy the text's marks/markers when it did fire.
 */
export type StringSyncHook = (root: any, path: (string | number)[], targetValue: string) => boolean;

/** Recursively sync a mutable Automerge doc to match a target snapshot. */
export function syncToTarget(
  d: any,
  target: any,
  onString?: StringSyncHook,
  path: (string | number)[] = [],
  root: any = d,
): void {
  // Delete keys not in target
  for (const key of Object.keys(d)) {
    if (!(key in target)) delete d[key];
  }
  // Set or recurse into keys from target
  for (const key of Object.keys(target)) {
    const tv = target[key];
    const dv = d[key];
    if (typeof tv === 'string' && onString?.(root, [...path, key], tv)) continue;
    if (tv === null || typeof tv !== 'object') {
      if (dv !== tv) d[key] = tv;
    } else if (!Array.isArray(tv) && typeof dv === 'object' && dv !== null && !Array.isArray(dv)) {
      syncToTarget(dv, tv, onString, [...path, key], root);
    } else {
      d[key] = toPlain(tv);
    }
  }
}
