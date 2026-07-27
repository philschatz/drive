/**
 * Role picker — bottom sheet. Shared by the two flows that need a role:
 * inviting someone new and changing an existing member's.
 *
 * Dismissing without choosing cancels, so callers can treat `onPick` as the
 * only success path. `relay` is a real keyhive access level but is deliberately
 * not offered — the rest of the UI can't represent it either (see AccessIcon).
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { MemberRole } from '../shared/keyhive-types';

const ROLES: { role: MemberRole; icon: string; label: string; detail: string }[] = [
  { role: 'read', icon: 'visibility', label: 'Read', detail: 'Can view but not change' },
  { role: 'edit', icon: 'edit', label: 'Edit', detail: 'Can view and change' },
  { role: 'admin', icon: 'admin_panel_settings', label: 'Admin', detail: 'Can also manage sharing' },
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4 overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="role-picker-sheet">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>

          <md-list style={{ background: 'transparent' }} className="mt-2">
            {ROLES.map(({ role, icon, label, detail }) => (
              <md-list-item
                key={role}
                type="button"
                data-testid={`role-${role}`}
                onClick={() => { onOpenChange(false); onPick(role); }}
              >
                <md-icon slot="start">{icon}</md-icon>
                <div slot="headline">{label}</div>
                <div slot="supporting-text">{detail}</div>
                {value === role && <md-icon slot="end">check</md-icon>}
              </md-list-item>
            ))}
          </md-list>
        </div>
      </SheetContent>
    </Sheet>
  );
}
