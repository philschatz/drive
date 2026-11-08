/**
 * Wires a version list (rows carrying `data-version`) to the scrubbing rule in
 * version-scrub.ts: user scrolls select a version, and a version chosen some
 * other way (slider, row tap, the list remounting) scrolls the list to match.
 *
 * Only user scrolls drive the selection. The scroll event our own `scrollTop`
 * assignment causes is remembered and swallowed once — without that, placing
 * a row at the (clamped) end of the list would trip the "bottom ⇒ oldest" rule.
 */
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';
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

export function useVersionScrub(version: number, onChange: (v: number) => void): {
  /** Callback ref for the scroll container (must be `position: relative`). */
  listRef: (el: HTMLElement | null) => void;
  /** The container's scroll handler. */
  onScroll: () => void;
} {
  const elRef = useRef<HTMLElement | null>(null);
  const versionRef = useRef(version);
  versionRef.current = version;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastTopRef = useRef(0);
  const ownScrollRef = useRef<number | null>(null);

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

  const listRef = useCallback((el: HTMLElement | null) => {
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
    const next = scrubTarget(readRows(el), viewOf(el), versionRef.current);
    if (next === null || next === versionRef.current) return;
    versionRef.current = next;
    onChangeRef.current(next);
  }, []);

  return { listRef, onScroll };
}
