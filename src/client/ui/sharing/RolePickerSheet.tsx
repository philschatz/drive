/**
 * Role picker — bottom sheet. Shared by the three flows that need a role: inviting
 * someone new, changing an existing member's, and changing a device's access.
 *
 * A thin wrapper over the generic {@link PickerSheet}, which is the app's one
 * implementation of "pick one of these with a checkmark on the current one". The
 * roles and their explanations live here; the surface doesn't.
 *
 * `relay` is a real keyhive access level but is deliberately not offered — the rest
 * of the UI can't represent it either (see AccessIcon).
 */

import { PickerSheet, type PickerOption } from '../common/PickerSheet';
import type { MemberRole } from '../../../shared/keyhive-types';

const ROLES: PickerOption<MemberRole>[] = [
  { value: 'read', icon: 'visibility', label: 'Read', detail: 'Can view but not change', testId: 'role-read' },
  { value: 'edit', icon: 'edit', label: 'Edit', detail: 'Can view and change', testId: 'role-edit' },
  { value: 'admin', icon: 'admin_panel_settings', label: 'Admin', detail: 'Can also manage sharing', testId: 'role-admin' },
];

export function RolePickerSheet({
  open,
  onOpenChange,
  title,
  value,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Current role, checked in the list. Omit when inviting someone new. */
  value?: MemberRole;
  onPick: (role: MemberRole) => void;
}) {
  return (
    <PickerSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      options={ROLES}
      value={value}
      onPick={onPick}
      data-testid="role-picker-sheet"
    />
  );
}
