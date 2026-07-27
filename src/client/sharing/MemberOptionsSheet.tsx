/**
 * Actions for one member of a document, opened by tapping their row on the
 * Sharing page. Role and removal are admin-only; renaming is not, since it only
 * touches this device's contact list.
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { MemberInfo } from '../shared/keyhive-types';

export function MemberOptionsSheet({
  member,
  displayName,
  isAdmin,
  busy,
  onOpenChange,
  onRename,
  onChangeRole,
  onRemove,
}: {
  /** The member to act on; null closes the sheet. */
  member: MemberInfo | null;
  displayName: string;
  isAdmin: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (member: MemberInfo) => void;
  onChangeRole: (member: MemberInfo) => void;
  onRemove: (member: MemberInfo) => void;
}) {
  return (
    <Sheet open={!!member} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4 overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="member-options-sheet">
          <SheetHeader>
            <SheetTitle>{displayName}</SheetTitle>
          </SheetHeader>

          {/* Unavailable actions are omitted rather than shown disabled. */}
          {member && (
            <md-list style={{ background: 'transparent' }} className="mt-2">
              <md-list-item
                type="button"
                data-testid="member-rename"
                onClick={() => onRename(member)}
              >
                <md-icon slot="start">edit</md-icon>
                <div slot="headline">Rename</div>
                {/* Contact names are global: this renames them everywhere, not
                    just on this document. */}
                <div slot="supporting-text">Renames this friend everywhere</div>
              </md-list-item>

              {isAdmin && (
                <md-list-item
                  type="button"
                  data-testid="member-change-role"
                  onClick={() => onChangeRole(member)}
                  disabled={busy || undefined}
                >
                  <md-icon slot="start">admin_panel_settings</md-icon>
                  <div slot="headline">Change role</div>
                  <div slot="supporting-text" className="capitalize">{member.role ?? 'read'}</div>
                </md-list-item>
              )}

              {isAdmin && (
                <md-list-item
                  type="button"
                  data-testid="member-remove"
                  onClick={() => onRemove(member)}
                  disabled={busy || undefined}
                >
                  <md-icon slot="start" style={{ color: 'var(--md-sys-color-error)' }}>person_remove</md-icon>
                  <div slot="headline" style={{ color: 'var(--md-sys-color-error)' }}>Remove from document</div>
                </md-list-item>
              )}
            </md-list>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
