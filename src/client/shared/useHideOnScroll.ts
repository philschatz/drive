import { useEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';

/**
 * Next visibility of hide-on-scroll chrome. Pure for testability.
 * @param prev      whether the chrome is currently hidden
 * @param acc       accumulated scroll delta in the current direction (px; + = down)
 * @param scrollTop current scroll offset
 */
export function nextChromeState(prev: boolean, acc: number, scrollTop: number, threshold = 12): boolean {
  if (scrollTop <= threshold) return false; // always show near the top
  if (acc > threshold) return true; // scrolling down hides
  if (acc < -threshold) return false; // scrolling up reveals
  return prev;
}

/**
 * Scroll-direction chrome hiding, shared by every document editor: returns true
 * while the toolbars should be hidden (dragging up / scrolling down) and false
 * once the user drags back down or reaches the top.
 *
 * With no `target`, it listens on the document in the **capture** phase, so it
 * responds to whichever element actually scrolls — the window (Tasks, Counters,
 * source viewer), a full-height editor's inner scroller (DataGrid's grid,
 * schedule-x's calendar grid), without each editor having to wire up a ref.
 * Scroll containers inside overlays (bottom sheets) are ignored so scrolling a
 * sheet's content never moves the chrome behind it.
 *
 * @param target Optional specific scroller to watch instead.
 * @param enabled Set false to freeze the current state (e.g. in a modal mode).
 */
export function useHideOnScroll(target?: RefObject<HTMLElement> | null, enabled = true): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!enabled) return;

    // Per-scroller bookkeeping: several elements (and the window) can scroll,
    // and horizontal-only scrollers must not disturb the vertical tracking.
    const lasts = new WeakMap<object, number>();
    let acc = 0;

    const scrollTopOf = (t: EventTarget | null): number | null => {
      if (!t || t === document || t === window || t === document.documentElement || t === document.body) {
        return window.scrollY;
      }
      const el = t as HTMLElement;
      if (typeof el.scrollTop !== 'number') return null;
      // A sheet/dialog's own scrolling must not move the chrome underneath it.
      if (el.closest?.('[data-overlay-content]')) return null;
      return el.scrollTop;
    };

    const onScroll = (e: Event) => {
      const t = e.target ?? window;
      const st = scrollTopOf(t);
      if (st == null) return;
      const key = (t === document || t === window ? window : t) as object;
      const last = lasts.get(key) ?? st;
      lasts.set(key, st);
      const delta = st - last;
      if (delta === 0) return; // horizontal-only scroll, or no movement
      if (delta > 0 !== acc > 0) acc = 0; // direction change resets
      acc += delta;
      setHidden(prev => nextChromeState(prev, acc, st));
    };

    const el = target?.current;
    if (target) {
      if (!el) return;
      // Seed the position so the very first scroll event yields a real delta.
      lasts.set(el, el.scrollTop);
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => el.removeEventListener('scroll', onScroll);
    }
    lasts.set(window, window.scrollY);
    // Scroll events don't bubble, but they do propagate in the capture phase.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [target, target?.current, enabled]);
  return hidden;
}
