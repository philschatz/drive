/**
 * A sheet-level action (Delete, Archive, Remove) as a Material list row — the
 * shape every option sheet in the app uses (FriendOptionsSheet,
 * MemberOptionsSheet, DeviceOptionsSheet), so a destructive action reads as an
 * error-toned row rather than a stray button.
 *
 * Extracted from PropertySheet so ConfirmSheet can share the tone recipe without
 * inheriting PropertySheet's dependency chain (PeerDot → presence → worker-api),
 * which would force `jest.mock('../worker-api')` into every test that renders a
 * confirm. This file depends only on preact.
 */
import type { ComponentChildren } from 'preact';

/**
 * `md-list-item` has no implicit ARIA role while unregistered under jsdom, so
 * these always carry a testid; query them by that, not by `getByRole('button')`.
 */
export function SheetActionItem({ icon, label, destructive, onClick, 'data-testid': testId }: {
  icon: string;
  label: string;
  destructive?: boolean;
  onClick: () => void;
  'data-testid': string;
}) {
  const tone = destructive ? { color: 'var(--md-sys-color-error)' } : undefined;
  return (
    <md-list-item type="button" data-testid={testId} onClick={onClick}>
      <md-icon slot="start" style={tone}>{icon}</md-icon>
      <div slot="headline" style={tone}>{label}</div>
    </md-list-item>
  );
}

/** Divider + list wrapper for a run of {@link SheetActionItem}s. */
export function SheetActions({ children }: { children: ComponentChildren }) {
  return (
    <div className="mt-2">
      <md-divider role="separator" />
      <md-list style={{ background: 'transparent' }}>{children}</md-list>
    </div>
  );
}
