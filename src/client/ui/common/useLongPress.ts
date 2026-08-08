/**
 * useLongPress — pointer-based tap vs. long-press for list rows (touch + mouse + pen).
 *
 * Interaction model for the mobile-first redesign: a whole-row press performs the
 * PRIMARY action (`onTap`), and holding the row (~450ms) runs the row's FIRST
 * secondary action (`onLongPress`) — usually "edit this". Desktop right-click maps
 * to the same thing, and so do the keyboard's context-menu gestures (Shift+F10 or
 * the ContextMenu key), so a hold is never the only route.
 *
 * Which action a hold runs, and what the row shows beside it, follow from how many
 * secondary actions the row has: none means no hold at all, one means the hold
 * fires it and the row wears that action's own icon, and two or more means the hold
 * fires the first while a kebab lists them all. That rule is not a convention each
 * row re-derives — `common/ListRow.tsx` owns it, and rows should go through it
 * rather than wiring this hook up by hand.
 *
 * Omitting `onLongPress` makes the row tap-only: no hold timer is armed, and
 * right-click keeps the browser's own menu instead of being swallowed for a
 * secondary surface that doesn't exist.
 *
 * Known limit: with TalkBack/VoiceOver in explore-by-touch, a real hold never
 * reaches the app. That is why the trailing control is always visible — for an AT
 * touch user it, or the context-menu key, is the route.
 *
 * The click-swallow that follows a long-press is scoped to the gesture that
 * armed it: a new `pointerdown` clears it, and a mouse right-click never arms
 * it at all. Otherwise the flag outlives its press and eats the next real tap —
 * which, now that a tap is the row's primary action, silently drops the edit.
 *
 * Wiring: spread the returned handlers on the row element (e.g. an `md-list-item`).
 * Do NOT also add your own `onClick` — the primary action is `onTap`, invoked from
 * the real click event so keyboard Enter/Space on a focusable row still works. The
 * hook swallows the synthetic click that follows a long-press so nothing double-fires.
 * Presses that start on an interactive child (checkbox, kebab, links…) are ignored
 * so those controls keep working.
 */
import { useRef } from 'preact/hooks';

/** Elements whose own press should NOT trigger the row's tap/long-press. */
const INTERACTIVE_SELECTOR =
  'button,a,input,select,textarea,label,[role="button"],[role="checkbox"],[role="switch"],' +
  '[data-no-longpress],md-checkbox,md-switch,md-icon-button,md-menu,md-fab';

export interface UseLongPressOptions {
  /**
   * Secondary action — fired after a hold, on right-click, or on Shift+F10.
   * Omit it for a row that has none: no timer, and right-click is left alone.
   */
  onLongPress?: (e: PointerEvent | MouseEvent | KeyboardEvent) => void;
  /** Primary action — fired on a normal tap/click (and keyboard activation). */
  onTap?: (e: MouseEvent) => void;
  /** Hold duration in ms before long-press fires (default 450). */
  delay?: number;
  /** Movement (px) that reclassifies the press as a scroll/drag and cancels it. */
  moveTolerance?: number;
  /** Treat desktop right-click as a long-press (default true). */
  contextMenuAsLongPress?: boolean;
}

export interface LongPressHandlers {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onPointerCancel: (e: PointerEvent) => void;
  onClick: (e: MouseEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}

export function useLongPress(opts: UseLongPressOptions): LongPressHandlers {
  // Keep the latest callbacks/options in a ref so the handler identities stay stable
  // (no need to re-spread) while never reading stale closures.
  const cb = useRef(opts);
  cb.current = opts;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);
  const fired = useRef(false);
  const moved = useRef(false);
  const suppressClick = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const handlers = useRef<LongPressHandlers | null>(null);
  if (handlers.current) return handlers.current;

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // The row itself may carry an interactive role (e.g. role="checkbox" on a
  // task row) — only bail for interactive DESCENDANTS, never the host the
  // handlers are attached to.
  const interactiveChild = (e: Event): boolean => {
    const hit = (e.target as HTMLElement | null)?.closest(INTERACTIVE_SELECTOR);
    return !!hit && hit !== e.currentTarget;
  };

  handlers.current = {
    onPointerDown(e) {
      if (interactiveChild(e)) {
        active.current = false;
        return;
      }
      active.current = true;
      fired.current = false;
      moved.current = false;
      // A new press is a new gesture: whatever armed the swallow belongs to the
      // last one and must not eat this press's click.
      suppressClick.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      // No secondary action, no hold — but the bookkeeping above still runs, so
      // a tap-only row clears a stale swallow like any other. Arming the timer
      // regardless would set suppressClick when it fired, and a 450ms press
      // would silently eat its own tap: the row would look broken rather than
      // merely hold-less.
      const onLongPress = cb.current.onLongPress;
      if (!onLongPress) return;
      const { delay = 450 } = cb.current;
      timer.current = setTimeout(() => {
        fired.current = true;
        suppressClick.current = true; // the ensuing click must not also tap
        onLongPress(e);
      }, delay);
    },
    onPointerMove(e) {
      if (!active.current || !start.current) return;
      const { moveTolerance = 10 } = cb.current;
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > moveTolerance) {
        moved.current = true;
        clear();
      }
    },
    onPointerUp() {
      clear();
      active.current = false;
    },
    onPointerCancel() {
      clear();
      active.current = false;
    },
    onClick(e) {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // A click bubbling up from an inline control (kebab, checkbox, link…)
      // belongs to that control — don't also fire the row's primary action.
      if (interactiveChild(e)) return;
      cb.current.onTap?.(e);
    },
    onContextMenu(e) {
      const { contextMenuAsLongPress = true, onLongPress } = cb.current;
      // Bail BEFORE preventDefault: a row with no secondary action must leave
      // the browser's own context menu alone rather than swallow it for a
      // surface that doesn't exist.
      if (!contextMenuAsLongPress || !onLongPress) return;
      e.preventDefault();
      // Only arm the click-swallow when a click is actually coming. A mouse
      // right-click (button 2) never produces one — `click` is primary-button
      // only, `auxclick` carries the rest — so arming here would leave the flag
      // set and eat the user's NEXT genuine tap. A touch long-press, which also
      // raises contextmenu (Android), reports button 0 and IS followed by a
      // click, so that one still needs swallowing.
      if (e.button !== 2) suppressClick.current = true;
      onLongPress(e);
    },
    // Keyboard path to the secondary action: the standard "open context
    // actions" keys. Note browsers also fire contextmenu for these —
    // preventDefault here stops that, so the action fires only once.
    onKeyDown(e) {
      const isMenuKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
      const onLongPress = cb.current.onLongPress;
      // Same as onContextMenu: no action, no preventDefault.
      if (!isMenuKey || !onLongPress || interactiveChild(e)) return;
      e.preventDefault();
      onLongPress(e);
    },
  };

  return handlers.current;
}
