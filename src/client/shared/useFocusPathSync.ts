import { useEffect, useRef } from 'preact/hooks';

/**
 * Broadcast the currently focused doc path (e.g. ['events', uid, 'title']) as
 * presence. Dedupes by value: `focusPath` is typically rebuilt every render, and
 * set-presence should not fire when the path hasn't actually changed — without
 * this, every incoming peer-presence update triggers a re-render that
 * re-broadcasts, and two open editors ping-pong presence at each other forever.
 *
 * The focused path is deliberately NOT mirrored into the URL: transient
 * selection state has no business in the address bar, and `#/d/<docId>` stays
 * free for real navigation (sheet switches, the sharing screen).
 */
export function useFocusPathSync(
  focusPath: (string | number)[] | null | undefined,
  broadcast: (key: 'focusedField', value: (string | number)[] | null) => void,
) {
  const lastRef = useRef<string | null>('');
  const path = focusPath ?? null;
  useEffect(() => {
    const key = JSON.stringify(path);
    if (lastRef.current === key) return;
    lastRef.current = key;
    broadcast('focusedField', path);
  }, [path, broadcast]);
}
