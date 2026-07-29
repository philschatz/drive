/**
 * The two layout primitives every Settings sub-screen is built from: a labelled
 * group of `md-list` rows, and the explanatory prose that sits between groups.
 *
 * A settings page is a list, not a form — so a section is a subheader plus rows,
 * and the old `<section className="mb-6">` + `<h2 className="text-lg font-semibold">`
 * pairs are gone.
 */
import type { ComponentChildren } from 'preact';

export function SettingsGroup({ label, children, 'data-testid': testId }: {
  /** Subheader above the group. Omit for a single unlabelled group. */
  label?: string;
  children: ComponentChildren;
  'data-testid'?: string;
}) {
  return (
    <div data-testid={testId}>
      {label && <div className="md-label-large text-on-surface-variant mt-4 mb-1 px-4">{label}</div>}
      {/* md-list defaults to --md-sys-color-surface, which fights the page tone. */}
      <md-list style={{ background: 'transparent' }}>{children}</md-list>
    </div>
  );
}

/**
 * Explanatory copy between groups. `px-4` matches `md-item`'s own 16px padding, so
 * prose lines up with the row headlines above it instead of floating to their left.
 */
export function SettingsProse({ children }: { children: ComponentChildren }) {
  return <p className="md-body-medium text-on-surface-variant px-4 pt-1 pb-2">{children}</p>;
}
