import { useEffect, useRef } from 'preact/hooks';
import { replaceDocHash, encodeRestPath } from './doc-urls';

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
) {
  const lastRef = useRef<string | null>('');
  useEffect(() => {
    const key = focusPath ? JSON.stringify(focusPath) : null;
    if (lastRef.current === key) return;
    lastRef.current = key;
    broadcast('focusedField', focusPath ?? null);
    if (docId) replaceDocHash(docId, focusPath ? encodeRestPath(focusPath) : undefined);
  }, [focusPath, docId, broadcast]);
}
