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
 *
 * Only a *visible* tab broadcasts. All tabs of a device share one presence state
 * (one peerId, one Presence object), so `focusedField` is a single slot they would
 * otherwise fight over — a background tab's stale path would flicker into every
 * peer's view. The visible tab owns it, and re-asserts on becoming visible.
 */
function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export function useFocusPathSync(
  focusPath: (string | number)[] | null | undefined,
  broadcast: (key: 'focusedField', value: (string | number)[] | null) => void,
) {
  const lastRef = useRef<string | null>('');
  const path = focusPath ?? null;
  // Read by the visibilitychange handler, which is registered once.
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    const key = JSON.stringify(path);
    // Leave lastRef alone while hidden so becoming visible re-broadcasts this path.
    if (!isVisible()) return;
    if (lastRef.current === key) return;
    lastRef.current = key;
    broadcast('focusedField', path);
  }, [path, broadcast]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (!isVisible()) return;
      lastRef.current = JSON.stringify(pathRef.current);
      broadcast('focusedField', pathRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [broadcast]);
}
