/**
 * Wires a version list (rows carrying `data-version`) to the scrubbing rules:
 * user scrolls select a version, and a version chosen some other way (slider,
 * row tap, the list remounting) scrolls the list to match.
 *
 * Two rules, by input:
 *  - With a mouse (a hover-capable, fine pointer), the version is the row LAST
 *    UNDER THE POINTER — moving onto a row previews it, and a wheel scroll that
 *    slides a different row under the still pointer previews that one. Leaving
 *    the list keeps the last one.
 *  - Otherwise (touch, keyboard, a scrollbar drag with the pointer off the rows)
 *    the edge rule in version-scrub.ts decides from the scroll position alone.
 *
 * Only user scrolls drive the selection. The scroll event our own `scrollTop`
 * assignment causes is remembered and swallowed once — without that, placing
 * a row at the (clamped) end of the list would trip the "bottom ⇒ oldest" rule.
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { placementFor, scrubTarget, type ScrubRow, type ScrubView } from './version-scrub';

function readRows(el: HTMLElement): ScrubRow[] {
  return Array.from(el.querySelectorAll<HTMLElement>('[data-version]')).map(r => ({
    version: Number(r.dataset.version),
    top: r.offsetTop,
    height: r.offsetHeight,
  }));
}

const viewOf = (el: HTMLElement): ScrubView => ({
  scrollTop: el.scrollTop,
  clientHeight: el.clientHeight,
  scrollHeight: el.scrollHeight,
});

const versionOf = (node: EventTarget | Element | null): number | null => {
  const row = (node as Element | null)?.closest?.('[data-version]') as HTMLElement | null;
  return row ? Number(row.dataset.version) : null;
};

/** A pointer that can rest over a row without pressing it: a mouse or trackpad. */
const canHover = () =>
  typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

export function useVersionScrub(version: number, onChange: (v: number) => void): {
  /** Spread onto the scroll container (must be `position: relative`). */
  listProps: {
    ref: (el: HTMLElement | null) => void;
    onScroll: () => void;
    onMouseMove: (e: MouseEvent) => void;
    onMouseLeave: () => void;
  };
} {
  const elRef = useRef<HTMLElement | null>(null);
  const versionRef = useRef(version);
  versionRef.current = version;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastTopRef = useRef(0);
  const ownScrollRef = useRef<number | null>(null);
  // Where the mouse last was over the list, hover-capable devices only.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const hover = useMemo(canHover, []);

  const select = useCallback((next: number | null) => {
    if (next === null || Number.isNaN(next) || next === versionRef.current) return;
    versionRef.current = next;
    onChangeRef.current(next);
  }, []);

  const place = useCallback((el: HTMLElement, v: number) => {
    const row = readRows(el).find(r => r.version === v);
    if (!row) return;
    const target = placementFor(row, viewOf(el));
    if (target === null) return;
    const before = el.scrollTop;
    el.scrollTop = target;
    if (el.scrollTop !== before) {
      ownScrollRef.current = el.scrollTop;
      lastTopRef.current = el.scrollTop;
    }
  }, []);

  const ref = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
    if (!el) return;
    lastTopRef.current = el.scrollTop;
    place(el, versionRef.current);
  }, [place]);

  useLayoutEffect(() => {
    if (elRef.current) place(elRef.current, version);
  }, [version, place]);

  const onScroll = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (ownScrollRef.current !== null) {
      const own = ownScrollRef.current;
      ownScrollRef.current = null;
      if (Math.abs(top - own) < 1) {
        lastTopRef.current = top;
        return;
      }
    }
    const dy = top - lastTopRef.current;
    lastTopRef.current = top;
    if (dy === 0) return;
    // A wheel scroll under a resting mouse: the row now under it is the version.
    const p = pointerRef.current;
    if (p) {
      const under = versionOf(document.elementFromPoint?.(p.x, p.y) ?? null);
      if (under !== null) { select(under); return; }
    }
    select(scrubTarget(readRows(el), viewOf(el), versionRef.current));
  }, [select]);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!hover) return;
    pointerRef.current = { x: e.clientX, y: e.clientY };
    select(versionOf(e.target));
  }, [hover, select]);

  const onMouseLeave = useCallback(() => { pointerRef.current = null; }, []);

  return { listProps: { ref, onScroll, onMouseMove, onMouseLeave } };
}
