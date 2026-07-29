/**
 * Actions for one linked device, opened by tapping its row in DeviceList:
 * rename, reset the name, change access, remove.
 *
 * Unavailable actions are omitted rather than shown disabled — the same rule
 * MemberOptionsSheet follows. That is how the two load-bearing device rules are
 * expressed: your own row offers no role change and no removal, because
 * self-demotion from admin is unrecoverable from this screen and removing the
 * device you're using is not a thing you can want. The rules live in this row
 * inventory now, rather than in whether a control happens to be rendered.
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { DeviceInfo } from '@/common/keyhive-api';

export function DeviceOptionsSheet({
  device,
  displayName,
  hasStoredName,
  isAdmin,
  busy,
  onOpenChange,
  onRename,
  onResetName,
  onChangeRole,
  onRemove,
}: {
  /** The device to act on; null closes the sheet. */
  device: DeviceInfo | null;
  displayName: string;
  /** Gates the Reset-name row: there is nothing to reset to a default from. */
  hasStoredName: boolean;
  isAdmin: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (device: DeviceInfo) => void;
  onResetName: (device: DeviceInfo) => void;
  onChangeRole: (device: DeviceInfo) => void;
  onRemove: (device: DeviceInfo) => void;
}) {
  const canManage = isAdmin && !device?.isMe;

  return (
    <Sheet open={!!device} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] p-4 overflow-y-auto">
        {/* SheetContent doesn't forward extra props — testid goes on a wrapper */}
        <div data-testid="device-options-sheet">
          <SheetHeader>
            <SheetTitle className="pr-8">{displayName}</SheetTitle>
          </SheetHeader>

          {device && (
            <>
              {/* Two unnamed devices are otherwise indistinguishable in this sheet. */}
              <p className="text-xs font-mono text-muted-foreground break-all mt-1">
                {device.agentId.slice(0, 24)}…
              </p>

              <md-list style={{ background: 'transparent' }} className="mt-2">
                <md-list-item type="button" data-testid="device-rename" onClick={() => onRename(device)}>
                  <md-icon slot="start">edit</md-icon>
                  <div slot="headline">Rename</div>
                  {!device.isMe && (
                    <div slot="supporting-text">A local label — not shared with that device</div>
                  )}
                </md-list-item>

                {hasStoredName && (
                  <md-list-item type="button" data-testid="device-reset-name" onClick={() => onResetName(device)}>
                    <md-icon slot="start">restart_alt</md-icon>
                    <div slot="headline">Reset name</div>
                    <div slot="supporting-text">
                      {device.isMe ? 'Back to the generated name' : 'Back to the device id'}
                    </div>
                  </md-list-item>
                )}

                {canManage && (
                  <md-list-item
                    type="button"
                    data-testid="device-change-role"
                    disabled={busy || undefined}
                    onClick={() => onChangeRole(device)}
                  >
                    <md-icon slot="start">admin_panel_settings</md-icon>
                    <div slot="headline">Change access</div>
                    <div slot="supporting-text" className="capitalize">{device.role}</div>
                  </md-list-item>
                )}

                {canManage && (
                  <md-list-item
                    type="button"
                    data-testid="device-remove"
                    disabled={busy || undefined}
                    onClick={() => onRemove(device)}
                  >
                    <md-icon slot="start" style={{ color: 'var(--md-sys-color-error)' }}>phonelink_erase</md-icon>
                    <div slot="headline" style={{ color: 'var(--md-sys-color-error)' }}>Remove device</div>
                  </md-list-item>
                )}
              </md-list>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
