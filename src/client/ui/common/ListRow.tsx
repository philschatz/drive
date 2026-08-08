/**
 * ListRow — the shape every list row in this app has, and the one place the
 * interaction rule is written down rather than re-derived per row.
 *
 * A click ANYWHERE on the row runs the PRIMARY action (`onTap`). Everything else
 * the row can do goes in `actions`, and its LENGTH decides the rest:
 *
 *   0 actions → no trailing control, and no hold at all
 *   1 action  → that action's own icon (a pencil, a trash…), and a hold fires it
 *   2+        → a kebab listing them all, and a hold fires the FIRST — so put the
 *               most useful one first (usually "edit this")
 *
 * A hold is therefore never the only route: the trailing control is always
 * visible, and right-click / Shift+F10 reach the same action (see useLongPress).
 *
 * `actions` is typed as OverflowMenu's own item type, so the 2+ case hands the
 * array straight to `OverflowMenu` and a row never describes an action twice.
 * `title` is what the lone icon uses as its aria-label, so give it the specific
 * one ("Edit Buy milk") and leave `label` the generic verb the menu shows.
 *
 * Do NOT pass `onClick`: the primary action is `onTap`, which useLongPress fires
 * off the real click event so keyboard Enter/Space still activates the row, and
 * which it swallows after a hold so nothing double-fires. The handler spread is
 * last below, so an `onClick` would be overwritten rather than merely discouraged.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useLongPress } from './useLongPress';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

/** A row action. `testId` reaches the lone icon button; menu items carry `title`. */
export type RowAction = OverflowMenuItem & { testId?: string };

export type ListRowProps = JSX.IntrinsicElements['md-list-item'] & {
  /** Primary action: a tap anywhere on the row, or keyboard activation. */
  onTap?: (e: MouseEvent) => void;
  /**
   * Makes the row a real link, for a row whose primary action is navigation
   * (`docUrl(id)`, `sourceUrl(id, path)`). Use this rather than an `onTap` that
   * assigns `location.hash`: the browser then gives Cmd/Ctrl+click and
   * middle-click a new tab for free, AT announces a link rather than a button,
   * and the target shows in the status bar. Pass one or the other, not both.
   */
  href?: string;
  /** Secondary actions. Length picks the trailing control; [0] is the hold. */
  actions?: RowAction[];
  /** Trailing content that is NOT an action — badges, presence dots, chevrons. */
  end?: ComponentChildren;
  /** aria-label for the kebab, e.g. `Actions for ${title}`. */
  actionsLabel?: string;
  children?: ComponentChildren;
};

export function ListRow({
  onTap, href, actions = [], end, actionsLabel, children, ...rest
}: ListRowProps) {
  const [first] = actions;
  // A disabled first action means no hold rather than a hold that falls through
  // to the second: which action a gesture runs should not depend on permissions.
  // The trailing control still reaches everything.
  const run = first && !first.disabled
    ? () => {
        if (first.onSelect) first.onSelect();
        else if (first.href) window.location.hash = first.href;
      }
    : undefined;
  // The standard SPA-link click. The browser keeps every gesture that means
  // "somewhere else" — Cmd/Ctrl+click and middle-click for a new tab, Shift for
  // a window — and we handle only the plain left-click, because this is a hash
  // route and `hashHistory.push` is exactly this assignment. Handling it here
  // rather than leaving it to the anchor is also what keeps a link row testable:
  // md-list-item never upgrades under jsdom, so its internal <a> doesn't exist
  // and an href alone would navigate nowhere.
  const follow = href
    ? (e: MouseEvent) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        window.location.hash = href;
      }
    : undefined;

  const lp = useLongPress({
    onTap: onTap ?? follow,
    onLongPress: run,
    // On a link, right-click belongs to the link: taking it would cost "Open in
    // new tab" and "Copy link address" to buy a third route to an action a hold
    // and Shift+F10 already reach. Elsewhere it stays the desktop equivalent of
    // a hold, since there is no browser menu worth keeping on a plain row.
    contextMenuAsLongPress: !href,
  });

  return (
    <md-list-item
      // Only a row with something to do is a button. Without `type`,
      // md-list-item renders an inert <li tabindex="-1"> instead of a focusable
      // <button> — which is what a 0-action, no-tap row should be, rather than a
      // control that takes a tab stop and then does nothing.
      type={href ? 'link' : onTap || follow || run ? 'button' : undefined}
      href={href}
      // The ONLY announcement AT gets that a second surface exists: md-list-item
      // re-emits exactly aria-selected/checked/expanded/haspopup onto its inner
      // button and shifts every other aria-* to data-*, so aria-label and
      // aria-keyshortcuts here would look right in source and do nothing.
      // A single action isn't a popup, so it gets none.
      aria-haspopup={actions.length > 1 ? 'menu' : undefined}
      {...rest}
      {...lp}
    >
      {children}
      {(end || actions.length > 0) && (
        <span slot="end" className="flex items-center gap-1.5">
          {end}
          {actions.length === 1 && (
            // One destination, so its own glyph — a kebab would promise a menu
            // that isn't there. Being a real <button> is also what makes
            // useLongPress skip it as an interactive child, so pressing the
            // icon never also fires the row's tap.
            <button
              aria-label={first.title ?? first.label}
              title={first.title ?? first.label}
              data-testid={first.testId}
              disabled={first.disabled}
              className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer text-muted-foreground shrink-0"
              onClick={() => run?.()}
            >
              <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 20 }}>
                {first.icon}
              </span>
            </button>
          )}
          {actions.length > 1 && <OverflowMenu items={actions} aria-label={actionsLabel} />}
        </span>
      )}
    </md-list-item>
  );
}
