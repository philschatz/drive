import { useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

/**
 * Next visibility of hide-on-scroll chrome. Pure for testability.
 * @param prev    whether the chrome is currently hidden
 * @param acc     accumulated scroll delta in the current direction (px; + = down)
 * @param scrollTop current scroll offset
 */
export function nextChromeState(prev: boolean, acc: number, scrollTop: number, threshold = 12): boolean {
  if (scrollTop <= threshold) return false; // always show near the top
  if (acc > threshold) return true; // scrolling down hides
  if (acc < -threshold) return false; // scrolling up reveals
  return prev;
}

/**
 * Scroll-direction chrome hiding: returns true while toolbars should be
 * hidden (scrolling down), false once the user scrolls back up or is near
 * the top. `mounted` re-arms the listener when the (conditionally rendered)
 * scroll container appears.
 */
export function useHideOnScroll(ref: RefObject<HTMLElement>, mounted: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = el.scrollTop;
    let acc = 0;
    const onScroll = () => {
      const st = el.scrollTop;
      const delta = st - last;
      last = st;
      if (delta !== 0 && delta > 0 !== acc > 0) acc = 0; // direction change resets
      acc += delta;
      setHidden(prev => nextChromeState(prev, acc, st));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [mounted]);
  return hidden;
}
