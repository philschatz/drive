/**
 * useLongPress — pointer-based tap vs. long-press for list rows (touch + mouse + pen).
 *
 * Interaction model for the mobile-first redesign: a whole-row press performs the
 * PRIMARY action (`onTap`), and holding the row (~450ms) opens a SECONDARY surface
 * (`onLongPress`) — an edit/actions sheet. Desktop right-click maps to the same
 * secondary surface, and so do the keyboard's context-menu gestures (Shift+F10 or
 * the ContextMenu key) — rows have no trailing kebab, so this is the SR/keyboard path.
 *
 * Wiring: spread the returned handlers on the row element (e.g. an `md-list-item`).
 * Do NOT also add your own `onClick` — the primary action is `onTap`, invoked from
 * the real click event so keyboard Enter/Space on a focusable row still works. The
 * hook swallows the synthetic click that follows a long-press so nothing double-fires.
 * Presses that start on an interactive child (checkbox, links…) are ignored so
 * those controls keep working.
 */
import { useRef } from 'preact/hooks';

/** Elements whose own press should NOT trigger the row's tap/long-press. */
const INTERACTIVE_SELECTOR =
  'button,a,input,select,textarea,label,[role="button"],[role="checkbox"],[role="switch"],' +
  '[data-no-longpress],md-checkbox,md-switch,md-icon-button,md-menu,md-fab';

export interface UseLongPressOptions {
  /** Secondary action — fired after a hold, on right-click, or on Shift+F10. */
  onLongPress: (e: PointerEvent | MouseEvent | KeyboardEvent) => void;
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
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      const { delay = 450 } = cb.current;
      timer.current = setTimeout(() => {
        fired.current = true;
        suppressClick.current = true; // the ensuing click must not also tap
        cb.current.onLongPress(e);
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
      const { contextMenuAsLongPress = true } = cb.current;
      if (!contextMenuAsLongPress) return;
      e.preventDefault();
      suppressClick.current = true;
      cb.current.onLongPress(e);
    },
    // Keyboard path to the secondary action (rows have no kebab): the standard
    // "open context actions" keys. Note browsers also fire contextmenu for
    // these — preventDefault here stops that, so the action fires only once.
    onKeyDown(e) {
      const isMenuKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
      if (!isMenuKey || interactiveChild(e)) return;
      e.preventDefault();
      cb.current.onLongPress(e);
    },
  };

  return handlers.current;
}
