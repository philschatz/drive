/**
 * Actions for one linked device, opened by tapping its row in DeviceList:
 * rename, reset the name, change access, remove.
 *
 * Unavailable actions are omitted rather than shown disabled — the same rule
 * MemberOptionsSheet follows — so this row inventory *is* where keyhive's three
 * limits on managing a device are expressed, rather than being discovered as a
 * failed call:
 *
 * - **Never yourself.** Self-revocation is the one case keyhive lets an admin
 *   revoke its own delegation, and doing it empties the group (see
 *   KeyhiveOps.assertNotSelf).
 * - **Never the founder.** Its delegation is the group's root delegation, which has
 *   no proof to revoke it with, so keyhive returns `NoProof` and the call throws.
 * - **Only devices you delegated.** You can revoke a delegation you issued, or one
 *   descended from it — so a linked admin device manages only the devices *it*
 *   linked, not its siblings. The founder issued everything, so it manages everyone.
 */

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { accessTitle } from '@/components/AccessIcon';
import type { DeviceInfo } from '@/common/keyhive-api';

export function DeviceOptionsSheet({
  device,
  displayName,
  hasStoredName,
  isAdmin,
  iAmFounder,
  myAgentId,
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
  /** This device holds the group's root delegation, so it can manage every device. */
  iAmFounder: boolean;
  /** This device's agentId, to tell the devices we delegated from their siblings. */
  myAgentId?: string;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (device: DeviceInfo) => void;
  onResetName: (device: DeviceInfo) => void;
  onChangeRole: (device: DeviceInfo) => void;
  onRemove: (device: DeviceInfo) => void;
}) {
  // `isFounder`/`issuerAgentId` are optional so a stale worker bundle degrades to
  // the old behaviour (offer the action, let it fail) rather than hiding actions on
  // every row — hence the `!== false` / `?? true` shape rather than plain truthiness.
  const isFounder = device?.isFounder === true;
  const iDelegatedIt = iAmFounder
    || device?.issuerAgentId === undefined
    || device.issuerAgentId === myAgentId;
  const canManage = isAdmin && !device?.isMe && !isFounder && iDelegatedIt;

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
                    <div slot="supporting-text">{accessTitle(device.role)}</div>
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

                {/* Say why the actions aren't there, rather than letting the user
                    hunt for them. Both cases are permanent facts about keyhive's
                    delegation graph, not transient failures. */}
                {isAdmin && !device.isMe && isFounder && (
                  <md-list-item type="text" data-testid="device-founder-note">
                    <md-icon slot="start">lock</md-icon>
                    <div slot="headline">{accessTitle(device.role)}</div>
                    <div slot="supporting-text">
                      This device created the group, so its access can’t be changed or removed.
                    </div>
                  </md-list-item>
                )}
                {isAdmin && !device.isMe && !isFounder && !iDelegatedIt && (
                  <md-list-item type="text" data-testid="device-not-mine-note">
                    <md-icon slot="start">lock</md-icon>
                    <div slot="headline">{accessTitle(device.role)}</div>
                    <div slot="supporting-text">
                      Only the device that linked this one — or the device that created the group —
                      can change its access.
                    </div>
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
