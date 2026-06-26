/**
 * Shared access-level icon, used by the document topbar (AccessControl trigger) and
 * the home page rows so both render the same glyph for a given keyhive access level.
 *
 * `null` explicitly means "no access" (revoked / not a member). Any other unrecognized
 * value throws — we fail fast on a bad/typo'd access string rather than silently
 * rendering a lock. Callers coalesce the loading-state `undefined` to `null`.
 */

/** Material-symbols glyph for a keyhive access level. null = no access. Throws on anything else. */
export function accessIcon(access: string | null): string {
  switch (access) {
    case 'admin': return 'admin_panel_settings';
    case 'edit': return 'edit';
    case 'read': return 'visibility';
    case null: return 'lock'; // explicit: no access
    default: throw new Error(`Unknown access level: ${access}`);
  }
}

/** Human label for the tooltip. null = no access. Throws on anything else. */
export function accessTitle(access: string | null): string {
  switch (access) {
    case 'admin': return 'Admin';
    case 'edit': return 'Edit';
    case 'read': return 'Read';
    case null: return 'No access';
    default: throw new Error(`Unknown access level: ${access}`);
  }
}

interface AccessIconProps {
  access: string | null;
  style?: any;
  className?: string;
  /** Tooltip text; defaults to the access label. Pass "" to suppress (e.g. when a parent sets the title). */
  title?: string;
}

export function AccessIcon({ access, style, className, title }: AccessIconProps) {
  return (
    <span
      className={`material-symbols-outlined${className ? ' ' + className : ''}`}
      style={style}
      title={title ?? accessTitle(access)}
    >
      {accessIcon(access)}
    </span>
  );
}
