import { useEffect, useRef } from 'preact/hooks';
import { replaceDocHash, encodeRestPath } from './doc-urls';

export interface FocusPathSyncOptions {
  /** Extra query string (e.g. `?anchor=rowId:colId`) appended to the URL hash. */
  query?: string;
  /**
   * Override for what gets broadcast as `focusedField` presence. Defaults to
   * `focusPath`. DataGrid uses this to keep sheet-only paths in the URL while
   * broadcasting null (presence only tracks a focused *cell*).
   */
  presencePath?: (string | number)[] | null;
}

/**
 * Keep presence and the URL hash in sync with the currently focused doc path
 * (e.g. ['events', uid, 'title']). Dedupes by value: `focusPath` is typically
 * rebuilt every render, and neither set-presence nor history.replaceState
 * should fire when the path hasn't actually changed — without this, every
 * incoming peer-presence update triggers a re-render that re-broadcasts,
 * and two open editors ping-pong presence at each other forever.
 */
export function useFocusPathSync(
  docId: string | null | undefined,
  focusPath: (string | number)[] | undefined,
  broadcast: (key: 'focusedField', value: (string | number)[] | null) => void,
  opts?: FocusPathSyncOptions,
) {
  const lastRef = useRef<string | null>('');
  const presencePath = (opts && 'presencePath' in opts ? opts.presencePath : focusPath) ?? null;
  const query = opts?.query;
  useEffect(() => {
    const key = JSON.stringify([focusPath ?? null, presencePath, query ?? null]);
    if (lastRef.current === key) return;
    lastRef.current = key;
    broadcast('focusedField', presencePath);
    if (docId) replaceDocHash(docId, focusPath ? encodeRestPath(focusPath) : undefined, query);
  }, [focusPath, presencePath, query, docId, broadcast]);
}
