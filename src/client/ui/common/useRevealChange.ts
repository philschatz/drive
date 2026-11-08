/**
 * Scroll the first highlighted change into view, once per description.
 *
 * `changes` is what history mode loaded for the version on screen
 * (`DocumentHistory.changes`); the editor marks what it highlights with
 * `data-diff`. The description and the pinned snapshot arrive separately, so
 * the marked element may not exist yet when `changes` lands — the effect re-runs
 * on `deps` (whatever the editor renders from) until it finds one, and remembers
 * which description it revealed so later re-renders do not scroll again.
 *
 * `scrollIntoView` is optional-called: jsdom has none.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';

export function useRevealChange(
  changes: unknown,
  deps: unknown[],
  opts: { root?: () => ParentNode | null; selector?: string } = {},
): void {
  const revealed = useRef<unknown>(null);
  useLayoutEffect(() => {
    if (!changes || revealed.current === changes) return;
    const root = opts.root ? opts.root() : document;
    const el = root?.querySelector(opts.selector ?? '[data-diff]') as HTMLElement | null;
    if (!el) return;
    revealed.current = changes;
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [changes, ...deps]);
}
