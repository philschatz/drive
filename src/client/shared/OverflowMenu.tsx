/**
 * Material overflow ("kebab") menu — a `more_vert` icon button anchoring an
 * `md-menu`. Shared by the editor top app bar and Home. Items render as
 * `md-menu-item`s; `href` items navigate (used for hash routes), the rest fire
 * `onSelect`. The menu closes itself after a selection (md-menu default).
 */
import { Fragment } from 'preact';
import { useRef } from 'preact/hooks';

export interface OverflowMenuItem {
  /** Material Symbols icon name. */
  icon: string;
  label: string;
  onSelect?: () => void;
  /** Navigate instead of firing onSelect (e.g. '#/settings'). */
  href?: string;
  /** Tooltip; defaults to the label. */
  title?: string;
  disabled?: boolean;
  /** Render a divider above this item. */
  dividerBefore?: boolean;
}

export function OverflowMenu({
  items,
  'aria-label': ariaLabel = 'More actions',
  positioning = 'popover',
}: {
  items: OverflowMenuItem[];
  'aria-label'?: string;
  /**
   * How md-menu escapes its container. Defaults to `popover` (the browser's top
   * layer), which is the only value that survives an ancestor with clipping or
   * a stacking context — a kebab inside an `md-list-item`'s `end` slot renders
   * its menu trapped inside the row otherwise.
   */
  positioning?: 'popover' | 'fixed' | 'absolute' | 'document';
}) {
  const menuRef = useRef<any>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);

  if (items.length === 0) return null;

  const toggle = () => {
    const menu = menuRef.current;
    if (!menu) return;
    menu.anchorElement = kebabRef.current;
    menu.open = !menu.open;
  };

  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={kebabRef}
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-haspopup="menu"
        className="inline-flex items-center justify-center h-10 w-10 rounded-full state-layer"
        onClick={toggle}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 22 }}>more_vert</span>
      </button>
      <md-menu ref={menuRef} positioning={positioning} anchor-corner="end-end" menu-corner="start-end">
        {items.map(item => (
          <Fragment key={item.label}>
            {item.dividerBefore && <md-divider role="separator" />}
            <md-menu-item
              title={item.title ?? item.label}
              disabled={item.disabled || undefined}
              href={item.href}
              onClick={item.onSelect}
            >
              <md-icon slot="start">{item.icon}</md-icon>
              <div slot="headline">{item.label}</div>
            </md-menu-item>
          </Fragment>
        ))}
      </md-menu>
    </span>
  );
}
